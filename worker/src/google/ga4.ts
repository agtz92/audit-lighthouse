/**
 * Google Analytics 4: Data API para los números y Admin API para saber qué
 * eventos clave tiene definidos cada propiedad.
 *
 * Los informes de un mismo periodo se piden juntos con batchRunReports, que
 * acepta hasta cinco por llamada: totales, canales, dispositivos, páginas de
 * entrada y eventos clave salen en un solo viaje en vez de cinco.
 */

import type { GoogleClient } from './client.js';

const DATA = 'https://analyticsdata.googleapis.com/v1beta';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const API_DATA = 'API de Google Analytics Data';
const API_ADMIN = 'API de Google Analytics Admin';

interface Value { value?: string }
interface ReportRow { dimensionValues?: Value[]; metricValues?: Value[] }
export interface Report {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
  rows?: ReportRow[];
}

/** Una fila con sus dimensiones y métricas ya nombradas. */
export type NamedRow = { dims: Record<string, string>; mets: Record<string, number> };

/** Convierte las filas posicionales de GA4 en objetos con nombre. */
export function namedRows(report: Report | undefined): NamedRow[] {
  if (report === undefined) return [];
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name ?? '');
  const mets = (report.metricHeaders ?? []).map((h) => h.name ?? '');
  return (report.rows ?? []).map((row) => ({
    dims: Object.fromEntries(dims.map((n, i) => [n, row.dimensionValues?.[i]?.value ?? ''])),
    mets: Object.fromEntries(mets.map((n, i) => {
      const v = Number(row.metricValues?.[i]?.value ?? 0);
      return [n, Number.isFinite(v) ? v : 0];
    })),
  }));
}

/** GA4 entrega la fecha como 20261004. */
export function gaDate(raw: string): string {
  return /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw;
}

export interface GaDailyRow {
  date: string;
  sessions: number;
  engagedSessions: number;
  totalUsers: number;
  newUsers: number;
  pageViews: number;
  keyEvents: number;
}

const DAILY_METRICS = ['sessions', 'engagedSessions', 'totalUsers', 'newUsers', 'screenPageViews', 'keyEvents'];

export function parseDaily(report: Report | undefined): GaDailyRow[] {
  return namedRows(report).map((r) => ({
    date: gaDate(r.dims.date ?? ''),
    sessions: Math.round(r.mets.sessions ?? 0),
    engagedSessions: Math.round(r.mets.engagedSessions ?? 0),
    totalUsers: Math.round(r.mets.totalUsers ?? 0),
    newUsers: Math.round(r.mets.newUsers ?? 0),
    pageViews: Math.round(r.mets.screenPageViews ?? 0),
    keyEvents: Math.round((r.mets.keyEvents ?? 0) * 100) / 100,
  })).sort((a, b) => a.date.localeCompare(b.date));
}

function prop(id: string): string {
  return `properties/${id}`;
}

export async function fetchGaDaily(
  client: GoogleClient,
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<GaDailyRow[]> {
  const report = await client.request<Report>(API_DATA, `${DATA}/${prop(propertyId)}:runReport`, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'date' }],
    metrics: DAILY_METRICS.map((name) => ({ name })),
    limit: 2000,
    keepEmptyRows: true,
  });
  return parseDaily(report);
}

/** Totales del periodo. Aquí sí cuadran los usuarios: no se suman entre días. */
export interface GaTotals {
  sessions: number;
  engagedSessions: number;
  totalUsers: number;
  newUsers: number;
  pageViews: number;
  keyEvents: number;
  avgSessionSeconds: number;
}

export interface GaLabeledRow {
  key: string;
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
}

export interface GaKeyEventRow {
  name: string;
  count: number;
}

export interface GaPeriodReports {
  totals: GaTotals;
  channels: GaLabeledRow[];
  devices: GaLabeledRow[];
  landing: GaLabeledRow[];
  keyEvents: GaKeyEventRow[];
}

const BREAKDOWN_METRICS = [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }];

function labeled(report: Report | undefined, dim: string): GaLabeledRow[] {
  return namedRows(report).map((r) => ({
    key: r.dims[dim] || '(sin dato)',
    sessions: Math.round(r.mets.sessions ?? 0),
    engagedSessions: Math.round(r.mets.engagedSessions ?? 0),
    keyEvents: Math.round((r.mets.keyEvents ?? 0) * 100) / 100,
  }));
}

export function parsePeriodReports(reports: Report[]): GaPeriodReports {
  const t = namedRows(reports[0])[0]?.mets ?? {};
  return {
    totals: {
      sessions: Math.round(t.sessions ?? 0),
      engagedSessions: Math.round(t.engagedSessions ?? 0),
      totalUsers: Math.round(t.totalUsers ?? 0),
      newUsers: Math.round(t.newUsers ?? 0),
      pageViews: Math.round(t.screenPageViews ?? 0),
      keyEvents: Math.round((t.keyEvents ?? 0) * 100) / 100,
      avgSessionSeconds: Math.round(t.averageSessionDuration ?? 0),
    },
    channels: labeled(reports[1], 'sessionDefaultChannelGroup'),
    devices: labeled(reports[2], 'deviceCategory'),
    landing: labeled(reports[3], 'landingPage'),
    keyEvents: namedRows(reports[4])
      .map((r) => ({ name: r.dims.eventName ?? '', count: Math.round((r.mets.keyEvents ?? 0) * 100) / 100 }))
      .filter((r) => r.name !== '' && r.count > 0),
  };
}

/** Los cinco informes de un periodo en una sola llamada. */
export async function fetchGaPeriod(
  client: GoogleClient,
  propertyId: string,
  startDate: string,
  endDate: string,
): Promise<GaPeriodReports> {
  const dateRanges = [{ startDate, endDate }];
  const porSesiones = [{ metric: { metricName: 'sessions' }, desc: true }];
  const res = await client.request<{ reports?: Report[] }>(API_DATA, `${DATA}/${prop(propertyId)}:batchRunReports`, {
    requests: [
      {
        dateRanges,
        metrics: [...DAILY_METRICS, 'averageSessionDuration'].map((name) => ({ name })),
      },
      { dateRanges, dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: BREAKDOWN_METRICS, orderBys: porSesiones, limit: 20 },
      { dateRanges, dimensions: [{ name: 'deviceCategory' }], metrics: BREAKDOWN_METRICS, orderBys: porSesiones, limit: 10 },
      { dateRanges, dimensions: [{ name: 'landingPage' }], metrics: BREAKDOWN_METRICS, orderBys: porSesiones, limit: 50 },
      {
        dateRanges,
        dimensions: [{ name: 'eventName' }],
        metrics: [{ name: 'keyEvents' }],
        orderBys: [{ metric: { metricName: 'keyEvents' }, desc: true }],
        limit: 50,
      },
    ],
  });
  return parsePeriodReports(res.reports ?? []);
}

/**
 * Nombres de los eventos clave definidos en la propiedad.
 *
 * Usa la Admin API, que es otra API que hay que habilitar en Google Cloud. Si
 * no lo está, la sincronización sigue: esto es información de apoyo, no un dato
 * del que dependan los números.
 */
export async function fetchKeyEventNames(client: GoogleClient, propertyId: string): Promise<string[]> {
  const nombres: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${ADMIN}/${prop(propertyId)}/keyEvents`);
    url.searchParams.set('pageSize', '200');
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const res = await client.request<{ keyEvents?: Array<{ eventName?: string }>; nextPageToken?: string }>(
      API_ADMIN,
      url.toString(),
    );
    for (const k of res.keyEvents ?? []) if (typeof k.eventName === 'string') nombres.push(k.eventName);
    pageToken = res.nextPageToken || undefined;
  } while (pageToken !== undefined);
  return nombres.sort();
}

export interface GaPropertySummary {
  id: string;
  name: string;
  account: string;
}

/** Propiedades de GA4 a las que la cuenta de servicio tiene acceso. */
export async function listGaProperties(client: GoogleClient): Promise<GaPropertySummary[]> {
  const out: GaPropertySummary[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${ADMIN}/accountSummaries`);
    url.searchParams.set('pageSize', '200');
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const res = await client.request<{
      accountSummaries?: Array<{
        displayName?: string;
        propertySummaries?: Array<{ property?: string; displayName?: string }>;
      }>;
      nextPageToken?: string;
    }>(API_ADMIN, url.toString());
    for (const acc of res.accountSummaries ?? []) {
      for (const p of acc.propertySummaries ?? []) {
        const id = (p.property ?? '').replace(/^properties\//, '');
        if (id !== '') out.push({ id, name: p.displayName ?? id, account: acc.displayName ?? '' });
      }
    }
    pageToken = res.nextPageToken || undefined;
  } while (pageToken !== undefined);
  return out.sort((a, b) => `${a.account} ${a.name}`.localeCompare(`${b.account} ${b.name}`));
}
