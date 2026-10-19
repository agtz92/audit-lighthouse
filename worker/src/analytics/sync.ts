/**
 * Una sincronización de Search Console, GA4 y Google Ads: todos los sitios
 * conectados, o uno solo si se pide desde el dashboard.
 *
 * Por sitio:
 *   1. Series diarias de cada fuente, desde donde se quedó (o 16 meses atrás
 *      la primera vez), volviendo a pedir los últimos días.
 *   2. Desgloses de los cuatro periodos: consultas, páginas, canales,
 *      dispositivos, páginas de entrada, eventos clave y totales.
 *   3. Google Ads: serie diaria por campaña y sus desgloses por periodo
 *      (campañas, keywords, términos de búsqueda, anuncios...).
 *   4. Al final, con todos los datos ya guardados, analitica.pdf.
 *
 * Las fuentes son independientes: si GA4 falla por permisos, Search Console
 * se guarda igual y el sitio queda 'partial', con el motivo en su fila.
 */

import pLimit from 'p-limit';
import { env, type Env } from '../config/env.js';
import { loadSitesConfig, type ResolvedSite } from '../config/sites.js';
import { log as rootLog, type Logger } from '../lib/logger.js';
import { syncSites } from '../db/sites.js';
import type { RunStatus, RunTrigger } from '../db/runs.js';
import {
  startAnalyticsRun, finishAnalyticsRun, startAnalyticsSiteRun, finishAnalyticsSiteRun, recordAnalyticsPdf,
  maxStoredDate, upsertGscDaily, upsertGaDaily, upsertGaAiDaily, saveBreakdown, purgeAnalytics, fetchGscDailyRange,
  replaceAdsDaily, fetchAdsTotalsRange,
  type SourceOutcome, type BreakdownKind,
} from '../db/analytics.js';
import { fetchGscDaily, fetchGscTop } from '../google/search-console.js';
import { fetchGaDaily, fetchGaPeriod, fetchGaAiDaily, fetchGaAiPeriod, fetchKeyEventNames, type GaTotals } from '../google/ga4.js';
import { fetchAdsAccount, fetchAdsDaily, fetchAdInventory, fetchAdsPeriod } from '../google/ads.js';
import { GoogleApiError, type GoogleClient } from '../google/client.js';
import { googleClient, googleAdsClient } from './google.js';
import { addDays, isoToday, periodRanges, syncWindow, PERIOD_KEYS } from './periods.js';
import { gscTotals, relChange } from '../report/analytics-model.js';
import { loadAnalyticsReport } from './report-data.js';
import { renderAnalyticsHtml, trafficFooterText } from '../report/analytics-template.js';
import { launchBrowser, cdpPortForSlot } from '../audit/browser.js';
import { sitePdfPaths, writeReportPdf, cleanStaleTmpDirs } from '../pdf/site-pdfs.js';
import { deliverWebhook } from '../notify/webhook.js';

export interface AnalyticsRunOptions {
  trigger: RunTrigger;
  siteId?: string | undefined;
  dryRun?: boolean;
  log?: Logger;
  onStart?: (runId: number) => void;
}

/** Lo que el webhook y el resumen necesitan de cada sitio. */
export interface AnalyticsSiteResult {
  siteId: string;
  siteRunId: number | null;
  status: RunStatus;
  gsc: SourceOutcome & { kind: GoogleApiError['kind'] | null; clicks: number | null; previousClicks: number | null };
  ga: SourceOutcome & { kind: GoogleApiError['kind'] | null; sessions: number | null; previousSessions: number | null };
  /** property = el id de cliente de Ads. Importes en `currency`, de los últimos 28 días contra los 28 previos. */
  ads: SourceOutcome & {
    kind: GoogleApiError['kind'] | null;
    currency: string | null;
    cost: number | null;
    previousCost: number | null;
    conversions: number | null;
    previousConversions: number | null;
  };
}

export interface AnalyticsSummary {
  runId: number | null;
  status: RunStatus;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  results: AnalyticsSiteResult[];
  notes: string | null;
}

/** Sitios a sincronizar: uno concreto (aunque esté en pausa), o los conectados y habilitados. */
export function selectAnalyticsSites(all: ResolvedSite[], siteId: string | undefined): ResolvedSite[] {
  const conectado = (s: ResolvedSite): boolean =>
    s.google.searchConsole !== null || s.google.ga4Property !== null || s.google.adsCustomerId !== null;
  if (siteId !== undefined) return all.filter((s) => s.id === siteId && conectado(s));
  return all.filter((s) => s.enabled && conectado(s));
}

/** Estado del sitio a partir de sus fuentes conectadas. */
export function siteStatus(...fuentes: Array<SourceOutcome['status']>): RunStatus {
  const conectadas = fuentes.filter((s) => s !== 'off');
  const ok = conectadas.filter((s) => s === 'ok').length;
  if (ok === conectadas.length) return 'ok';
  return ok === 0 ? 'failed' : 'partial';
}

function describe(err: unknown): { message: string; kind: GoogleApiError['kind'] | null; raw: string } {
  if (err instanceof GoogleApiError) return { message: err.message, kind: err.kind, raw: err.raw };
  const m = err instanceof Error ? err.message : String(err);
  return { message: m, kind: null, raw: m };
}

async function syncSite(
  site: ResolvedSite,
  client: GoogleClient,
  adsClient: GoogleClient | null,
  runId: number | null,
  cfg: Env,
  dryRun: boolean,
  log: Logger,
): Promise<AnalyticsSiteResult> {
  const today = isoToday(cfg.TZ);
  const ayer = addDays(today, -1);
  const siteRunId = runId === null ? null : await startAnalyticsSiteRun(runId, site.id);

  const gsc: AnalyticsSiteResult['gsc'] = {
    property: site.google.searchConsole, status: 'off', error: null, rows: 0, latestDate: null,
    kind: null, clicks: null, previousClicks: null,
  };
  const ga: AnalyticsSiteResult['ga'] = {
    property: site.google.ga4Property, status: 'off', error: null, rows: 0, latestDate: null,
    kind: null, sessions: null, previousSessions: null,
  };
  const ads: AnalyticsSiteResult['ads'] = {
    property: site.google.adsCustomerId, status: 'off', error: null, rows: 0, latestDate: null,
    kind: null, currency: null, cost: null, previousCost: null, conversions: null, previousConversions: null,
  };
  let keyEvents: string[] = [];

  const fallo = (
    fuente: { status: SourceOutcome['status']; error: string | null; kind: GoogleApiError['kind'] | null },
    nombre: string,
    err: unknown,
  ): void => {
    const d = describe(err);
    fuente.status = 'error';
    fuente.error = d.message;
    fuente.kind = d.kind;
    log.warn(`${nombre}: falló`, { motivo: d.message, google: d.raw, tipo: d.kind });
  };

  // ── 1. Series diarias ──────────────────────────────────────────────────
  if (site.google.searchConsole !== null) {
    const prop = site.google.searchConsole;
    const guardado = await maxStoredDate('gsc_daily', site.id);
    gsc.latestDate = guardado;
    try {
      const v = syncWindow({ today, maxStored: guardado, refreshDays: cfg.ANALYTICS_REFRESH_DAYS, backfillDays: cfg.ANALYTICS_BACKFILL_DAYS });
      const filas = await fetchGscDaily(client, prop, v.start, v.end);
      if (!dryRun) await upsertGscDaily(site.id, filas);
      gsc.rows = filas.length;
      gsc.status = 'ok';
      const ultimo = filas[filas.length - 1]?.date ?? null;
      if (ultimo !== null && (guardado === null || ultimo > guardado)) gsc.latestDate = ultimo;
      log.info('search console: días sincronizados', { desde: v.start, hasta: v.end, filas: filas.length, carga_inicial: v.backfill });
    } catch (err) {
      fallo(gsc, 'search console', err);
    }
  }

  if (site.google.ga4Property !== null) {
    const prop = site.google.ga4Property;
    const guardado = await maxStoredDate('ga_daily', site.id);
    ga.latestDate = guardado;
    try {
      const v = syncWindow({ today, maxStored: guardado, refreshDays: cfg.ANALYTICS_REFRESH_DAYS, backfillDays: cfg.ANALYTICS_BACKFILL_DAYS });
      const filas = await fetchGaDaily(client, prop, v.start, v.end);
      if (!dryRun) await upsertGaDaily(site.id, filas);
      ga.rows = filas.length;
      ga.status = 'ok';
      const ultimo = filas[filas.length - 1]?.date ?? null;
      if (ultimo !== null && (guardado === null || ultimo > guardado)) ga.latestDate = ultimo;
      log.info('ga4: días sincronizados', { desde: v.start, hasta: v.end, filas: filas.length, carga_inicial: v.backfill });
    } catch (err) {
      fallo(ga, 'ga4', err);
    }

    // Visitas desde asistentes de IA, con su propia ventana: la tabla es más
    // nueva que ga_daily y su primera carga necesita los 16 meses aunque
    // ga_daily ya esté al día. Es un dato de apoyo: si falla, GA4 sigue 'ok'.
    if (ga.status === 'ok') {
      try {
        const guardadoIa = await maxStoredDate('ga_ai_daily', site.id);
        const v = syncWindow({ today, maxStored: guardadoIa, refreshDays: cfg.ANALYTICS_REFRESH_DAYS, backfillDays: cfg.ANALYTICS_BACKFILL_DAYS });
        const filas = await fetchGaAiDaily(client, prop, v.start, v.end);
        if (!dryRun) await upsertGaAiDaily(site.id, filas);
        log.info('ga4: visitas desde asistentes de IA', {
          desde: v.start, hasta: v.end, sesiones: filas.reduce((a, f) => a + f.sessions, 0), carga_inicial: v.backfill,
        });
      } catch (err) {
        log.warn('ga4: no se pudieron leer las visitas desde asistentes de IA', { motivo: describe(err).message });
      }
    }
  }

  // ── 2. Desgloses por periodo ───────────────────────────────────────────
  // Los periodos de 28 días se anclan en el último día que publicó Search
  // Console, y GA4 usa el mismo ancla: así «últimos 28 días» es el mismo
  // rango en las dos fuentes y se pueden poner lado a lado.
  const ranges = periodRanges(today, gsc.status === 'ok' && gsc.latestDate !== null ? gsc.latestDate : ayer);

  if (gsc.status === 'ok' && site.google.searchConsole !== null) {
    const prop = site.google.searchConsole;
    try {
      for (const p of PERIOD_KEYS) {
        const [consultas, paginas] = await Promise.all([
          fetchGscTop(client, prop, 'query', ranges[p].start, ranges[p].end),
          fetchGscTop(client, prop, 'page', ranges[p].start, ranges[p].end),
        ]);
        if (!dryRun) {
          await saveBreakdown(site.id, p, 'gsc_queries', ranges[p], consultas);
          await saveBreakdown(site.id, p, 'gsc_pages', ranges[p], paginas);
        }
      }
      // Totales de 28 días para el webhook, desde lo que quedó guardado.
      if (!dryRun) {
        gsc.clicks = gscTotals(await fetchGscDailyRange(site.id, ranges.last28.start, ranges.last28.end)).clicks;
        gsc.previousClicks = gscTotals(await fetchGscDailyRange(site.id, ranges.prev28.start, ranges.prev28.end)).clicks;
      }
    } catch (err) {
      fallo(gsc, 'search console (desgloses)', err);
    }
  }

  if (ga.status === 'ok' && site.google.ga4Property !== null) {
    const prop = site.google.ga4Property;
    try {
      const totales: Partial<Record<string, GaTotals>> = {};
      for (const p of PERIOD_KEYS) {
        const r = await fetchGaPeriod(client, prop, ranges[p].start, ranges[p].end);
        totales[p] = r.totals;
        if (!dryRun) {
          await saveBreakdown(site.id, p, 'ga_totals', ranges[p], r.totals);
          await saveBreakdown(site.id, p, 'ga_channels', ranges[p], r.channels);
          await saveBreakdown(site.id, p, 'ga_devices', ranges[p], r.devices);
          await saveBreakdown(site.id, p, 'ga_landing', ranges[p], r.landing);
          await saveBreakdown(site.id, p, 'ga_key_events', ranges[p], r.keyEvents);
        }
      }
      ga.sessions = totales.last28?.sessions ?? null;
      ga.previousSessions = totales.prev28?.sessions ?? null;
    } catch (err) {
      fallo(ga, 'ga4 (desgloses)', err);
    }

    try {
      for (const p of PERIOD_KEYS) {
        const r = await fetchGaAiPeriod(client, prop, ranges[p].start, ranges[p].end);
        if (!dryRun) {
          await saveBreakdown(site.id, p, 'ga_ai_assistants', ranges[p], r.assistants);
          await saveBreakdown(site.id, p, 'ga_ai_landing', ranges[p], r.landing);
        }
      }
    } catch (err) {
      log.warn('ga4: no se pudieron leer los desgloses de asistentes de IA', { motivo: describe(err).message });
    }

    // Información de apoyo: si la Admin API no está habilitada, los números
    // siguen sirviendo y solo falta la lista de eventos clave sin ocurrencias.
    try {
      keyEvents = await fetchKeyEventNames(client, prop);
    } catch (err) {
      log.warn('ga4: no se pudo leer la lista de eventos clave', { motivo: describe(err).message });
    }
  }

  // ── 3. Google Ads ──────────────────────────────────────────────────────
  if (site.google.adsCustomerId !== null) {
    await syncAds(site.id, site.google.adsCustomerId, adsClient, ads, { today, ayer, cfg, dryRun, log, fallo });
  }

  const status = siteStatus(gsc.status, ga.status, ads.status);
  if (siteRunId !== null) {
    await finishAnalyticsSiteRun(siteRunId, { status, gsc, ga, keyEvents, ads });
  }
  log.info('sitio sincronizado', {
    estado: status, gsc: gsc.status, ga4: ga.status, ads: ads.status, eventos_clave: keyEvents.length,
  });
  return { siteId: site.id, siteRunId, status, gsc, ga, ads };
}

/**
 * Serie diaria y desgloses de Google Ads. Escribe el resultado en `ads`.
 *
 * Los periodos se anclan en ayer y no en el último día de Search Console: Ads
 * publica el día anterior completo, y una campaña sin gasto ayer no significa
 * que falten datos.
 */
async function syncAds(
  siteId: string,
  customerId: string,
  adsClient: GoogleClient | null,
  ads: AnalyticsSiteResult['ads'],
  ctx: {
    today: string;
    ayer: string;
    cfg: Env;
    dryRun: boolean;
    log: Logger;
    fallo: (fuente: AnalyticsSiteResult['ads'], nombre: string, err: unknown) => void;
  },
): Promise<void> {
  const { today, ayer, cfg, dryRun, log, fallo } = ctx;
  if (adsClient === null) {
    ads.status = 'error';
    ads.kind = 'auth';
    ads.error = 'Falta GOOGLE_ADS_DEVELOPER_TOKEN en .env: sin él no se puede leer Google Ads.';
    log.warn('google ads: sin developer token');
    return;
  }

  try {
    ads.currency = (await fetchAdsAccount(adsClient, customerId))?.currency ?? null;
    const guardado = await maxStoredDate('ads_daily', siteId);
    // Sin días guardados se repite la carga inicial en cada corrida: es una
    // sola consulta, y una cuenta sin gasto no deja otra marca de hasta dónde llegó.
    const v = syncWindow({ today, maxStored: guardado, refreshDays: cfg.ADS_REFRESH_DAYS, backfillDays: cfg.ANALYTICS_BACKFILL_DAYS });
    const filas = await fetchAdsDaily(adsClient, customerId, v.start, v.end);
    if (!dryRun) await replaceAdsDaily(siteId, v.start, v.end, filas);
    ads.rows = filas.length;
    ads.latestDate = v.end;
    ads.status = 'ok';
    log.info('google ads: días sincronizados', {
      desde: v.start, hasta: v.end, filas: filas.length, carga_inicial: v.backfill, moneda: ads.currency,
    });
  } catch (err) {
    fallo(ads, 'google ads', err);
    return;
  }

  const ranges = periodRanges(today, ayer);
  try {
    const inventario = await fetchAdInventory(adsClient, customerId);
    const regiones = new Map<string, string>();
    for (const p of PERIOD_KEYS) {
      const r = await fetchAdsPeriod(adsClient, customerId, ranges[p].start, ranges[p].end, inventario, regiones);
      if (dryRun) continue;
      const guardar = (kind: BreakdownKind, rows: unknown): Promise<void> => saveBreakdown(siteId, p, kind, ranges[p], rows);
      await guardar('ads_totals', r.totals);
      await guardar('ads_campaigns', r.campaigns);
      await guardar('ads_conversion_actions', r.conversionActions);
      await guardar('ads_ad_groups', r.adGroups);
      await guardar('ads_keywords', r.keywords);
      await guardar('ads_search_terms', r.searchTerms);
      await guardar('ads_ads', r.ads);
      await guardar('ads_devices', r.devices);
      await guardar('ads_landing', r.landing);
      await guardar('ads_geo', r.geo);
      await guardar('ads_gender', r.gender);
      await guardar('ads_age', r.age);
      await guardar('ads_schedule', r.schedule);
    }
    log.info('google ads: desgloses guardados', { anuncios: inventario.length });
  } catch (err) {
    fallo(ads, 'google ads (desgloses)', err);
  }

  if (!dryRun && ads.status === 'ok') {
    const actual = await fetchAdsTotalsRange(siteId, ranges.last28.start, ranges.last28.end);
    const previo = await fetchAdsTotalsRange(siteId, ranges.prev28.start, ranges.prev28.end);
    ads.cost = actual.cost;
    ads.previousCost = previo.cost;
    ads.conversions = actual.conversions;
    ads.previousConversions = previo.conversions;
  }
}

/**
 * Espera a que el worker termine de auditar antes de abrir Chromium.
 *
 * Los dos procesos juntos no caben en la memoria de Docker: el worker usa
 * hasta 2.4 GB durante Lighthouse. A las 05:00 nunca coinciden, pero un
 * «Sincronizar ahora» a media auditoría sí. Los datos se guardan sin esperar;
 * lo que se pospone son solo los PDFs.
 */
async function waitForWorkerIdle(workerUrl: string, maxMs: number, log: Logger): Promise<boolean> {
  const limite = Date.now() + maxMs;
  let avisado = false;
  while (Date.now() < limite) {
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { corriendo?: boolean };
      if (body.corriendo !== true) return true;
    } catch {
      // Sin worker no hay con quién competir por memoria.
      return true;
    }
    if (!avisado) {
      log.info('el worker está auditando; los PDFs esperan a que termine');
      avisado = true;
    }
    await new Promise((r) => setTimeout(r, 30_000).unref());
  }
  return false;
}

async function writePdfs(
  sites: ResolvedSite[],
  results: AnalyticsSiteResult[],
  runId: number | null,
  cfg: Env,
  dryRun: boolean,
  log: Logger,
): Promise<number> {
  const conDatos = results.filter((r) => r.gsc.status === 'ok' || r.ga.status === 'ok');
  if (conDatos.length === 0) return 0;

  if (!dryRun && !(await waitForWorkerIdle(cfg.WORKER_URL, 60 * 60_000, log))) {
    log.warn('el worker siguió ocupado una hora; los PDFs de tráfico se generan en la próxima sincronización');
    return 0;
  }

  const browser = await launchBrowser(cdpPortForSlot(0)).catch((err: unknown) => {
    log.error('no se pudo abrir Chromium; no habrá PDFs de tráfico esta vez', err);
    return null;
  });
  if (browser === null) return 0;

  let escritos = 0;
  try {
    for (const r of conDatos) {
      const site = sites.find((s) => s.id === r.siteId);
      if (site === undefined) continue;
      const slog = log.child({ site_id: site.id });
      try {
        const datos = await loadAnalyticsReport(site, {
          consultant: { name: cfg.REPORT_AUTHOR_NAME, role: cfg.REPORT_AUTHOR_ROLE, credentials: cfg.REPORT_AUTHOR_CREDENTIALS },
          mode: cfg.REPORT_PERIOD,
          today: isoToday(cfg.TZ),
          generatedAt: new Date(),
          runId: runId ?? 0,
          dropThreshold: cfg.TRAFFIC_DROP_THRESHOLD,
        });
        if (datos === null) continue;
        await cleanStaleTmpDirs(cfg.PDF_DIR, site.id, 'analytics');
        const meta = await writeReportPdf({
          paths: sitePdfPaths(cfg.PDF_DIR, site.id, runId ?? 'dry-run', 'analytics'),
          strategy: 'analitica',
          html: await renderAnalyticsHtml(datos),
          footerLeft: trafficFooterText(datos),
          browser,
          quality: cfg.PDF_QUALITY,
          compressTimeoutMs: cfg.PDF_COMPRESS_TIMEOUT_MS,
          renderTimeoutMs: cfg.PDF_RENDER_TIMEOUT_MS,
          dryRun,
          log: slog,
        });
        if (meta !== null) escritos += 1;
        if (r.siteRunId !== null) await recordAnalyticsPdf(r.siteRunId, meta);
      } catch (err) {
        slog.error('no se pudo armar el informe de tráfico', err);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return escritos;
}

export async function runAnalyticsSync(opts: AnalyticsRunOptions): Promise<AnalyticsSummary> {
  const cfg = env();
  const dryRun = opts.dryRun === true;
  const baseLog = opts.log ?? rootLog;

  const all = await loadSitesConfig(cfg.SITES_FILE);
  const sites = selectAnalyticsSites(all, opts.siteId);

  if (opts.siteId !== undefined && sites.length === 0) {
    const existe = all.some((s) => s.id === opts.siteId);
    throw new Error(existe
      ? `"${opts.siteId}" no tiene Search Console, GA4 ni Google Ads conectados en ${cfg.SITES_FILE}`
      : `no existe el sitio "${opts.siteId}" en ${cfg.SITES_FILE}`);
  }
  if (sites.length === 0) {
    // Sin sitios conectados no se registra corrida: sería una fila vacía al
    // día hasta que alguien conecte el primero.
    baseLog.info('sincronización omitida: ningún sitio tiene Search Console, GA4 ni Google Ads conectados');
    return { runId: null, status: 'ok', sitesTotal: 0, sitesOk: 0, sitesFailed: 0, results: [], notes: null };
  }

  if (!dryRun) await syncSites(all);
  const runId = dryRun ? null : await startAnalyticsRun(opts.trigger);
  if (runId !== null) opts.onStart?.(runId);
  const log = baseLog.child({ analytics_run_id: runId ?? 'dry-run', trigger: opts.trigger });
  log.info('sincronización iniciada', { sitios: sites.length, dry_run: dryRun });

  // Sin llave no hay nada que hacer, pero la corrida queda registrada con el
  // motivo: es lo que el dashboard muestra en vez de un silencio.
  let client: GoogleClient;
  try {
    ({ client } = await googleClient(cfg.GOOGLE_CREDENTIALS_FILE));
  } catch (err) {
    const notes = err instanceof Error ? err.message : String(err);
    log.error('sin credenciales de Google', { motivo: notes });
    if (runId !== null) {
      await finishAnalyticsRun(runId, { status: 'failed', sitesTotal: sites.length, sitesOk: 0, sitesFailed: sites.length, notes });
    }
    return { runId, status: 'failed', sitesTotal: sites.length, sitesOk: 0, sitesFailed: sites.length, results: [], notes };
  }

  // Ads usa la misma llave, ya validada arriba. Sin developer token queda en
  // null, y cada sitio con adsCustomerId lo reporta como error con el motivo.
  const adsClient = cfg.GOOGLE_ADS_DEVELOPER_TOKEN !== undefined && sites.some((s) => s.google.adsCustomerId !== null)
    ? await googleAdsClient(cfg.GOOGLE_CREDENTIALS_FILE, cfg.GOOGLE_ADS_DEVELOPER_TOKEN, cfg.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
    : null;

  const limit = pLimit(cfg.ANALYTICS_CONCURRENCY);
  const results = await Promise.all(sites.map((site) => limit(async (): Promise<AnalyticsSiteResult> => {
    const slog = log.child({ site_id: site.id });
    try {
      return await syncSite(site, client, adsClient, runId, cfg, dryRun, slog);
    } catch (err) {
      // Un error de base de datos u otro imprevisto: el sitio falla, la corrida sigue.
      slog.error('el sitio falló fuera de las fuentes', err);
      const vacio = { property: null, status: 'error' as const, error: describe(err).message, rows: 0, latestDate: null, kind: null };
      return {
        siteId: site.id, siteRunId: null, status: 'failed',
        gsc: { ...vacio, clicks: null, previousClicks: null },
        ga: { ...vacio, sessions: null, previousSessions: null },
        ads: { ...vacio, currency: null, cost: null, previousCost: null, conversions: null, previousConversions: null },
      };
    }
  })));

  const pdfs = await writePdfs(sites, results, runId, cfg, dryRun, log);

  const sitesOk = results.filter((r) => r.status !== 'failed').length;
  const sitesFailed = results.length - sitesOk;
  const status: RunStatus = sitesOk === 0 ? 'failed' : results.every((r) => r.status === 'ok') ? 'ok' : 'partial';
  const errores = results.filter((r) => r.status !== 'ok').map((r) => r.siteId);
  const notes = errores.length === 0 ? null : `con problemas: ${errores.join(', ')}`;

  if (runId !== null) {
    await finishAnalyticsRun(runId, { status, sitesTotal: results.length, sitesOk, sitesFailed, notes });
  }
  log.info('sincronización terminada', { estado: status, ok: sitesOk, fallidos: sitesFailed, pdfs });

  const summary: AnalyticsSummary = { runId, status, sitesTotal: results.length, sitesOk, sitesFailed, results, notes };

  if (runId !== null) {
    await sendAnalyticsWebhook(summary, opts.trigger, cfg, log);
    try {
      await purgeAnalytics(cfg.RETENTION_DAYS, cfg.ANALYTICS_RETENTION_DAYS, log);
    } catch (err) {
      log.error('la purga de tráfico falló; la sincronización sigue siendo válida', err);
    }
  }
  return summary;
}

/** Errores que no se arreglan solos: alguien tiene que dar acceso o habilitar algo. */
const SIN_ACCESO = new Set(['permission', 'not_found', 'auth', 'api_disabled']);

export interface AnalyticsSiteFlags {
  trafficDropped: boolean;
  accessLost: boolean;
}

export function analyticsFlags(r: AnalyticsSiteResult, dropThreshold: number): AnalyticsSiteFlags {
  const caida = relChange(r.gsc.clicks, r.gsc.previousClicks);
  return {
    trafficDropped: caida !== null && caida <= -dropThreshold / 100,
    accessLost: [r.gsc.kind, r.ga.kind, r.ads.kind].some((k) => k !== null && SIN_ACCESO.has(k)),
  };
}

async function sendAnalyticsWebhook(summary: AnalyticsSummary, trigger: RunTrigger, cfg: Env, log: Logger): Promise<void> {
  if (cfg.WEBHOOK_URL === undefined) return;
  try {
    await deliverWebhook({
      event: 'analytics.finished',
      run: {
        id: summary.runId,
        trigger,
        status: summary.status,
        sitesTotal: summary.sitesTotal,
        sitesOk: summary.sitesOk,
        sitesFailed: summary.sitesFailed,
      },
      sites: summary.results.map((r) => ({
        id: r.siteId,
        status: r.status,
        searchConsole: {
          status: r.gsc.status, error: r.gsc.error, latestDate: r.gsc.latestDate,
          clicks28d: r.gsc.clicks, previousClicks28d: r.gsc.previousClicks,
          change: relChange(r.gsc.clicks, r.gsc.previousClicks),
        },
        ga4: {
          status: r.ga.status, error: r.ga.error, latestDate: r.ga.latestDate,
          sessions28d: r.ga.sessions, previousSessions28d: r.ga.previousSessions,
          change: relChange(r.ga.sessions, r.ga.previousSessions),
        },
        googleAds: {
          status: r.ads.status, error: r.ads.error, latestDate: r.ads.latestDate, currency: r.ads.currency,
          cost28d: r.ads.cost, previousCost28d: r.ads.previousCost,
          conversions28d: r.ads.conversions, previousConversions28d: r.ads.previousConversions,
          costChange: relChange(r.ads.cost, r.ads.previousCost),
        },
        flags: analyticsFlags(r, cfg.TRAFFIC_DROP_THRESHOLD),
      })),
    }, { url: cfg.WEBHOOK_URL, log });
  } catch (err) {
    log.error('no se pudo entregar el webhook de tráfico; la sincronización sigue siendo válida', err);
  }
}
