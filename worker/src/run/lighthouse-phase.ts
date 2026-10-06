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
 * Así que primero se audita todo (fase ruidosa, concurrencia 2), y solo cuando
 * eso terminó se mide rendimiento, de uno en uno. Cuesta un lanzamiento extra de
 * Chromium por sitio —unos 40 s en total para 20 sitios— y compra números
 * comparables.
 *
 * Los PDFs se imprimen en un navegador APARTE, no en el que usa Lighthouse.
 * Lighthouse vigila las pestañas del navegador al que se conecta; abrir una para
 * imprimir y cerrarla lo hace intentar adjuntarse a una sesión que ya no existe,
 * y lanza desde un callback que nadie espera. Eso mató una corrida completa con
 * "Protocol error (Target.getTargetInfo): Session with given id not found"
 * después de haber auditado los 20 sitios.
 */

import pLimit from 'p-limit';
import type { ResolvedSite } from '../config/sites.js';
import type { Logger } from '../lib/logger.js';
import type { Deadline } from '../lib/deadline.js';
import { launchBrowser, cdpPortForSlot } from '../audit/browser.js';
import { runLighthouse, isComplete } from '../audit/lighthouse.js';
import { insertLighthouseResult } from '../db/lighthouse.js';
import { recordPdfMeta } from '../db/runs.js';
import { fetchPreviousForReport } from '../db/snapshots.js';
import { buildReportData } from '../report/build.js';
import { renderReportHtml, footerLeftText } from '../report/template.js';
import { pathOfUrl } from '../lib/url.js';
import { sitePdfPaths, writeReportPdf, cleanStaleTmpDirs } from '../pdf/site-pdfs.js';
import type { PdfQuality } from '../pdf/compress.js';
import type { SiteRunResult } from './site-runner.js';

/**
 * Intentos por estrategia. Una medición incompleta se reintenta con un navegador
 * nuevo: la causa más común es que Chromium quedó en mal estado, y relanzarlo
 * cuesta segundo y medio. Un informe sin rendimiento no es aceptable mientras el
 * sitio responda.
 */
const MAX_INTENTOS = 3;

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

/**
 * Solo cuentas, a propósito.
 *
 * Esto devolvía además un Map con los `LighthouseOutcome` completos de todos los
 * sitios, y cada uno carga el LHR entero —el reporte de Lighthouse sin recortar,
 * varios MB en el heap—. Con veinte sitios por dos estrategias eran cuarenta
 * reportes vivos hasta el final de la fase, y nadie los leía: el orquestador
 * llama a esta función sin guardar lo que devuelve. Eso tumbó la corrida de las
 * 06:00 cuatro días seguidos con "Reached heap limit".
 *
 * Lo que un llamador podría querer ya está en la base: `lighthouse_results`
 * guarda scores, métricas y el reporte comprimido.
 */
export interface LighthousePhaseResult {
  measured: number;
  skipped: number;
  failed: number;
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

  // Navegador dedicado a imprimir, separado del que mide. Uno solo para toda la
  // fase: abrirlo cuesta un segundo y evita interferir con Lighthouse.
  const printer = candidates.length === 0 ? null : await launchBrowser(cdpPortForSlot(1)).catch((err: unknown) => {
    deps.log.error('no se pudo abrir el navegador de impresión; no habrá PDFs esta corrida', err);
    return null;
  });

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
        let browser = await launchBrowser(port).catch((err: unknown) => {
          log.error('no se pudo abrir Chromium para lighthouse', err);
          return null;
        });
        if (browser === null) {
          failed += 2;
          return;
        }

        await cleanStaleTmpDirs(deps.pdfDir, result.siteId);
        const paths = sitePdfPaths(deps.pdfDir, result.siteId, deps.runId ?? 'dry-run');
        /** Lo que hay que imprimir, una vez cerrado el navegador de Lighthouse. */
        const porImprimir: Array<{ strategy: 'desktop' | 'mobile'; html: string; footerLeft: string }> = [];

        try {
          for (const strategy of ['desktop', 'mobile'] as const) {
            let outcome = await runLighthouse(result.homeUrl, port, strategy, deps.timeoutMs);

            // Se reintenta mientras la medición venga incompleta. No basta con
            // que Lighthouse no haya lanzado: si la categoría de rendimiento
            // viene vacía, el informe saldría sin la mitad que importa.
            for (let intento = 2; intento <= MAX_INTENTOS && !isComplete(outcome); intento += 1) {
              log.warn('medición incompleta, reintentando con un navegador nuevo', {
                estrategia: strategy,
                intento,
                performance: outcome.scores.performance,
                lcp_ms: outcome.metrics.lcpMs,
                motivo: outcome.error ?? 'Lighthouse no produjo la categoría de rendimiento',
              });
              await browser.close().catch(() => {});
              const nuevo = await launchBrowser(port).catch(() => null);
              if (nuevo === null) break;
              browser = nuevo;
              outcome = await runLighthouse(result.homeUrl, port, strategy, deps.timeoutMs);
            }

            if (!isComplete(outcome) && outcome.ok) {
              // Se agotaron los intentos y el sitio sí responde: queda registrado
              // en la fila, no escondido en un log que nadie lee.
              outcome.error = `medición incompleta tras ${MAX_INTENTOS} intentos: Lighthouse no produjo la categoría de rendimiento`;
              log.error('no se logró una medición completa', {
                estrategia: strategy,
                intentos: MAX_INTENTOS,
              });
            }

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

              const datos = buildReportData({
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
              });
              const html = await renderReportHtml(datos);

              // Se guarda para imprimirlo DESPUÉS de cerrar este navegador.
              porImprimir.push({ strategy, html, footerLeft: footerLeftText(datos) });
            }

            // El LHR y su gzip ya cumplieron: la fila quedó escrita arriba y el
            // HTML del informe ya está armado —`buildReportData` copia lo que
            // necesita a objetos propios, no guarda referencias al reporte—. Se
            // sueltan aquí, dentro del ciclo, para que el recolector se los
            // pueda llevar mientras la fase sigue con el resto de los sitios.
            // Sin esto el heap crece sitio por sitio hasta topar el límite.
            outcome.lhr = null;
            outcome.rawGzip = null;

            if (isComplete(outcome)) {
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
              log.warn('lighthouse sin medición utilizable', { estrategia: strategy, motivo: outcome.error });
            }
          }
        } finally {
          await browser.close().catch(() => {});
        }

        // Con el navegador de Lighthouse ya cerrado, imprimir no puede
        // interferir con su vigilancia de pestañas.
        if (printer !== null) {
          for (const { strategy, html, footerLeft } of porImprimir) {
            const meta = await writeReportPdf({
              paths,
              strategy,
              html,
              footerLeft,
              browser: printer,
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
        }

      }),
    ),
  );

  await printer?.close().catch(() => {});

  deps.log.info('fase de lighthouse terminada', { medidos: measured, fallidos: failed, omitidos: skipped });
  return { measured, skipped, failed };
}
