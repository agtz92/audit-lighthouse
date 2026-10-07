/** Formateo del informe. Todo en español de México y hora de Ciudad de México. */

const TZ = 'America/Mexico_City';

export function ms(value: number | null): string {
  if (value === null) return '—';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(2)} s`;
}

export function bytes(value: number | null): string {
  if (value === null) return '—';
  if (value < 1024) return `${value} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function num(value: number | null): string {
  return value === null ? '—' : String(value);
}

export function cls(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

export function longDate(d: Date): string {
  return d.toLocaleDateString('es-MX', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export function shortDate(d: Date): string {
  return d.toLocaleDateString('es-MX', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}

export function time(d: Date): string {
  return d.toLocaleTimeString('es-MX', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
}

/** Entero con separador de miles: 48,210. */
export function int(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('es-MX');
}

/** Cantidades grandes abreviadas para tarjetas: 1.92 M, 188 k. */
export function compact(value: number | null): string {
  if (value === null) return '—';
  const a = Math.abs(value);
  if (a >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} M`;
  if (a >= 10_000) return `${Math.round(value / 1000)} k`;
  return int(value);
}

/** Proporción (0..1) como porcentaje. */
export function pct(ratio: number | null, digits = 1): string {
  return ratio === null || !Number.isFinite(ratio) ? '—' : `${(ratio * 100).toFixed(digits)}%`;
}

/** Duración en segundos como «2 min 14 s». */
export function seconds(value: number | null): string {
  if (value === null) return '—';
  const s = Math.round(value);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

/** Fecha de calendario (YYYY-MM-DD) como «4 oct 2026», sin pasar por husos horarios. */
export function isoDate(iso: string, withYear = true): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('es-MX', {
    timeZone: 'UTC', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}),
  });
}

/** Mes de calendario: «septiembre de 2026». */
export function monthName(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-MX', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

/** Folio del documento: fecha de la corrida más su número. */
export function folio(runAt: Date, runId: number): string {
  const iso = runAt.toLocaleDateString('en-CA', { timeZone: TZ }).replace(/-/g, '');
  return `${iso}-${String(runId).padStart(3, '0')}`;
}

/** Escapa texto que viene de un sitio ajeno antes de meterlo al HTML. */
export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
