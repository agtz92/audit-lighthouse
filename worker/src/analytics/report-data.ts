/**
 * Arma los datos del informe de tráfico a partir de lo que ya está en la base.
 *
 * Lo usan dos procesos: el servicio analytics, para analitica.pdf, y el worker,
 * para la parte de tráfico del integral. Por eso lee solo de la base y no habla
 * con Google: el worker no tiene la llave de la cuenta de servicio.
 */

import type { ResolvedSite } from '../config/sites.js';
import type { Consultant } from '../report/model.js';
import { buildAnalyticsReport, type AnalyticsReportData } from '../report/analytics-model.js';
import { folio } from '../report/format.js';
import {
  fetchBreakdowns, fetchGscDailyRange, fetchGaDailyRange, fetchLatestAnalyticsState, fetchLatestPageHealth,
  type StoredBreakdown,
} from '../db/analytics.js';
import { addDays, periodRanges, reportPeriods, type DateRange, type PeriodKey } from './periods.js';
import type { GscDimensionRow } from '../google/search-console.js';
import type { GaTotals, GaLabeledRow, GaKeyEventRow } from '../google/ga4.js';

export interface LoadReportOptions {
  consultant: Consultant;
  mode: 'month' | '28d';
  today: string;
  generatedAt: Date;
  /** Número para el folio: el de la corrida que imprime. */
  runId: number;
  dropThreshold: number;
}

function rows<T>(list: StoredBreakdown[], period: PeriodKey, kind: StoredBreakdown['kind']): T[] {
  const b = list.find((x) => x.period === period && x.kind === kind);
  return Array.isArray(b?.rows) ? (b.rows as T[]) : [];
}

function single<T>(list: StoredBreakdown[], period: PeriodKey, kind: StoredBreakdown['kind']): T | null {
  const b = list.find((x) => x.period === period && x.kind === kind);
  return b === undefined || b.rows === null || typeof b.rows !== 'object' || Array.isArray(b.rows) ? null : (b.rows as T);
}

/** El rango que quedó guardado para un periodo; si no hay, el que tocaría hoy. */
function rangeOf(list: StoredBreakdown[], period: PeriodKey, fallback: DateRange): DateRange {
  const b = list.find((x) => x.period === period);
  return b === undefined ? fallback : { start: b.start, end: b.end };
}

/**
 * null cuando el sitio no tiene ninguna fuente conectada con datos: no hay
 * informe de tráfico que hacer, y el integral sale sin esas hojas.
 */
export async function loadAnalyticsReport(site: ResolvedSite, opts: LoadReportOptions): Promise<AnalyticsReportData | null> {
  const conGsc = site.google.searchConsole !== null;
  const conGa = site.google.ga4Property !== null;
  if (!conGsc && !conGa) return null;

  const estado = await fetchLatestAnalyticsState(site.id);
  if (estado === null) return null;

  const { current, previous } = reportPeriods(opts.mode);
  const guardados = await fetchBreakdowns(site.id, [current, previous]);
  const porDefecto = periodRanges(opts.today, estado.gscLatestDate ?? addDays(opts.today, -1));
  const rCur = rangeOf(guardados, current, porDefecto[current]);
  const rPrev = rangeOf(guardados, previous, porDefecto[previous]);

  const hayGsc = conGsc && estado.gscLatestDate !== null;
  const hayGa = conGa && estado.gaLatestDate !== null;
  if (!hayGsc && !hayGa) return null;

  const [gscCur, gscPrev, gaCur, gaPrev, health] = await Promise.all([
    hayGsc ? fetchGscDailyRange(site.id, rCur.start, rCur.end) : Promise.resolve([]),
    hayGsc ? fetchGscDailyRange(site.id, rPrev.start, rPrev.end) : Promise.resolve([]),
    hayGa ? fetchGaDailyRange(site.id, rCur.start, rCur.end) : Promise.resolve([]),
    hayGa ? fetchGaDailyRange(site.id, rPrev.start, rPrev.end) : Promise.resolve([]),
    fetchLatestPageHealth(site.id),
  ]);

  return buildAnalyticsReport({
    consultant: opts.consultant,
    site: { name: site.name, url: site.url },
    generatedAt: opts.generatedAt,
    folio: folio(opts.generatedAt, opts.runId),
    mode: opts.mode,
    current: rCur,
    previous: rPrev,
    gsc: !hayGsc ? null : {
      property: site.google.searchConsole ?? '',
      latestDate: estado.gscLatestDate,
      daily: gscCur,
      previousDaily: gscPrev,
      queries: rows<GscDimensionRow>(guardados, current, 'gsc_queries'),
      previousQueries: rows<GscDimensionRow>(guardados, previous, 'gsc_queries'),
      pages: rows<GscDimensionRow>(guardados, current, 'gsc_pages'),
    },
    ga: !hayGa ? null : {
      property: site.google.ga4Property ?? '',
      daily: gaCur,
      previousDaily: gaPrev,
      totals: single<GaTotals>(guardados, current, 'ga_totals'),
      previousTotals: single<GaTotals>(guardados, previous, 'ga_totals'),
      channels: rows<GaLabeledRow>(guardados, current, 'ga_channels'),
      devices: rows<GaLabeledRow>(guardados, current, 'ga_devices'),
      landing: rows<GaLabeledRow>(guardados, current, 'ga_landing'),
      keyEvents: rows<GaKeyEventRow>(guardados, current, 'ga_key_events'),
      keyEventsDefined: estado.keyEvents,
    },
    health,
    dropThreshold: opts.dropThreshold,
  });
}
