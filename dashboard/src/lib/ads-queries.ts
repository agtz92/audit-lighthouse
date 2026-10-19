/**
 * Google Ads en el dashboard: la serie que sincroniza el servicio analytics
 * (ads_daily), el estado de la última sincronización y lo que Claude escribió
 * (ads_notes, ads_context).
 *
 * Los tipos de las notas reflejan los esquemas de worker/src/ai/ads-writer.ts.
 */

import { query } from './db';
import { addDays, pares, type DailyPair, type TrafficRange } from './traffic-queries';

export interface AdsState {
  status: 'ok' | 'error' | 'off';
  error: string | null;
  customerId: string | null;
  currency: string;
  latestDate: string | null;
  finishedAt: Date | null;
}

/** Lo último que se supo de la cuenta de Ads del sitio. */
export async function fetchAdsState(siteId: string): Promise<AdsState | null> {
  const [r] = await query<{
    ads_status: AdsState['status']; ads_error: string | null; ads_customer_id: string | null;
    ads_currency: string | null; d: string | null; finished_at: Date | null;
  }>(`
    SELECT ads_status, ads_error, ads_customer_id, ads_currency, to_char(ads_latest_date, 'YYYY-MM-DD') AS d, finished_at
      FROM analytics_site_runs
     WHERE site_id = $1 AND status <> 'running' AND ads_status <> 'off'
     ORDER BY started_at DESC LIMIT 1
  `, [siteId]);
  if (r === undefined) return null;
  return {
    status: r.ads_status, error: r.ads_error, customerId: r.ads_customer_id,
    currency: r.ads_currency ?? 'MXN', latestDate: r.d, finishedAt: r.finished_at,
  };
}

export interface AdsTotals {
  cost: number;
  clicks: number;
  impressions: number;
  conversions: number;
  conversionsValue: number;
}

export interface AdsCampaignRow extends AdsTotals {
  id: string;
  name: string;
  previousCost: number;
  previousConversions: number;
}

export interface AdsSummary {
  latest: string | null;
  totals: AdsTotals | null;
  previous: AdsTotals | null;
  campaigns: AdsCampaignRow[];
  series: { cost: DailyPair[]; conversions: DailyPair[] };
}

/** Totales, campañas y serie de un rango, anclados en el último día sincronizado. */
export async function fetchAdsSummary(siteId: string, range: TrafficRange): Promise<AdsSummary> {
  const [ult] = await query<{ d: string | null; first: string | null }>(`
    SELECT to_char(max(date), 'YYYY-MM-DD') AS d, to_char(min(date), 'YYYY-MM-DD') AS first FROM ads_daily WHERE site_id = $1
  `, [siteId]);
  const latest = ult?.d ?? null;
  if (latest === null) return { latest: null, totals: null, previous: null, campaigns: [], series: { cost: [], conversions: [] } };

  const desde = addDays(latest, -(range - 1));
  const desdePrev = addDays(desde, -range);
  const filas = await query<{
    d: string; campaign_id: string; campaign_name: string; impressions: number; clicks: number;
    cost: number; conversions: number; conversions_value: number;
  }>(`
    SELECT to_char(date, 'YYYY-MM-DD') AS d, campaign_id::text AS campaign_id, campaign_name, impressions, clicks,
           cost_micros / 1000000.0 AS cost, conversions, conversions_value
      FROM ads_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3
  `, [siteId, desdePrev, latest]);

  const vacio = (): AdsTotals => ({ cost: 0, clicks: 0, impressions: 0, conversions: 0, conversionsValue: 0 });
  const totals = vacio();
  const previous = vacio();
  const porCampana = new Map<string, AdsCampaignRow>();
  const costoDia = new Map<string, number>();
  const convDia = new Map<string, number>();
  for (const f of filas) {
    const actual = f.d >= desde;
    const t = actual ? totals : previous;
    t.cost += f.cost; t.clicks += f.clicks; t.impressions += f.impressions;
    t.conversions += f.conversions; t.conversionsValue += f.conversions_value;
    costoDia.set(f.d, (costoDia.get(f.d) ?? 0) + f.cost);
    convDia.set(f.d, (convDia.get(f.d) ?? 0) + f.conversions);
    const c = porCampana.get(f.campaign_id) ?? { id: f.campaign_id, name: f.campaign_name, ...vacio(), previousCost: 0, previousConversions: 0 };
    if (actual) {
      c.cost += f.cost; c.clicks += f.clicks; c.impressions += f.impressions;
      c.conversions += f.conversions; c.conversionsValue += f.conversions_value;
      // El nombre más reciente gana: una campaña renombrada no sale dos veces.
      c.name = f.campaign_name;
    } else {
      c.previousCost += f.cost;
      c.previousConversions += f.conversions;
    }
    porCampana.set(f.campaign_id, c);
  }

  // Ads no manda días en cero: un día sin fila es cero, salvo antes del primero guardado.
  const primero = ult?.first ?? null;
  const conPrevio = primero !== null && primero <= desdePrev;
  return {
    latest,
    totals,
    previous: conPrevio ? previous : null,
    campaigns: [...porCampana.values()].filter((c) => c.cost > 0 || c.previousCost > 0).sort((a, b) => b.cost - a.cost),
    series: { cost: pares(costoDia, latest, range, primero), conversions: pares(convDia, latest, range, primero) },
  };
}

export interface WeeklyNote {
  createdAt: Date;
  model: string;
  periodStart: string;
  periodEnd: string;
  resumen: string;
  mejoro: string[];
  empeoro: string[];
  alertas: string[];
  acciones: string[];
}

export interface AdsContext {
  profile: string;
  baseline: string | null;
  baselineUpdatedAt: Date | null;
}

export async function fetchLatestWeeklyNote(siteId: string): Promise<WeeklyNote | null> {
  const [r] = await query<{ created_at: Date; model: string; s: string; e: string; content: Omit<WeeklyNote, 'createdAt' | 'model' | 'periodStart' | 'periodEnd'> }>(`
    SELECT created_at, model, to_char(period_start, 'YYYY-MM-DD') AS s, to_char(period_end, 'YYYY-MM-DD') AS e, content
      FROM ads_notes WHERE site_id = $1 AND kind = 'weekly'
     ORDER BY created_at DESC LIMIT 1
  `, [siteId]);
  if (r === undefined) return null;
  const c = r.content;
  const lista = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    createdAt: r.created_at, model: r.model, periodStart: r.s, periodEnd: r.e,
    resumen: typeof c.resumen === 'string' ? c.resumen : '',
    mejoro: lista(c.mejoro), empeoro: lista(c.empeoro), alertas: lista(c.alertas), acciones: lista(c.acciones),
  };
}

export async function fetchAdsContext(siteId: string): Promise<AdsContext> {
  const [r] = await query<{ profile: string; baseline: string | null; baseline_updated_at: Date | null }>(`
    SELECT profile, baseline, baseline_updated_at FROM ads_context WHERE site_id = $1
  `, [siteId]);
  return { profile: r?.profile ?? '', baseline: r?.baseline ?? null, baselineUpdatedAt: r?.baseline_updated_at ?? null };
}

/** Cuándo se generaron los textos de los informes por última vez, y con qué modelo. */
export async function fetchReportNotesInfo(siteId: string): Promise<{ createdAt: Date; model: string } | null> {
  const [r] = await query<{ created_at: Date; model: string }>(`
    SELECT created_at, model FROM ads_notes WHERE site_id = $1 AND kind IN ('cliente', 'admin')
     ORDER BY created_at DESC LIMIT 1
  `, [siteId]);
  return r === undefined ? null : { createdAt: r.created_at, model: r.model };
}
