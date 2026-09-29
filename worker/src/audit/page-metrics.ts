/**
 * Medición de disponibilidad y velocidad de una página.
 *
 * El peso transferido y el número de requests se leen por CDP (dominio Network)
 * y no de la Performance API del navegador: transferSize de la Performance API
 * miente con recursos cross-origin sin Timing-Allow-Origin, que en un sitio con
 * CDN y fuentes externas son la mayoría. encodedDataLength de CDP es lo que de
 * verdad viajó por el cable.
 */

import { errors as playwrightErrors, type BrowserContext, type Page, type Response } from 'playwright';
import type { ResolvedSite } from '../config/sites.js';

/** Coincide con el enum error_category de la base de datos. */
export type ErrorCategory =
  | 'timeout' | 'dns' | 'tls' | 'http_4xx' | 'http_5xx'
  | 'navigation' | 'render' | 'pdf' | 'lighthouse' | 'unknown';

export interface RedirectHop {
  url: string;
  status: number | null;
}

export interface PageMetrics {
  url: string;
  finalUrl: string | null;
  httpStatus: number | null;
  redirectChain: RedirectHop[];
  ttfbMs: number | null;
  loadMs: number | null;
  dclMs: number | null;
  transferBytes: number | null;
  requestCount: number | null;
  ok: boolean;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  attemptCount: number;
  degradedWait: boolean;
}

/**
 * Traduce el error de navegación a una de las categorías del esquema.
 * Chromium reporta causas concretas en net::ERR_*; aprovecharlas es la
 * diferencia entre "falló" y "el DNS no resuelve".
 */
export function categorizeNavigationError(err: unknown): { category: ErrorCategory; message: string } {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof playwrightErrors.TimeoutError || /Timeout .*exceeded/i.test(message)) {
    return { category: 'timeout', message };
  }
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|ERR_DNS/i.test(message)) {
    return { category: 'dns', message };
  }
  if (/ERR_CERT_|ERR_SSL_|ERR_TLS|ERR_BAD_SSL/i.test(message)) {
    return { category: 'tls', message };
  }
  if (/ERR_CONNECTION_|ERR_ADDRESS_|ERR_SOCKET_|ERR_EMPTY_RESPONSE|ERR_TOO_MANY_REDIRECTS|ERR_ABORTED|ERR_FAILED/i.test(message)) {
    return { category: 'navigation', message };
  }
  return { category: 'unknown', message };
}

/** Categoría que corresponde a un status HTTP, o null si el status está bien. */
export function categorizeStatus(status: number): ErrorCategory | null {
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return null;
}

/** Reconstruye la cadena de redirecciones desde la respuesta final hacia atrás. */
function redirectChainOf(response: Response): RedirectHop[] {
  const hops: RedirectHop[] = [];
  let request = response.request().redirectedFrom();
  while (request !== null) {
    hops.push({ url: request.url(), status: null });
    request = request.redirectedFrom();
  }
  hops.reverse();
  // El status de cada salto lo tiene la respuesta del salto, que ya se perdió;
  // lo que importa es la secuencia de URLs y el status final, que va aparte.
  return hops;
}

interface Timings {
  ttfbMs: number | null;
  loadMs: number | null;
  dclMs: number | null;
}

async function readTimings(page: Page): Promise<Timings> {
  try {
    const raw = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      if (nav === undefined) return null;
      return {
        responseStart: nav.responseStart,
        loadEventEnd: nav.loadEventEnd,
        domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
      };
    });
    if (raw === null) return { ttfbMs: null, loadMs: null, dclMs: null };
    // Un 0 significa que el evento no había ocurrido, no que tardó 0 ms.
    const clean = (v: number): number | null => (v > 0 ? Math.round(v) : null);
    return {
      ttfbMs: clean(raw.responseStart),
      loadMs: clean(raw.loadEventEnd),
      dclMs: clean(raw.domContentLoadedEventEnd),
    };
  } catch {
    return { ttfbMs: null, loadMs: null, dclMs: null };
  }
}

export interface AuditPageOptions {
  /** Sobrescribe el waitUntil del sitio, para el reintento degradado. */
  waitUntil?: ResolvedSite['waitUntil'];
  signal?: AbortSignal;
  /**
   * Se invoca con la página ya cargada, antes de cerrarla, solo si la navegación
   * salió bien. Existe para que la generación del PDF aproveche esta misma visita:
   * cargar cada página dos veces —una para medir y otra para imprimir— duplicaría
   * el costo de la corrida. Si lanza, se registra pero no invalida la medición.
   */
  capture?: (page: Page, url: string) => Promise<void>;
}

/** Mide una página. Una sola pasada, sin reintentos: eso lo maneja quien llama. */
async function auditOnce(
  context: BrowserContext,
  url: string,
  site: ResolvedSite,
  opts: AuditPageOptions,
): Promise<Omit<PageMetrics, 'attemptCount' | 'degradedWait'>> {
  const page = await context.newPage();
  let transferBytes = 0;
  let requestCount = 0;

  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', () => {
      requestCount += 1;
    });
    cdp.on('Network.loadingFinished', (event) => {
      const { encodedDataLength } = event as { encodedDataLength?: number };
      transferBytes += encodedDataLength ?? 0;
    });

    let response: Response | null;
    try {
      response = await page.goto(url, {
        waitUntil: opts.waitUntil ?? site.waitUntil,
        timeout: site.timeoutMs,
      });
    } catch (err) {
      const { category, message } = categorizeNavigationError(err);
      return {
        url,
        finalUrl: null,
        httpStatus: null,
        redirectChain: [],
        ttfbMs: null,
        loadMs: null,
        dclMs: null,
        // Aunque la navegación falle, lo que ya se descargó es dato útil.
        transferBytes: transferBytes > 0 ? transferBytes : null,
        requestCount: requestCount > 0 ? requestCount : null,
        ok: false,
        errorCategory: category,
        errorMessage: message,
      };
    }

    if (response === null) {
      return {
        url, finalUrl: page.url(), httpStatus: null, redirectChain: [],
        ttfbMs: null, loadMs: null, dclMs: null,
        transferBytes, requestCount,
        ok: false,
        errorCategory: 'navigation',
        errorMessage: 'la navegación no produjo respuesta',
      };
    }

    const status = response.status();
    const statusCategory = categorizeStatus(status);
    const timings = await readTimings(page);

    // El capture va después de leer los timings para no contaminarlos, y solo si
    // la página respondió: imprimir un 503 no sirve de nada.
    if (statusCategory === null && opts.capture !== undefined) {
      try {
        await opts.capture(page, url);
      } catch {
        // Defensa en profundidad: quien implementa capture ya reporta sus
        // errores. Que no se pueda imprimir un PDF no invalida una medición que
        // ya está tomada.
      }
    }

    return {
      url,
      finalUrl: response.url(),
      httpStatus: status,
      redirectChain: redirectChainOf(response),
      ...timings,
      transferBytes,
      requestCount,
      ok: statusCategory === null,
      errorCategory: statusCategory,
      errorMessage: statusCategory === null ? null : `el servidor respondió HTTP ${status}`,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Mide una página con un reintento, como pide el brief.
 *
 * El reintento no es una repetición ciega: si el primer intento se fue a timeout
 * y el sitio estaba configurado con networkidle, el segundo espera solo `load`.
 * networkidle nunca se cumple en sitios con analítica que hace polling, y sin
 * esta degradación los marcaríamos caídos aunque carguen perfecto. Cuando pasa,
 * degradedWait queda en true para que el dashboard distinga "lento" de "nunca
 * se queda quieto".
 */
export async function auditPage(
  context: BrowserContext,
  url: string,
  site: ResolvedSite,
  opts: AuditPageOptions = {},
): Promise<PageMetrics> {
  const first = await auditOnce(context, url, site, opts);
  if (first.ok) {
    return { ...first, attemptCount: 1, degradedWait: false };
  }

  const degrade = first.errorCategory === 'timeout' && (opts.waitUntil ?? site.waitUntil) === 'networkidle';
  const second = await auditOnce(context, url, site, {
    ...opts,
    ...(degrade ? { waitUntil: 'load' as const } : {}),
  });

  return {
    ...second,
    attemptCount: 2,
    degradedWait: degrade && second.ok,
  };
}
