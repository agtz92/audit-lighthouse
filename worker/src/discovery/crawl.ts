/**
 * Descubrimiento por links internos, para sitios sin sitemap utilizable.
 *
 * Usa HTTP plano en lugar del navegador: si crawleáramos con Playwright cada
 * página se cargaría dos veces, una para sacar sus links y otra para medirla.
 * A cambio, un sitio que pinta sus links solo con JavaScript no suelta nada por
 * este camino; eso se registra como discovery = 'home_only' en vez de fingir
 * que el sitio tiene una sola página.
 */

import { normalizeUrl, sameSite, looksLikePage } from '../lib/url.js';

export interface CrawlOptions {
  userAgent: string;
  timeoutMs: number;
  maxPages: number;
  /**
   * Cuántas URLs se juntan en total. Por default maxPages, pero el descubrimiento
   * pide muchas más para poder ofrecerlas a elegir en el dashboard: recolectar es
   * gratis —son links de un HTML que ya se leyó—, lo que cuesta es descargar.
   */
  collect?: number;
  /**
   * Cuántos documentos HTML se descargan para sacar links. Es el costo real del
   * crawl y va aparte de `collect` justo por eso: subir el catálogo de 5 a 200
   * URLs no debe multiplicar por 40 el tiempo del descubrimiento.
   */
  maxFetches?: number;
  /** Profundidad de saltos desde la home. 2 alcanza el menú y su primer nivel. */
  maxDepth?: number;
  exclude: string[];
  signal?: AbortSignal;
}

export interface CrawlResult {
  /** Todo lo que se juntó, hasta `collect`. El recorte a maxPages es de quien llama. */
  urls: string[];
  /** Páginas cuyo HTML se leyó para sacar links. */
  fetched: number;
  /** true si quedaron páginas en la cola sin visitar al topar con un límite. */
  truncated: boolean;
}

/** Extrae los href de un documento HTML, resolviéndolos contra su base. */
export function extractLinks(html: string, baseUrl: string): string[] {
  // Un <base href> cambia la resolución de todo lo demás.
  //
  // Ojo: la base NO se normaliza. normalizeUrl quita la diagonal final, y esa
  // diagonal decide cómo se resuelve un link relativo: "d" contra "/a/b/" es
  // "/a/b/d", pero contra "/a/b" es "/a/d". Normalizar aquí haría que el crawler
  // resolviera un nivel arriba en toda página con URL de directorio.
  const baseTag = /<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i.exec(html);
  let effectiveBase = baseUrl;
  if (baseTag) {
    try {
      effectiveBase = new URL(baseTag[2] ?? baseTag[3] ?? baseTag[4] ?? '', baseUrl).toString();
    } catch {
      // Un <base href> inválido se ignora, como hacen los navegadores.
    }
  }

  const out: string[] = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (href === '' || href.startsWith('#')) continue;
    const abs = normalizeUrl(href, effectiveBase);
    if (abs !== null) out.push(abs);
  }
  return out;
}

function isExcluded(url: string, patterns: string[]): boolean {
  return patterns.some((p) => url.includes(p));
}

/**
 * Recorre el sitio en anchura desde la home hasta juntar `collect` URLs, sin
 * pasarse de `maxFetches` descargas. La home siempre es la primera de la lista.
 */
export async function crawlInternalLinks(siteUrl: string, opts: CrawlOptions): Promise<CrawlResult> {
  const maxDepth = opts.maxDepth ?? 2;
  const collect = Math.max(opts.collect ?? opts.maxPages, opts.maxPages);
  const maxFetches = opts.maxFetches ?? opts.maxPages;
  const home = normalizeUrl(siteUrl) ?? siteUrl;

  const found = new Set<string>([home]);
  const order: string[] = [home];
  const queue: Array<{ url: string; depth: number }> = [{ url: home, depth: 0 }];
  let fetched = 0;

  while (queue.length > 0 && fetched < maxFetches && order.length < collect) {
    const node = queue.shift();
    if (node === undefined) break;
    if (node.depth >= maxDepth) continue;
    if (opts.signal?.aborted === true) break;

    let html: string;
    let base: string = node.url;
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
      const res = await fetch(node.url, {
        redirect: 'follow',
        headers: { 'user-agent': opts.userAgent, accept: 'text/html,*/*' },
        signal,
      });
      if (!res.ok) continue;
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('html')) continue;
      html = await res.text();
      // La base para resolver links es la URL FINAL de la respuesta, no la que
      // pedimos: si hubo redirección, los relativos cuelgan de la destino.
      base = res.url === '' ? node.url : res.url;
      fetched += 1;
    } catch {
      // Una página que no se puede leer para descubrir links no es un fallo del
      // sitio: se sigue con la cola. Si es la home, el resultado será solo ella
      // y el auditor registrará el error real al medirla.
      continue;
    }

    for (const link of extractLinks(html, base)) {
      if (order.length >= collect) break;
      if (found.has(link)) continue;
      if (!sameSite(link, home)) continue;
      if (!looksLikePage(link)) continue;
      if (isExcluded(link, opts.exclude)) continue;
      found.add(link);
      order.push(link);
      queue.push({ url: link, depth: node.depth + 1 });
    }
  }

  return {
    urls: order.slice(0, collect),
    fetched,
    // Si la cola quedó con trabajo pendiente es que topamos con un límite.
    truncated: queue.length > 0,
  };
}
