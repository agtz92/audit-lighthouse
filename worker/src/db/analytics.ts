/**
 * Escritura y lectura de lo que trae la sincronización de Search Console, GA4
 * y Google Ads.
 */

import { db } from './pool.js';
import type { RunStatus, RunTrigger, PdfMeta } from './runs.js';
import type { GscDailyRow } from '../google/search-console.js';
import type { GaDailyRow, GaAiDailyRow } from '../google/ga4.js';
import type { AdsDailyRow } from '../google/ads.js';
import type { Logger } from '../lib/logger.js';
import type { PeriodKey } from '../analytics/periods.js';

export type SourceStatus = 'ok' | 'error' | 'off';

/** Igual que closeOrphanRuns del worker, para las sincronizaciones. */
export async function closeOrphanAnalyticsRuns(): Promise<number> {
  await db().query(
    `UPDATE analytics_site_runs
        SET status = 'failed', finished_at = now()
      WHERE status = 'running'`,
  );
  const r = await db().query(
    `UPDATE analytics_runs
        SET status = 'failed',
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
            notes = 'el servicio analytics se reinició durante la sincronización'
      WHERE status = 'running'`,
  );
  return r.rowCount ?? 0;
}

export async function startAnalyticsRun(trigger: RunTrigger): Promise<number> {
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO analytics_runs (trigger) VALUES ($1) RETURNING id`,
    [trigger],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT en analytics_runs no devolvió id');
  return id;
}

export async function finishAnalyticsRun(
  runId: number,
  o: { status: RunStatus; sitesTotal: number; sitesOk: number; sitesFailed: number; notes: string | null },
): Promise<void> {
  await db().query(
    `UPDATE analytics_runs SET
       status       = $2,
       finished_at  = now(),
       duration_ms  = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
       sites_total  = $3,
       sites_ok     = $4,
       sites_failed = $5,
       notes        = $6
     WHERE id = $1`,
    [runId, o.status, o.sitesTotal, o.sitesOk, o.sitesFailed, o.notes],
  );
}

export async function startAnalyticsSiteRun(runId: number, siteId: string): Promise<number> {
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO analytics_site_runs (run_id, site_id) VALUES ($1, $2)
     ON CONFLICT (run_id, site_id) DO UPDATE SET status = 'running', started_at = now()
     RETURNING id`,
    [runId, siteId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT en analytics_site_runs no devolvió id');
  return id;
}

export interface SourceOutcome {
  property: string | null;
  status: SourceStatus;
  error: string | null;
  rows: number;
  latestDate: string | null;
}

export async function finishAnalyticsSiteRun(
  id: number,
  o: {
    status: RunStatus;
    gsc: SourceOutcome;
    ga: SourceOutcome;
    keyEvents: string[];
    ads: SourceOutcome & { currency: string | null };
  },
): Promise<void> {
  await db().query(
    `UPDATE analytics_site_runs SET
       status          = $2,
       finished_at     = now(),
       duration_ms     = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
       gsc_property    = $3,  gsc_status = $4,  gsc_error = $5,  gsc_rows = $6,  gsc_latest_date = $7,
       ga_property     = $8,  ga_status  = $9,  ga_error  = $10, ga_rows  = $11, ga_latest_date  = $12,
       ga_key_events   = $13,
       ads_customer_id = $14, ads_status = $15, ads_error = $16, ads_rows = $17, ads_latest_date = $18,
       ads_currency    = $19
     WHERE id = $1`,
    [
      id, o.status,
      o.gsc.property, o.gsc.status, o.gsc.error, o.gsc.rows, o.gsc.latestDate,
      o.ga.property, o.ga.status, o.ga.error, o.ga.rows, o.ga.latestDate,
      o.keyEvents,
      o.ads.property, o.ads.status, o.ads.error, o.ads.rows, o.ads.latestDate, o.ads.currency,
    ],
  );
}

export async function recordAnalyticsPdf(siteRunId: number, meta: PdfMeta | null): Promise<void> {
  if (meta === null) return;
  await db().query(
    `UPDATE analytics_site_runs
        SET analytics_pdf_bytes = $2, analytics_pdf_pages = $3, analytics_pdf_generated_at = $4
      WHERE id = $1`,
    [siteRunId, meta.bytes, meta.pages, meta.generatedAt],
  );
}

/** Último día guardado de una fuente, como YYYY-MM-DD. */
export async function maxStoredDate(table: 'gsc_daily' | 'ga_daily' | 'ga_ai_daily' | 'ads_daily', siteId: string): Promise<string | null> {
  const { rows } = await db().query<{ d: string | null }>(
    `SELECT to_char(max(date), 'YYYY-MM-DD') AS d FROM ${table} WHERE site_id = $1`,
    [siteId],
  );
  return rows[0]?.d ?? null;
}

/** unnest + ON CONFLICT: 490 días de la carga inicial en un solo viaje. */
export async function upsertGscDaily(siteId: string, rows: GscDailyRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db().query(
    `INSERT INTO gsc_daily (site_id, date, clicks, impressions, position)
     SELECT $1, d, c, i, p
       FROM unnest($2::date[], $3::int[], $4::int[], $5::numeric[]) AS t(d, c, i, p)
     ON CONFLICT (site_id, date) DO UPDATE SET
       clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, position = EXCLUDED.position`,
    [siteId, rows.map((r) => r.date), rows.map((r) => r.clicks), rows.map((r) => r.impressions), rows.map((r) => r.position)],
  );
}

export async function upsertGaDaily(siteId: string, rows: GaDailyRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db().query(
    `INSERT INTO ga_daily (site_id, date, sessions, engaged_sessions, total_users, new_users, page_views, key_events)
     SELECT $1, d, s, e, u, n, v, k
       FROM unnest($2::date[], $3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::numeric[])
            AS t(d, s, e, u, n, v, k)
     ON CONFLICT (site_id, date) DO UPDATE SET
       sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
       total_users = EXCLUDED.total_users, new_users = EXCLUDED.new_users,
       page_views = EXCLUDED.page_views, key_events = EXCLUDED.key_events`,
    [
      siteId,
      rows.map((r) => r.date),
      rows.map((r) => r.sessions),
      rows.map((r) => r.engagedSessions),
      rows.map((r) => r.totalUsers),
      rows.map((r) => r.newUsers),
      rows.map((r) => r.pageViews),
      rows.map((r) => r.keyEvents),
    ],
  );
}

/** Visitas desde asistentes de IA, con el día sin visitas incluido. */
export async function upsertGaAiDaily(siteId: string, rows: GaAiDailyRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db().query(
    `INSERT INTO ga_ai_daily (site_id, date, sessions, engaged_sessions, key_events, by_assistant)
     SELECT $1, d, s, e, k, b
       FROM unnest($2::date[], $3::int[], $4::int[], $5::numeric[], $6::jsonb[]) AS t(d, s, e, k, b)
     ON CONFLICT (site_id, date) DO UPDATE SET
       sessions = EXCLUDED.sessions, engaged_sessions = EXCLUDED.engaged_sessions,
       key_events = EXCLUDED.key_events, by_assistant = EXCLUDED.by_assistant`,
    [
      siteId,
      rows.map((r) => r.date),
      rows.map((r) => r.sessions),
      rows.map((r) => r.engagedSessions),
      rows.map((r) => r.keyEvents),
      rows.map((r) => JSON.stringify(r.byAssistant)),
    ],
  );
}

/**
 * Reemplaza la serie de Ads de una ventana, en una transacción.
 *
 * Borra antes de escribir porque Ads no manda filas en cero: si Google
 * corrige a 0 un día que tenía clics (clics inválidos), con un simple upsert
 * la fila vieja se quedaría para siempre.
 */
export async function replaceAdsDaily(siteId: string, start: string, end: string, rows: AdsDailyRow[]): Promise<void> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM ads_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3`, [siteId, start, end]);
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO ads_daily (site_id, date, campaign_id, campaign_name, impressions, clicks, cost_micros,
                                conversions, conversions_value, all_conversions)
         SELECT $1, d, c, n, i, k, m, v, vv, a
           FROM unnest($2::date[], $3::bigint[], $4::text[], $5::bigint[], $6::bigint[], $7::bigint[],
                       $8::numeric[], $9::numeric[], $10::numeric[]) AS t(d, c, n, i, k, m, v, vv, a)`,
        [
          siteId,
          rows.map((r) => r.date),
          rows.map((r) => r.campaignId),
          rows.map((r) => r.campaignName),
          rows.map((r) => r.impressions),
          rows.map((r) => r.clicks),
          rows.map((r) => r.costMicros),
          rows.map((r) => r.conversions),
          rows.map((r) => r.conversionsValue),
          rows.map((r) => r.allConversions),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Totales de Ads de un rango, para el webhook. El costo ya en la moneda de la cuenta. */
export async function fetchAdsTotalsRange(
  siteId: string,
  start: string,
  end: string,
): Promise<{ cost: number; clicks: number; conversions: number }> {
  const { rows } = await db().query<{ cost: string | null; clicks: string | null; conversions: string | null }>(
    `SELECT sum(cost_micros) / 1000000.0 AS cost, sum(clicks) AS clicks, sum(conversions) AS conversions
       FROM ads_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3`,
    [siteId, start, end],
  );
  const r = rows[0];
  return {
    cost: Math.round(Number(r?.cost ?? 0) * 100) / 100,
    clicks: Number(r?.clicks ?? 0),
    conversions: Math.round(Number(r?.conversions ?? 0) * 100) / 100,
  };
}

export type BreakdownKind =
  | 'gsc_queries' | 'gsc_pages'
  | 'ga_totals' | 'ga_channels' | 'ga_devices' | 'ga_landing' | 'ga_key_events'
  | 'ga_ai_assistants' | 'ga_ai_landing'
  | 'ads_totals' | 'ads_campaigns' | 'ads_conversion_actions' | 'ads_ad_groups' | 'ads_keywords'
  | 'ads_search_terms' | 'ads_ads' | 'ads_asset_groups' | 'ads_pmax_terms' | 'ads_audiences' | 'ads_devices' | 'ads_landing' | 'ads_geo' | 'ads_gender' | 'ads_age'
  | 'ads_schedule';

export async function saveBreakdown(
  siteId: string,
  period: PeriodKey,
  kind: BreakdownKind,
  range: { start: string; end: string },
  rows: unknown,
): Promise<void> {
  await db().query(
    `INSERT INTO analytics_breakdowns (site_id, period, kind, start_date, end_date, rows, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
     ON CONFLICT (site_id, period, kind) DO UPDATE SET
       start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
       rows = EXCLUDED.rows, fetched_at = now()`,
    [siteId, period, kind, range.start, range.end, JSON.stringify(rows)],
  );
}

export async function hasSuccessfulAnalyticsRunToday(timezone: string): Promise<boolean> {
  const { rows } = await db().query<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM analytics_runs
        WHERE status IN ('ok', 'partial')
          AND (started_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
     ) AS existe`,
    [timezone],
  );
  return rows[0]?.existe === true;
}

/**
 * Retención: las corridas como las auditorías; las series diarias aparte y
 * más largas, porque comparar contra el año anterior necesita más de 90 días.
 */
export async function purgeAnalytics(runDays: number, dailyDays: number, log: Logger): Promise<void> {
  const corridas = await db().query(
    `DELETE FROM analytics_runs
      WHERE started_at < now() - ($1 || ' days')::interval AND status <> 'running'`,
    [runDays],
  );
  const gsc = await db().query(`DELETE FROM gsc_daily WHERE date < current_date - $1::int`, [dailyDays]);
  const ga = await db().query(`DELETE FROM ga_daily WHERE date < current_date - $1::int`, [dailyDays]);
  const ia = await db().query(`DELETE FROM ga_ai_daily WHERE date < current_date - $1::int`, [dailyDays]);
  const ads = await db().query(`DELETE FROM ads_daily WHERE date < current_date - $1::int`, [dailyDays]);
  const total = (corridas.rowCount ?? 0) + (gsc.rowCount ?? 0) + (ga.rowCount ?? 0) + (ia.rowCount ?? 0) + (ads.rowCount ?? 0);
  if (total > 0) {
    log.info('retención de tráfico', {
      corridas_borradas: corridas.rowCount ?? 0,
      dias_gsc_borrados: gsc.rowCount ?? 0,
      dias_ga_borrados: ga.rowCount ?? 0,
      dias_ia_borrados: ia.rowCount ?? 0,
      filas_ads_borradas: ads.rowCount ?? 0,
    });
  }
}

// ── Lectura para los informes ───────────────────────────────────────────────

export interface StoredBreakdown {
  period: PeriodKey;
  kind: BreakdownKind;
  start: string;
  end: string;
  rows: unknown;
}

export async function fetchBreakdowns(siteId: string, periods: PeriodKey[]): Promise<StoredBreakdown[]> {
  const { rows } = await db().query<{ period: PeriodKey; kind: BreakdownKind; s: string; e: string; rows: unknown }>(
    `SELECT period, kind, to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e, rows
       FROM analytics_breakdowns
      WHERE site_id = $1 AND period = ANY($2::text[])`,
    [siteId, periods],
  );
  return rows.map((r) => ({ period: r.period, kind: r.kind, start: r.s, end: r.e, rows: r.rows }));
}

export async function fetchGscDailyRange(siteId: string, start: string, end: string): Promise<GscDailyRow[]> {
  const { rows } = await db().query<{ d: string; clicks: number; impressions: number; position: number | null }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, clicks, impressions, position
       FROM gsc_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteId, start, end],
  );
  return rows.map((r) => ({ date: r.d, clicks: r.clicks, impressions: r.impressions, position: r.position }));
}

export async function fetchGaDailyRange(siteId: string, start: string, end: string): Promise<GaDailyRow[]> {
  const { rows } = await db().query<{
    d: string; sessions: number; engaged_sessions: number; total_users: number;
    new_users: number; page_views: number; key_events: number;
  }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, sessions, engaged_sessions, total_users, new_users, page_views, key_events
       FROM ga_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteId, start, end],
  );
  return rows.map((r) => ({
    date: r.d,
    sessions: r.sessions,
    engagedSessions: r.engaged_sessions,
    totalUsers: r.total_users,
    newUsers: r.new_users,
    pageViews: r.page_views,
    keyEvents: r.key_events,
  }));
}

/** Visitas desde asistentes de IA de un rango, y el primer día que tiene la serie. */
export async function fetchGaAiDailyRange(siteId: string, start: string, end: string): Promise<GaAiDailyRow[]> {
  const { rows } = await db().query<{
    d: string; sessions: number; engaged_sessions: number; key_events: number; by_assistant: Record<string, number>;
  }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, sessions, engaged_sessions, key_events, by_assistant
       FROM ga_ai_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3 ORDER BY date`,
    [siteId, start, end],
  );
  return rows.map((r) => ({
    date: r.d,
    sessions: r.sessions,
    engagedSessions: r.engaged_sessions,
    keyEvents: r.key_events,
    byAssistant: r.by_assistant,
  }));
}

export async function minStoredAiDate(siteId: string): Promise<string | null> {
  const { rows } = await db().query<{ d: string | null }>(
    `SELECT to_char(min(date), 'YYYY-MM-DD') AS d FROM ga_ai_daily WHERE site_id = $1`,
    [siteId],
  );
  return rows[0]?.d ?? null;
}

/** Lo último que se supo de la conexión del sitio: para el informe integral y el webhook. */
export interface LatestAnalyticsState {
  gscStatus: SourceStatus;
  gaStatus: SourceStatus;
  gscLatestDate: string | null;
  gaLatestDate: string | null;
  keyEvents: string[];
  finishedAt: Date | null;
}

export async function fetchLatestAnalyticsState(siteId: string): Promise<LatestAnalyticsState | null> {
  const { rows } = await db().query<{
    gsc_status: SourceStatus; ga_status: SourceStatus; gsc: string | null; ga: string | null;
    ga_key_events: string[]; finished_at: Date | null;
  }>(
    `SELECT gsc_status, ga_status,
            to_char(gsc_latest_date, 'YYYY-MM-DD') AS gsc, to_char(ga_latest_date, 'YYYY-MM-DD') AS ga,
            ga_key_events, finished_at
       FROM analytics_site_runs
      WHERE site_id = $1 AND status <> 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [siteId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return {
    gscStatus: r.gsc_status,
    gaStatus: r.ga_status,
    gscLatestDate: r.gsc,
    gaLatestDate: r.ga,
    keyEvents: r.ga_key_events,
    finishedAt: r.finished_at,
  };
}

/**
 * Estado de las páginas en la última auditoría del sitio, por ruta. Es lo que
 * permite cruzar «esta página recibe tráfico» con «esta página responde 404».
 */
export async function fetchLatestPageHealth(siteId: string): Promise<Map<string, { httpStatus: number | null; loadMs: number | null; ok: boolean }>> {
  const { rows } = await db().query<{ url: string; http_status: number | null; load_ms: number | null; ok: boolean }>(
    `SELECT pr.url, pr.http_status, pr.load_ms, pr.ok
       FROM page_results pr
      WHERE pr.site_run_id = (
        SELECT id FROM site_runs
         WHERE site_id = $1 AND status IN ('ok', 'partial')
         ORDER BY started_at DESC LIMIT 1
      )`,
    [siteId],
  );
  const out = new Map<string, { httpStatus: number | null; loadMs: number | null; ok: boolean }>();
  for (const r of rows) {
    out.set(pathKey(r.url), { httpStatus: r.http_status, loadMs: r.load_ms, ok: r.ok });
  }
  return out;
}

/**
 * Llave para cruzar páginas entre fuentes: Search Console da la URL completa,
 * GA4 solo la ruta, y la auditoría la URL tal como la pidió. Se compara la ruta
 * sin diagonal final ni query.
 */
export function pathKey(urlOrPath: string): string {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath, 'https://x.invalid').pathname;
  } catch {
    // se queda como venía
  }
  path = path.replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

// ── Lectura para los informes de Ads ────────────────────────────────────────

/** La cuenta de Ads por día: la suma de sus campañas, con el costo ya en la moneda de la cuenta. */
export async function fetchAdsDayTotals(
  siteId: string,
  start: string,
  end: string,
): Promise<Array<{ date: string; impressions: number; clicks: number; cost: number; conversions: number; conversionsValue: number }>> {
  const { rows } = await db().query<{ d: string; i: string; c: string; cost: string; conv: string; v: string }>(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d, sum(impressions) AS i, sum(clicks) AS c,
            sum(cost_micros) / 1000000.0 AS cost, sum(conversions) AS conv, sum(conversions_value) AS v
       FROM ads_daily WHERE site_id = $1 AND date BETWEEN $2 AND $3
      GROUP BY date ORDER BY date`,
    [siteId, start, end],
  );
  return rows.map((r) => ({
    date: r.d,
    impressions: Number(r.i),
    clicks: Number(r.c),
    cost: Math.round(Number(r.cost) * 100) / 100,
    conversions: Math.round(Number(r.conv) * 100) / 100,
    conversionsValue: Math.round(Number(r.v) * 100) / 100,
  }));
}

/** Lo último que se supo de la cuenta de Ads del sitio. null si nunca se sincronizó bien. */
export async function fetchLatestAdsState(siteId: string): Promise<{ customerId: string; currency: string; latestDate: string } | null> {
  const { rows } = await db().query<{ ads_customer_id: string; ads_currency: string | null; d: string }>(
    `SELECT ads_customer_id, ads_currency, to_char(ads_latest_date, 'YYYY-MM-DD') AS d
       FROM analytics_site_runs
      WHERE site_id = $1 AND ads_status = 'ok' AND ads_latest_date IS NOT NULL
      ORDER BY started_at DESC LIMIT 1`,
    [siteId],
  );
  const r = rows[0];
  return r === undefined ? null : { customerId: r.ads_customer_id, currency: r.ads_currency ?? 'MXN', latestDate: r.d };
}

// ── Texto de Claude sobre las cuentas de Ads ────────────────────────────────

export async function fetchAdsContext(siteId: string): Promise<{ profile: string; baseline: string | null }> {
  const { rows } = await db().query<{ profile: string; baseline: string | null }>(
    `SELECT profile, baseline FROM ads_context WHERE site_id = $1`,
    [siteId],
  );
  return rows[0] ?? { profile: '', baseline: null };
}

export async function saveAdsBaseline(siteId: string, baseline: string): Promise<void> {
  await db().query(
    `INSERT INTO ads_context (site_id, baseline, baseline_updated_at) VALUES ($1, $2, now())
     ON CONFLICT (site_id) DO UPDATE SET baseline = EXCLUDED.baseline, baseline_updated_at = now(), updated_at = now()`,
    [siteId, baseline],
  );
}

export type AdsNoteKind = 'weekly' | 'cliente' | 'admin';

export async function saveAdsNote(
  siteId: string,
  n: { kind: AdsNoteKind; range: { start: string; end: string }; model: string; content: unknown; inputTokens: number; outputTokens: number },
): Promise<void> {
  await db().query(
    `INSERT INTO ads_notes (site_id, kind, period_start, period_end, model, content, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [siteId, n.kind, n.range.start, n.range.end, n.model, JSON.stringify(n.content), n.inputTokens, n.outputTokens],
  );
}

/** El último análisis semanal: si ya hay uno de esta semana no se vuelve a pagar. */
export async function latestAdsNoteDate(siteId: string, kind: AdsNoteKind): Promise<Date | null> {
  const { rows } = await db().query<{ created_at: Date }>(
    `SELECT created_at FROM ads_notes WHERE site_id = $1 AND kind = $2 ORDER BY created_at DESC LIMIT 1`,
    [siteId, kind],
  );
  return rows[0]?.created_at ?? null;
}

/** El perfil lo escribe una persona desde el dashboard; vacío lo borra. */
export async function saveAdsProfile(siteId: string, profile: string): Promise<void> {
  await db().query(
    `INSERT INTO ads_context (site_id, profile) VALUES ($1, $2)
     ON CONFLICT (site_id) DO UPDATE SET profile = EXCLUDED.profile, updated_at = now()`,
    [siteId, profile],
  );
}
