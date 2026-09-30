/**
 * Compresión de PDFs con Ghostscript.
 *
 * Chromium imprime cada página con su propia copia de las fuentes y de las
 * imágenes, así que un full.pdf concatenado carga el mismo logo cincuenta veces.
 * Ghostscript reescribe el documento completo: deduplica esos recursos, submuestrea
 * las imágenes a la resolución elegida y recomprime los streams. En páginas web
 * típicas eso es una reducción de entre 5x y 20x.
 *
 * El texto NO se rasteriza: sigue siendo texto vectorial y seleccionable. Lo
 * único que pierde calidad son las imágenes, y solo hasta los DPI configurados.
 */

import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import type { Logger } from '../lib/logger.js';

/**
 * Perfiles de Ghostscript:
 *   screen  imágenes a 72 dpi  — el más pequeño, suficiente para leer en pantalla
 *   ebook   imágenes a 150 dpi — equilibrio; el default
 *   printer imágenes a 300 dpi — casi sin pérdida visible, reduce bastante menos
 *   none    sin compresión
 */
export const PDF_QUALITIES = ['none', 'screen', 'ebook', 'printer'] as const;
export type PdfQuality = (typeof PDF_QUALITIES)[number];

export interface CompressResult {
  bytes: Uint8Array;
  originalBytes: number;
  finalBytes: number;
  /** Cuántas veces más chico quedó. 1 = no se comprimió. */
  ratio: number;
  applied: boolean;
  reason: string | null;
}

function runGhostscript(input: string, output: string, quality: PdfQuality, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const gs = spawn(
      'gs',
      [
        '-sDEVICE=pdfwrite',
        '-dCompatibilityLevel=1.7',
        `-dPDFSETTINGS=/${quality}`,
        '-dNOPAUSE',
        '-dQUIET',
        '-dBATCH',
        // Sin esto Ghostscript puede pedir interacción ante un PDF raro y colgarse.
        '-dSAFER',
        // Conserva el texto como texto en lugar de convertirlo a curvas.
        '-dSubsetFonts=true',
        '-dCompressFonts=true',
        '-dDetectDuplicateImages=true',
        `-sOutputFile=${output}`,
        input,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    let stderr = '';
    gs.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      gs.kill('SIGKILL');
      reject(new Error(`Ghostscript excedió ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref();

    gs.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    gs.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Ghostscript salió con código ${code}: ${stderr.trim().slice(0, 300)}`));
    });
  });
}

/**
 * Tope de tiempo de Ghostscript, proporcional al tamaño del documento.
 *
 * Un número fijo no sirve: con 180 s fijos, dos documentos de esta corrida
 * (275 y 196 hojas) se pasaron del tope y se guardaron sin comprimir, uno de
 * ellos en 100 MB. Comprimir es lineal en el tamaño, así que el tope también.
 */
export function compressTimeoutFor(bytes: number, baseMs: number): number {
  const porMegabyte = 6000;
  const megas = bytes / 1_000_000;
  return Math.min(900_000, Math.max(baseMs, Math.round(baseMs + megas * porMegabyte)));
}

export interface CompressOptions {
  quality: PdfQuality;
  /** Directorio de trabajo; debe existir. */
  tmpDir: string;
  /** Nombre base para los temporales, único dentro del directorio. */
  name: string;
  /** Páginas que debe tener el resultado. Si no coinciden, se descarta. */
  expectedPages: number;
  timeoutMs?: number;
  log: Logger;
}

/**
 * Comprime un PDF. Ante cualquier duda devuelve el original: es preferible un
 * archivo grande a uno corrupto, porque este es el archivo que el usuario
 * descarga y nadie revisa hasta que lo necesita.
 */
export async function compressPdf(bytes: Uint8Array, opts: CompressOptions): Promise<CompressResult> {
  const originalBytes = bytes.byteLength;
  const untouched: CompressResult = {
    bytes, originalBytes, finalBytes: originalBytes, ratio: 1, applied: false, reason: null,
  };

  if (opts.quality === 'none') return { ...untouched, reason: 'compresión desactivada' };

  const input = join(opts.tmpDir, `${opts.name}.gs-in.pdf`);
  const output = join(opts.tmpDir, `${opts.name}.gs-out.pdf`);

  try {
    const timeoutMs = compressTimeoutFor(originalBytes, opts.timeoutMs ?? 60_000);
    await writeFile(input, bytes);
    await runGhostscript(input, output, opts.quality, timeoutMs);
    const compressed = await readFile(output);

    // Guardas: el resultado tiene que ser un PDF legible, con las mismas páginas
    // y de verdad más chico. Ghostscript a veces agranda documentos ya optimizados.
    const pages = (await PDFDocument.load(compressed, { ignoreEncryption: true })).getPageCount();
    if (pages !== opts.expectedPages) {
      opts.log.warn('compresión descartada: cambió el número de páginas', {
        esperadas: opts.expectedPages, obtenidas: pages,
      });
      return { ...untouched, reason: 'el número de páginas no coincide' };
    }
    if (compressed.byteLength >= originalBytes) {
      return { ...untouched, reason: 'el resultado no era más chico' };
    }

    return {
      bytes: new Uint8Array(compressed),
      originalBytes,
      finalBytes: compressed.byteLength,
      ratio: originalBytes / compressed.byteLength,
      applied: true,
      reason: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    opts.log.warn('no se pudo comprimir el PDF, se guarda sin comprimir', { motivo: reason });
    return { ...untouched, reason };
  } finally {
    await rm(input, { force: true }).catch(() => {});
    await rm(output, { force: true }).catch(() => {});
  }
}
