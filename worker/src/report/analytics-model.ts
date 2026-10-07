/**
 * Datos del informe de búsqueda y tráfico, ya resueltos.
 *
 * Igual que model.ts y build.ts para Lighthouse: aquí vive el criterio —qué
 * se compara contra qué, qué se considera un problema, cómo se redacta— y todo
 * es puro, para poder probarlo sin base de datos ni navegador.
 */

import type { Consultant, Priority } from './model.js';
import type { GscDailyRow, GscDimensionRow } from '../google/search-console.js';
import type { GaDailyRow, GaTotals, GaLabeledRow, GaKeyEventRow } from '../google/ga4.js';
import { eachDay, type DateRange } from '../analytics/periods.js';
import { int, pct, isoDate, monthName, ms, esc } from './format.js';

/** Salud de una página según la última auditoría, para cruzarla con su tráfico. */
export interface PageHealth {
  httpStatus: number | null;
  loadMs: number | null;
  ok: boolean;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  /** null si no hubo impresiones. */
  ctr: number | null;
  /** Posición media ponderada por impresiones, como la calcula Google. */
  position: number | null;
}

export interface QueryRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
  /** Posiciones ganadas (positivo) o perdidas (negativo). null si no aparecía antes. */
  positionGain: number | null;
}

export interface PageTrafficRow {
  path: string;
  clicks: number | null;
  impressions: number | null;
  sessions: number | null;
  engagementRate: number | null;
  keyEvents: number | null;
  health: PageHealth | null;
}

export interface ShareRow {
  key: string;
  sessions: number;
  share: number;
  engagementRate: number | null;
  keyEvents: number;
}

export interface AnalyticsReportData {
  consultant: Consultant;
  site: { name: string; url: string };
  generatedAt: Date;
  folio: string;
  period: {
    /** «septiembre de 2026» o «8 sep – 4 oct 2026». */
    label: string;
    previousLabel: string;
    current: DateRange;
    previous: DateRange;
  };
  gsc: null | {
    property: string;
    latestDate: string | null;
    /** Aviso cuando Search Console todavía no publica todo el periodo. */
    coverageNote: string | null;
    totals: GscTotals;
    previousTotals: GscTotals;
    dailyClicks: Array<number | null>;
    previousDailyClicks: Array<number | null>;
    queries: QueryRow[];
    pages: PageTrafficRow[];
  };
  ga: null | {
    property: string;
    totals: GaTotals;
    previousTotals: GaTotals | null;
    dailySessions: Array<number | null>;
    previousDailySessions: Array<number | null>;
    channels: ShareRow[];
    devices: ShareRow[];
    landing: PageTrafficRow[];
    keyEvents: GaKeyEventRow[];
    /** Eventos clave definidos en la propiedad, aunque no hayan ocurrido. */
    keyEventsDefined: string[];
  };
  priorities: Priority[];
}

// ── Cálculos ────────────────────────────────────────────────────────────────

export function gscTotals(rows: GscDailyRow[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let ponderada = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    if (r.position !== null) ponderada += r.position * r.impressions;
  }
  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : null,
    position: impressions > 0 ? Math.round((ponderada / impressions) * 10) / 10 : null,
  };
}

/** Cambio relativo. null cuando no hay base contra qué comparar. */
export function relChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

/**
 * Una serie diaria con un valor por cada día del rango. Los días que Google no
 * devolvió van en cero si ya pasaron —sin impresiones ese día— y en null si
 * caen después del último día publicado, que es «todavía no se sabe».
 */
export function dailySeries<T extends { date: string }>(
  rows: T[],
  range: DateRange,
  pick: (r: T) => number,
  latest: string | null,
): Array<number | null> {
  const porDia = new Map(rows.map((r) => [r.date, pick(r)]));
  return eachDay(range).map((d) => {
    const v = porDia.get(d);
    if (v !== undefined) return v;
    return latest !== null && d > latest ? null : 0;
  });
}

function share(rows: GaLabeledRow[]): ShareRow[] {
  const total = rows.reduce((a, r) => a + r.sessions, 0);
  return rows.map((r) => ({
    key: r.key,
    sessions: r.sessions,
    share: total > 0 ? r.sessions / total : 0,
    engagementRate: r.sessions > 0 ? r.engagedSessions / r.sessions : null,
    keyEvents: r.keyEvents,
  }));
}

/** Ruta de una URL de Search Console, para cruzarla con GA4 y la auditoría. */
export function pathOf(urlOrPath: string): string {
  try {
    const u = new URL(urlOrPath, 'https://x.invalid');
    const p = u.pathname.replace(/\/+$/, '');
    return p === '' ? '/' : p;
  } catch {
    return urlOrPath;
  }
}

export function queryRows(current: GscDimensionRow[], previous: GscDimensionRow[]): QueryRow[] {
  const antes = new Map(previous.map((r) => [r.key, r.position]));
  return current.map((r) => {
    const p = antes.get(r.key);
    return {
      key: r.key,
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.impressions > 0 ? r.clicks / r.impressions : null,
      position: r.position,
      positionGain: p === undefined || p === null || r.position === null ? null : Math.round((p - r.position) * 10) / 10,
    };
  });
}

/** El nombre del canal tal como lo leería un cliente. */
const CANALES: Record<string, string> = {
  'Organic Search': 'Búsqueda orgánica',
  Direct: 'Directo',
  Referral: 'Referido',
  'Organic Social': 'Social orgánico',
  'Paid Search': 'Búsqueda pagada',
  'Paid Social': 'Social pagado',
  Email: 'Correo',
  'Cross-network': 'Varias redes',
  Display: 'Display',
  'Organic Video': 'Video orgánico',
  'Paid Video': 'Video pagado',
  'Organic Shopping': 'Shopping orgánico',
  'Paid Shopping': 'Shopping pagado',
  Affiliates: 'Afiliados',
  'Paid Other': 'Otros pagados',
  SMS: 'SMS',
  Unassigned: 'Sin asignar',
};
const DISPOSITIVOS: Record<string, string> = { mobile: 'Móvil', desktop: 'Escritorio', tablet: 'Tableta', 'smart tv': 'Televisión' };

export function channelLabel(raw: string): string {
  return CANALES[raw] ?? raw;
}
export function deviceLabel(raw: string): string {
  return DISPOSITIVOS[raw.toLowerCase()] ?? raw;
}

// ── Construcción ────────────────────────────────────────────────────────────

export interface BuildAnalyticsInput {
  consultant: Consultant;
  site: { name: string; url: string };
  generatedAt: Date;
  folio: string;
  mode: 'month' | '28d';
  current: DateRange;
  previous: DateRange;
  gsc: null | {
    property: string;
    latestDate: string | null;
    daily: GscDailyRow[];
    previousDaily: GscDailyRow[];
    queries: GscDimensionRow[];
    previousQueries: GscDimensionRow[];
    pages: GscDimensionRow[];
  };
  ga: null | {
    property: string;
    daily: GaDailyRow[];
    previousDaily: GaDailyRow[];
    totals: GaTotals | null;
    previousTotals: GaTotals | null;
    channels: GaLabeledRow[];
    devices: GaLabeledRow[];
    landing: GaLabeledRow[];
    keyEvents: GaKeyEventRow[];
    keyEventsDefined: string[];
  };
  health: Map<string, PageHealth>;
  dropThreshold: number;
}

function rangeLabel(r: DateRange, mode: 'month' | '28d'): string {
  if (mode === 'month') return monthName(r.start);
  return `${isoDate(r.start, false)} – ${isoDate(r.end)}`;
}

/** Totales de GA4 a partir de los días, cuando no hay un total guardado. */
function totalsFromDaily(rows: GaDailyRow[]): GaTotals {
  const t: GaTotals = { sessions: 0, engagedSessions: 0, totalUsers: 0, newUsers: 0, pageViews: 0, keyEvents: 0, avgSessionSeconds: 0 };
  for (const r of rows) {
    t.sessions += r.sessions;
    t.engagedSessions += r.engagedSessions;
    // Suma de usuarios diarios: sobreestima, pero solo se usa si falta el total real.
    t.totalUsers += r.totalUsers;
    t.newUsers += r.newUsers;
    t.pageViews += r.pageViews;
    t.keyEvents += r.keyEvents;
  }
  return t;
}

export function buildAnalyticsReport(input: BuildAnalyticsInput): AnalyticsReportData {
  let gsc: AnalyticsReportData['gsc'] = null;
  if (input.gsc !== null) {
    const g = input.gsc;
    const totals = gscTotals(g.daily);
    const previousTotals = gscTotals(g.previousDaily);
    const incompleto = g.latestDate !== null && g.latestDate < input.current.end;
    gsc = {
      property: g.property,
      latestDate: g.latestDate,
      coverageNote: incompleto && g.latestDate !== null
        ? `Search Console publica con 2 a 3 días de retraso: este periodo tiene datos hasta el ${isoDate(g.latestDate)}.`
        : null,
      totals,
      previousTotals,
      dailyClicks: dailySeries(g.daily, input.current, (r) => r.clicks, g.latestDate),
      previousDailyClicks: dailySeries(g.previousDaily, input.previous, (r) => r.clicks, null),
      queries: queryRows(g.queries, g.previousQueries),
      pages: g.pages.map((p) => {
        const path = pathOf(p.key);
        return {
          path,
          clicks: p.clicks,
          impressions: p.impressions,
          sessions: null,
          engagementRate: null,
          keyEvents: null,
          health: input.health.get(path) ?? null,
        };
      }),
    };
  }

  let ga: AnalyticsReportData['ga'] = null;
  if (input.ga !== null) {
    const a = input.ga;
    const latest = a.daily.length > 0 ? (a.daily[a.daily.length - 1]?.date ?? null) : null;
    ga = {
      property: a.property,
      totals: a.totals ?? totalsFromDaily(a.daily),
      previousTotals: a.previousTotals ?? (a.previousDaily.length > 0 ? totalsFromDaily(a.previousDaily) : null),
      dailySessions: dailySeries(a.daily, input.current, (r) => r.sessions, latest),
      previousDailySessions: dailySeries(a.previousDaily, input.previous, (r) => r.sessions, null),
      channels: share(a.channels).map((r) => ({ ...r, key: channelLabel(r.key) })),
      devices: share(a.devices).map((r) => ({ ...r, key: deviceLabel(r.key) })),
      landing: a.landing.map((l) => {
        const path = pathOf(l.key);
        return {
          path,
          clicks: null,
          impressions: null,
          sessions: l.sessions,
          engagementRate: l.sessions > 0 ? l.engagedSessions / l.sessions : null,
          keyEvents: l.keyEvents,
          health: input.health.get(path) ?? null,
        };
      }),
      keyEvents: a.keyEvents,
      keyEventsDefined: a.keyEventsDefined,
    };
  }

  const base = {
    consultant: input.consultant,
    site: input.site,
    generatedAt: input.generatedAt,
    folio: input.folio,
    period: {
      label: rangeLabel(input.current, input.mode),
      previousLabel: rangeLabel(input.previous, input.mode),
      current: input.current,
      previous: input.previous,
    },
    gsc,
    ga,
  };
  return { ...base, priorities: trafficPriorities({ ...base, priorities: [] }, input.dropThreshold) };
}

/**
 * Páginas con tráfico de las dos fuentes en una sola lista, ordenadas por lo
 * que traen. Es la tabla que cruza tráfico con salud.
 */
export function mergedPages(data: AnalyticsReportData, limit = 12): PageTrafficRow[] {
  const porRuta = new Map<string, PageTrafficRow>();
  for (const p of data.gsc?.pages ?? []) porRuta.set(p.path, { ...p });
  for (const l of data.ga?.landing ?? []) {
    const previo = porRuta.get(l.path);
    if (previo === undefined) porRuta.set(l.path, { ...l });
    else porRuta.set(l.path, { ...previo, sessions: l.sessions, engagementRate: l.engagementRate, keyEvents: l.keyEvents });
  }
  return [...porRuta.values()]
    .filter((p) => p.path !== '(not set)' && p.path !== '')
    .sort((a, b) => (b.clicks ?? 0) + (b.sessions ?? 0) - ((a.clicks ?? 0) + (a.sessions ?? 0)))
    .slice(0, limit);
}

/** Una página con tráfico que la auditoría vio rota o muy lenta. */
export function pageProblem(p: PageTrafficRow): 'down' | 'slow' | null {
  if (p.health === null) return null;
  if (!p.health.ok || (p.health.httpStatus !== null && p.health.httpStatus >= 400)) return 'down';
  if (p.health.loadMs !== null && p.health.loadMs > 4000) return 'slow';
  return null;
}

/**
 * Qué atender primero, según el tráfico.
 *
 * El orden es por costo de no hacerlo: una página con visitas que responde
 * error pierde esas visitas hoy; una caída fuerte de clics es una señal que no
 * conviene dejar pasar; una consulta en la segunda mitad de la primera página
 * es la ganancia más barata que ofrece la búsqueda.
 */
export function trafficPriorities(data: AnalyticsReportData, dropThreshold: number): Priority[] {
  const out: Priority[] = [];
  const visitas = (p: PageTrafficRow): string =>
    p.clicks !== null && p.clicks > 0 ? `${int(p.clicks)} clics` : `${int(p.sessions)} sesiones`;

  for (const p of mergedPages(data, 30)) {
    const problema = pageProblem(p);
    if (problema === 'down') {
      out.push({
        title: `Corregir ${p.path}`,
        detail: `Recibe ${visitas(p)} en el periodo y en la última auditoría respondió ${p.health?.httpStatus ?? 'con error'}. Cada visita que llega ahí se pierde; si la página ya no existe, conviene redirigirla a la más parecida.`,
        impact: visitas(p),
        severity: 'critical',
      });
    }
  }

  if (data.gsc !== null) {
    const cambio = relChange(data.gsc.totals.clicks, data.gsc.previousTotals.clicks);
    if (cambio !== null && cambio <= -dropThreshold / 100) {
      out.push({
        title: 'Investigar la caída de clics desde Google',
        detail: `Los clics bajaron ${pct(-cambio, 0)} contra ${data.period.previousLabel}. Conviene revisar en Search Console si cayó una consulta o una página concreta, o si hubo un problema de indexación.`,
        impact: `${pct(cambio, 0)} clics`,
        severity: 'critical',
      });
    }
  }

  for (const p of mergedPages(data, 30)) {
    if (pageProblem(p) === 'slow' && out.length < 5) {
      out.push({
        title: `Acelerar ${p.path}`,
        detail: `Recibe ${visitas(p)} y tarda ${ms(p.health?.loadMs ?? null)} en cargar. Una página lenta con tráfico pierde visitas antes de que se muestre.`,
        impact: ms(p.health?.loadMs ?? null),
        severity: 'warning',
      });
    }
  }

  // Consultas «al borde»: entre la posición 4 y 15 con impresiones de sobra.
  // Subir unas posiciones ahí multiplica los clics sin crear contenido nuevo.
  const borde = (data.gsc?.queries ?? [])
    .filter((q) => q.position !== null && q.position >= 4 && q.position <= 15 && q.impressions >= 100)
    .sort((a, b) => b.impressions - a.impressions)[0];
  if (borde !== undefined) {
    out.push({
      title: `Mejorar la posición de «${borde.key}»`,
      detail: `Aparece en la posición ${borde.position?.toFixed(1)} con ${int(borde.impressions)} impresiones y ${int(borde.clicks)} clics. Llevarla a las primeras tres posiciones suele multiplicar sus clics.`,
      impact: `${int(borde.impressions)} impr.`,
      severity: 'warning',
    });
  }

  return out.slice(0, 5);
}

/** Párrafo de conclusión del tráfico, redactado a partir de los números. */
export function analyticsVerdict(data: AnalyticsReportData): string {
  const partes: string[] = [];
  const contra = `contra ${data.period.previousLabel}`;

  if (data.gsc !== null) {
    const c = relChange(data.gsc.totals.clicks, data.gsc.previousTotals.clicks);
    if (c === null) {
      partes.push(`El sitio recibió <b>${int(data.gsc.totals.clicks)} clics</b> desde Google en ${data.period.label}.`);
    } else if (Math.abs(c) < 0.03) {
      partes.push(`Los clics desde Google se mantuvieron estables: <b>${int(data.gsc.totals.clicks)}</b> ${contra}.`);
    } else {
      partes.push(`Los clics desde Google ${c > 0 ? 'subieron' : 'bajaron'} <b class="${c > 0 ? 'g' : 'b'}">${pct(Math.abs(c), 1)}</b>, a ${int(data.gsc.totals.clicks)}, ${contra}.`);
    }
    const top = data.gsc.queries[0];
    if (top !== undefined && top.clicks > 0) {
      // Lo que escribe la gente en Google llega tal cual: se escapa aquí
      // porque este párrafo es HTML.
      partes.push(`La consulta que más visitas trae es «${esc(top.key)}».`);
    }
  }

  if (data.ga !== null) {
    const s = relChange(data.ga.totals.sessions, data.ga.previousTotals?.sessions ?? null);
    const tasa = data.ga.totals.sessions > 0 ? data.ga.totals.engagedSessions / data.ga.totals.sessions : null;
    partes.push(
      `En total hubo <b>${int(data.ga.totals.sessions)} sesiones</b>${s === null ? '' : ` (${s >= 0 ? '+' : '−'}${pct(Math.abs(s), 1)})`}${tasa === null ? '' : ` con una tasa de interacción de ${pct(tasa, 0)}`}.`,
    );
    const movil = data.ga.devices.find((d) => d.key === 'Móvil');
    if (movil !== undefined && movil.share >= 0.5) {
      partes.push(`El ${pct(movil.share, 0)} llega desde el celular.`);
    }
    if (data.ga.keyEventsDefined.length === 0 && data.ga.totals.keyEvents === 0) {
      partes.push('La propiedad no tiene eventos clave definidos, así que no se pueden medir conversiones.');
    } else if (data.ga.totals.keyEvents > 0) {
      partes.push(`Se registraron ${int(data.ga.totals.keyEvents)} eventos clave.`);
    }
  }

  const rota = data.priorities.find((p) => p.severity === 'critical' && p.title.startsWith('Corregir'));
  if (rota !== undefined) partes.push(`Hay al menos una página con tráfico que no responde bien: ${esc(rota.title.replace('Corregir ', ''))}.`);

  if (partes.length === 0) partes.push('No hay datos de tráfico para este periodo.');
  return partes.join(' ');
}
