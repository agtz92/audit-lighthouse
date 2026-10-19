/**
 * Google Ads: consultas GAQL por REST, solo lectura.
 *
 * Cada consulta va a googleAds:searchStream, que entrega todas las filas en una
 * sola respuesta (un arreglo de lotes) en vez de paginar de 10 000 en 10 000.
 * Una consulta cuenta como una operación contra el límite diario del token.
 *
 * Por sitio y sincronización: una consulta de la cuenta, una de la serie
 * diaria, una del inventario de anuncios y doce por cada uno de los cuatro
 * periodos. Unas 55 en total, muy por debajo de las 2 880 de acceso Explorer.
 *
 * Los nombres de campo se escriben en snake_case en la consulta y llegan en
 * camelCase en el JSON (metrics.cost_micros → metrics.costMicros). Los int64
 * llegan como texto.
 */

import type { GoogleClient } from './client.js';

/**
 * Google retira cada versión de la API un año después de publicarla. Al
 * subirla hay que revisar las notas de la versión: los campos cambian de
 * nombre de vez en cuando.
 */
export const ADS_API_VERSION = 'v26';
const ADS = `https://googleads.googleapis.com/${ADS_API_VERSION}`;
const API = 'API de Google Ads';

export type AdsRow = Record<string, unknown>;

/** Lee un campo anidado de una fila: field(r, 'metrics.costMicros'). */
export function field(row: AdsRow, path: string): unknown {
  let v: unknown = row;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function text(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}

/** 0.4 → 0.4; null si Google no lo calculó (la campaña no es de búsqueda o no hubo volumen). */
function shareOrNull(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10_000) / 10_000 : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Una consulta GAQL completa, con todas sus filas. */
export async function gaql(client: GoogleClient, customerId: string, query: string): Promise<AdsRow[]> {
  const lotes = await client.request<Array<{ results?: AdsRow[] }>>(
    API,
    `${ADS}/customers/${customerId}/googleAds:searchStream`,
    { query },
  );
  return (Array.isArray(lotes) ? lotes : []).flatMap((l) => l.results ?? []);
}

/** `segments.date BETWEEN '2026-09-14' AND '2026-10-13'` */
function during(start: string, end: string): string {
  return `segments.date BETWEEN '${start}' AND '${end}'`;
}

// ── Métricas ────────────────────────────────────────────────────────────────

/**
 * Lo que se guarda de cada fila. El costo va en la moneda de la cuenta, ya
 * dividido entre un millón. CTR, CPC y CPA no se guardan: se calculan al
 * mostrar, para no promediar porcentajes.
 */
export interface AdsMetrics {
  impressions: number;
  clicks: number;
  cost: number;
  conversions: number;
  conversionsValue: number;
}

const METRICS = 'metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value';

export function metricsOf(row: AdsRow): AdsMetrics {
  return {
    impressions: num(field(row, 'metrics.impressions')),
    clicks: num(field(row, 'metrics.clicks')),
    cost: round2(num(field(row, 'metrics.costMicros')) / 1_000_000),
    conversions: round2(num(field(row, 'metrics.conversions'))),
    conversionsValue: round2(num(field(row, 'metrics.conversionsValue'))),
  };
}

export const ZERO_METRICS: AdsMetrics = { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversionsValue: 0 };

export function addMetrics(a: AdsMetrics, b: AdsMetrics): AdsMetrics {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    cost: round2(a.cost + b.cost),
    conversions: round2(a.conversions + b.conversions),
    conversionsValue: round2(a.conversionsValue + b.conversionsValue),
  };
}

/** Suma filas por llave, conservando lo que no es métrica de la primera que llega. */
function sumBy<T extends AdsMetrics>(items: T[], keyOf: (t: T) => string): T[] {
  const acc = new Map<string, T>();
  for (const it of items) {
    const k = keyOf(it);
    const prev = acc.get(k);
    acc.set(k, prev === undefined ? { ...it } : { ...prev, ...addMetrics(prev, it) });
  }
  return [...acc.values()];
}

const porCosto = <T extends AdsMetrics>(a: T, b: T): number => b.cost - a.cost || b.clicks - a.clicks;

// ── La cuenta ───────────────────────────────────────────────────────────────

export interface AdsAccount {
  id: string;
  name: string;
  currency: string;
  timeZone: string;
}

export function parseAccount(rows: AdsRow[]): AdsAccount | null {
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: text(field(r, 'customer.id')),
    name: text(field(r, 'customer.descriptiveName')),
    currency: text(field(r, 'customer.currencyCode')),
    timeZone: text(field(r, 'customer.timeZone')),
  };
}

export async function fetchAdsAccount(client: GoogleClient, customerId: string): Promise<AdsAccount | null> {
  return parseAccount(await gaql(client, customerId,
    'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone FROM customer LIMIT 1'));
}

// ── Serie diaria ────────────────────────────────────────────────────────────

export interface AdsDailyRow {
  date: string;
  campaignId: string;
  campaignName: string;
  impressions: number;
  clicks: number;
  /** Millonésimas, exactas: es lo que va a la base. */
  costMicros: number;
  conversions: number;
  conversionsValue: number;
  allConversions: number;
}

export function parseDaily(rows: AdsRow[]): AdsDailyRow[] {
  return rows.map((r) => ({
    date: text(field(r, 'segments.date')),
    campaignId: text(field(r, 'campaign.id')),
    campaignName: text(field(r, 'campaign.name'), '(sin nombre)'),
    impressions: num(field(r, 'metrics.impressions')),
    clicks: num(field(r, 'metrics.clicks')),
    costMicros: num(field(r, 'metrics.costMicros')),
    conversions: round2(num(field(r, 'metrics.conversions'))),
    conversionsValue: round2(num(field(r, 'metrics.conversionsValue'))),
    allConversions: round2(num(field(r, 'metrics.allConversions'))),
  }))
    .filter((r) => r.date !== '' && r.campaignId !== '')
    .sort((a, b) => a.date.localeCompare(b.date) || a.campaignId.localeCompare(b.campaignId));
}

/** Solo los días con actividad: Google no manda filas en cero. */
export async function fetchAdsDaily(client: GoogleClient, customerId: string, start: string, end: string): Promise<AdsDailyRow[]> {
  return parseDaily(await gaql(client, customerId,
    `SELECT segments.date, campaign.id, campaign.name, ${METRICS}, metrics.all_conversions
       FROM campaign WHERE ${during(start, end)}`));
}

// ── Inventario de anuncios ──────────────────────────────────────────────────

/**
 * Los anuncios con su estado actual, sin fechas. Va aparte de las métricas
 * porque una consulta con fechas solo devuelve lo que tuvo impresiones, y un
 * anuncio rechazado no tiene: justo el que más importa ver.
 */
export interface AdsAdInfo {
  adId: string;
  adGroupId: string;
  adGroup: string;
  campaignId: string;
  type: string;
  status: string;
  approval: string;
  strength: string;
  headlines: string[];
  finalUrl: string | null;
}

export function parseAdInventory(rows: AdsRow[]): AdsAdInfo[] {
  return rows.map((r) => {
    const headlines = field(r, 'adGroupAd.ad.responsiveSearchAd.headlines');
    const urls = field(r, 'adGroupAd.ad.finalUrls');
    return {
      adId: text(field(r, 'adGroupAd.ad.id')),
      adGroupId: text(field(r, 'adGroup.id')),
      adGroup: text(field(r, 'adGroup.name')),
      campaignId: text(field(r, 'campaign.id')),
      type: text(field(r, 'adGroupAd.ad.type'), 'UNKNOWN'),
      status: text(field(r, 'adGroupAd.status'), 'UNKNOWN'),
      approval: text(field(r, 'adGroupAd.policySummary.approvalStatus'), 'UNKNOWN'),
      strength: text(field(r, 'adGroupAd.adStrength'), 'UNSPECIFIED'),
      headlines: Array.isArray(headlines) ? headlines.map((h) => text(field(h as AdsRow, 'text'))).filter((t) => t !== '') : [],
      finalUrl: Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : null,
    };
  }).filter((a) => a.adId !== '');
}

export async function fetchAdInventory(client: GoogleClient, customerId: string): Promise<AdsAdInfo[]> {
  return parseAdInventory(await gaql(client, customerId,
    `SELECT campaign.id, ad_group.id, ad_group.name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status,
            ad_group_ad.policy_summary.approval_status, ad_group_ad.ad_strength,
            ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.final_urls
       FROM ad_group_ad
      WHERE ad_group_ad.status != 'REMOVED' AND campaign.status != 'REMOVED' AND ad_group.status != 'REMOVED'`));
}

// ── Desgloses de un periodo ─────────────────────────────────────────────────

export interface AdsCampaignRow extends AdsMetrics {
  id: string;
  name: string;
  status: string;
  channel: string;
  bidding: string;
  /** Presupuesto diario, en la moneda de la cuenta. */
  dailyBudget: number | null;
  allConversions: number;
  /** Fracciones de 0 a 1, del periodo completo. null fuera de la red de búsqueda. */
  impressionShare: number | null;
  rankLostShare: number | null;
  budgetLostShare: number | null;
}

export interface AdsConversionActionRow {
  campaignId: string;
  name: string;
  category: string;
  conversions: number;
  allConversions: number;
  conversionsValue: number;
}

export interface AdsAdGroupRow extends AdsMetrics {
  id: string;
  name: string;
  campaignId: string;
  status: string;
}

export interface AdsKeywordRow extends AdsMetrics {
  criterionId: string;
  text: string;
  matchType: string;
  status: string;
  adGroupId: string;
  adGroup: string;
  campaignId: string;
  /** 1 a 10. null cuando Google no tiene datos suficientes. */
  qualityScore: number | null;
  /** Relevancia del anuncio, experiencia en la página de destino y CTR esperado. */
  adRelevance: string | null;
  landingPage: string | null;
  expectedCtr: string | null;
}

export interface AdsSearchTermRow extends AdsMetrics {
  term: string;
  matchType: string;
  /** ADDED (ya es keyword), EXCLUDED (negativa) o NONE. */
  status: string;
}

export type AdsAdRow = AdsAdInfo & AdsMetrics;

export interface AdsLabeledRow extends AdsMetrics {
  key: string;
}

export interface AdsSchedule {
  byDay: AdsLabeledRow[];
  byHour: AdsLabeledRow[];
}

export interface AdsPeriodReports {
  totals: AdsMetrics;
  campaigns: AdsCampaignRow[];
  conversionActions: AdsConversionActionRow[];
  adGroups: AdsAdGroupRow[];
  keywords: AdsKeywordRow[];
  searchTerms: AdsSearchTermRow[];
  ads: AdsAdRow[];
  devices: AdsLabeledRow[];
  landing: AdsLabeledRow[];
  geo: AdsLabeledRow[];
  gender: AdsLabeledRow[];
  age: AdsLabeledRow[];
  schedule: AdsSchedule;
}

/** Cuántas filas se guardan de las listas largas. */
const TOP = { keywords: 300, searchTerms: 200, landing: 100, geo: 50 };

export function parseCampaigns(rows: AdsRow[]): AdsCampaignRow[] {
  return rows.map((r) => {
    const budget = field(r, 'campaignBudget.amountMicros');
    return {
      id: text(field(r, 'campaign.id')),
      name: text(field(r, 'campaign.name'), '(sin nombre)'),
      status: text(field(r, 'campaign.status'), 'UNKNOWN'),
      channel: text(field(r, 'campaign.advertisingChannelType'), 'UNKNOWN'),
      bidding: text(field(r, 'campaign.biddingStrategyType'), 'UNKNOWN'),
      dailyBudget: budget === undefined ? null : round2(num(budget) / 1_000_000),
      ...metricsOf(r),
      allConversions: round2(num(field(r, 'metrics.allConversions'))),
      impressionShare: shareOrNull(field(r, 'metrics.searchImpressionShare')),
      rankLostShare: shareOrNull(field(r, 'metrics.searchRankLostImpressionShare')),
      budgetLostShare: shareOrNull(field(r, 'metrics.searchBudgetLostImpressionShare')),
    };
  }).sort(porCosto);
}

export function parseConversionActions(rows: AdsRow[]): AdsConversionActionRow[] {
  return rows.map((r) => ({
    campaignId: text(field(r, 'campaign.id')),
    name: text(field(r, 'segments.conversionActionName'), '(sin nombre)'),
    category: text(field(r, 'segments.conversionActionCategory'), 'UNKNOWN'),
    conversions: round2(num(field(r, 'metrics.conversions'))),
    allConversions: round2(num(field(r, 'metrics.allConversions'))),
    conversionsValue: round2(num(field(r, 'metrics.conversionsValue'))),
  })).sort((a, b) => b.allConversions - a.allConversions);
}

export function parseAdGroups(rows: AdsRow[]): AdsAdGroupRow[] {
  return rows.map((r) => ({
    id: text(field(r, 'adGroup.id')),
    name: text(field(r, 'adGroup.name'), '(sin nombre)'),
    campaignId: text(field(r, 'campaign.id')),
    status: text(field(r, 'adGroup.status'), 'UNKNOWN'),
    ...metricsOf(r),
  })).sort(porCosto);
}

const nullIfUnknown = (v: unknown): string | null => {
  const s = text(v);
  return s === '' || s === 'UNSPECIFIED' || s === 'UNKNOWN' ? null : s;
};

export function parseKeywords(rows: AdsRow[]): AdsKeywordRow[] {
  return rows.map((r) => {
    const qs = field(r, 'adGroupCriterion.qualityInfo.qualityScore');
    return {
      criterionId: text(field(r, 'adGroupCriterion.criterionId')),
      text: text(field(r, 'adGroupCriterion.keyword.text')),
      matchType: text(field(r, 'adGroupCriterion.keyword.matchType'), 'UNKNOWN'),
      status: text(field(r, 'adGroupCriterion.status'), 'UNKNOWN'),
      adGroupId: text(field(r, 'adGroup.id')),
      adGroup: text(field(r, 'adGroup.name')),
      campaignId: text(field(r, 'campaign.id')),
      qualityScore: qs === undefined || qs === null ? null : num(qs),
      adRelevance: nullIfUnknown(field(r, 'adGroupCriterion.qualityInfo.creativeQualityScore')),
      landingPage: nullIfUnknown(field(r, 'adGroupCriterion.qualityInfo.postClickQualityScore')),
      expectedCtr: nullIfUnknown(field(r, 'adGroupCriterion.qualityInfo.searchPredictedCtr')),
      ...metricsOf(r),
    };
  }).sort(porCosto).slice(0, TOP.keywords);
}

/**
 * Un mismo término aparece una vez por grupo de anuncios que lo atrapó. Se
 * suma por término y tipo de coincidencia: lo que importa es cuánto costó la
 * búsqueda, no por qué grupo entró.
 */
export function parseSearchTerms(rows: AdsRow[]): AdsSearchTermRow[] {
  const filas = rows.map((r) => ({
    term: text(field(r, 'searchTermView.searchTerm')),
    matchType: text(field(r, 'segments.searchTermMatchType'), 'UNKNOWN'),
    status: text(field(r, 'searchTermView.status'), 'NONE'),
    ...metricsOf(r),
  })).filter((t) => t.term !== '');
  const sumadas = sumBy(filas, (t) => `${t.term}\u0000${t.matchType}`);
  // Si en algún grupo ya es keyword o negativa, eso es lo que vale para el término.
  for (const s of sumadas) {
    const marcado = filas.find((f) => f.term === s.term && f.matchType === s.matchType && f.status !== 'NONE');
    if (marcado !== undefined) s.status = marcado.status;
  }
  return sumadas.sort(porCosto).slice(0, TOP.searchTerms);
}

/** El inventario con las métricas del periodo; los anuncios sin impresiones quedan en cero. */
export function mergeAds(inventory: AdsAdInfo[], metricRows: AdsRow[]): AdsAdRow[] {
  const porId = new Map<string, AdsMetrics>();
  for (const r of metricRows) {
    const id = text(field(r, 'adGroupAd.ad.id'));
    porId.set(id, addMetrics(porId.get(id) ?? ZERO_METRICS, metricsOf(r)));
  }
  return inventory.map((a) => ({ ...a, ...(porId.get(a.adId) ?? ZERO_METRICS) })).sort(porCosto);
}

/** Suma por una etiqueta: dispositivo, página, región, género, edad, día u hora. */
export function labeledBy(rows: AdsRow[], keyOf: (r: AdsRow) => string): AdsLabeledRow[] {
  return sumBy(rows.map((r) => ({ key: keyOf(r) || '(sin dato)', ...metricsOf(r) })), (r) => r.key).sort(porCosto);
}

const DIAS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export function parseSchedule(rows: AdsRow[]): AdsSchedule {
  const byDay = labeledBy(rows, (r) => text(field(r, 'segments.dayOfWeek')))
    .sort((a, b) => DIAS.indexOf(a.key) - DIAS.indexOf(b.key));
  const byHour = labeledBy(rows, (r) => text(field(r, 'segments.hour'), '0'))
    .sort((a, b) => Number(a.key) - Number(b.key));
  return { byDay, byHour };
}

/**
 * Nombres de las regiones: geographic_view solo da el recurso
 * (geoTargetConstants/1010043). Se resuelven todos en una consulta y se
 * guardan en `cache`, que dura la sincronización: los cuatro periodos repiten
 * casi las mismas regiones.
 */
async function geoNames(client: GoogleClient, customerId: string, recursos: string[], cache: Map<string, string>): Promise<void> {
  const faltan = recursos.filter((r) => r.startsWith('geoTargetConstants/') && !cache.has(r));
  if (faltan.length === 0) return;
  const filas = await gaql(client, customerId,
    `SELECT geo_target_constant.resource_name, geo_target_constant.canonical_name
       FROM geo_target_constant
      WHERE geo_target_constant.resource_name IN (${faltan.map((r) => `'${r}'`).join(', ')})`);
  for (const f of filas) {
    cache.set(text(field(f, 'geoTargetConstant.resourceName')), text(field(f, 'geoTargetConstant.canonicalName')));
  }
}

/** Las doce consultas de un periodo, en paralelo. */
export async function fetchAdsPeriod(
  client: GoogleClient,
  customerId: string,
  start: string,
  end: string,
  inventory: AdsAdInfo[],
  geoCache: Map<string, string>,
): Promise<AdsPeriodReports> {
  const d = during(start, end);
  const q = (query: string): Promise<AdsRow[]> => gaql(client, customerId, query);

  const [campaigns, conversions, adGroups, keywords, terms, ads, devices, landing, geo, gender, age, schedule] = await Promise.all([
    q(`SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type,
              campaign_budget.amount_micros, ${METRICS}, metrics.all_conversions, metrics.search_impression_share,
              metrics.search_rank_lost_impression_share, metrics.search_budget_lost_impression_share
         FROM campaign WHERE ${d}`),
    q(`SELECT campaign.id, segments.conversion_action_name, segments.conversion_action_category,
              metrics.conversions, metrics.all_conversions, metrics.conversions_value
         FROM campaign WHERE ${d}`),
    q(`SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ${METRICS} FROM ad_group WHERE ${d}`),
    q(`SELECT campaign.id, ad_group.id, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
              ad_group_criterion.keyword.match_type, ad_group_criterion.status,
              ad_group_criterion.quality_info.quality_score, ad_group_criterion.quality_info.creative_quality_score,
              ad_group_criterion.quality_info.post_click_quality_score, ad_group_criterion.quality_info.search_predicted_ctr,
              ${METRICS}
         FROM keyword_view WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT ${TOP.keywords}`),
    q(`SELECT search_term_view.search_term, search_term_view.status, segments.search_term_match_type, ${METRICS}
         FROM search_term_view WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT 1000`),
    q(`SELECT ad_group_ad.ad.id, ${METRICS} FROM ad_group_ad WHERE ${d}`),
    q(`SELECT segments.device, ${METRICS} FROM campaign WHERE ${d}`),
    q(`SELECT landing_page_view.unexpanded_final_url, ${METRICS}
         FROM landing_page_view WHERE ${d} ORDER BY metrics.cost_micros DESC LIMIT ${TOP.landing}`),
    // Dónde estaba la persona, no lo que le interesaba: es la que cuadra con
    // las regiones a las que se apunta la campaña.
    q(`SELECT segments.geo_target_region, ${METRICS}
         FROM geographic_view WHERE ${d} AND geographic_view.location_type = 'LOCATION_OF_PRESENCE'`),
    q(`SELECT ad_group_criterion.gender.type, ${METRICS} FROM gender_view WHERE ${d}`),
    q(`SELECT ad_group_criterion.age_range.type, ${METRICS} FROM age_range_view WHERE ${d}`),
    q(`SELECT segments.day_of_week, segments.hour, ${METRICS} FROM campaign WHERE ${d}`),
  ]);

  const regiones = [...new Set(geo.map((r) => text(field(r, 'segments.geoTargetRegion'))).filter((r) => r !== ''))];
  await geoNames(client, customerId, regiones, geoCache);

  const campanas = parseCampaigns(campaigns);
  return {
    totals: campanas.reduce<AdsMetrics>((acc, c) => addMetrics(acc, metricsOnly(c)), ZERO_METRICS),
    campaigns: campanas,
    conversionActions: parseConversionActions(conversions),
    adGroups: parseAdGroups(adGroups),
    keywords: parseKeywords(keywords),
    searchTerms: parseSearchTerms(terms),
    ads: mergeAds(inventory, ads),
    devices: labeledBy(devices, (r) => text(field(r, 'segments.device'))),
    landing: labeledBy(landing, (r) => text(field(r, 'landingPageView.unexpandedFinalUrl'))).slice(0, TOP.landing),
    geo: labeledBy(geo, (r) => {
      const rec = text(field(r, 'segments.geoTargetRegion'));
      return rec === '' ? '(sin región)' : (geoCache.get(rec) || rec);
    }).slice(0, TOP.geo),
    gender: labeledBy(gender, (r) => text(field(r, 'adGroupCriterion.gender.type'))),
    age: labeledBy(age, (r) => text(field(r, 'adGroupCriterion.ageRange.type'))),
    schedule: parseSchedule(schedule),
  };
}

function metricsOnly(m: AdsMetrics): AdsMetrics {
  return { impressions: m.impressions, clicks: m.clicks, cost: m.cost, conversions: m.conversions, conversionsValue: m.conversionsValue };
}
