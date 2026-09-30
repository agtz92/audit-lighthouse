/**
 * Impresión del reporte de Lighthouse a PDF.
 *
 * El reporte que genera Lighthouse es un HTML autocontenido que se arma a sí
 * mismo con JavaScript: trae el JSON embebido y construye el DOM al cargar. Por
 * eso no basta con imprimirlo, hay que dejarlo ejecutarse primero.
 *
 * Y hay que abrir sus secciones colapsadas. El reporte esconde el detalle de
 * cada auditoría dentro de <details> cerrados, así que un PDF hecho tal cual
 * saldría con los cuatro scores y casi nada más: justo el detalle por el que uno
 * guarda el reporte se perdería.
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
        // Un momento para que el script del reporte termine de construir el DOM.
        await page.waitForFunction(
          () => document.querySelectorAll('.lh-audit, .lh-metric').length > 0,
          undefined,
          { timeout: 15_000 },
        ).catch(() => {
          // Si el selector cambia en una versión futura de Lighthouse, se
          // imprime de todos modos en lugar de quedarse sin PDF.
        });
        await page.evaluate(PREPARE_FOR_PRINT);
        await page.emulateMedia({ media: 'screen' });
        return await page.pdf({
          format: 'A4',
          printBackground: true,
          margin: { top: '0.4in', bottom: '0.4in', left: '0.3in', right: '0.3in' },
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
