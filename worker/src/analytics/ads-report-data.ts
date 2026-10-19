/**
 * Arma los datos de los informes de Ads a partir de lo que ya está en la base.
 *
 * Igual que report-data.ts: lee solo de la base y no habla con Google, así que
 * los informes se pueden volver a generar sin gastar cuota de la API.
 */

import type { ResolvedSite } from '../config/sites.js';
import type { Consultant } from '../report/model.js';
import { buildAdsReport, type AdsReportData, type AdsPeriodInput } from '../report/ads-model.js';
import { folio } from '../report/format.js';
import {
  fetchBreakdowns, fetchLatestPageHealth, fetchAdsDayTotals, fetchLatestAdsState, type StoredBreakdown,
} from '../db/analytics.js';
import { addDays, minIso, periodRanges, reportPeriods, type DateRange, type PeriodKey } from './periods.js';
import type { AdsMetrics, AdsSchedule } from '../google/ads.js';

export interface LoadAdsReportOptions {
  consultant: Consultant;
  mode: 'month' | '28d';
  today: string;
  generatedAt: Date;
  /** Número para el folio. */
  runId: number;
}

function rangeOf(list: StoredBreakdown[], period: PeriodKey, fallback: DateRange): DateRange {
  const b = list.find((x) => x.period === period && x.kind.startsWith('ads_'));
  return b === undefined ? fallback : { start: b.start, end: b.end };
}

function periodInput(list: StoredBreakdown[], period: PeriodKey): AdsPeriodInput | null {
  const de = list.filter((x) => x.period === period && x.kind.startsWith('ads_'));
  if (de.length === 0) return null;
  const arr = <T>(kind: StoredBreakdown['kind']): T[] => {
    const b = de.find((x) => x.kind === kind);
    return Array.isArray(b?.rows) ? (b.rows as T[]) : [];
  };
  const obj = <T>(kind: StoredBreakdown['kind']): T | null => {
    const b = de.find((x) => x.kind === kind);
    return b === undefined || b.rows === null || typeof b.rows !== 'object' || Array.isArray(b.rows) ? null : (b.rows as T);
  };
  return {
    totals: obj<AdsMetrics>('ads_totals'),
    campaigns: arr('ads_campaigns'),
    conversionActions: arr('ads_conversion_actions'),
    adGroups: arr('ads_ad_groups'),
    keywords: arr('ads_keywords'),
    searchTerms: arr('ads_search_terms'),
    ads: arr('ads_ads'),
    assetGroups: arr('ads_asset_groups'),
    pmaxTerms: arr('ads_pmax_terms'),
    audiences: arr('ads_audiences'),
    devices: arr('ads_devices'),
    landing: arr('ads_landing'),
    geo: arr('ads_geo'),
    gender: arr('ads_gender'),
    age: arr('ads_age'),
    schedule: obj<AdsSchedule>('ads_schedule'),
  };
}

/** null cuando el sitio no tiene Ads conectado o todavía no hay una sincronización buena. */
export async function loadAdsReport(site: ResolvedSite, opts: LoadAdsReportOptions): Promise<AdsReportData | null> {
  if (site.google.adsCustomerId === null) return null;
  const estado = await fetchLatestAdsState(site.id);
  if (estado === null) return null;

  const { current, previous } = reportPeriods(opts.mode);
  const guardados = await fetchBreakdowns(site.id, [current, previous]);
  const ahora = periodInput(guardados, current);
  if (ahora === null) return null;

  const porDefecto = periodRanges(opts.today, addDays(opts.today, -1));
  const rCur = rangeOf(guardados, current, porDefecto[current]);
  const rPrev = rangeOf(guardados, previous, porDefecto[previous]);
  // Los días tienen que cubrir los dos periodos y las dos semanas de la comparación de 7 días.
  const desde = minIso(rPrev.start, addDays(estado.latestDate, -15));

  const [days, health] = await Promise.all([
    fetchAdsDayTotals(site.id, desde, estado.latestDate),
    fetchLatestPageHealth(site.id),
  ]);

  return buildAdsReport({
    consultant: opts.consultant,
    site: { name: site.name, url: site.url },
    generatedAt: opts.generatedAt,
    folio: folio(opts.generatedAt, opts.runId),
    customerId: estado.customerId,
    currency: estado.currency,
    mode: opts.mode,
    current: rCur,
    previous: rPrev,
    latestDate: estado.latestDate,
    days,
    now: ahora,
    before: periodInput(guardados, previous),
    health,
  });
}
