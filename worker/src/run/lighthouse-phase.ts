/**
 * Segunda fase de la corrida: Lighthouse, con la máquina en silencio.
 *
 * Por qué es una fase aparte y no parte del corredor de cada sitio: Lighthouse
 * mide rendimiento, y el rendimiento depende de qué más esté haciendo la máquina.
 * Medido en este proyecto, el mismo sitio dio performance 96 en aislamiento y 49
 * mientras otro sitio crawleaba y Ghostscript comprimía en paralelo. Con Lighthouse
 * embebido en el corredor, el score de cada sitio dependería de con qué otro sitio
 * le tocó compartir el turno, y las tendencias día contra día no significarían nada.
 *
 * Así que primero se audita y se imprime todo (fase ruidosa, concurrencia 2), y
 * solo cuando eso terminó se mide rendimiento, de uno en uno. Cuesta un
 * lanzamiento extra de Chromium por sitio —unos 40 s en total para 20 sitios— y
 * compra números comparables.
 */

import pLimit from 'p-limit';
import type { ResolvedSite } from '../config/sites.js';
import type { Logger } from '../lib/logger.js';
import type { Deadline } from '../lib/deadline.js';
import { launchBrowser, cdpPortForSlot } from '../audit/browser.js';
import { runLighthouse, type LighthouseOutcome } from '../audit/lighthouse.js';
import { insertLighthouseResult } from '../db/lighthouse.js';
import { recordPdfMeta } from '../db/runs.js';
import { fetchPreviousForReport } from '../db/snapshots.js';
import { buildReportData } from '../report/build.js';
import { renderReportHtml } from '../report/template.js';
import { pathOfUrl } from '../lib/url.js';
import { sitePdfPaths, writeReportPdf, cleanStaleTmpDirs } from '../pdf/site-pdfs.js';
import type { PdfQuality } from '../pdf/compress.js';
import type { SiteRunResult } from './site-runner.js';

export interface LighthousePhaseDeps {
  concurrency: number;
  timeoutMs: number;
  deadline: Deadline;
  dryRun: boolean;
  log: Logger;
  /** Los dos PDFs por sitio son los reportes de Lighthouse, así que se generan aquí. */
  pdfDir: string;
  pdfQuality: PdfQuality;
  pdfCompressTimeoutMs: number;
  pdfRenderTimeoutMs: number;
  runId: number | null;
  /** Datos de marca que encabezan cada informe. */
  consultant: { name: string; role: string; credentials: string };
}

export interface LighthousePhaseResult {
  measured: number;
  skipped: number;
  failed: number;
  outcomes: Map<string, LighthouseOutcome[]>;
}

/** ¿Vale la pena medir el rendimiento de este sitio? */
function shouldMeasure(result: SiteRunResult): boolean {
  // Un sitio caído no tiene rendimiento que medir, y uno omitido por tiempo
  // tampoco alcanzó a auditarse.
  if (result.status === 'failed' || result.status === 'skipped_timeout') return false;
  if (result.homeUrl === null) return false;
  const home = result.pages.find((p) => p.isHome);
  return home?.ok === true;
}

export async function runLighthousePhase(
  sites: Map<string, ResolvedSite>,
  results: SiteRunResult[],
  deps: LighthousePhaseDeps,
): Promise<LighthousePhaseResult> {
  const candidates = results.filter(shouldMeasure);
  const outcomes = new Map<string, LighthouseOutcome[]>();
  let measured = 0;
  let failed = 0;
  let skipped = results.length - candidates.length;

  deps.log.info('fase de lighthouse', {
    candidatos: candidates.length,
    omitidos_por_estado: skipped,
    concurrencia: deps.concurrency,
  });

  // Con concurrencia 1 (el default) esto es estrictamente secuencial, que es el
  // punto. El semáforo está para poder subirlo si algún día hay más máquina.
  const limit = pLimit(deps.concurrency);

  await Promise.all(
    candidates.map((result) =>
      limit(async () => {
        const site = sites.get(result.siteId);
        if (site === undefined || result.homeUrl === null) return;

        if (deps.deadline.expired) {
          skipped += 1;
          deps.log.warn('lighthouse omitido: presupuesto agotado', { site_id: result.siteId });
          return;
        }

        const log = deps.log.child({ site_id: result.siteId });
        const port = cdpPortForSlot(0);
        const browser = await launchBrowser(port).catch((err: unknown) => {
          log.error('no se pudo abrir Chromium para lighthouse', err);
          return null;
        });
        if (browser === null) {
          failed += 2;
          return;
        }

        const siteOutcomes: LighthouseOutcome[] = [];
        await cleanStaleTmpDirs(deps.pdfDir, result.siteId);
        const paths = sitePdfPaths(deps.pdfDir, result.siteId, deps.runId ?? 'dry-run');

        try {
          for (const strategy of ['desktop', 'mobile'] as const) {
            const outcome = await runLighthouse(result.homeUrl, port, strategy, deps.timeoutMs);
            siteOutcomes.push(outcome);

            if (!deps.dryRun && result.siteRunId !== null) {
              await insertLighthouseResult(result.siteRunId, result.siteId, outcome);
            }

            // El PDF es nuestro informe, no el reporte de Lighthouse: se arma
            // desde su JSON más lo que midió el propio sistema (disponibilidad
            // por página, certificado, comparación con ayer). Si falla, el
            // documento del día anterior queda intacto.
            if (outcome.ok && outcome.lhr !== null) {
              const previous = result.siteRunId === null
                ? null
                : await fetchPreviousForReport(result.siteId, strategy, result.siteRunId);

              const html = await renderReportHtml(buildReportData({
                consultant: deps.consultant,
                site: { name: site.name, url: site.url },
                strategy,
                runId: deps.runId ?? 0,
                runAt: new Date(),
                lhr: outcome.lhr,
                pages: result.pages.map((p) => ({
                  path: pathOfUrl(p.url),
                  isHome: p.isHome,
                  httpStatus: p.httpStatus,
                  ttfbMs: p.ttfbMs,
                  loadMs: p.loadMs,
                  transferBytes: p.transferBytes,
                  requestCount: p.requestCount,
                  ok: p.ok,
                })),
                pagesDiscovered: result.pagesDiscovered,
                cert: result.cert === null ? null : {
                  issuer: result.cert.issuer,
                  validTo: result.cert.validTo,
                  daysRemaining: result.cert.daysRemaining,
                  valid: result.cert.valid,
                },
                previous,
              }));

              const meta = await writeReportPdf({
                paths,
                strategy,
                html,
                browser,
                quality: deps.pdfQuality,
                compressTimeoutMs: deps.pdfCompressTimeoutMs,
                renderTimeoutMs: deps.pdfRenderTimeoutMs,
                dryRun: deps.dryRun,
                log,
              });
              if (!deps.dryRun && result.siteRunId !== null) {
                await recordPdfMeta(result.siteRunId, strategy, meta);
              }
            }

            if (outcome.ok) {
              measured += 1;
              log.info('lighthouse', {
                estrategia: strategy,
                performance: outcome.scores.performance,
                accesibilidad: outcome.scores.accessibility,
                best_practices: outcome.scores.bestPractices,
                seo: outcome.scores.seo,
                lcp_ms: outcome.metrics.lcpMs,
                cls: outcome.metrics.cls,
                tbt_ms: outcome.metrics.tbtMs,
              });
            } else {
              failed += 1;
              // Que Lighthouse falle no cambia el estado del sitio: las métricas
              // de disponibilidad ya están tomadas y son las que dicen si vive.
              log.warn('lighthouse falló', { estrategia: strategy, motivo: outcome.error });
            }
          }
        } finally {
          await browser.close().catch(() => {});
        }

        outcomes.set(result.siteId, siteOutcomes);
      }),
    ),
  );

  deps.log.info('fase de lighthouse terminada', { medidos: measured, fallidos: failed, omitidos: skipped });
  return { measured, skipped, failed, outcomes };
}
