/**
 * Página de índice del full.pdf.
 *
 * El problema de orden: los números de página del índice dependen de cuántas
 * páginas ocupa cada PDF individual Y de cuántas ocupa el índice mismo. Se
 * resuelve en dos tiempos: la paginación del índice depende solo de cuántas
 * entradas hay (no de los números), así que primero se dispone el layout para
 * saber cuántas hojas ocupa, y con ese dato ya se pueden escribir los números
 * definitivos. Nada de estimaciones ni de iterar hasta que converja.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 42;
const LINE_HEIGHT = 13.2;
const FONT_SIZE = 8.5;
const TITLE_BLOCK_HEIGHT = 92;
const PAGE_NUM_COLUMN = 38;

export interface IndexEntry {
  url: string;
  /** Página del PDF final donde empieza, 1-based. */
  page: number;
}

export interface IndexMeta {
  siteName: string;
  siteUrl: string;
  generatedAt: Date;
  /** URLs descubiertas en total, antes del recorte por maxPages. */
  discovered: number;
  truncated: boolean;
  maxPages: number;
  /** Páginas que no se pudieron renderizar (error de carga). */
  failed: number;
}

/**
 * Helvetica de pdf-lib codifica WinAnsi: un carácter fuera de Latin-1 la hace
 * fallar. Las URLs con acentos sin escapar o en IDN existen, y no vale la pena
 * tumbar el PDF completo por un carácter.
 */
function toWinAnsi(text: string): string {
  return text.replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/** Recorta con elipsis para que el texto quepa en `maxWidth`. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  const ellipsis = '...';
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + ellipsis, size) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + ellipsis;
}

/**
 * Reparte las entradas en hojas. Solo depende de cuántas son, no de sus números,
 * y por eso se puede llamar antes de conocer los números definitivos.
 */
export function layoutIndex(entryCount: number): number[] {
  const firstPageRows = Math.floor((A4.height - MARGIN * 2 - TITLE_BLOCK_HEIGHT) / LINE_HEIGHT);
  const otherPageRows = Math.floor((A4.height - MARGIN * 2 - 24) / LINE_HEIGHT);

  const pages: number[] = [];
  let remaining = entryCount;
  pages.push(Math.min(remaining, firstPageRows));
  remaining -= pages[0] as number;
  while (remaining > 0) {
    const take = Math.min(remaining, otherPageRows);
    pages.push(take);
    remaining -= take;
  }
  return pages;
}

/** Cuántas hojas ocupará el índice para ese número de entradas. */
export function countIndexPages(entryCount: number): number {
  return layoutIndex(entryCount).length;
}

/** Construye el PDF del índice con los números de página ya definitivos. */
export async function buildIndexPdf(entries: IndexEntry[], meta: IndexMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Índice — ${meta.siteName}`);
  doc.setCreator('site-monitor');

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.45, 0.45, 0.5);
  const rule = rgb(0.85, 0.85, 0.87);

  const distribution = layoutIndex(entries.length);
  let cursor = 0;

  for (const [pageIndex, rows] of distribution.entries()) {
    const page = doc.addPage([A4.width, A4.height]);
    let y = A4.height - MARGIN;

    if (pageIndex === 0) {
      page.drawText(toWinAnsi(meta.siteName), { x: MARGIN, y: y - 16, size: 17, font: bold, color: ink });
      y -= 34;
      page.drawText(toWinAnsi(meta.siteUrl), { x: MARGIN, y: y - 10, size: 9.5, font: regular, color: muted });
      y -= 22;

      const fecha = meta.generatedAt.toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City',
        dateStyle: 'long',
        timeStyle: 'short',
      });
      const incluidas = entries.length;
      const resumen =
        `Generado el ${fecha} · ${incluidas} ${incluidas === 1 ? 'página' : 'páginas'} incluidas` +
        (meta.failed > 0 ? ` · ${meta.failed} no se pudieron cargar` : '');
      page.drawText(toWinAnsi(resumen), { x: MARGIN, y: y - 9, size: 8.5, font: regular, color: muted });
      y -= 16;

      if (meta.truncated) {
        // Este aviso es obligatorio: sin él, un full.pdf de 50 páginas de un sitio
        // de 1257 parecería el sitio completo.
        const aviso =
          `Documento truncado: el sitio declara ${meta.discovered} URLs y el límite ` +
          `configurado es ${meta.maxPages} (maxPages en sites.yaml).`;
        page.drawText(toWinAnsi(aviso), { x: MARGIN, y: y - 9, size: 8.5, font: bold, color: rgb(0.7, 0.32, 0.05) });
        y -= 16;
      }

      y -= 6;
      page.drawLine({
        start: { x: MARGIN, y },
        end: { x: A4.width - MARGIN, y },
        thickness: 0.7,
        color: rule,
      });
      y -= 16;
    } else {
      page.drawText(toWinAnsi(`${meta.siteName} — índice (continuación)`), {
        x: MARGIN, y: y - 9, size: 8.5, font: regular, color: muted,
      });
      y -= 24;
    }

    const urlWidth = A4.width - MARGIN * 2 - PAGE_NUM_COLUMN - 8;

    for (let i = 0; i < rows; i += 1) {
      const entry = entries[cursor];
      cursor += 1;
      if (entry === undefined) break;

      // Se muestra la ruta, no la URL completa: el dominio ya está en el título
      // y así cabe mucho más de lo que importa.
      let label: string;
      try {
        const u = new URL(entry.url);
        label = u.pathname === '/' ? '/ (inicio)' : u.pathname + u.search;
      } catch {
        label = entry.url;
      }

      const text = fit(toWinAnsi(label), regular, FONT_SIZE, urlWidth);
      page.drawText(text, { x: MARGIN, y, size: FONT_SIZE, font: regular, color: ink });

      const num = String(entry.page);
      const numWidth = regular.widthOfTextAtSize(num, FONT_SIZE);
      page.drawText(num, {
        x: A4.width - MARGIN - numWidth,
        y,
        size: FONT_SIZE,
        font: regular,
        color: muted,
      });

      y -= LINE_HEIGHT;
    }
  }

  return doc.save();
}
