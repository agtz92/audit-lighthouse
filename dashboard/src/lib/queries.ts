/**
 * Todo el SQL del dashboard vive aquí.
 *
 * Son agregaciones sobre las últimas corridas, escritas a mano a propósito: un
 * ORM las convertiría en algo más difícil de leer y de afinar que el SQL mismo.
 * Los índices que las sostienen están en la migración inicial:
 * (site_id, started_at DESC) y (site_id, strategy, created_at DESC).
 */

import { query } from './db';

export type SiteRunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped_timeout';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';
export type Strategy = 'desktop' | 'mobile';

export interface LighthouseSnapshot {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  ok: boolean;
}

export type ByStrategy = Partial<Record<Strategy, LighthouseSnapshot>>;

export interface OverviewRow {
  siteId: string;
  name: string;
  url: string;
  enabled: boolean;
  removedFromYaml: boolean;
  siteRunId: number | null;
  status: SiteRunStatus | null;
  startedAt: Date | null;
  durationMs: number | null;
  homeHttpStatus: number | null;
  pagesAudited: number;
  pagesFailed: number;
  pagesDiscovered: number;
  truncated: boolean;
  certValid: boolean | null;
  certDaysRemaining: number | null;
  desktopPdfBytes: number | null;
  desktopPdfPages: number | null;
  desktopPdfGeneratedAt: Date | null;
  mobilePdfBytes: number | null;
  mobilePdfPages: number | null;
  mobilePdfGeneratedAt: Date | null;
  errorCategory: string | null;
  errorMessage: string | null;
  current: ByStrategy;
  previous: ByStrategy;
  previousAt: Date | null;
}

/**
 * Agrupa las filas de lighthouse_results de una corrida en un objeto
 * {desktop: {...}, mobile: {...}}, para no tener que unir la tabla dos veces por
 * estrategia y otras dos para la corrida anterior.
 */
const LIGHTHOUSE_BY_STRATEGY = `
  SELECT site_run_id,
         jsonb_object_agg(strategy, jsonb_build_object(
           'performance',   performance,
           'accessibility', accessibility,
           'bestPractices', best_practices,
           'seo',           seo,
           'lcpMs',         lcp_ms,
           'cls',           cls,
           'tbtMs',         tbt_ms,
           'ok',            ok
         )) AS by_strategy
    FROM lighthouse_results
   GROUP BY site_run_id
`;

interface OverviewSqlRow extends Record<string, unknown> {
  site_id: string;
  name: string;
  url: string;
  enabled: boolean;
  removed_from_yaml_at: Date | null;
  site_run_id: number | null;
  status: SiteRunStatus | null;
  started_at: Date | null;
  duration_ms: number | null;
  home_http_status: number | null;
  pages_audited: number | null;
  pages_failed: number | null;
  pages_discovered: number | null;
  truncated: boolean | null;
  cert_valid: boolean | null;
  cert_days_remaining: number | null;
  desktop_pdf_bytes: number | null;
  desktop_pdf_pages: number | null;
  desktop_pdf_generated_at: Date | null;
  mobile_pdf_bytes: number | null;
  mobile_pdf_pages: number | null;
  mobile_pdf_generated_at: Date | null;
  error_category: string | null;
  error_message: string | null;
  current_lh: ByStrategy | null;
  previous_lh: ByStrategy | null;
  previous_at: Date | null;
}

/** Una fila por sitio: su última corrida terminada y la anterior, para los deltas. */
export async function fetchOverview(): Promise<OverviewRow[]> {
  const rows = await query<OverviewSqlRow>(`
    WITH ultima AS (
      SELECT DISTINCT ON (site_id) *
        FROM site_runs
       WHERE status <> 'running'
       ORDER BY site_id, started_at DESC
    ),
    anterior AS (
      SELECT DISTINCT ON (sr.site_id) sr.*
        FROM site_runs sr
        JOIN ultima u ON u.site_id = sr.site_id AND sr.started_at < u.started_at
       WHERE sr.status <> 'running'
       ORDER BY sr.site_id, sr.started_at DESC
    ),
    lh AS (${LIGHTHOUSE_BY_STRATEGY})
    SELECT s.id AS site_id, s.name, s.url, s.enabled, s.removed_from_yaml_at,
           u.id AS site_run_id, u.status, u.started_at, u.duration_ms,
           u.home_http_status, u.pages_audited, u.pages_failed, u.pages_discovered, u.truncated,
           u.cert_valid, u.cert_days_remaining,
           u.desktop_pdf_bytes, u.desktop_pdf_pages, u.desktop_pdf_generated_at,
           u.mobile_pdf_bytes, u.mobile_pdf_pages, u.mobile_pdf_generated_at,
           u.error_category, u.error_message,
           lhu.by_strategy AS current_lh,
           lha.by_strategy AS previous_lh,
           a.started_at    AS previous_at
      FROM sites s
      LEFT JOIN ultima   u   ON u.site_id = s.id
      LEFT JOIN anterior a   ON a.site_id = s.id
      LEFT JOIN lh       lhu ON lhu.site_run_id = u.id
      LEFT JOIN lh       lha ON lha.site_run_id = a.id
     ORDER BY
       -- Lo que exige atención primero: caídos, luego parciales, luego el resto.
       CASE u.status WHEN 'failed' THEN 0 WHEN 'skipped_timeout' THEN 1 WHEN 'partial' THEN 2 ELSE 3 END,
       s.name
  `);

  return rows.map((r) => ({
    siteId: r.site_id,
    name: r.name,
    url: r.url,
    enabled: r.enabled,
    removedFromYaml: r.removed_from_yaml_at !== null,
    siteRunId: r.site_run_id,
    status: r.status,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    homeHttpStatus: r.home_http_status,
    pagesAudited: r.pages_audited ?? 0,
    pagesFailed: r.pages_failed ?? 0,
    pagesDiscovered: r.pages_discovered ?? 0,
    truncated: r.truncated ?? false,
    certValid: r.cert_valid,
    certDaysRemaining: r.cert_days_remaining,
    desktopPdfBytes: r.desktop_pdf_bytes,
    desktopPdfPages: r.desktop_pdf_pages,
    desktopPdfGeneratedAt: r.desktop_pdf_generated_at,
    mobilePdfBytes: r.mobile_pdf_bytes,
    mobilePdfPages: r.mobile_pdf_pages,
    mobilePdfGeneratedAt: r.mobile_pdf_generated_at,
    errorCategory: r.error_category,
    errorMessage: r.error_message,
    current: r.current_lh ?? {},
    previous: r.previous_lh ?? {},
    previousAt: r.previous_at,
  }));
}

export interface LastRunInfo {
  id: number;
  trigger: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  sitesSkipped: number;
  budgetExceeded: boolean;
  /** true si esa corrida ocurrió hoy en hora de Ciudad de México. */
  isToday: boolean;
}

/** La corrida más reciente, terminada o en curso. Alimenta el banner de estado. */
export async function fetchLastRun(): Promise<LastRunInfo | null> {
  const rows = await query<Record<string, never> & {
    id: number; trigger: string; status: RunStatus; started_at: Date; finished_at: Date | null;
    duration_ms: number | null; sites_total: number; sites_ok: number; sites_failed: number;
    sites_skipped: number; budget_exceeded: boolean; is_today: boolean;
  }>(`
    SELECT id, trigger, status, started_at, finished_at, duration_ms,
           sites_total, sites_ok, sites_failed, sites_skipped, budget_exceeded,
           (started_at AT TIME ZONE 'America/Mexico_City')::date
             = (now() AT TIME ZONE 'America/Mexico_City')::date AS is_today
      FROM runs
     ORDER BY started_at DESC
     LIMIT 1
  `);
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    sitesTotal: r.sites_total,
    sitesOk: r.sites_ok,
    sitesFailed: r.sites_failed,
    sitesSkipped: r.sites_skipped,
    budgetExceeded: r.budget_exceeded,
    isToday: r.is_today,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Vista por sitio
// ─────────────────────────────────────────────────────────────────────────────

export interface SiteInfo {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  removedFromYaml: boolean;
}

export async function fetchSite(siteId: string): Promise<SiteInfo | null> {
  const rows = await query<{ id: string; name: string; url: string; enabled: boolean; removed_from_yaml_at: Date | null }>(
    `SELECT id, name, url, enabled, removed_from_yaml_at FROM sites WHERE id = $1`,
    [siteId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { id: r.id, name: r.name, url: r.url, enabled: r.enabled, removedFromYaml: r.removed_from_yaml_at !== null };
}

export interface TrendPoint {
  /** Identifica la corrida. Agrupar por fecha NO sirve: desktop y mobile de una
   *  misma corrida tienen timestamps distintos, y dos corridas del mismo día se
   *  fusionarían en un solo punto. */
  siteRunId: number;
  at: Date;
  strategy: Strategy;
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
}

/** Serie de Lighthouse de un sitio. El índice (site_id, strategy, created_at DESC) la cubre. */
export async function fetchLighthouseTrend(siteId: string, days: number): Promise<TrendPoint[]> {
  const rows = await query<{
    site_run_id: number; at: Date; strategy: Strategy; performance: number | null;
    accessibility: number | null; best_practices: number | null; seo: number | null;
    lcp_ms: number | null; cls: number | null; tbt_ms: number | null;
  }>(
    `SELECT site_run_id, created_at AS at, strategy, performance, accessibility, best_practices, seo,
            lcp_ms, cls, tbt_ms
       FROM lighthouse_results
      WHERE site_id = $1
        AND ok
        AND created_at >= now() - ($2 || ' days')::interval
      ORDER BY created_at ASC`,
    [siteId, days],
  );
  return rows.map((r) => ({
    siteRunId: r.site_run_id,
    at: r.at,
    strategy: r.strategy,
    performance: r.performance,
    accessibility: r.accessibility,
    bestPractices: r.best_practices,
    seo: r.seo,
    lcpMs: r.lcp_ms,
    cls: r.cls,
    tbtMs: r.tbt_ms,
  }));
}

export interface AvailabilityPoint {
  at: Date;
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
  requestCount: number | null;
  pagesAudited: number;
  pagesFailed: number;
}

/**
 * Disponibilidad y velocidad promediadas por corrida.
 * Se promedia por site_run y no por página: la tendencia que interesa es la del
 * sitio, y una corrida con 50 páginas y otra con 20 seguirían siendo comparables.
 */
export async function fetchAvailabilityTrend(siteId: string, days: number): Promise<AvailabilityPoint[]> {
  const rows = await query<{
    at: Date; ttfb_ms: number | null; load_ms: number | null; transfer_bytes: number | null;
    request_count: number | null; pages_audited: number; pages_failed: number;
  }>(
    `SELECT sr.started_at AS at,
            round(avg(pr.ttfb_ms) FILTER (WHERE pr.ok))::int        AS ttfb_ms,
            round(avg(pr.load_ms) FILTER (WHERE pr.ok))::int        AS load_ms,
            round(avg(pr.transfer_bytes) FILTER (WHERE pr.ok))::int AS transfer_bytes,
            round(avg(pr.request_count) FILTER (WHERE pr.ok))::int  AS request_count,
            count(*)                        AS pages_audited,
            count(*) FILTER (WHERE NOT pr.ok) AS pages_failed
       FROM site_runs sr
       JOIN page_results pr ON pr.site_run_id = sr.id
      WHERE sr.site_id = $1
        AND sr.started_at >= now() - ($2 || ' days')::interval
      GROUP BY sr.id, sr.started_at
      ORDER BY sr.started_at ASC`,
    [siteId, days],
  );
  return rows.map((r) => ({
    at: r.at,
    ttfbMs: r.ttfb_ms,
    loadMs: r.load_ms,
    transferBytes: r.transfer_bytes,
    requestCount: r.request_count,
    pagesAudited: r.pages_audited,
    pagesFailed: r.pages_failed,
  }));
}

export interface PageRow {
  url: string;
  finalUrl: string | null;
  isHome: boolean;
  httpStatus: number | null;
  redirects: number;
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
  requestCount: number | null;
  ok: boolean;
  errorCategory: string | null;
  errorMessage: string | null;
  attemptCount: number;
  degradedWait: boolean;
}

/** Páginas auditadas en la última corrida del sitio. */
export async function fetchLastRunPages(siteId: string): Promise<PageRow[]> {
  const rows = await query<{
    url: string; final_url: string | null; is_home: boolean; http_status: number | null;
    redirects: number; ttfb_ms: number | null; load_ms: number | null;
    transfer_bytes: number | null; request_count: number | null; ok: boolean;
    error_category: string | null; error_message: string | null;
    attempt_count: number; degraded_wait: boolean;
  }>(
    `WITH ultima AS (
       SELECT id FROM site_runs
        WHERE site_id = $1 AND status <> 'running'
        ORDER BY started_at DESC LIMIT 1
     )
     SELECT pr.url, pr.final_url, pr.is_home, pr.http_status,
            jsonb_array_length(pr.redirect_chain) AS redirects,
            pr.ttfb_ms, pr.load_ms, pr.transfer_bytes, pr.request_count,
            pr.ok, pr.error_category, pr.error_message, pr.attempt_count, pr.degraded_wait
       FROM page_results pr
       JOIN ultima u ON u.id = pr.site_run_id
      ORDER BY pr.is_home DESC, pr.ok ASC, pr.load_ms DESC NULLS LAST`,
    [siteId],
  );
  return rows.map((r) => ({
    url: r.url,
    finalUrl: r.final_url,
    isHome: r.is_home,
    httpStatus: r.http_status,
    redirects: r.redirects,
    ttfbMs: r.ttfb_ms,
    loadMs: r.load_ms,
    transferBytes: r.transfer_bytes,
    requestCount: r.request_count,
    ok: r.ok,
    errorCategory: r.error_category,
    errorMessage: r.error_message,
    attemptCount: r.attempt_count,
    degradedWait: r.degraded_wait,
  }));
}

export interface SiteRunHistoryRow {
  id: number;
  runId: number;
  status: SiteRunStatus;
  startedAt: Date;
  durationMs: number | null;
  discovery: string | null;
  pagesAudited: number;
  pagesFailed: number;
  truncated: boolean;
  homeHttpStatus: number | null;
  certDaysRemaining: number | null;
  errorCategory: string | null;
  errorMessage: string | null;
}

export async function fetchSiteRunHistory(siteId: string, days: number): Promise<SiteRunHistoryRow[]> {
  const rows = await query<{
    id: number; run_id: number; status: SiteRunStatus; started_at: Date; duration_ms: number | null;
    discovery: string | null; pages_audited: number; pages_failed: number; truncated: boolean;
    home_http_status: number | null; cert_days_remaining: number | null;
    error_category: string | null; error_message: string | null;
  }>(
    `SELECT id, run_id, status, started_at, duration_ms, discovery,
            pages_audited, pages_failed, truncated, home_http_status,
            cert_days_remaining, error_category, error_message
       FROM site_runs
      WHERE site_id = $1
        AND started_at >= now() - ($2 || ' days')::interval
      ORDER BY started_at DESC`,
    [siteId, days],
  );
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    status: r.status,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    discovery: r.discovery,
    pagesAudited: r.pages_audited,
    pagesFailed: r.pages_failed,
    truncated: r.truncated,
    homeHttpStatus: r.home_http_status,
    certDaysRemaining: r.cert_days_remaining,
    errorCategory: r.error_category,
    errorMessage: r.error_message,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Vista de corridas
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHistoryRow {
  id: number;
  trigger: string;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  sitesSkipped: number;
  budgetExceeded: boolean;
  notes: string | null;
  /** Errores de los sitios que fallaron en esa corrida, para el log. */
  errors: Array<{ siteId: string; category: string | null; message: string | null }>;
}

export async function fetchRunHistory(limit = 60): Promise<RunHistoryRow[]> {
  const rows = await query<{
    id: number; trigger: string; status: RunStatus; started_at: Date; finished_at: Date | null;
    duration_ms: number | null; sites_total: number; sites_ok: number; sites_failed: number;
    sites_skipped: number; budget_exceeded: boolean; notes: string | null;
    errors: Array<{ siteId: string; category: string | null; message: string | null }> | null;
  }>(
    `SELECT r.id, r.trigger, r.status, r.started_at, r.finished_at, r.duration_ms,
            r.sites_total, r.sites_ok, r.sites_failed, r.sites_skipped,
            r.budget_exceeded, r.notes,
            (
              SELECT jsonb_agg(jsonb_build_object(
                       'siteId',  sr.site_id,
                       'category', sr.error_category,
                       'message',  sr.error_message)
                     ORDER BY sr.site_id)
                FROM site_runs sr
               WHERE sr.run_id = r.id
                 AND sr.status IN ('failed', 'skipped_timeout')
            ) AS errors
       FROM runs r
      ORDER BY r.started_at DESC
      LIMIT $1`,
    [limit],
  );
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
    sitesSkipped: r.sites_skipped,
    budgetExceeded: r.budget_exceeded,
    notes: r.notes,
    errors: r.errors ?? [],
  }));
}
