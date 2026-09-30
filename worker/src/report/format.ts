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
