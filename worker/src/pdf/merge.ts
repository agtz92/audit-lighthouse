/**
 * Concatenación del full.pdf: índice + todas las páginas, en un solo documento.
 */

import { PDFDocument } from 'pdf-lib';
import { buildIndexPdf, countIndexPages, type IndexEntry, type IndexMeta } from './index-page.js';

export interface PdfPart {
  url: string;
  bytes: Uint8Array;
}

export interface MergedPdf {
  bytes: Uint8Array;
  totalPages: number;
  /** URL -> página donde empieza, con el índice ya contado. */
  entries: IndexEntry[];
}

/** Une varios PDFs en uno. Devuelve el resultado y cuántas páginas aportó cada uno. */
export async function mergePdfs(parts: Uint8Array[]): Promise<{ bytes: Uint8Array; pageCounts: number[] }> {
  const out = await PDFDocument.create();
  const pageCounts: number[] = [];

  for (const part of parts) {
    const src = await PDFDocument.load(part, { ignoreEncryption: true });
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
    pageCounts.push(pages.length);
  }

  return { bytes: await out.save(), pageCounts };
}

/**
 * Construye el full.pdf completo.
 *
 * El orden importa: primero se cuenta cuántas hojas ocupará el índice (depende
 * solo del número de entradas), luego se miden las páginas del cuerpo, y con
 * ambos datos los números del índice salen exactos a la primera.
 */
export async function buildFullPdf(parts: PdfPart[], meta: IndexMeta): Promise<MergedPdf> {
  const indexPages = countIndexPages(parts.length);

  // Primera pasada: solo contar hojas, para saber dónde empieza cada documento.
  //
  // Se carga uno a la vez y se suelta la referencia en lugar de guardarlos todos:
  // pdf-lib mantiene cada documento entero en memoria, y con 50 páginas pesadas
  // eso son cientos de megabytes de pico. Con el contenedor cerca de su límite,
  // esa presión hacía que el recolector de basura se comiera el tiempo de la
  // corrida. Cuesta parsear cada PDF dos veces, que es barato al lado de unirlos.
  const entries: IndexEntry[] = [];
  let offset = 0;
  for (const part of parts) {
    const doc = await PDFDocument.load(part.bytes, { ignoreEncryption: true });
    entries.push({ url: part.url, page: indexPages + offset + 1 });
    offset += doc.getPageCount();
  }

  const indexPdf = await buildIndexPdf(entries, meta);

  const out = await PDFDocument.create();
  out.setTitle(`${meta.siteName} — captura completa`);
  out.setCreator('site-monitor');
  out.setCreationDate(meta.generatedAt);

  const indexDoc = await PDFDocument.load(indexPdf);
  if (indexDoc.getPageCount() !== indexPages) {
    // Si esto se dispara, layoutIndex y buildIndexPdf dejaron de estar de acuerdo
    // y todos los números del índice estarían corridos. Mejor fallar que mentir.
    throw new Error(
      `el índice ocupó ${indexDoc.getPageCount()} hojas pero se reservaron ${indexPages}: los números del índice serían incorrectos`,
    );
  }
  for (const page of await out.copyPages(indexDoc, indexDoc.getPageIndices())) out.addPage(page);

  // Segunda pasada: copiar. Un documento fuente vivo a la vez.
  for (const part of parts) {
    const doc = await PDFDocument.load(part.bytes, { ignoreEncryption: true });
    for (const page of await out.copyPages(doc, doc.getPageIndices())) out.addPage(page);
  }

  return { bytes: await out.save(), totalPages: out.getPageCount(), entries };
}
