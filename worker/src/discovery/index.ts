/**
 * Orquestación del descubrimiento de páginas de un sitio.
 *
 * Orden: sitemap declarado en el YAML -> /sitemap.xml -> directivas Sitemap: de
 * robots.txt -> crawl de links internos. El primero que devuelva algo gana.
 */

import type { ResolvedSite } from '../config/sites.js';
import type { Logger } from '../lib/logger.js';
import { normalizeUrl, canonicalKey } from '../lib/url.js';
import { collectSitemapUrls } from './sitemap.js';
import { discoverSitemapsFromRobots } from './robots.js';
import { crawlInternalLinks } from './crawl.js';

/** Coincide con el enum discovery_method de la base de datos. */
export type DiscoveryMethod = 'sitemap' | 'robots' | 'crawl' | 'home_only' | 'none';

export interface Discovery {
  method: DiscoveryMethod;
  /** URLs a auditar, con la home siempre primero, ya recortadas a maxPages. */
  urls: string[];
  /** Cuántas se encontraron antes de recortar. Alimenta pages_discovered. */
  discovered: number;
  truncated: boolean;
  /** De dónde salieron, para el log: la URL del sitemap o "crawl". */
  source: string;
}

export interface FinalizeOptions {
  maxPages: number;
  exclude: string[];
}

/**
 * Deja la lista lista para auditar: home primero, sin excluidas, deduplicada y
 * recortada. Separado del I/O para poder probarlo.
 *
 * La home va primero porque es la única URL que recibe Lighthouse y la que va
 * en home.pdf; si el recorte por maxPages la dejara fuera, el sitio perdería sus
 * dos métricas más importantes.
 */
export function finalizeUrlList(
  homeUrl: string,
  candidates: string[],
  opts: FinalizeOptions,
): { urls: string[]; discovered: number; truncated: boolean } {
  const home = normalizeUrl(homeUrl) ?? homeUrl;
  const excluded = (u: string): boolean => opts.exclude.some((p) => u.includes(p));

  // La deduplicación va por canonicalKey, no por URL literal: si el sitemap
  // lista el apex y la home está en www, son la misma página.
  const seen = new Set<string>([canonicalKey(home)]);
  const rest: string[] = [];
  for (const raw of candidates) {
    const url = normalizeUrl(raw) ?? raw;
    const key = canonicalKey(url);
    if (seen.has(key)) continue;
    if (excluded(url)) continue;
    seen.add(key);
    rest.push(url);
  }

  const all = [home, ...rest];
  return {
    urls: all.slice(0, opts.maxPages),
    discovered: all.length,
    truncated: all.length > opts.maxPages,
  };
}

export interface DiscoverOptions {
  userAgent: string;
  signal?: AbortSignal;
  log: Logger;
}

export async function discoverPages(site: ResolvedSite, opts: DiscoverOptions): Promise<Discovery> {
  const fetchOpts = {
    userAgent: opts.userAgent,
    timeoutMs: site.timeoutMs,
    signal: opts.signal,
  };

  /** Prueba una URL de sitemap; devuelve null si no dio nada usable. */
  const trySitemap = async (sitemapUrl: string, method: DiscoveryMethod): Promise<Discovery | null> => {
    try {
      const result = await collectSitemapUrls(sitemapUrl, site.url, fetchOpts);
      if (result.urls.length === 0) return null;
      const { urls, discovered, truncated } = finalizeUrlList(site.url, result.urls, site);
      opts.log.debug('sitemap leído', {
        sitemap: sitemapUrl,
        documentos: result.documents,
        urls: result.urls.length,
        descartadas: result.rejected,
      });
      return { method, urls, discovered, truncated, source: sitemapUrl };
    } catch (err) {
      opts.log.debug('sitemap no utilizable', {
        sitemap: sitemapUrl,
        motivo: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };

  // 1) El sitemap que declara el YAML.
  if (site.sitemap !== undefined) {
    const found = await trySitemap(site.sitemap, 'sitemap');
    if (found !== null) return found;
  }

  // 2) El /sitemap.xml de rigor.
  const conventional = new URL('/sitemap.xml', site.url).toString();
  if (conventional !== site.sitemap) {
    const found = await trySitemap(conventional, 'sitemap');
    if (found !== null) return found;
  }

  // 3) Lo que anuncie robots.txt.
  for (const declared of await discoverSitemapsFromRobots(site.url, fetchOpts)) {
    if (declared === site.sitemap || declared === conventional) continue;
    const found = await trySitemap(declared, 'robots');
    if (found !== null) return found;
  }

  // 4) Crawl de links internos.
  const crawled = await crawlInternalLinks(site.url, {
    ...fetchOpts,
    maxPages: site.maxPages,
    exclude: site.exclude,
  });
  const { urls, discovered, truncated } = finalizeUrlList(site.url, crawled.urls, site);

  return {
    // Solo la home significa que el crawl no encontró links: probablemente el
    // sitio los pinta con JavaScript, o la home no respondió.
    method: urls.length <= 1 ? 'home_only' : 'crawl',
    urls,
    discovered,
    truncated,
    source: 'crawl',
  };
}
