/**
 * Search Console: rendimiento en la búsqueda de Google.
 *
 * Se usa el endpoint REST de Search Analytics directamente. Dos detalles que
 * no son obvios:
 *
 *  - La propiedad va en la ruta, codificada entera: `sc-domain:ejemplo.com`
 *    o `https://www.ejemplo.com/` con su diagonal final. Sin ella, Google
 *    contesta 403 aunque la cuenta sí tenga acceso, porque busca otra propiedad.
 *  - Los días sin impresiones no vienen en la respuesta. No es un hueco de la
 *    sincronización: ese día el sitio no apareció en Google.
 */

import type { GoogleClient } from './client.js';

const BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const API = 'API de Search Console';

export interface GscRow {
  keys?: string[];
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
}

export interface GscDailyRow {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

/** Una consulta o una página con su desempeño en el periodo. */
export interface GscDimensionRow {
  key: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

function encodeProperty(property: string): string {
  return encodeURIComponent(property);
}

/** Redondea la posición a dos decimales, que es lo que cabe en la columna. */
function pos(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

export function parseDailyRows(rows: GscRow[] | undefined): GscDailyRow[] {
  return (rows ?? [])
    .filter((r) => typeof r.keys?.[0] === 'string')
    .map((r) => ({
      date: r.keys?.[0] ?? '',
      clicks: Math.round(r.clicks ?? 0),
      impressions: Math.round(r.impressions ?? 0),
      position: pos(r.position),
    }));
}

export function parseDimensionRows(rows: GscRow[] | undefined): GscDimensionRow[] {
  return (rows ?? [])
    .filter((r) => typeof r.keys?.[0] === 'string')
    .map((r) => ({
      key: r.keys?.[0] ?? '',
      clicks: Math.round(r.clicks ?? 0),
      impressions: Math.round(r.impressions ?? 0),
      position: pos(r.position),
    }));
}

async function query(
  client: GoogleClient,
  property: string,
  body: Record<string, unknown>,
): Promise<GscRow[]> {
  const res = await client.request<{ rows?: GscRow[] }>(
    API,
    `${BASE}/sites/${encodeProperty(property)}/searchAnalytics/query`,
    body,
  );
  return res.rows ?? [];
}

/** Clics, impresiones y posición por día. */
export async function fetchGscDaily(
  client: GoogleClient,
  property: string,
  startDate: string,
  endDate: string,
): Promise<GscDailyRow[]> {
  const rows = await query(client, property, {
    startDate,
    endDate,
    dimensions: ['date'],
    // 16 meses son ~490 filas; el tope sobra.
    rowLimit: 25_000,
    type: 'web',
  });
  return parseDailyRows(rows);
}

/** Consultas o páginas principales del periodo, ordenadas por clics. */
export async function fetchGscTop(
  client: GoogleClient,
  property: string,
  dimension: 'query' | 'page',
  startDate: string,
  endDate: string,
  limit = 50,
): Promise<GscDimensionRow[]> {
  const rows = await query(client, property, {
    startDate,
    endDate,
    dimensions: [dimension],
    rowLimit: limit,
    type: 'web',
  });
  return parseDimensionRows(rows);
}

/** Propiedades a las que la cuenta de servicio tiene acceso real. */
export async function listGscSites(client: GoogleClient): Promise<GscSiteEntry[]> {
  const res = await client.request<{ siteEntry?: GscSiteEntry[] }>(API, `${BASE}/sites`);
  // 'siteUnverifiedUser' aparece cuando alguien agregó la propiedad pero la
  // cuenta no tiene permisos sobre ella: listarla solo invitaría a elegirla.
  return (res.siteEntry ?? [])
    .filter((s) => s.permissionLevel !== 'siteUnverifiedUser')
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}
