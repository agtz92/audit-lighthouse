/**
 * Normalización y comparación de URLs para el descubrimiento de páginas.
 *
 * El caso que motiva `sameSite`: grupohule.com sirve su sitemap en
 * www.grupohule.com pero las URLs de dentro apuntan al apex sin www. Si
 * compararamos hosts literalmente descartaríamos las 78 URLs del sitio entero.
 */

/** Quita el `www.` inicial para poder comparar apex y subdominio www como el mismo sitio. */
export function bareHost(host: string): string {
  const h = host.toLowerCase();
  return h.startsWith('www.') ? h.slice(4) : h;
}

/** true si ambas URLs pertenecen al mismo sitio, tratando www y apex como iguales. */
export function sameSite(a: string | URL, b: string | URL): boolean {
  try {
    const ua = a instanceof URL ? a : new URL(a);
    const ub = b instanceof URL ? b : new URL(b);
    return bareHost(ua.hostname) === bareHost(ub.hostname);
  } catch {
    return false;
  }
}

export interface NormalizeOptions {
  /** Ignorar query strings. Default true: ?utm_source= multiplicaría la misma página. */
  stripQuery?: boolean;
}

/**
 * Forma canónica de una URL para deduplicar.
 * Devuelve null si no es http/https o si no parsea.
 */
export function normalizeUrl(raw: string, base?: string, opts: NormalizeOptions = {}): string | null {
  const { stripQuery = true } = opts;
  let u: URL;
  try {
    u = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  u.hash = '';
  if (stripQuery) u.search = '';
  u.hostname = u.hostname.toLowerCase();

  // Un puerto explícito que es el default del esquema solo ensucia la comparación.
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
    u.port = '';
  }

  // /ruta/ y /ruta son la misma página; la raíz se queda como "/".
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }

  return u.toString();
}

/**
 * Llave para deduplicar páginas dentro de un mismo sitio.
 *
 * Ignora el esquema y el `www.` porque para un sitio son la misma página:
 * grupohule.com publica su sitemap con URLs en el apex mientras su home vive en
 * www, así que comparando URLs completas la home se auditaría dos veces —una por
 * cada forma— y aparecería duplicada en full.pdf.
 *
 * El puerto sí cuenta: un :8443 es otro servicio, no otra escritura del mismo.
 */
export function canonicalKey(url: string): string {
  try {
    const u = new URL(url);
    const port = u.port === '' ? '' : `:${u.port}`;
    return `${bareHost(u.hostname)}${port}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** Extensiones que no son páginas: ni se auditan ni se meten al PDF. */
const NON_PAGE_EXT =
  /\.(pdf|zip|rar|7z|gz|tgz|docx?|xlsx?|pptx?|csv|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4[av]|wav|ogg|webm|mov|avi|woff2?|ttf|otf|eot|css|js|mjs|json|xml|rss|atom|txt)$/i;

export function looksLikePage(url: string): boolean {
  try {
    return !NON_PAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Ruta legible de una URL, sin esquema ni dominio. Para tablas del informe. */
export function pathOfUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/' : u.pathname + u.search;
  } catch {
    return url;
  }
}
