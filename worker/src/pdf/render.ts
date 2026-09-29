/**
 * Impresión de una página a PDF.
 *
 * Dos detalles que cambian por completo el resultado:
 *
 * 1. emulateMedia({ media: 'screen' }). page.pdf() usa CSS de impresión por
 *    default, y muchos sitios esconden o reordenan cosas en @media print. Sin
 *    esto el PDF no se parece al sitio, que es justo lo que se quiere archivar.
 * 2. Los márgenes explícitos. Chromium recorta el header y el footer si el margen
 *    no les deja espacio, así que el pie con la URL simplemente no aparecería.
 */

import type { Page } from 'playwright';

/** Márgenes A4 en pulgadas; el pie necesita ~0.5in abajo para caber. */
const MARGIN = { top: '0.4in', bottom: '0.55in', left: '0.4in', right: '0.4in' };

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Pie de página con la URL de origen y la numeración de Chromium.
 * El tamaño de fuente va inline: el default de Chromium es ilegible.
 */
function footerTemplate(url: string): string {
  return `
<div style="width:100%;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:7.5px;color:#555;
            padding:0 0.4in;display:flex;justify-content:space-between;gap:12px;">
  <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;">${escapeHtml(url)}</span>
  <span style="white-space:nowrap;"><span class="pageNumber"></span>/<span class="totalPages"></span></span>
</div>`;
}

/** Imprime la página actual a un buffer PDF en A4. */
export async function renderPagePdf(page: Page, sourceUrl: string): Promise<Uint8Array> {
  await page.emulateMedia({ media: 'screen' });
  return page.pdf({
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>', // vacío, pero requerido si se activa el footer
    footerTemplate: footerTemplate(sourceUrl),
    margin: MARGIN,
    // Sin esto, un sitio con @page { size: landscape } sobreescribe el A4.
    preferCSSPageSize: false,
  });
}
