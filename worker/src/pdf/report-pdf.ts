/**
 * Impresión de un informe a PDF.
 *
 * Nació para imprimir el reporte nativo de Lighthouse, que se arma con
 * JavaScript y esconde su detalle en <details> cerrados; de ahí que todavía
 * abra lo colapsable antes de imprimir. Hoy imprime las plantillas propias
 * (escritorio, móvil, tráfico e integral), que son HTML estático, y abrir
 * <details> sobre ellas no cambia nada.
 */

import type { Browser } from 'playwright';
import { withTimeout } from '../lib/timeout.js';

/** Abre todo lo colapsable y desactiva animaciones antes de imprimir. */
const PREPARE_FOR_PRINT = `
  for (const d of document.querySelectorAll('details')) d.open = true;
  // Los grupos de auditorías de Lighthouse usan esta clase para colapsar.
  for (const el of document.querySelectorAll('.lh-audit-group--diagnostics, .lh-clump')) {
    el.setAttribute('open', '');
  }
  const style = document.createElement('style');
  style.textContent = \`
    *, *::before, *::after { animation: none !important; transition: none !important; }
    .lh-topbar, .lh-sticky-header { display: none !important; }
  \`;
  document.head.appendChild(style);
  true;
`;

export interface RenderReportOptions {
  /** Tope para toda la operación: cargar, expandir e imprimir. */
  timeoutMs: number;
  /** Ancho del viewport al imprimir. Afecta cómo se acomoda el reporte. */
  width?: number;
  /** Texto de la izquierda del pie: sitio, estrategia y fecha. */
  footerLeft?: string;
}

/**
 * Pie que dibuja Chromium en el margen de cada página.
 *
 * La numeración la pone él, no la plantilla: un "Hoja 2 de 5" escrito a mano
 * miente en cuanto el contenido ocupa una hoja más, y el informe debe poder
 * crecer según lo que encuentre. El tamaño de fuente va inline porque el
 * default de Chromium para el pie es ilegible.
 */
function footerTemplate(left: string): string {
  const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="width:100%;font-family:Archivo,Helvetica,Arial,sans-serif;font-size:7pt;
      letter-spacing:.09em;color:#98a1ad;padding:0 15mm;display:flex;justify-content:space-between;">
    <span>${esc(left)}</span>
    <span>Hoja <span class="pageNumber"></span> de <span class="totalPages"></span></span>
  </div>`;
}

/**
 * Imprime el HTML de un reporte de Lighthouse a PDF.
 * Usa el navegador que ya está abierto; crea y cierra su propia página.
 */
export async function renderReportPdf(
  browser: Browser,
  html: string,
  opts: RenderReportOptions,
): Promise<Uint8Array> {
  const context = await browser.newContext({
    viewport: { width: opts.width ?? 1280, height: 1000 },
  });
  const page = await context.newPage();

  try {
    return await withTimeout(
      (async (): Promise<Uint8Array> => {
        // El HTML no pide recursos externos: todo viene embebido, así que
        // 'load' basta y no hay que esperar a la red.
        await page.setContent(html, { waitUntil: 'load' });
        // Los informes son HTML estático con las fuentes embebidas: lo único
        // que hay que esperar es que las fuentes estén listas. Aquí antes se
        // esperaba a que aparecieran los nodos del reporte nativo de
        // Lighthouse, que nuestra plantilla no tiene, así que cada documento
        // se quedaba 15 s parado hasta que vencía la espera.
        await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => true);
        await page.evaluate(PREPARE_FOR_PRINT);
        await page.emulateMedia({ media: 'screen' });
        return await page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<div></div>',
          footerTemplate: footerTemplate(opts.footerLeft ?? ''),
          // El pie vive en el margen inferior: sin espacio reservado, Chromium
          // lo recorta y simplemente no aparece.
          margin: { top: '0mm', bottom: '12mm', left: '0mm', right: '0mm' },
          preferCSSPageSize: false,
        });
      })(),
      opts.timeoutMs,
      'impresión del reporte de Lighthouse',
    );
  } finally {
    await context.close().catch(() => {});
  }
}
