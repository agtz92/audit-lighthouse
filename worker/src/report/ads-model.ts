/**
 * Datos de los informes de Google Ads, ya resueltos.
 *
 * Igual que analytics-model.ts: aquí vive el criterio —qué se compara contra
 * qué, qué cuenta como alerta— y todo es puro. Los números de los informes
 * salen de aquí y de ningún otro lado: la capa de Claude recibe este objeto
 * para redactar, pero las tablas y las cifras de las alertas nunca pasan por el
 * modelo de lenguaje.
 */

import type { Consultant, Priority } from './model.js';
import type {
  AdsMetrics, AdsCampaignRow, AdsConversionActionRow, AdsAdGroupRow, AdsKeywordRow, AdsSearchTermRow, AdsAdRow,
  AdsAssetGroupRow, AdsPmaxTermRow, AdsAudienceRow, AdsLabeledRow, AdsSchedule,
} from '../google/ads.js';
import type { PageHealth } from './analytics-model.js';
import { pathOf, rangeLabel, relChange } from './analytics-model.js';
import { eachDay, type DateRange } from '../analytics/periods.js';
import { int, pct, money, ms } from './format.js';

// ── Métricas derivadas ──────────────────────────────────────────────────────

/** Las métricas de Ads con las razones que se calculan de ellas. null si el denominador es cero. */
export interface AdsKpis extends AdsMetrics {
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  convRate: number | null;
  roas: number | null;
}

export function kpisOf(m: AdsMetrics): AdsKpis {
  const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
  return {
    impressions: m.impressions,
    clicks: m.clicks,
    cost: m.cost,
    conversions: m.conversions,
    conversionsValue: m.conversionsValue,
    ctr: div(m.clicks, m.impressions),
    cpc: div(m.cost, m.clicks),
    cpa: div(m.cost, m.conversions),
    convRate: div(m.conversions, m.clicks),
    roas: m.conversionsValue > 0 ? div(m.conversionsValue, m.cost) : null,
  };
}

/** Un día de la cuenta: la suma de sus campañas. */
export interface AdsDayTotals extends AdsMetrics {
  date: string;
}

function sumDays(days: AdsDayTotals[], range: DateRange): AdsMetrics {
  const t: AdsMetrics = { impressions: 0, clicks: 0, cost: 0, conversions: 0, conversionsValue: 0 };
  for (const d of days) {
    if (d.date < range.start || d.date > range.end) continue;
    t.impressions += d.impressions;
    t.clicks += d.clicks;
    t.cost += d.cost;
    t.conversions += d.conversions;
    t.conversionsValue += d.conversionsValue;
  }
  t.cost = Math.round(t.cost * 100) / 100;
  t.conversions = Math.round(t.conversions * 100) / 100;
  return t;
}

// ── Etiquetas ───────────────────────────────────────────────────────────────

const ETIQUETAS: Record<string, string> = {
  MOBILE: 'Móvil', DESKTOP: 'Escritorio', TABLET: 'Tablet', CONNECTED_TV: 'TV', OTHER: 'Otro',
  MALE: 'Hombres', FEMALE: 'Mujeres', UNDETERMINED: 'Sin determinar',
  MONDAY: 'Lunes', TUESDAY: 'Martes', WEDNESDAY: 'Miércoles', THURSDAY: 'Jueves', FRIDAY: 'Viernes', SATURDAY: 'Sábado', SUNDAY: 'Domingo',
  EXACT: 'Exacta', PHRASE: 'Frase', BROAD: 'Amplia', NEAR_EXACT: 'Casi exacta', NEAR_PHRASE: 'Casi frase',
  ENABLED: 'Activa', PAUSED: 'En pausa', REMOVED: 'Eliminada',
  SEARCH: 'Búsqueda', PERFORMANCE_MAX: 'Performance Max', DISPLAY: 'Display', VIDEO: 'Video', SHOPPING: 'Shopping', DEMAND_GEN: 'Demand Gen',
  ABOVE_AVERAGE: 'Superior', AVERAGE: 'Promedio', BELOW_AVERAGE: 'Inferior',
  EXCELLENT: 'Excelente', GOOD: 'Buena', POOR: 'Deficiente', PENDING: 'Pendiente',
  APPROVED: 'Aprobado', APPROVED_LIMITED: 'Limitado', DISAPPROVED: 'Rechazado', AREA_OF_INTEREST_ONLY: 'Solo zona de interés',
  TARGET_SPEND: 'Maximizar clics', MAXIMIZE_CONVERSIONS: 'Maximizar conversiones', MAXIMIZE_CONVERSION_VALUE: 'Maximizar valor',
  TARGET_CPA: 'CPA objetivo', TARGET_ROAS: 'ROAS objetivo', MANUAL_CPC: 'CPC manual', TARGET_IMPRESSION_SHARE: 'Cuota de impr. objetivo',
};

/** Etiqueta en español de un valor de la API; si no se conoce, el valor tal cual. */
export function adsLabel(raw: string): string {
  const edad = /^AGE_RANGE_(\d+)_(\d+)$/.exec(raw);
  if (edad !== null) return `${edad[1]}–${edad[2]}`;
  if (raw === 'AGE_RANGE_65_UP') return '65+';
  if (raw === 'AGE_RANGE_UNDETERMINED') return 'Sin determinar';
  return ETIQUETAS[raw] ?? raw;
}

// ── El informe ──────────────────────────────────────────────────────────────

export interface AdsCampaignLine extends AdsKpis {
  id: string;
  name: string;
  status: string;
  channel: string;
  bidding: string;
  dailyBudget: number | null;
  /** Gasto diario promedio contra el presupuesto diario. 1 = se gasta completo. */
  budgetUse: number | null;
  impressionShare: number | null;
  rankLostShare: number | null;
  budgetLostShare: number | null;
  previous: AdsKpis | null;
}

export type AdsKeywordLine = AdsKeywordRow & AdsKpis;
export type AdsSearchTermLine = AdsSearchTermRow & AdsKpis;

export interface AdsShareLine extends AdsKpis {
  key: string;
  /** Fracción del gasto total. */
  costShare: number;
}

export interface AdsLandingLine extends AdsKpis {
  url: string;
  path: string;
  health: PageHealth | null;
}

/** Una alerta: Priority con el área a la que pertenece, para agruparlas. */
export interface AdsAlert extends Priority {
  area: 'cuenta' | 'presupuesto' | 'keywords' | 'terminos' | 'anuncios' | 'landing' | 'medicion' | 'segmentacion' | 'pmax';
}

export interface AdsReportData {
  consultant: Consultant;
  site: { name: string; url: string };
  generatedAt: Date;
  folio: string;
  customerId: string;
  currency: string;
  period: { label: string; previousLabel: string; current: DateRange; previous: DateRange };
  totals: AdsKpis;
  previousTotals: AdsKpis | null;
  /** Los últimos 7 días con datos contra los 7 previos: la señal más fresca. */
  week: { current: AdsKpis; previous: AdsKpis; range: DateRange; previousRange: DateRange };
  dailyCost: Array<number | null>;
  previousDailyCost: Array<number | null>;
  dailyConversions: Array<number | null>;
  campaigns: AdsCampaignLine[];
  conversionActions: AdsConversionActionRow[];
  adGroups: Array<AdsAdGroupRow & AdsKpis>;
  keywords: AdsKeywordLine[];
  searchTerms: AdsSearchTermLine[];
  ads: AdsAdRow[];
  assetGroups: AdsAssetGroupRow[];
  pmaxTerms: AdsPmaxTermRow[];
  audiences: Array<AdsAudienceRow & AdsKpis>;
  devices: AdsShareLine[];
  landing: AdsLandingLine[];
  geo: AdsShareLine[];
  gender: AdsShareLine[];
  age: AdsShareLine[];
  schedule: { byDay: AdsShareLine[]; byHour: AdsShareLine[] };
  alerts: AdsAlert[];
}

export interface AdsPeriodInput {
  totals: AdsMetrics | null;
  campaigns: AdsCampaignRow[];
  conversionActions: AdsConversionActionRow[];
  adGroups: AdsAdGroupRow[];
  keywords: AdsKeywordRow[];
  searchTerms: AdsSearchTermRow[];
  ads: AdsAdRow[];
  assetGroups: AdsAssetGroupRow[];
  pmaxTerms: AdsPmaxTermRow[];
  audiences: AdsAudienceRow[];
  devices: AdsLabeledRow[];
  landing: AdsLabeledRow[];
  geo: AdsLabeledRow[];
  gender: AdsLabeledRow[];
  age: AdsLabeledRow[];
  schedule: AdsSchedule | null;
}

export interface BuildAdsInput {
  consultant: Consultant;
  site: { name: string; url: string };
  generatedAt: Date;
  folio: string;
  customerId: string;
  currency: string;
  mode: 'month' | '28d';
  current: DateRange;
  previous: DateRange;
  /** Último día con datos: ancla de la comparación de 7 días. */
  latestDate: string;
  /** Días de la cuenta: deben cubrir los dos periodos y las dos semanas. */
  days: AdsDayTotals[];
  now: AdsPeriodInput;
  before: AdsPeriodInput | null;
  health: Map<string, PageHealth>;
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function shareLines(rows: AdsLabeledRow[], label = true): AdsShareLine[] {
  const total = rows.reduce((a, r) => a + r.cost, 0);
  return rows.map((r) => ({ key: label ? adsLabel(r.key) : r.key, ...kpisOf(r), costShare: total > 0 ? r.cost / total : 0 }));
}

function daySeries(days: AdsDayTotals[], range: DateRange, pick: (d: AdsDayTotals) => number, latest: string | null): Array<number | null> {
  const porDia = new Map(days.map((d) => [d.date, d]));
  // Ads no manda días en cero: un día sin fila dentro del rango con datos es
  // un día sin gasto, no un hueco. Después del último día con datos sí es hueco.
  return eachDay(range).map((d) => (latest !== null && d > latest ? null : pick(porDia.get(d) ?? { date: d, impressions: 0, clicks: 0, cost: 0, conversions: 0, conversionsValue: 0 })));
}

export function buildAdsReport(input: BuildAdsInput): AdsReportData {
  const n = input.now;
  const antes = new Map((input.before?.campaigns ?? []).map((c) => [c.id, kpisOf(c)]));
  const diasPeriodo = Math.max(1, eachDay(input.current).filter((d) => d <= input.latestDate).length);

  const totalsNow = n.totals ?? sumDays(input.days, input.current);
  const totalsBefore = input.before === null ? null : (input.before.totals ?? sumDays(input.days, input.previous));

  const semana = { start: addDaysIso(input.latestDate, -6), end: input.latestDate };
  const semanaPrevia = { start: addDaysIso(input.latestDate, -13), end: addDaysIso(input.latestDate, -7) };

  const campaigns: AdsCampaignLine[] = n.campaigns.map((c) => ({
    ...kpisOf(c),
    id: c.id,
    name: c.name,
    status: c.status,
    channel: c.channel,
    bidding: c.bidding,
    dailyBudget: c.dailyBudget,
    budgetUse: c.dailyBudget !== null && c.dailyBudget > 0 ? c.cost / diasPeriodo / c.dailyBudget : null,
    impressionShare: c.impressionShare,
    rankLostShare: c.rankLostShare,
    budgetLostShare: c.budgetLostShare,
    previous: antes.get(c.id) ?? null,
  }));

  const base: Omit<AdsReportData, 'alerts'> = {
    consultant: input.consultant,
    site: input.site,
    generatedAt: input.generatedAt,
    folio: input.folio,
    customerId: input.customerId,
    currency: input.currency,
    period: {
      label: rangeLabel(input.current, input.mode),
      previousLabel: rangeLabel(input.previous, input.mode),
      current: input.current,
      previous: input.previous,
    },
    totals: kpisOf(totalsNow),
    previousTotals: totalsBefore === null ? null : kpisOf(totalsBefore),
    week: {
      current: kpisOf(sumDays(input.days, semana)),
      previous: kpisOf(sumDays(input.days, semanaPrevia)),
      range: semana,
      previousRange: semanaPrevia,
    },
    dailyCost: daySeries(input.days, input.current, (d) => d.cost, input.latestDate),
    previousDailyCost: daySeries(input.days, input.previous, (d) => d.cost, null),
    dailyConversions: daySeries(input.days, input.current, (d) => d.conversions, input.latestDate),
    campaigns,
    conversionActions: n.conversionActions,
    adGroups: n.adGroups.map((g) => ({ ...g, ...kpisOf(g) })),
    keywords: n.keywords.map((k) => ({ ...k, ...kpisOf(k) })),
    searchTerms: n.searchTerms.map((t) => ({ ...t, ...kpisOf(t) })),
    ads: n.ads,
    assetGroups: n.assetGroups,
    pmaxTerms: n.pmaxTerms,
    audiences: n.audiences.map((a) => ({ ...a, ...kpisOf(a) })),
    devices: shareLines(n.devices),
    landing: n.landing.map((l) => {
      const path = pathOf(l.key);
      return { url: l.key, path, ...kpisOf(l), health: input.health.get(path) ?? null };
    }),
    geo: shareLines(n.geo, false),
    gender: shareLines(n.gender),
    age: shareLines(n.age),
    schedule: {
      byDay: shareLines(n.schedule?.byDay ?? []),
      byHour: shareLines(n.schedule?.byHour ?? [], false),
    },
  };
  return { ...base, alerts: adsAlerts(base, input.days, input.latestDate) };
}

// ── Alertas ─────────────────────────────────────────────────────────────────

/**
 * Umbrales de las alertas. Juntos y con nombre para poder discutirlos: son
 * criterio, no física, y una cuenta con poco volumen dispara cosas que en una
 * grande serían ruido.
 */
export const ADS_THRESHOLDS = {
  /** Subida del CPA contra el periodo anterior que amerita aviso, y la que es crítica. */
  cpaRise: 0.15,
  cpaRiseCritical: 0.3,
  /** Conversiones mínimas en el periodo anterior para que comparar el CPA tenga sentido. */
  minConversionsToCompare: 10,
  conversionsDrop: 0.2,
  /** Cuota perdida por presupuesto que ya es mercado que se deja ir. */
  budgetLost: 0.1,
  rankLost: 0.3,
  /** Quality Score que se considera bajo. */
  lowQs: 3,
  /** Una keyword sin conversiones se marca si gastó más que esto veces el CPA de la cuenta. */
  wasteCpaMultiple: 1.5,
  /** Clics sin una sola conversión que hacen sospechar de la medición. */
  trackingClicks: 100,
  /** Un dispositivo cuyo CPA es esto veces el del mejor, con al menos esta parte del gasto. */
  deviceCpaGap: 1.4,
  deviceMinShare: 0.15,
} as const;

/**
 * Qué atender, en orden de costo de no hacerlo: lo que hoy pierde dinero o
 * deja de medir va primero; las mejoras de eficiencia después.
 *
 * Texto plano: las plantillas lo escapan al imprimirlo.
 */
export function adsAlerts(d: Omit<AdsReportData, 'alerts'>, days: AdsDayTotals[], latestDate: string): AdsAlert[] {
  const T = ADS_THRESHOLDS;
  const $ = (v: number | null): string => money(v, d.currency);
  const out: AdsAlert[] = [];
  const cpaCuenta = d.totals.cpa;

  // La cuenta dejó de gastar: los dos últimos días en cero después de dos semanas con gasto.
  const ultimos = [latestDate, addDaysIso(latestDate, -1)].map((f) => days.find((x) => x.date === f)?.cost ?? 0);
  const previos = days.filter((x) => x.date < addDaysIso(latestDate, -1) && x.date >= addDaysIso(latestDate, -15));
  if (ultimos.every((c) => c === 0) && previos.some((x) => x.cost > 0)) {
    out.push({
      area: 'cuenta', severity: 'critical',
      title: 'La cuenta dejó de gastar',
      detail: 'Los dos últimos días no hubo gasto, después de dos semanas con actividad. Suele ser un pago rechazado, campañas pausadas por error o anuncios rechazados.',
      impact: '0 en 2 días',
    });
  }

  // Medición: muchos clics y ninguna conversión en una campaña.
  for (const c of d.campaigns) {
    if (c.clicks >= T.trackingClicks && c.conversions === 0) {
      out.push({
        area: 'medicion', severity: 'critical',
        title: `Revisar la medición de «${c.name}»`,
        detail: `${int(c.clicks)} clics y ${$(c.cost)} de gasto sin una sola conversión. Antes de tocar pujas conviene confirmar que las acciones de conversión siguen disparándose.`,
        impact: $(c.cost),
      });
    }
  }

  // Anuncios rechazados y fuerza deficiente.
  const rechazados = d.ads.filter((a) => a.approval === 'DISAPPROVED');
  if (rechazados.length > 0) {
    out.push({
      area: 'anuncios', severity: 'critical',
      title: `${rechazados.length === 1 ? 'Un anuncio rechazado' : `${rechazados.length} anuncios rechazados`}`,
      detail: `En ${[...new Set(rechazados.map((a) => a.adGroup))].join(', ')}. Un anuncio rechazado no se muestra; hay que corregirlo o apelar.`,
      impact: `${rechazados.length} anuncio${rechazados.length === 1 ? '' : 's'}`,
    });
  }

  // Landing pages pagadas que la auditoría vio caídas o lentas.
  for (const l of d.landing) {
    if (l.health === null || l.cost <= 0) continue;
    const caida = !l.health.ok || (l.health.httpStatus !== null && l.health.httpStatus >= 400);
    const lenta = !caida && l.health.loadMs !== null && l.health.loadMs > 4000;
    if (caida || lenta) {
      out.push({
        area: 'landing', severity: caida ? 'critical' : 'warning',
        title: `${caida ? 'Corregir' : 'Acelerar'} ${l.path}`,
        detail: caida
          ? `Recibe ${$(l.cost)} de gasto en anuncios y en la última auditoría respondió ${l.health.httpStatus ?? 'con error'}. Cada clic que llega ahí se paga y se pierde.`
          : `Recibe ${$(l.cost)} de gasto en anuncios y tarda ${ms(l.health.loadMs)} en cargar. Una página lenta baja la tasa de conversión y la experiencia en la página de destino del Quality Score.`,
        impact: $(l.cost),
      });
    }
  }

  // CPA y conversiones contra el periodo anterior.
  const prev = d.previousTotals;
  if (prev !== null && prev.conversions >= T.minConversionsToCompare) {
    const cpa = relChange(d.totals.cpa, prev.cpa);
    if (cpa !== null && cpa >= T.cpaRise) {
      out.push({
        area: 'cuenta', severity: cpa >= T.cpaRiseCritical ? 'critical' : 'warning',
        title: 'El costo por conversión subió',
        detail: `De ${$(prev.cpa)} a ${$(d.totals.cpa)} (${pct(cpa, 0)} más) contra ${d.period.previousLabel}.`,
        impact: `+${pct(cpa, 0)} CPA`,
      });
    }
    const conv = relChange(d.totals.conversions, prev.conversions);
    if (conv !== null && conv <= -T.conversionsDrop) {
      out.push({
        area: 'cuenta', severity: 'critical',
        title: 'Bajaron las conversiones',
        detail: `De ${int(prev.conversions)} a ${int(d.totals.conversions)} contra ${d.period.previousLabel}.`,
        impact: `${pct(conv, 0)} conv.`,
      });
    }
  }

  // Keywords que gastan sin convertir.
  if (cpaCuenta !== null) {
    const derroche = d.keywords
      .filter((k) => k.conversions === 0 && k.cost >= cpaCuenta * T.wasteCpaMultiple)
      .slice(0, 5);
    if (derroche.length > 0) {
      const total = derroche.reduce((a, k) => a + k.cost, 0);
      out.push({
        area: 'keywords', severity: 'critical',
        title: 'Keywords que gastan sin convertir',
        detail: `${derroche.map((k) => `«${k.text}» (${$(k.cost)})`).join(', ')}. Cada una gastó más de ${T.wasteCpaMultiple}× el costo por conversión de la cuenta (${$(cpaCuenta)}) sin traer ninguna.`,
        impact: $(total),
      });
    }
  }

  // Quality Score bajo con gasto relevante.
  const bajas = d.keywords.filter((k) => k.qualityScore !== null && k.qualityScore <= T.lowQs && k.cost > 0);
  if (bajas.length > 0) {
    const gasto = bajas.reduce((a, k) => a + k.cost, 0);
    const porLanding = bajas.filter((k) => k.landingPage === 'BELOW_AVERAGE').length;
    out.push({
      area: 'keywords', severity: d.totals.cost > 0 && gasto / d.totals.cost >= 0.25 ? 'critical' : 'warning',
      title: `${bajas.length} keyword${bajas.length === 1 ? '' : 's'} con Quality Score de ${T.lowQs} o menos`,
      detail: `Concentran ${$(gasto)}${d.totals.cost > 0 ? `, el ${pct(gasto / d.totals.cost, 0)} del gasto` : ''}. ${porLanding > 0 ? `En ${porLanding} el componente débil es la experiencia en la página de destino: mejorar la página baja el CPC de todas.` : 'Revisa la relevancia del anuncio y el CTR esperado de cada una.'}`,
      impact: $(gasto),
    });
  }

  // Términos de búsqueda que gastaron sin convertir y no son keyword ni negativa.
  if (cpaCuenta !== null) {
    const negativas = d.searchTerms.filter((t) => t.conversions === 0 && t.status === 'NONE' && t.cost >= cpaCuenta).slice(0, 6);
    if (negativas.length > 0) {
      out.push({
        area: 'terminos', severity: 'warning',
        title: 'Términos de búsqueda candidatos a negativa',
        detail: `${negativas.map((t) => `«${t.term}» (${$(t.cost)})`).join(', ')}: gastaron al menos un costo por conversión sin convertir.`,
        impact: $(negativas.reduce((a, t) => a + t.cost, 0)),
      });
    }
  }

  // Presupuesto y ranking.
  for (const c of d.campaigns) {
    if (c.budgetLostShare !== null && c.budgetLostShare >= T.budgetLost) {
      out.push({
        area: 'presupuesto', severity: 'warning',
        title: `«${c.name}» se queda sin presupuesto`,
        detail: `Pierde el ${pct(c.budgetLostShare, 0)} de las impresiones posibles por presupuesto${c.dailyBudget === null ? '' : ` (${$(c.dailyBudget)} al día, se usa el ${pct(c.budgetUse, 0)})`}. Antes de subirlo conviene recortar lo que gasta sin convertir.`,
        impact: `${pct(c.budgetLostShare, 0)} cuota`,
      });
    }
    if (c.rankLostShare !== null && c.rankLostShare >= T.rankLost) {
      out.push({
        area: 'presupuesto', severity: 'warning',
        title: `«${c.name}» pierde subastas por ranking`,
        detail: `El ${pct(c.rankLostShare, 0)} de las impresiones posibles se pierde por ranking: Quality Score o puja. Subir el Quality Score es más barato que subir la puja.`,
        impact: `${pct(c.rankLostShare, 0)} cuota`,
      });
    }
  }

  // Dispositivo con CPA muy por encima del mejor.
  const conCpa = d.devices.filter((x) => x.cpa !== null);
  const mejor = conCpa.reduce<AdsShareLine | null>((a, x) => (a === null || (x.cpa ?? Infinity) < (a.cpa ?? Infinity) ? x : a), null);
  for (const x of conCpa) {
    if (mejor === null || x === mejor || x.cpa === null || mejor.cpa === null) continue;
    if (x.costShare >= T.deviceMinShare && x.cpa >= mejor.cpa * T.deviceCpaGap) {
      out.push({
        area: 'segmentacion', severity: 'warning',
        title: `${x.key}: conversiones más caras`,
        detail: `${x.key} se lleva el ${pct(x.costShare, 0)} del gasto con un costo por conversión de ${$(x.cpa)}, contra ${$(mejor.cpa)} en ${mejor.key}. Un ajuste de puja por dispositivo lo equilibra.`,
        impact: `${$(x.cpa)} vs ${$(mejor.cpa)}`,
      });
    }
  }

  const debiles = d.ads.filter((a) => a.strength === 'POOR' && a.approval !== 'DISAPPROVED');
  if (debiles.length > 0) {
    out.push({
      area: 'anuncios', severity: 'warning',
      title: `${debiles.length === 1 ? 'Un anuncio' : `${debiles.length} anuncios`} con fuerza deficiente`,
      detail: 'Agregar títulos y descripciones distintos entre sí sube la fuerza del anuncio y el número de combinaciones que Google puede probar.',
      impact: `${debiles.length} anuncio${debiles.length === 1 ? '' : 's'}`,
    });
  }

  const noElegibles = d.assetGroups.flatMap((g) => g.assets.filter((a) => a.status === 'NOT_ELIGIBLE').map(() => g.name));
  if (noElegibles.length > 0) {
    out.push({
      area: 'pmax', severity: 'warning',
      title: `${noElegibles.length} asset${noElegibles.length === 1 ? '' : 's'} de PMax no elegible${noElegibles.length === 1 ? '' : 's'}`,
      detail: `En ${[...new Set(noElegibles)].join(', ')}. Un asset no elegible no se muestra y le resta fuerza al asset group.`,
      impact: `${noElegibles.length} asset${noElegibles.length === 1 ? '' : 's'}`,
    });
  }

  const orden = { critical: 0, warning: 1 } as const;
  return out.sort((a, b) => orden[a.severity] - orden[b.severity]);
}

/** Párrafo de conclusión con reglas: lo que dice el informe si Claude no está disponible. */
export function adsVerdict(d: AdsReportData): string {
  const $ = (v: number | null): string => money(v, d.currency);
  const t = d.totals;
  const p = d.previousTotals;
  const partes: string[] = [];
  partes.push(`En ${d.period.label} la cuenta invirtió <b>${$(t.cost)}</b> y obtuvo <b>${int(t.conversions)} conversiones</b>${t.cpa === null ? '' : `, a ${$(t.cpa)} cada una`}.`);
  if (p !== null) {
    const c = relChange(t.conversions, p.conversions);
    const cpa = relChange(t.cpa, p.cpa);
    if (c !== null && cpa !== null) {
      partes.push(`Contra ${d.period.previousLabel}, las conversiones ${c >= 0 ? 'subieron' : 'bajaron'} ${pct(Math.abs(c), 0)} y el costo por conversión ${cpa <= 0 ? 'bajó' : 'subió'} ${pct(Math.abs(cpa), 0)}.`);
    }
  }
  const criticas = d.alerts.filter((a) => a.severity === 'critical').length;
  if (criticas > 0) partes.push(`Hay ${criticas} alerta${criticas === 1 ? '' : 's'} crítica${criticas === 1 ? '' : 's'} que atender primero.`);
  return partes.join(' ');
}

// ── Bloques ─────────────────────────────────────────────────────────────────

export type AdsBlockId =
  | 'resumen' | 'eficiencia' | 'conversiones' | 'tendencia' | 'pmax' | 'cobertura' | 'presupuesto' | 'puja'
  | 'keywords' | 'terminos' | 'geografia' | 'dispositivo' | 'horario' | 'demografia' | 'anuncios' | 'landing'
  | 'audiencias' | 'salud';

/**
 * Los bloques que responden los informes, en orden. Son los de ads-analyst:
 * `ask` es lo que se le pide a Claude, `hasData` decide si el bloque existe
 * (un informe sin PMax no lleva bloque de PMax, en vez de decir «sin datos»).
 */
export const ADS_BLOCKS: Array<{ id: AdsBlockId; title: string; ask: string; hasData: (d: AdsReportData) => boolean }> = [
  { id: 'resumen', title: 'Resumen', ask: 'Foto general: gasto, conversiones, costo por conversión, CTR. ¿Cómo viene la cuenta?', hasData: () => true },
  { id: 'eficiencia', title: 'Eficiencia por campaña', ask: 'Por campaña: gasto, conversiones, costo por conversión y ROAS si hay valor. ¿Cuáles rinden y cuáles desperdician?', hasData: (d) => d.campaigns.length > 0 },
  { id: 'conversiones', title: 'Conversiones por acción', ask: '¿Qué acciones de conversión dominan? ¿Hay acciones que no cuentan en «Conversiones» o medición sospechosa?', hasData: (d) => d.conversionActions.length > 0 },
  { id: 'tendencia', title: 'Tendencia', ask: 'Últimos 7 días contra los 7 previos, y el periodo contra el anterior: qué mejoró, qué empeoró y cuánto.', hasData: (d) => d.previousTotals !== null || d.week.previous.cost > 0 },
  { id: 'pmax', title: 'Performance Max', ask: 'Asset groups (fuerza, gasto, conversiones, assets no elegibles) y categorías de búsqueda. ¿Qué ayuda y qué falla?', hasData: (d) => d.assetGroups.length > 0 },
  { id: 'cobertura', title: 'Cobertura de mercado', ask: 'Cuota de impresiones y lo perdido por ranking y por presupuesto. ¿Dónde se deja ir mercado y por qué?', hasData: (d) => d.campaigns.some((c) => c.impressionShare !== null) },
  { id: 'presupuesto', title: 'Presupuesto', ask: 'Uso del presupuesto diario y pérdida por presupuesto. ¿Qué campañas están topadas? ¿Dónde reasignar?', hasData: (d) => d.campaigns.some((c) => c.dailyBudget !== null) },
  { id: 'puja', title: 'Estrategia de puja y canales', ask: 'Estrategia de puja y canal de cada campaña contra su desempeño. ¿Está funcionando?', hasData: (d) => d.campaigns.length > 0 },
  { id: 'keywords', title: 'Keywords', ask: 'Keywords de más gasto con su Quality Score y conversiones. ¿Cuáles convierten, cuáles desperdician y qué componente del QS falla?', hasData: (d) => d.keywords.length > 0 },
  { id: 'terminos', title: 'Términos de búsqueda', ask: '¿Hay términos irrelevantes para negativizar? ¿Oportunidades para nuevas keywords?', hasData: (d) => d.searchTerms.length > 0 },
  { id: 'geografia', title: 'Geografía', ask: 'Regiones por gasto y conversiones. ¿Dónde rinde mejor o peor?', hasData: (d) => d.geo.length > 0 },
  { id: 'dispositivo', title: 'Dispositivo', ask: 'Desempeño por dispositivo. ¿Conviene ajustar pujas?', hasData: (d) => d.devices.length > 0 },
  { id: 'horario', title: 'Día y hora', ask: '¿Qué días y horas rinden mejor? ¿Conviene programar anuncios?', hasData: (d) => d.schedule.byDay.length > 0 },
  { id: 'demografia', title: 'Demografía', ask: 'Edad y género: ¿qué segmentos rinden mejor o peor?', hasData: (d) => d.age.length > 0 || d.gender.length > 0 },
  { id: 'anuncios', title: 'Anuncios', ask: 'Tipo, fuerza, aprobación, títulos y desempeño. ¿Qué anuncios mejorar?', hasData: (d) => d.ads.length > 0 },
  { id: 'landing', title: 'Páginas de destino', ask: '¿Qué páginas reciben más inversión, cómo convierten y qué dice la auditoría de su velocidad y estado?', hasData: (d) => d.landing.length > 0 },
  { id: 'audiencias', title: 'Audiencias', ask: '¿Qué audiencias rinden? ¿Algo que escalar o excluir?', hasData: (d) => d.audiences.length > 0 },
  { id: 'salud', title: 'Salud y alertas', ask: 'Medición sospechosa, desperdicio evidente, anuncios rechazados, campañas sin entrega.', hasData: () => true },
];
