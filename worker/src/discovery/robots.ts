/**
 * Lectura de robots.txt, solo para encontrar directivas Sitemap:.
 *
 * No interpretamos Disallow: auditamos sitios propios y el punto es medirlos
 * completos, no comportarnos como un buscador.
 */

export interface RobotsOptions {
  userAgent: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Extrae las URLs declaradas en directivas `Sitemap:` de un robots.txt. */
export function parseRobotsSitemaps(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Un # empieza comentario en cualquier punto de la línea.
    const line = rawLine.split('#')[0] ?? '';
    const match = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
    if (match?.[1] !== undefined) out.push(match[1]);
  }
  return out;
}

/** Devuelve las URLs de sitemap que anuncia el robots.txt del origen dado. */
export async function discoverSitemapsFromRobots(
  siteUrl: string,
  opts: RobotsOptions,
): Promise<string[]> {
  const robotsUrl = new URL('/robots.txt', siteUrl).toString();
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal === undefined ? timeout : AbortSignal.any([timeout, opts.signal]);

  try {
    const res = await fetch(robotsUrl, {
      redirect: 'follow',
      headers: { 'user-agent': opts.userAgent, accept: 'text/plain,*/*' },
      signal,
    });
    if (!res.ok) return [];
    return parseRobotsSitemaps(await res.text());
  } catch {
    // Un robots.txt inaccesible no es un error del sitio: solo significa que
    // hay que descubrir por otro camino.
    return [];
  }
}
