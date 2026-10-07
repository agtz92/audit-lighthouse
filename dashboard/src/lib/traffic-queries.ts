/**
 * Consultas de tráfico (Search Console y GA4) para el dashboard.
 *
 * Los periodos se calculan aquí desde las series diarias, no desde los
 * desgloses guardados: así el selector de 28, 90 y 365 días funciona sin que
 * la sincronización tenga que precalcular cada combinación. Lo único que no se
 * puede sumar entre días son los usuarios, y por eso el panorama no los
 * muestra: sumar usuarios diarios contaría dos veces a quien volvió.
 *
 * Cada fuente se ancla en su último día con datos. Search Console publica con
 * 2 a 3 días de retraso; anclar en ayer dejaría los últimos días en cero y
 * todas las comparaciones sesgadas a la baja.
 */

import { query } from './db';

export const TRAFFIC_RANGES = [28, 90, 365] as const;
export type TrafficRange = (typeof TRAFFIC_RANGES)[number];

export function parseTrafficRange(raw: string | undefined): TrafficRange {
  const n = Number(raw);
  return (TRAFFIC_RANGES as readonly number[]).includes(n) ? (n as TrafficRange) : 28;
}

export type SourceStatus = 'ok' | 'error' | 'off';

export interface GscPeriod {
  clicks: number;
  impressions: number;
  ctr: number | null;
  position: number | null;
}

export interface GaPeriod {
  sessions: number;
  engagedSessions: number;
  keyEvents: number;
  engagementRate: number | null;
}

export interface TrafficOverviewRow {
  siteId: string;
  name: string;
  /** Lo que dice la última sincronización de cada fuente. null si nunca se sincronizó. */
  gscStatus: SourceStatus | null;
  gaStatus: SourceStatus | null;
  gscError: string | null;
  gaError: string | null;
  gscLatest: string | null;
  gaLatest: string | null;
  gsc: GscPeriod | null;
  gscPrev: GscPeriod | null;
  ga: GaPeriod | null;
  gaPrev: GaPeriod | null;
  /** Clics por día (o por semana en 365 días), para la tendencia. */
  spark: number[];
  mobilePerformance: number | null;
  keyEventsDefined: number;
}

function gscPeriod(clicks: number | null, impressions: number | null, posW: number | null): GscPeriod | null {
  if (clicks === null && impressions === null) return null;
  const c = clicks ?? 0;
  const i = impressions ?? 0;
  return {
    clicks: c,
    impressions: i,
    ctr: i > 0 ? c / i : null,
    position: i > 0 && posW !== null ? Math.round((posW / i) * 10) / 10 : null,
  };
}

function gaPeriod(sessions: number | null, engaged: number | null, keyEvents: number | null): GaPeriod | null {
  if (sessions === null) return null;
  return {
    sessions,
    engagedSessions: engaged ?? 0,
    keyEvents: keyEvents ?? 0,
    engagementRate: sessions > 0 ? (engaged ?? 0) / sessions : null,
  };
}

/** Agrupa una serie diaria por semanas, para que 365 puntos quepan en una tendencia de 96 px. */
function semanal(valores: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < valores.length; i += 7) out.push(valores.slice(i, i + 7).reduce((a, v) => a + v, 0));
  return out;
}

export async function fetchTrafficOverview(days: TrafficRange): Promise<TrafficOverviewRow[]> {
  const rows = await query<{
    site_id: string; name: string;
    gsc_status: SourceStatus | null; ga_status: SourceStatus | null; gsc_error: string | null; ga_error: string | null;
    gsc_latest: string | null; ga_latest: string | null; key_events: string[] | null;
    clicks: number | null; impressions: number | null; pos_w: number | null;
    p_clicks: number | null; p_impressions: number | null; p_pos_w: number | null;
    sessions: number | null; engaged: number | null; kev: number | null;
    p_sessions: number | null; p_engaged: number | null; p_kev: number | null;
    perf: number | null;
  }>(`
    WITH ga_anchor AS (SELECT site_id, max(date) AS anchor, min(date) AS first FROM ga_daily GROUP BY site_id),
    gsc_anchor AS (SELECT site_id, max(date) AS anchor, min(date) AS first FROM gsc_daily GROUP BY site_id),
    gsc AS (
      SELECT d.site_id,
             sum(d.clicks)                     FILTER (WHERE d.date >  a.anchor - $1::int) AS clicks,
             sum(d.impressions)                FILTER (WHERE d.date >  a.anchor - $1::int) AS impressions,
             sum(d.position * d.impressions)   FILTER (WHERE d.date >  a.anchor - $1::int) AS pos_w,
             sum(d.clicks)                     FILTER (WHERE d.date <= a.anchor - $1::int) AS p_clicks,
             sum(d.impressions)                FILTER (WHERE d.date <= a.anchor - $1::int) AS p_impressions,
             sum(d.position * d.impressions)   FILTER (WHERE d.date <= a.anchor - $1::int) AS p_pos_w
        FROM gsc_daily d JOIN gsc_anchor a USING (site_id)
       WHERE d.date > a.anchor - 2 * $1::int
       GROUP BY d.site_id
    ),
    ga AS (
      SELECT d.site_id,
             sum(d.sessions)         FILTER (WHERE d.date >  a.anchor - $1::int) AS sessions,
             sum(d.engaged_sessions) FILTER (WHERE d.date >  a.anchor - $1::int) AS engaged,
             sum(d.key_events)       FILTER (WHERE d.date >  a.anchor - $1::int) AS kev,
             sum(d.sessions)         FILTER (WHERE d.date <= a.anchor - $1::int) AS p_sessions,
             sum(d.engaged_sessions) FILTER (WHERE d.date <= a.anchor - $1::int) AS p_engaged,
             sum(d.key_events)       FILTER (WHERE d.date <= a.anchor - $1::int) AS p_kev
        FROM ga_daily d JOIN ga_anchor a USING (site_id)
       WHERE d.date > a.anchor - 2 * $1::int
       GROUP BY d.site_id
    ),
    ultima AS (
      SELECT DISTINCT ON (site_id) *
        FROM analytics_site_runs WHERE status <> 'running'
       ORDER BY site_id, started_at DESC
    ),
    lh AS (
      SELECT DISTINCT ON (site_id) site_id, performance
        FROM lighthouse_results
       WHERE strategy = 'mobile' AND performance IS NOT NULL
       ORDER BY site_id, created_at DESC
    )
    SELECT s.id AS site_id, s.name,
           u.gsc_status, u.ga_status, u.gsc_error, u.ga_error, u.ga_key_events AS key_events,
           to_char(gsa.anchor, 'YYYY-MM-DD') AS gsc_latest, to_char(gaa.anchor, 'YYYY-MM-DD') AS ga_latest,
           gsc.clicks, gsc.impressions, gsc.pos_w,
           -- El periodo anterior solo cuenta si la historia lo cubre completo:
           -- uno a medias haría parecer que el tráfico se disparó.
           CASE WHEN gsa.first <= gsa.anchor - (2 * $1::int - 1) THEN gsc.p_clicks END AS p_clicks,
           CASE WHEN gsa.first <= gsa.anchor - (2 * $1::int - 1) THEN gsc.p_impressions END AS p_impressions,
           CASE WHEN gsa.first <= gsa.anchor - (2 * $1::int - 1) THEN gsc.p_pos_w END AS p_pos_w,
           ga.sessions, ga.engaged, ga.kev,
           CASE WHEN gaa.first <= gaa.anchor - (2 * $1::int - 1) THEN ga.p_sessions END AS p_sessions,
           CASE WHEN gaa.first <= gaa.anchor - (2 * $1::int - 1) THEN ga.p_engaged END AS p_engaged,
           CASE WHEN gaa.first <= gaa.anchor - (2 * $1::int - 1) THEN ga.p_kev END AS p_kev,
           lh.performance AS perf
      FROM sites s
      LEFT JOIN ultima u ON u.site_id = s.id
      LEFT JOIN gsc_anchor gsa ON gsa.site_id = s.id
      LEFT JOIN ga_anchor gaa ON gaa.site_id = s.id
      LEFT JOIN gsc ON gsc.site_id = s.id
      LEFT JOIN ga ON ga.site_id = s.id
      LEFT JOIN lh ON lh.site_id = s.id
     WHERE s.removed_from_yaml_at IS NULL
  `, [days]);

  // La tendencia: clics por día del rango, rellenando con cero los días sin filas.
  const serie = await query<{ site_id: string; d: string; clicks: number }>(`
    SELECT d.site_id, to_char(d.date, 'YYYY-MM-DD') AS d, d.clicks
      FROM gsc_daily d
      JOIN (SELECT site_id, max(date) AS anchor FROM gsc_daily GROUP BY site_id) a USING (site_id)
     WHERE d.date > a.anchor - $1::int
     ORDER BY d.site_id, d.date
  `, [days]);
  const porSitio = new Map<string, Map<string, number>>();
  for (const r of serie) {
    const m = porSitio.get(r.site_id) ?? new Map<string, number>();
    m.set(r.d, r.clicks);
    porSitio.set(r.site_id, m);
  }

  return rows.map((r) => {
    let spark: number[] = [];
    const m = porSitio.get(r.site_id);
    if (m !== undefined && r.gsc_latest !== null) {
      const fin = new Date(`${r.gsc_latest}T00:00:00Z`);
      for (let i = days - 1; i >= 0; i -= 1) {
        const d = new Date(fin);
        d.setUTCDate(d.getUTCDate() - i);
        spark.push(m.get(d.toISOString().slice(0, 10)) ?? 0);
      }
      if (days > 90) spark = semanal(spark);
    }
    return {
      siteId: r.site_id,
      name: r.name,
      gscStatus: r.gsc_status,
      gaStatus: r.ga_status,
      gscError: r.gsc_error,
      gaError: r.ga_error,
      gscLatest: r.gsc_latest,
      gaLatest: r.ga_latest,
      gsc: gscPeriod(r.clicks, r.impressions, r.pos_w),
      gscPrev: gscPeriod(r.p_clicks, r.p_impressions, r.p_pos_w),
      ga: gaPeriod(r.sessions, r.engaged, r.kev),
      gaPrev: gaPeriod(r.p_sessions, r.p_engaged, r.p_kev),
      spark,
      mobilePerformance: r.perf,
      keyEventsDefined: r.key_events?.length ?? 0,
    };
  });
}

export interface AnalyticsRunInfo {
  id: number;
  trigger: string;
  status: 'running' | 'ok' | 'partial' | 'failed';
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  notes: string | null;
  /** Por sitio: qué fuente falló y por qué. */
  problems: Array<{ siteId: string; gscError: string | null; gaError: string | null }>;
}

export async function fetchAnalyticsRuns(limit = 30): Promise<AnalyticsRunInfo[]> {
  const rows = await query<{
    id: number; trigger: string; status: AnalyticsRunInfo['status']; started_at: Date; finished_at: Date | null;
    duration_ms: number | null; sites_total: number; sites_ok: number; sites_failed: number; notes: string | null;
    problems: AnalyticsRunInfo['problems'] | null;
  }>(`
    SELECT r.*,
           (SELECT jsonb_agg(jsonb_build_object('siteId', sr.site_id, 'gscError', sr.gsc_error, 'gaError', sr.ga_error) ORDER BY sr.site_id)
              FROM analytics_site_runs sr
             WHERE sr.run_id = r.id AND (sr.gsc_status = 'error' OR sr.ga_status = 'error' OR sr.status = 'failed')) AS problems
      FROM analytics_runs r
     ORDER BY r.started_at DESC
     LIMIT $1
  `, [limit]);
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    sitesTotal: r.sites_total,
    sitesOk: r.sites_ok,
    sitesFailed: r.sites_failed,
    notes: r.notes,
    problems: r.problems ?? [],
  }));
}

// ── Detalle de un sitio ─────────────────────────────────────────────────────

export interface DailyPair {
  /** Fecha del periodo actual (YYYY-MM-DD). */
  date: string;
  current: number | null;
  previous: number | null;
}

export interface SiteTraffic {
  gscLatest: string | null;
  gaLatest: string | null;
  gscStatus: SourceStatus | null;
  gaStatus: SourceStatus | null;
  gscError: string | null;
  gaError: string | null;
  lastSyncAt: Date | null;
  keyEventsDefined: string[];
  gsc: GscPeriod | null;
  gscPrev: GscPeriod | null;
  ga: GaPeriod | null;
  gaPrev: GaPeriod | null;
  series: {
    clicks: DailyPair[];
    impressions: DailyPair[];
    position: DailyPair[];
    sessions: DailyPair[];
    users: DailyPair[];
    keyEvents: DailyPair[];
  };
  breakdowns: {
    range: { start: string; end: string } | null;
    queries: Array<{ key: string; clicks: number; impressions: number; position: number | null; prevPosition: number | null }>;
    pages: Array<{ key: string; clicks: number; impressions: number; position: number | null }>;
    channels: Array<{ key: string; sessions: number; engagedSessions: number; keyEvents: number }>;
    devices: Array<{ key: string; sessions: number; engagedSessions: number; keyEvents: number }>;
    landing: Array<{ key: string; sessions: number; engagedSessions: number; keyEvents: number }>;
    keyEvents: Array<{ name: string; count: number }>;
  };
  /** Estado de cada ruta en la última auditoría, para cruzarlo con el tráfico. */
  health: Record<string, { httpStatus: number | null; loadMs: number | null; ok: boolean }>;
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Dos periodos consecutivos alineados día a día: el actual contra el anterior.
 *
 * Un día sin fila vale cero si cae después del primer día guardado —ese día
 * no hubo nada—, y null si cae antes: ahí no es que no hubo, es que todavía no
 * se sabe. Sin esa distinción, un sitio conectado hace dos semanas mostraría un
 * periodo anterior plano en cero, como si el tráfico se hubiera disparado.
 */
function pares(rows: Map<string, number>, anchor: string, days: number, desde: string | null): DailyPair[] {
  const valor = (d: string): number | null => (desde === null || d < desde ? null : rows.get(d) ?? 0);
  const out: DailyPair[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = addDays(anchor, -i);
    out.push({ date: d, current: valor(d), previous: valor(addDays(d, -days)) });
  }
  return out;
}

/** Normaliza una ruta para cruzar Search Console, GA4 y la auditoría. */
export function pathKey(urlOrPath: string): string {
  let p = urlOrPath;
  try {
    p = new URL(urlOrPath, 'https://x.invalid').pathname;
  } catch {
    // se queda igual
  }
  p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

export async function fetchSiteTraffic(siteId: string, days: TrafficRange): Promise<SiteTraffic> {
  const [estado] = await query<{
    gsc_status: SourceStatus; ga_status: SourceStatus; gsc_error: string | null; ga_error: string | null;
    finished_at: Date | null; ga_key_events: string[];
  }>(`
    SELECT gsc_status, ga_status, gsc_error, ga_error, finished_at, ga_key_events
      FROM analytics_site_runs WHERE site_id = $1 AND status <> 'running'
     ORDER BY started_at DESC LIMIT 1
  `, [siteId]);

  const [anclas] = await query<{ gsc: string | null; ga: string | null; gsc_first: string | null; ga_first: string | null }>(`
    SELECT (SELECT to_char(max(date), 'YYYY-MM-DD') FROM gsc_daily WHERE site_id = $1) AS gsc,
           (SELECT to_char(max(date), 'YYYY-MM-DD') FROM ga_daily  WHERE site_id = $1) AS ga,
           (SELECT to_char(min(date), 'YYYY-MM-DD') FROM gsc_daily WHERE site_id = $1) AS gsc_first,
           (SELECT to_char(min(date), 'YYYY-MM-DD') FROM ga_daily  WHERE site_id = $1) AS ga_first
  `, [siteId]);
  const gscLatest = anclas?.gsc ?? null;
  const gaLatest = anclas?.ga ?? null;
  const gscFirst = anclas?.gsc_first ?? null;
  const gaFirst = anclas?.ga_first ?? null;

  const gscRows = gscLatest === null ? [] : await query<{ d: string; clicks: number; impressions: number; position: number | null }>(`
    SELECT to_char(date, 'YYYY-MM-DD') AS d, clicks, impressions, position
      FROM gsc_daily WHERE site_id = $1 AND date > $2::date - 2 * $3::int ORDER BY date
  `, [siteId, gscLatest, days]);
  const gaRows = gaLatest === null ? [] : await query<{ d: string; sessions: number; engaged_sessions: number; total_users: number; key_events: number }>(`
    SELECT to_char(date, 'YYYY-MM-DD') AS d, sessions, engaged_sessions, total_users, key_events
      FROM ga_daily WHERE site_id = $1 AND date > $2::date - 2 * $3::int ORDER BY date
  `, [siteId, gaLatest, days]);

  const mapa = <T extends { d: string }>(rs: T[], f: (r: T) => number | null): Map<string, number> =>
    new Map(rs.flatMap((r) => {
      const v = f(r);
      return v === null ? [] : [[r.d, v] as [string, number]];
    }));

  // El periodo anterior se compara solo si la historia lo cubre completo.
  const sumaGsc = (desde: string, hasta: string, completo = false): GscPeriod | null => {
    if (completo && (gscFirst === null || desde < gscFirst)) return null;
    const sel = gscRows.filter((r) => r.d >= desde && r.d <= hasta);
    if (sel.length === 0) return null;
    const c = sel.reduce((a, r) => a + r.clicks, 0);
    const i = sel.reduce((a, r) => a + r.impressions, 0);
    const w = sel.reduce((a, r) => a + (r.position ?? 0) * r.impressions, 0);
    return gscPeriod(c, i, w);
  };
  const sumaGa = (desde: string, hasta: string, completo = false): GaPeriod | null => {
    if (completo && (gaFirst === null || desde < gaFirst)) return null;
    const sel = gaRows.filter((r) => r.d >= desde && r.d <= hasta);
    if (sel.length === 0) return null;
    return gaPeriod(
      sel.reduce((a, r) => a + r.sessions, 0),
      sel.reduce((a, r) => a + r.engaged_sessions, 0),
      sel.reduce((a, r) => a + r.key_events, 0),
    );
  };

  const breakdowns = await query<{ period: string; kind: string; rows: unknown; s: string; e: string }>(`
    SELECT period, kind, rows, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e
      FROM analytics_breakdowns WHERE site_id = $1 AND period IN ('last28', 'prev28')
  `, [siteId]);
  const bd = <T>(period: string, kind: string): T[] => {
    const b = breakdowns.find((x) => x.period === period && x.kind === kind);
    return Array.isArray(b?.rows) ? (b.rows as T[]) : [];
  };
  const rango = breakdowns.find((b) => b.period === 'last28');
  const prevPos = new Map(bd<{ key: string; position: number | null }>('prev28', 'gsc_queries').map((q) => [q.key, q.position]));

  const salud = await query<{ url: string; http_status: number | null; load_ms: number | null; ok: boolean }>(`
    SELECT url, http_status, load_ms, ok FROM page_results
     WHERE site_run_id = (SELECT id FROM site_runs WHERE site_id = $1 AND status IN ('ok', 'partial') ORDER BY started_at DESC LIMIT 1)
  `, [siteId]);

  return {
    gscLatest,
    gaLatest,
    gscStatus: estado?.gsc_status ?? null,
    gaStatus: estado?.ga_status ?? null,
    gscError: estado?.gsc_error ?? null,
    gaError: estado?.ga_error ?? null,
    lastSyncAt: estado?.finished_at ?? null,
    keyEventsDefined: estado?.ga_key_events ?? [],
    gsc: gscLatest === null ? null : sumaGsc(addDays(gscLatest, 1 - days), gscLatest),
    gscPrev: gscLatest === null ? null : sumaGsc(addDays(gscLatest, 1 - 2 * days), addDays(gscLatest, -days), true),
    ga: gaLatest === null ? null : sumaGa(addDays(gaLatest, 1 - days), gaLatest),
    gaPrev: gaLatest === null ? null : sumaGa(addDays(gaLatest, 1 - 2 * days), addDays(gaLatest, -days), true),
    series: {
      clicks: gscLatest === null ? [] : pares(mapa(gscRows, (r) => r.clicks), gscLatest, days, gscFirst),
      impressions: gscLatest === null ? [] : pares(mapa(gscRows, (r) => r.impressions), gscLatest, days, gscFirst),
      position: gscLatest === null ? [] : pares(mapa(gscRows, (r) => r.position), gscLatest, days, gscFirst).map((p) => ({
        // Un día sin impresiones no tiene posición: cero sería «primer lugar».
        ...p, current: p.current === 0 ? null : p.current, previous: p.previous === 0 ? null : p.previous,
      })),
      sessions: gaLatest === null ? [] : pares(mapa(gaRows, (r) => r.sessions), gaLatest, days, gaFirst),
      users: gaLatest === null ? [] : pares(mapa(gaRows, (r) => r.total_users), gaLatest, days, gaFirst),
      keyEvents: gaLatest === null ? [] : pares(mapa(gaRows, (r) => r.key_events), gaLatest, days, gaFirst),
    },
    breakdowns: {
      range: rango === undefined ? null : { start: rango.s, end: rango.e },
      queries: bd<{ key: string; clicks: number; impressions: number; position: number | null }>('last28', 'gsc_queries')
        .map((q) => ({ ...q, prevPosition: prevPos.get(q.key) ?? null })),
      pages: bd('last28', 'gsc_pages'),
      channels: bd('last28', 'ga_channels'),
      devices: bd('last28', 'ga_devices'),
      landing: bd('last28', 'ga_landing'),
      keyEvents: bd('last28', 'ga_key_events'),
    },
    health: Object.fromEntries(salud.map((s) => [pathKey(s.url), { httpStatus: s.http_status, loadMs: s.load_ms, ok: s.ok }])),
  };
}
