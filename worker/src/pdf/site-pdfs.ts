/**
 * Los dos PDFs de un sitio: home.pdf y full.pdf.
 *
 * Cada página se imprime a un archivo temporal dentro del mismo volumen, no a
 * memoria: 50 páginas de Chromium pueden ser 150 MB, y con dos sitios en paralelo
 * dentro de un contenedor de 2 GB eso se nota. Al final se leen en orden, se unen
 * y se renombran sobre los definitivos.
 *
 * La garantía que importa: si algo falla, no se renombra nada y los PDFs del día
 * anterior siguen intactos. Nunca se deja al usuario sin PDF por un error de red.
 */

import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { renderPagePdf } from './render.js';
import { writeFileAtomic } from './atomic.js';
import { buildFullPdf, type PdfPart } from './merge.js';
import { compressPdf, type PdfQuality } from './compress.js';
import type { IndexMeta } from './index-page.js';
import type { PdfMeta } from '../db/runs.js';
import type { Logger } from '../lib/logger.js';

export interface SitePdfPaths {
  dir: string;
  home: string;
  full: string;
  tmpDir: string;
}

export function sitePdfPaths(pdfDir: string, siteId: string, runId: number | string): SitePdfPaths {
  const dir = join(pdfDir, siteId);
  return {
    dir,
    home: join(dir, 'home.pdf'),
    full: join(dir, 'full.pdf'),
    // El temporal vive junto al destino para que rename(2) sea atómico: cruzar
    // sistemas de archivos lo convertiría en copiar y borrar.
    tmpDir: join(dir, `.tmp-${runId}`),
  };
}

/** Nombre del temporal de una página. El índice va con ceros para ordenar bien. */
function pagePdfName(index: number): string {
  return `${String(index).padStart(4, '0')}.pdf`;
}

export interface SitePdfCollectorOptions {
  paths: SitePdfPaths;
  /** En dry-run se imprime igual (para medir el costo) pero no se escribe nada. */
  dryRun: boolean;
  log: Logger;
  /** Perfil de compresión aplicado a los dos archivos finales. */
  quality: PdfQuality;
  compressTimeoutMs: number;
  /** Tope para imprimir UNA página. page.pdf() no trae timeout propio. */
  renderTimeoutMs: number;
}

/**
 * Acumula los PDFs de las páginas de un sitio y al final produce los dos archivos.
 */
export class SitePdfCollector {
  /** url -> nombre del archivo temporal. */
  readonly #captured = new Map<string, string>();
  #ready = false;

  constructor(private readonly opts: SitePdfCollectorOptions) {}

  async init(): Promise<void> {
    if (this.opts.dryRun) {
      this.#ready = true;
      return;
    }
    // Un .tmp de una corrida anterior interrumpida no debe contaminar esta.
    await rm(this.opts.paths.tmpDir, { recursive: true, force: true }).catch(() => {});
    await mkdir(this.opts.paths.tmpDir, { recursive: true });
    this.#ready = true;
  }

  /**
   * Imprime la página actual. Se llama desde el hook `capture` del auditor, con
   * la página ya cargada y medida, para no visitarla dos veces.
   */
  async capture(page: Page, url: string, index: number): Promise<void> {
    if (!this.#ready) throw new Error('SitePdfCollector.init() no se llamó');
    try {
      const bytes = await renderPagePdf(page, url, this.opts.renderTimeoutMs);
      if (this.opts.dryRun) {
        this.#captured.set(url, `(dry-run ${bytes.byteLength} bytes)`);
        return;
      }
      await writeFileAtomic(join(this.opts.paths.tmpDir, pagePdfName(index)), bytes);
      this.#captured.set(url, pagePdfName(index));
    } catch (err) {
      // Una página que no se deja imprimir (un PDF incrustado, un canvas enorme)
      // se queda fuera del full.pdf, pero su medición ya se tomó y vale.
      this.opts.log.warn('no se pudo imprimir la página a PDF', {
        url,
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  get capturedCount(): number {
    return this.#captured.size;
  }

  /**
   * Une lo capturado y reemplaza los dos archivos definitivos.
   * `orderedUrls` fija el orden del documento: el del sitemap, no el de término.
   */
  async finalize(
    orderedUrls: string[],
    homeUrl: string | undefined,
    meta: IndexMeta,
  ): Promise<{ home: PdfMeta | null; full: (PdfMeta & { urls: number }) | null }> {
    if (this.opts.dryRun) {
      this.opts.log.info('dry-run: PDFs no escritos', { paginas_capturadas: this.#captured.size });
      return { home: null, full: null };
    }

    const generatedAt = new Date();
    let home: PdfMeta | null = null;
    let full: (PdfMeta & { urls: number }) | null = null;

    try {
      // ── home.pdf: solo la URL principal ────────────────────────────────────
      const homeName = homeUrl === undefined ? undefined : this.#captured.get(homeUrl);
      if (homeName !== undefined) {
        const raw = await readFile(join(this.opts.paths.tmpDir, homeName));
        const pages = (await PDFDocument.load(raw, { ignoreEncryption: true })).getPageCount();
        const squeezed = await this.#compress(raw, 'home', pages);
        const written = await writeFileAtomic(this.opts.paths.home, squeezed);
        home = { bytes: written, pages, generatedAt };
      } else {
        this.opts.log.warn('home.pdf no se reemplaza: la URL principal no se pudo imprimir');
      }

      // ── full.pdf: índice + todas las páginas, en orden de descubrimiento ───
      const parts: PdfPart[] = [];
      for (const url of orderedUrls) {
        const name = this.#captured.get(url);
        if (name === undefined) continue; // no cargó: no hay nada que imprimir
        parts.push({ url, bytes: await readFile(join(this.opts.paths.tmpDir, name)) });
      }

      if (parts.length > 0) {
        const merged = await buildFullPdf(parts, meta);
        const squeezed = await this.#compress(merged.bytes, 'full', merged.totalPages);
        const written = await writeFileAtomic(this.opts.paths.full, squeezed);
        full = { bytes: written, pages: merged.totalPages, generatedAt, urls: parts.length };
      } else {
        this.opts.log.warn('full.pdf no se reemplaza: ninguna página se pudo imprimir');
      }

      return { home, full };
    } finally {
      await this.cleanup();
    }
  }

  /** Comprime y reporta cuánto se ganó; ante cualquier duda devuelve el original. */
  async #compress(bytes: Uint8Array, name: string, expectedPages: number): Promise<Uint8Array> {
    const result = await compressPdf(bytes, {
      quality: this.opts.quality,
      tmpDir: this.opts.paths.tmpDir,
      name,
      expectedPages,
      timeoutMs: this.opts.compressTimeoutMs,
      log: this.opts.log,
    });
    // Se registra SIEMPRE, se haya aplicado o no: un descarte silencioso hacía
    // que un full.pdf de 100 MB simplemente no apareciera en el resumen.
    if (result.applied) {
      this.opts.log.info('PDF comprimido', {
        archivo: name,
        antes_bytes: result.originalBytes,
        despues_bytes: result.finalBytes,
        reduccion: `${result.ratio.toFixed(1)}x`,
        perfil: this.opts.quality,
      });
    } else {
      this.opts.log.warn('PDF guardado SIN comprimir', {
        archivo: name,
        bytes: result.originalBytes,
        motivo: result.reason ?? 'desconocido',
      });
    }
    return result.bytes;
  }

  async cleanup(): Promise<void> {
    if (this.opts.dryRun) return;
    await rm(this.opts.paths.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Limpia directorios .tmp-* olvidados por corridas que murieron a la mitad. */
export async function cleanStaleTmpDirs(pdfDir: string, siteId: string): Promise<number> {
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
