/**
 * Lanzamiento de Chromium.
 *
 * Un navegador por sitio, no uno global: aísla cookies y estado entre sitios y,
 * sobre todo, le da a Lighthouse un puerto CDP propio. El puerto se pasa
 * explícitamente porque Lighthouse se conecta por HTTP a /json/version, y el
 * wsEndpoint de Playwright es su propio protocolo, no CDP crudo.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import type { ResolvedSite } from '../config/sites.js';

/** Puerto CDP del slot `index` de concurrencia. Determinista, sin colisiones. */
export function cdpPortForSlot(index: number): number {
  return 9222 + index;
}

export async function launchBrowser(cdpPort: number): Promise<Browser> {
  return chromium.launch({
    // OBLIGATORIO para Lighthouse. Playwright 1.49+ usa por default el binario
    // chromium-headless-shell, una compilación recortada que NO emite Largest
    // Contentful Paint: Lighthouse devuelve NO_LCP y con eso se caen en silencio
    // el score de performance, TBT y TTI, mientras accessibility, best-practices
    // y seo siguen saliendo bien (no dependen del trace de rendimiento).
    // Medido en este proyecto: headless-shell da perf=null, el Chromium completo
    // da perf=0.96 y LCP=1327 ms sobre el mismo sitio.
    channel: 'chromium',
    args: [
      // Dentro de un contenedor sin SYS_ADMIN el sandbox de Chromium no arranca.
      '--no-sandbox',
      '--disable-setuid-sandbox',
      // El /dev/shm de Docker es de 64 MB por default; aunque le dimos 512 MB en
      // Compose, esta bandera evita que Chromium muera si se queda corto.
      '--disable-dev-shm-usage',
      '--disable-gpu',
      // Lo que Lighthouse necesita para conectarse a este mismo navegador.
      `--remote-debugging-port=${cdpPort}`,
    ],
  });
}

/** Contexto limpio para un sitio, con su viewport y user agent. */
export async function newSiteContext(browser: Browser, site: ResolvedSite, userAgent: string): Promise<BrowserContext> {
  return browser.newContext({
    viewport: site.viewport,
    userAgent,
    // NO ignoramos errores de TLS: un certificado malo debe reportarse como
    // fallo del sitio, no esconderse.
    ignoreHTTPSErrors: false,
  });
}
