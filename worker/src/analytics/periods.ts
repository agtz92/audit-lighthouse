/**
 * Fechas de la sincronización y de los informes.
 *
 * Todo se maneja como texto ISO (`2026-10-07`) y en la zona de Ciudad de
 * México. Google pide y entrega fechas de calendario, sin hora: convertirlas a
 * Date y de regreso es la forma clásica de perder un día en el cambio de UTC.
 */

/** Hoy en la zona dada, como YYYY-MM-DD. */
export function isoToday(tz: string, now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Suma días a una fecha ISO. La aritmética va en UTC, donde no hay horario de verano. */
export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Días de a hasta b, contando ambos extremos. */
export function daysInclusive(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

export function minIso(a: string, b: string): string {
  return a < b ? a : b;
}

export interface DateRange {
  start: string;
  end: string;
}

/**
 * Qué días pedirle a Google en esta sincronización.
 *
 * - Sin nada guardado: la carga inicial, hacia atrás `backfillDays`.
 * - Con datos: desde el día siguiente al último guardado, pero nunca menos de
 *   los últimos `refreshDays`. Lo primero rellena el hueco si el servicio
 *   estuvo apagado una semana; lo segundo vuelve a pedir los días que Google
 *   todavía está ajustando.
 *
 * Termina ayer: el día de hoy está incompleto en las dos fuentes.
 */
export function syncWindow(opts: {
  today: string;
  maxStored: string | null;
  refreshDays: number;
  backfillDays: number;
}): DateRange & { backfill: boolean } {
  const end = addDays(opts.today, -1);
  if (opts.maxStored === null) {
    return { start: addDays(opts.today, -opts.backfillDays), end, backfill: true };
  }
  const start = minIso(addDays(opts.maxStored, 1), addDays(opts.today, -opts.refreshDays));
  return { start: minIso(start, end), end, backfill: false };
}

export type PeriodKey = 'last28' | 'prev28' | 'month' | 'prev_month';
export const PERIOD_KEYS: PeriodKey[] = ['last28', 'prev28', 'month', 'prev_month'];

/** Último día del mes de una fecha ISO. */
function finDeMes(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** Primer día del mes anterior al de la fecha dada. */
function inicioMesAnterior(iso: string): string {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Los cuatro periodos que se guardan.
 *
 * Los dos de 28 días se anclan en `anchor`, el último día con datos de la
 * fuente: Search Console publica con 2 a 3 días de retraso, y anclar en ayer
 * dejaría los últimos días del periodo en cero y la comparación sesgada a la
 * baja. Los mensuales son de calendario y no se mueven: el último mes completo
 * respecto a `today`, y el anterior a ese.
 */
export function periodRanges(today: string, anchor: string): Record<PeriodKey, DateRange> {
  const mesInicio = inicioMesAnterior(today);
  const mesAnteriorInicio = inicioMesAnterior(mesInicio);
  return {
    last28: { start: addDays(anchor, -27), end: anchor },
    prev28: { start: addDays(anchor, -55), end: addDays(anchor, -28) },
    month: { start: mesInicio, end: finDeMes(mesInicio) },
    prev_month: { start: mesAnteriorInicio, end: finDeMes(mesAnteriorInicio) },
  };
}

/** Cuál par de periodos usa el informe según REPORT_PERIOD. */
export function reportPeriods(mode: 'month' | '28d'): { current: PeriodKey; previous: PeriodKey } {
  return mode === 'month'
    ? { current: 'month', previous: 'prev_month' }
    : { current: 'last28', previous: 'prev28' };
}

/** Todas las fechas de un rango, para rellenar con cero los días sin filas. */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.start; d <= range.end; d = addDays(d, 1)) out.push(d);
  return out;
}
