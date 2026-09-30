/** Formateo compartido. Todo en hora de Ciudad de México y español de México. */

const TZ = 'America/Mexico_City';

export function fmtBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, '0')} s`;
}

export function fmtTime(d: Date | null): string {
  if (d === null) return '—';
  return d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
}

export function fmtDateTime(d: Date | null): string {
  if (d === null) return '—';
  return d.toLocaleString('es-MX', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(d: Date | null): string {
  if (d === null) return '—';
  return d.toLocaleDateString('es-MX', { timeZone: TZ, day: '2-digit', month: 'short' });
}

export function fmtNum(n: number | null, digits = 0): string {
  if (n === null) return '—';
  return n.toLocaleString('es-MX', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Ruta legible de una URL, sin el dominio. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? '/' : u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Etiquetas en español de las categorías de error del esquema. */
export const ERROR_LABELS: Record<string, string> = {
  timeout: 'tiempo agotado',
  dns: 'DNS no resuelve',
  tls: 'certificado o TLS',
  http_4xx: 'error 4xx',
  http_5xx: 'error 5xx',
  navigation: 'no se pudo conectar',
  render: 'no se pudo renderizar',
  pdf: 'fallo al imprimir',
  lighthouse: 'fallo de Lighthouse',
  unknown: 'desconocido',
};

export const DISCOVERY_LABELS: Record<string, string> = {
  manual: 'páginas elegidas',
  sitemap: 'sitemap',
  robots: 'robots.txt',
  crawl: 'crawl de links',
  home_only: 'solo la home',
  none: 'sin descubrir',
};
