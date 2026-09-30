/**
 * Cosecha de links desde el DOM ya renderizado.
 *
 * Existe para los sitios que pintan su navegación con JavaScript: compatips.com
 * sirve 3 anchors en su HTML crudo y el resto aparece después de hidratar, así
 * que el crawl por HTTP plano solo encontraba 2 páginas de un sitio entero.
 *
 * Es un complemento, no un reemplazo: solo se usa cuando el descubrimiento
 * barato ya se quedó corto, porque cada página aquí cuesta una carga completa de
 * navegador. El tope de cargas está para que un sitio grande no se coma la
 * ventana de la corrida descubriendo en lugar de midiendo.
 */

import type { BrowserContext } from 'playwright';
import type { ResolvedSite } from '../config/sites.js';
import { normalizeUrl, sameSite, looksLikePage, canonicalKey } from '../lib/url.js';

/** Tope de espera a que la red se calme antes de leer los links. */
const NETWORK_SETTLE_MS = 8000;

export interface RenderedHarvestOptions {
  /** Cuántas páginas se cargan en el navegador para buscar links. */
  maxFetches?: number;
  /**
   * Cuántas URLs se juntan. Por default maxPages del sitio; el descubrimiento
   * pide más para poder ofrecerlas a elegir. Leer los anchors de una página que
   * ya se cargó no cuesta nada extra, así que este tope es independiente del de
   * cargas, que es el caro.
   */
  collect?: number;
  signal?: AbortSignal;
}

export interface RenderedHarvest {
  urls: string[];
  fetches: number;
}

export async function harvestRenderedLinks(
  context: BrowserContext,
  site: ResolvedSite,
  opts: RenderedHarvestOptions = {},
): Promise<RenderedHarvest> {
  const maxFetches = opts.maxFetches ?? 5;
  const collect = Math.max(opts.collect ?? site.maxPages, site.maxPages);
  const home = normalizeUrl(site.url) ?? site.url;

  const seen = new Set<string>([canonicalKey(home)]);
  const order: string[] = [home];
  const queue: string[] = [home];
  let fetches = 0;

  while (queue.length > 0 && fetches < maxFetches && order.length < collect) {
    const current = queue.shift();
    if (current === undefined) break;
    if (opts.signal?.aborted === true) break;

    const page = await context.newPage();
    try {
      await page.goto(current, { waitUntil: 'domcontentloaded', timeout: site.timeoutMs });
      // Los links que llegan por fetch aparecen bastante después del
      // domcontentloaded: compatips.com sirve 3 anchors al segundo y 23 a los
      // tres. Esperar a que la red se calme se adapta a cada sitio mejor que
      // cualquier número fijo; el catch cubre a los que nunca se callan.
      await page.waitForLoadState('networkidle', { timeout: NETWORK_SETTLE_MS }).catch(() => {});
      await page.waitForTimeout(400);
      fetches += 1;

      // element.href ya viene absoluto y resuelto por el navegador, incluyendo
      // <base href> y cualquier cosa que el router haya reescrito.
      const hrefs = await page.$$eval('a[href]', (anchors) =>
        anchors.map((a) => (a as HTMLAnchorElement).href),
      );

      for (const href of hrefs) {
        if (order.length >= collect) break;
        const url = normalizeUrl(href);
        if (url === null) continue;
        const key = canonicalKey(url);
        if (seen.has(key)) continue;
        if (!sameSite(url, home)) continue;
        if (!looksLikePage(url)) continue;
        if (site.exclude.some((p) => url.includes(p))) continue;
        seen.add(key);
        order.push(url);
        queue.push(url);
      }
    } catch {
      // Una página que no carga durante el descubrimiento no es un fallo del
      // sitio: el auditor la medirá y registrará el error real si le toca.
    } finally {
      await page.close().catch(() => {});
    }
  }

  return { urls: order, fetches };
}
