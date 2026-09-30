/**
 * Los dos PDFs de un sitio: desktop.pdf y mobile.pdf, cada uno con el reporte
 * de Lighthouse de esa estrategia.
 *
 * La garantía que importa se mantiene: se escribe a un .tmp y se renombra solo
 * al terminar bien, así que si una corrida falla los PDFs del día anterior
 * quedan intactos. Nunca se deja al usuario sin PDF por un error.
 */

import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { renderReportPdf } from './report-pdf.js';
import { writeFileAtomic } from './atomic.js';
import { compressPdf, type PdfQuality } from './compress.js';
import type { LighthouseStrategy } from '../audit/lighthouse.js';
import type { PdfMeta } from '../db/runs.js';
import type { Logger } from '../lib/logger.js';

export interface SitePdfPaths {
  dir: string;
  desktop: string;
  mobile: string;
  tmpDir: string;
}

export function sitePdfPaths(pdfDir: string, siteId: string, runId: number | string): SitePdfPaths {
  const dir = join(pdfDir, siteId);
  return {
    dir,
    desktop: join(dir, 'desktop.pdf'),
    mobile: join(dir, 'mobile.pdf'),
    // El temporal vive junto al destino para que rename(2) sea atómico: cruzar
    // sistemas de archivos lo convertiría en copiar y borrar.
    tmpDir: join(dir, `.tmp-${runId}`),
  };
}

export interface WriteReportOptions {
  paths: SitePdfPaths;
  strategy: LighthouseStrategy;
  html: string;
  browser: Browser;
  quality: PdfQuality;
  compressTimeoutMs: number;
  renderTimeoutMs: number;
  dryRun: boolean;
  log: Logger;
}

/**
 * Imprime, comprime y reemplaza el PDF de una estrategia.
 * Devuelve null si algo falló: el archivo anterior se queda como estaba.
 */
export async function writeReportPdf(opts: WriteReportOptions): Promise<PdfMeta | null> {
  const { paths, strategy, log } = opts;
  const target = strategy === 'desktop' ? paths.desktop : paths.mobile;

  try {
    const raw = await renderReportPdf(opts.browser, opts.html, { timeoutMs: opts.renderTimeoutMs });
    const pages = (await PDFDocument.load(raw, { ignoreEncryption: true })).getPageCount();

    if (opts.dryRun) {
      log.info('dry-run: PDF no escrito', { archivo: strategy, bytes: raw.byteLength, paginas: pages });
      return null;
    }

    await mkdir(paths.tmpDir, { recursive: true });
    const result = await compressPdf(raw, {
      quality: opts.quality,
      tmpDir: paths.tmpDir,
      name: strategy,
      expectedPages: pages,
      timeoutMs: opts.compressTimeoutMs,
      log,
    });

    // Se registra siempre, se haya comprimido o no: un descarte silencioso
    // escondía archivos enormes del resumen.
    if (result.applied) {
      log.info('PDF comprimido', {
        archivo: strategy,
        antes_bytes: result.originalBytes,
        despues_bytes: result.finalBytes,
        reduccion: `${result.ratio.toFixed(1)}x`,
        perfil: opts.quality,
      });
    } else {
      log.warn('PDF guardado SIN comprimir', {
        archivo: strategy,
        bytes: result.originalBytes,
        motivo: result.reason ?? 'desconocido',
      });
    }

    const bytes = await writeFileAtomic(target, result.bytes);
    log.info('PDF actualizado', { archivo: strategy, bytes, paginas: pages });
    return { bytes, pages, generatedAt: new Date() };
  } catch (err) {
    // Que no se pueda imprimir el reporte no invalida las métricas: ya están
    // guardadas. Y el PDF de ayer sigue en su lugar, que es lo que importa.
    log.warn('no se pudo generar el PDF del reporte', {
      archivo: strategy,
      motivo: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await rm(paths.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Limpia directorios .tmp-* olvidados por corridas que murieron a la mitad. */
export async function cleanStaleTmpDirs(pdfDir: string, siteId: string): Promise<number> {
  const { readdir } = await import('node:fs/promises');
  const dir = join(pdfDir, siteId);
  let removed = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.tmp-')) {
        await rm(join(dir, entry.name), { recursive: true, force: true }).catch(() => {});
        removed += 1;
      }
    }
  } catch {
    // El directorio del sitio aún no existe: nada que limpiar.
  }
  return removed;
}
