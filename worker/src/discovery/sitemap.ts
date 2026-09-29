/**
 * Lectura de sitemaps.
 *
 * No usamos un parser XML completo a propósito: los sitemaps del mundo real
 * traen entidades a medio escapar, BOMs y CDATA, y un parser estricto se niega
 * a leer un archivo que por lo demás es perfectamente usable. Extraer <loc> con
 * tolerancia es lo que hacen los crawlers de verdad. Lo que sí hacemos es
 * distinguir <urlset> de <sitemapindex>, porque confundirlos significa auditar
 * sitemaps en lugar de páginas.
 */

import { gunzipSync } from 'node:zlib';
import { normalizeUrl, sameSite, looksLikePage } from '../lib/url.js';

export type SitemapKind = 'urlset' | 'sitemapindex' | 'unknown';

export interface ParsedSitemap {
  kind: SitemapKind;
  /** Contenido crudo de cada <loc>, ya decodificado pero sin normalizar. */
  locs: string[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodifica las entidades XML que aparecen en URLs de sitemaps. */
export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Detecta el tipo de sitemap mirando el primer elemento significativo. */
function detectKind(xml: string): SitemapKind {
  // <sitemapindex> puede venir con namespace o atributos; basta el nombre.
  const index = xml.search(/<\s*sitemapindex[\s>]/i);
  const urlset = xml.search(/<\s*urlset[\s>]/i);
  if (index === -1 && urlset === -1) return 'unknown';
  if (index === -1) return 'urlset';
  if (urlset === -1) return 'sitemapindex';
  return index < urlset ? 'sitemapindex' : 'urlset';
}

export function parseSitemapXml(raw: string): ParsedSitemap {
  // Quita el BOM, que hace fallar la detección del primer elemento.
  const xml = raw.replace(/^﻿/, '');
  const kind = detectKind(xml);

  const locs: string[] = [];
  const re = /<\s*loc\s*>([\s\S]*?)<\s*\/\s*loc\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(xml)) !== null) {
    let value = match[1] ?? '';
    // <loc><![CDATA[https://...]]></loc>
    value = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    value = decodeXmlEntities(value).trim();
    if (value !== '') locs.push(value);
  }

  return { kind, locs };
}

/** Descomprime si el cuerpo es gzip: un .xml.gz no lo desenvuelve fetch. */
export function decodeSitemapBody(body: Uint8Array): string {
  const isGzip = body.length > 2 && body[0] === 0x1f && body[1] === 0x8b;
  const bytes = isGzip ? gunzipSync(body) : body;
  return new TextDecoder('utf-8').decode(bytes);
}

export interface FetchSitemapOptions {
  userAgent: string;
  timeoutMs: number;
  /** Tope de sitemaps a descargar, contando los anidados. */
  maxDocuments?: number;
  signal?: AbortSignal;
}

export interface SitemapCrawlResult {
  /** URLs de páginas, normalizadas y deduplicadas, en orden de aparición. */
  urls: string[];
  /** Cuántos documentos de sitemap se leyeron (1 = plano, >1 = tenía índice). */
  documents: number;
  /** URLs descartadas por apuntar a otro dominio o no ser páginas. */
  rejected: number;
}

async function fetchText(url: string, opts: FetchSitemapOptions): Promise<string | null> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': opts.userAgent, accept: 'application/xml,text/xml,*/*' },
    signal,
  });
  if (!res.ok) return null;
  const body = new Uint8Array(await res.arrayBuffer());
  return decodeSitemapBody(body);
}

/**
 * Lee un sitemap y, si es un índice, sus hijos. Se queda solo con URLs del mismo
 * sitio que `siteUrl`, tratando apex y www como el mismo sitio: grupohule.com
 * publica su índice en www pero las URLs de dentro apuntan al apex, y
 * compararlas literalmente descartaría el sitio completo.
 */
export async function collectSitemapUrls(
  sitemapUrl: string,
  siteUrl: string,
  opts: FetchSitemapOptions,
): Promise<SitemapCrawlResult> {
  const maxDocuments = opts.maxDocuments ?? 50;
  const queue = [sitemapUrl];
  const visited = new Set<string>();
  const seen = new Set<string>();
  const urls: string[] = [];
  let documents = 0;
  let rejected = 0;

  while (queue.length > 0 && documents < maxDocuments) {
    const current = queue.shift();
    if (current === undefined) break;
    const key = normalizeUrl(current, undefined, { stripQuery: false }) ?? current;
    if (visited.has(key)) continue;
    visited.add(key);

    const xml = await fetchText(current, opts);
    if (xml === null) continue;
    documents += 1;

    const { kind, locs } = parseSitemapXml(xml);

    for (const loc of locs) {
      const abs = normalizeUrl(loc, current);
      if (abs === null) {
        rejected += 1;
        continue;
      }
      if (kind === 'sitemapindex') {
        // Un índice apunta a más sitemaps; esos sí pueden vivir en el apex.
        if (sameSite(abs, siteUrl)) queue.push(abs);
        else rejected += 1;
        continue;
      }
      if (!sameSite(abs, siteUrl) || !looksLikePage(abs)) {
        rejected += 1;
        continue;
      }
      if (seen.has(abs)) continue;
      seen.add(abs);
      urls.push(abs);
    }
  }

  return { urls, documents, rejected };
}
