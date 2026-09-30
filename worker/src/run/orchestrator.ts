/**
 * Una corrida completa: todos los sitios, con concurrencia acotada y un
 * presupuesto de tiempo que no se negocia.
 */

import pLimit from 'p-limit';
import { env } from '../config/env.js';
import { loadSitesConfig, type ResolvedSite } from '../config/sites.js';
import { Deadline, SlotPool } from '../lib/deadline.js';
import { log as rootLog, type Logger } from '../lib/logger.js';
import { syncSites } from '../db/sites.js';
import { startRun, finishRun, startSiteRun, finishSiteRun, type RunStatus, type RunTrigger } from '../db/runs.js';
import { runSite, type SiteRunResult } from './site-runner.js';
import { runLighthousePhase } from './lighthouse-phase.js';
import { computeSiteDeltas, evaluateFlags, type SiteDeltas, type SiteFlags } from './deltas.js';
import { fetchRunSnapshot, fetchPreviousRunSnapshot } from '../db/snapshots.js';
import { purgeOldRuns } from '../db/retention.js';
import { buildPayload, deliverWebhook } from '../notify/webhook.js';

export interface RunAuditOptions {
  trigger: RunTrigger;
  /** Solo este sitio, ignorando enabled. Para `npm run check -- --site=x`. */
  siteId?: string | undefined;
  /** Sin escrituras en la base ni reemplazo de PDFs. */
  dryRun?: boolean;
  log?: Logger;
}

export interface RunSummary {
  runId: number | null;
  status: RunStatus;
  trigger: RunTrigger;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  sitesSkipped: number;
  budgetExceeded: boolean;
  durationMs: number;
  results: SiteRunResult[];
}

/** Elige los sitios de la corrida: uno concreto, o todos los habilitados. */
export function selectSites(all: ResolvedSite[], siteId: string | undefined): ResolvedSite[] {
  if (siteId === undefined) return all.filter((s) => s.enabled);
  return all.filter((s) => s.id === siteId);
}

export async function runAudit(opts: RunAuditOptions): Promise<RunSummary> {
  const cfg = env();
  const dryRun = opts.dryRun === true;
  const startedAt = Date.now();

  const all = await loadSitesConfig(cfg.SITES_FILE);
  const sites = selectSites(all, opts.siteId);

  if (opts.siteId !== undefined && sites.length === 0) {
    throw new Error(
      `no existe el sitio "${opts.siteId}" en ${cfg.SITES_FILE}. Disponibles: ${all.map((s) => s.id).join(', ')}`,
    );
  }
  if (sites.length === 0) {
    throw new Error(`${cfg.SITES_FILE} no tiene ningún sitio habilitado`);
  }

  // El espejo del YAML se actualiza antes de la corrida: site_runs referencia
  // sites por llave foránea, así que un sitio nuevo tiene que existir primero.
  if (!dryRun) await syncSites(all);

  const runId = dryRun ? null : await startRun(opts.trigger);
  const log = (opts.log ?? rootLog).child({ run_id: runId ?? 'dry-run', trigger: opts.trigger });

  const deadline = new Deadline(cfg.RUN_BUDGET_MINUTES * 60_000);
  const slots = new SlotPool(cfg.CONCURRENCY);
  const limit = pLimit(cfg.CONCURRENCY);


  log.info('corrida iniciada', {
    sitios: sites.length,
    concurrencia: cfg.CONCURRENCY,
    paginas_en_paralelo: cfg.PAGE_CONCURRENCY,
    presupuesto_min: cfg.RUN_BUDGET_MINUTES,
    dry_run: dryRun,
  });

  const results = await Promise.all(
    sites.map((site) =>
      limit(async (): Promise<SiteRunResult> => {
        if (deadline.expired) {
          log.warn('sitio omitido: presupuesto agotado', { site_id: site.id });
          return skipSite(site, runId, deadline.elapsedMs);
        }
        const slot = slots.acquire();
        try {
          return await runSite(site, {
            runId,
            slot,
            userAgent: cfg.USER_AGENT,
            pageConcurrency: cfg.PAGE_CONCURRENCY,
            deadline,
            log,
            pdfDir: cfg.PDF_DIR,
            dryRun,
            siteBudgetMs: cfg.SITE_BUDGET_MINUTES * 60_000,
          });
        } finally {
          slots.release(slot);
        }
      }),
    ),
  );

  // ── Segunda fase: Lighthouse con la máquina en silencio ───────────────────
  // Se hace después de que TODOS los sitios terminaron de crawlear, imprimir y
  // comprimir. Si corriera en paralelo con eso, el score de rendimiento de cada
  // sitio dependería de con qué otro sitio le tocó compartir CPU.
  await runLighthousePhase(new Map(sites.map((s) => [s.id, s])), results, {
    concurrency: cfg.LIGHTHOUSE_CONCURRENCY,
    timeoutMs: cfg.LIGHTHOUSE_TIMEOUT_MS,
    deadline,
    dryRun,
    log,
    pdfDir: cfg.PDF_DIR,
    pdfQuality: cfg.PDF_QUALITY,
    pdfCompressTimeoutMs: cfg.PDF_COMPRESS_TIMEOUT_MS,
    pdfRenderTimeoutMs: cfg.PDF_RENDER_TIMEOUT_MS,
    runId,
  });

  const sitesFailed = results.filter((r) => r.status === 'failed').length;
  const sitesSkipped = results.filter((r) => r.status === 'skipped_timeout').length;
  const sitesOk = results.length - sitesFailed - sitesSkipped;
  const budgetExceeded = results.some((r) => r.abortedByDeadline) || sitesSkipped > 0;

  const status: RunStatus =
    sitesOk === 0 ? 'failed' : results.every((r) => r.status === 'ok') ? 'ok' : 'partial';

  const durationMs = Date.now() - startedAt;

  if (runId !== null) {
    await finishRun(runId, {
      status,
      sitesTotal: results.length,
      sitesOk,
      sitesFailed,
      sitesSkipped,
      budgetExceeded,
      notes: budgetExceeded ? `presupuesto de ${cfg.RUN_BUDGET_MINUTES} min agotado` : null,
    });
  }

  log.info('corrida terminada', {
    estado: status,
    ok: sitesOk,
    fallidos: sitesFailed,
    omitidos: sitesSkipped,
    presupuesto_agotado: budgetExceeded,
    duracion_ms: durationMs,
  });

  const summary: RunSummary = {
    runId,
    status,
    trigger: opts.trigger,
    sitesTotal: results.length,
    sitesOk,
    sitesFailed,
    sitesSkipped,
    budgetExceeded,
    durationMs,
    results,
  };

  // Lo que sigue son tareas de cierre. Ninguna puede tumbar la corrida: los datos
  // ya están guardados y la auditoría ya cumplió su trabajo.
  if (runId !== null) {
    await sendWebhook(summary, runId, new Date(deadline.startedAt), cfg, log);

    try {
      await purgeOldRuns(cfg.RETENTION_DAYS, log);
    } catch (err) {
      log.error('la purga de retención falló; la corrida sigue siendo válida', err);
    }
  }

  return summary;
}

/**
 * Manda el webhook si está configurado. Se aísla aquí para que ninguna falla de
 * red, de la comparación o del destino afecte el estado de la corrida.
 */
async function sendWebhook(
  summary: RunSummary,
  runId: number,
  startedAt: Date,
  cfg: ReturnType<typeof env>,
  log: Logger,
): Promise<void> {
  if (cfg.WEBHOOK_URL === undefined) return;

  try {
    const current = await fetchRunSnapshot(runId);
    const previous = await fetchPreviousRunSnapshot(runId);

    const perSite = new Map<string, { deltas: SiteDeltas; flags: SiteFlags }>();
    for (const [siteId, snapshot] of current) {
      const deltas = computeSiteDeltas(snapshot, previous?.sites.get(siteId) ?? null);
      const flags = evaluateFlags(snapshot, deltas, {
        perfDropThreshold: cfg.PERF_DROP_THRESHOLD,
        certWarnDays: cfg.CERT_EXPIRY_WARN_DAYS,
      });
      perSite.set(siteId, { deltas, flags });
    }

    const alertas = [...perSite.values()].filter(
      (v) => v.flags.isDown || v.flags.performanceDropped || v.flags.certExpiringSoon,
    ).length;
    log.info('webhook: payload armado', {
      comparado_con_run: previous?.runId ?? null,
      sitios: current.size,
      con_alerta: alertas,
    });

    await deliverWebhook(buildPayload(summary, startedAt, current, previous, perSite), {
      url: cfg.WEBHOOK_URL,
      log,
    });
  } catch (err) {
    log.error('no se pudo preparar o entregar el webhook; la corrida sigue siendo válida', err);
  }
}


/** Deja constancia de un sitio que nunca arrancó por falta de tiempo. */
async function skipSite(site: ResolvedSite, runId: number | null, elapsedMs: number): Promise<SiteRunResult> {
  let siteRunId: number | null = null;
  if (runId !== null) {
    siteRunId = await startSiteRun(runId, site.id);
    await finishSiteRun(siteRunId, {
      status: 'skipped_timeout',
      discovery: null,
      pagesDiscovered: 0,
      pagesAudited: 0,
      pagesFailed: 0,
      maxPages: site.maxPages,
      truncated: false,
      homeHttpStatus: null,
      cert: null,
      errorCategory: 'timeout',
      errorMessage: `no arrancó: el presupuesto de la corrida se agotó a los ${Math.round(elapsedMs / 1000)} s`,
    });
  }
  return {
    siteId: site.id,
    siteRunId,
    status: 'skipped_timeout',
    discovery: null,
    pagesDiscovered: 0,
    pagesAudited: 0,
    pagesFailed: 0,
    truncated: false,
    abortedByDeadline: true,
    homeHttpStatus: null,
    cert: null,
    errorCategory: 'timeout',
    errorMessage: 'no arrancó: presupuesto de la corrida agotado',
    durationMs: 0,
    pages: [],
    homeUrl: null,
  };
}
