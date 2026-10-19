/**
 * Los informes de Google Ads: ads-cliente.pdf, ads-admin.pdf y el análisis
 * semanal con su baseline.
 *
 * Corre en el servicio analytics por dos caminos: solo, al terminar la
 * sincronización del día ADS_REPORT_WEEKDAY, y a pedido desde el dashboard.
 * Lee de la base —no habla con Google Ads—, así que generar otra vez no gasta
 * cuota de la API; lo que sí cuesta es el texto de Claude, y por eso el
 * análisis semanal no se repite si ya hay uno de los últimos seis días.
 *
 * Cada parte falla por separado: sin llave de Claude, o si Claude falla, los
 * PDFs salen con la conclusión escrita con reglas.
 */

import { env, type Env } from '../config/env.js';
import { loadSitesConfig, type ResolvedSite } from '../config/sites.js';
import { log as rootLog, type Logger } from '../lib/logger.js';
import { fetchAdsContext, saveAdsBaseline, saveAdsNote, latestAdsNoteDate } from '../db/analytics.js';
import { loadAdsReport } from './ads-report-data.js';
import { AdsWriter, type AdsAudience, type AccountContext } from '../ai/ads-writer.js';
import { renderAdsHtml, adsFooterText, type AdsTextInput } from '../report/ads-template.js';
import type { AdsReportData } from '../report/ads-model.js';
import { launchBrowser, cdpPortForSlot } from '../audit/browser.js';
import { sitePdfPaths, writeReportPdf, cleanStaleTmpDirs } from '../pdf/site-pdfs.js';
import { isoToday } from './periods.js';
import { waitForWorkerIdle } from './worker-idle.js';

export interface AdsReportsOptions {
  /** Uno solo, aunque esté en pausa; si no, todos los habilitados con Ads. */
  siteId?: string | undefined;
  /** Forzar el análisis semanal aunque ya haya uno reciente. */
  weekly: 'force' | 'if-stale' | 'skip';
  /** Para el folio y el temporal; null cuando se pide a mano. */
  runId: number | null;
  dryRun?: boolean;
  log?: Logger;
}

export interface AdsSiteOutcome {
  siteId: string;
  pdfs: number;
  weekly: boolean;
  /** Lo que salió mal, en una línea por parte. Vacío si todo salió. */
  problems: string[];
}

/** Seis días: el lunes siguiente ya toca otro, pero un clic a media semana no repite el del lunes. */
const SEMANAL_VIGENTE_MS = 6 * 24 * 60 * 60 * 1000;

export function selectAdsSites(all: ResolvedSite[], siteId: string | undefined): ResolvedSite[] {
  if (siteId !== undefined) return all.filter((s) => s.id === siteId && s.google.adsCustomerId !== null);
  return all.filter((s) => s.enabled && s.google.adsCustomerId !== null);
}

function writerFor(cfg: Env): AdsWriter | null {
  if (cfg.ANTHROPIC_API_KEY === undefined) return null;
  return new AdsWriter({ model: cfg.ADS_AI_MODEL, effort: cfg.ADS_AI_EFFORT });
}

/** Un sitio con sus datos y sus textos, listo para imprimir. */
interface Listo {
  site: ResolvedSite;
  data: AdsReportData;
  texts: Record<AdsAudience, AdsTextInput | null>;
  outcome: AdsSiteOutcome;
}

const motivo = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** El análisis semanal: lo guarda, actualiza el baseline y devuelve el contexto nuevo. */
async function weekly(
  siteId: string, data: AdsReportData, writer: AdsWriter, ctx: AccountContext, dryRun: boolean, log: Logger,
): Promise<AccountContext> {
  const r = await writer.weekly(data, ctx);
  if (!dryRun) {
    await saveAdsNote(siteId, { kind: 'weekly', range: data.week.range, model: r.model, content: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
    await saveAdsBaseline(siteId, r.content.baseline);
  }
  log.info('google ads: análisis semanal escrito', { modelo: r.model, tokens_entrada: r.inputTokens, tokens_salida: r.outputTokens });
  return { ...ctx, baseline: r.content.baseline };
}

async function reportText(
  siteId: string, data: AdsReportData, audience: AdsAudience, writer: AdsWriter, ctx: AccountContext, dryRun: boolean, log: Logger,
): Promise<AdsTextInput> {
  const r = await writer.report(data, audience, ctx);
  if (!dryRun) {
    await saveAdsNote(siteId, { kind: audience, range: data.period.current, model: r.model, content: r.content, inputTokens: r.inputTokens, outputTokens: r.outputTokens });
  }
  log.info(`google ads: texto del informe ${audience}`, { modelo: r.model, tokens_entrada: r.inputTokens, tokens_salida: r.outputTokens });
  return { content: r.content, model: r.model };
}

export async function runAdsReports(opts: AdsReportsOptions): Promise<AdsSiteOutcome[]> {
  const cfg = env();
  const log = opts.log ?? rootLog;
  const dryRun = opts.dryRun === true;
  const sites = selectAdsSites(await loadSitesConfig(cfg.SITES_FILE), opts.siteId);
  if (sites.length === 0) {
    log.info('informes de ads omitidos: ningún sitio tiene Google Ads conectado');
    return [];
  }

  const writer = writerFor(cfg);
  if (writer === null) log.warn('sin ANTHROPIC_API_KEY: los informes de ads salen sin el texto de Claude');
  const today = isoToday(cfg.TZ);
  const generatedAt = new Date();

  // Primero todo lo que no necesita navegador: datos y texto. Así Chromium
  // solo se abre si hay algo que imprimir, y por el menor tiempo posible.
  const listos: Array<Listo | (Omit<Listo, 'data'> & { data: null })> = [];
  for (const site of sites) {
    const slog = log.child({ site_id: site.id });
    const outcome: AdsSiteOutcome = { siteId: site.id, pdfs: 0, weekly: false, problems: [] };
    let data: AdsReportData | null;
    try {
      data = await loadAdsReport(site, {
        consultant: { name: cfg.REPORT_AUTHOR_NAME, role: cfg.REPORT_AUTHOR_ROLE, credentials: cfg.REPORT_AUTHOR_CREDENTIALS },
        mode: cfg.REPORT_PERIOD,
        today,
        generatedAt,
        runId: opts.runId ?? 0,
      });
    } catch (err) {
      outcome.problems.push(`no se pudieron leer los datos: ${motivo(err)}`);
      slog.error('google ads: no se pudieron armar los datos del informe', err);
      listos.push({ site, data: null, texts: { cliente: null, admin: null }, outcome });
      continue;
    }
    if (data === null) {
      outcome.problems.push('todavía no hay una sincronización buena de Google Ads');
      slog.info('google ads: sin datos sincronizados; no hay informe');
      listos.push({ site, data: null, texts: { cliente: null, admin: null }, outcome });
      continue;
    }

    const texts: Record<AdsAudience, AdsTextInput | null> = { cliente: null, admin: null };
    if (writer !== null) {
      let ctx = await fetchAdsContext(site.id);
      const ultimo = await latestAdsNoteDate(site.id, 'weekly');
      const toca = opts.weekly === 'force' || (opts.weekly === 'if-stale' && (ultimo === null || Date.now() - ultimo.getTime() > SEMANAL_VIGENTE_MS));
      if (toca) {
        try {
          ctx = await weekly(site.id, data, writer, ctx, dryRun, slog);
          outcome.weekly = true;
        } catch (err) {
          outcome.problems.push(`análisis semanal: ${motivo(err)}`);
          slog.warn('google ads: el análisis semanal falló', { motivo: motivo(err) });
        }
      }
      for (const audience of ['cliente', 'admin'] as const) {
        try {
          texts[audience] = await reportText(site.id, data, audience, writer, ctx, dryRun, slog);
        } catch (err) {
          outcome.problems.push(`texto del informe ${audience}: ${motivo(err)}`);
          slog.warn(`google ads: el texto del informe ${audience} falló; sale sin él`, { motivo: motivo(err) });
        }
      }
    }
    listos.push({ site, data, texts, outcome });
  }

  const conDatos = listos.filter((l): l is Listo => l.data !== null);
  if (conDatos.length > 0) {
    if (!dryRun && !(await waitForWorkerIdle(cfg.WORKER_URL, 60 * 60_000, log))) {
      log.warn('el worker siguió ocupado una hora; los PDFs de ads se generan en la próxima corrida');
      for (const l of conDatos) l.outcome.problems.push('el worker estuvo ocupado: no se imprimieron los PDFs');
    } else {
      await printAll(conDatos, opts.runId, cfg, dryRun, log);
    }
  }
  return listos.map((l) => l.outcome);
}

async function printAll(
  items: Listo[],
  runId: number | null,
  cfg: Env,
  dryRun: boolean,
  log: Logger,
): Promise<void> {
  const browser = await launchBrowser(cdpPortForSlot(0)).catch((err: unknown) => {
    log.error('no se pudo abrir Chromium; no habrá PDFs de ads esta vez', err);
    return null;
  });
  if (browser === null) {
    for (const i of items) i.outcome.problems.push('no se pudo abrir Chromium');
    return;
  }
  try {
    for (const { site, data, texts, outcome } of items) {
      const slog = log.child({ site_id: site.id });
      await cleanStaleTmpDirs(cfg.PDF_DIR, site.id, 'analytics');
      const paths = sitePdfPaths(cfg.PDF_DIR, site.id, runId ?? `ads-${Date.now()}`, 'analytics');
      for (const audience of ['cliente', 'admin'] as const) {
        try {
          const meta = await writeReportPdf({
            paths,
            strategy: audience === 'cliente' ? 'ads-cliente' : 'ads-admin',
            html: await renderAdsHtml(data, audience, texts[audience]),
            footerLeft: adsFooterText(data, audience),
            browser,
            quality: cfg.PDF_QUALITY,
            compressTimeoutMs: cfg.PDF_COMPRESS_TIMEOUT_MS,
            renderTimeoutMs: cfg.PDF_RENDER_TIMEOUT_MS,
            dryRun,
            log: slog,
          });
          if (meta !== null || dryRun) outcome.pdfs += 1;
        } catch (err) {
          outcome.problems.push(`PDF ${audience}: ${motivo(err)}`);
          slog.error(`google ads: no se pudo imprimir el informe ${audience}`, err);
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
