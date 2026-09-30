/**
 * Fotografías de corridas, para comparar la de hoy contra la anterior.
 */

import { db } from './pool.js';
import type { SiteRunStatus } from './runs.js';
import type { SiteSnapshot, StrategySnapshot } from '../run/deltas.js';

interface SnapshotRow {
  site_id: string;
  status: SiteRunStatus;
  home_http_status: number | null;
  cert_days_remaining: number | null;
  strategy: 'desktop' | 'mobile' | null;
  performance: number | null;
  accessibility: number | null;
  best_practices: number | null;
  seo: number | null;
  lcp_ms: number | null;
  cls: number | null;
}

function emptySnapshot(row: SnapshotRow): SiteSnapshot {
  return {
    status: row.status,
    homeHttpStatus: row.home_http_status,
    certDaysRemaining: row.cert_days_remaining,
    desktop: null,
    mobile: null,
  };
}

function strategyFrom(row: SnapshotRow): StrategySnapshot {
  return {
    scores: {
      performance: row.performance,
      accessibility: row.accessibility,
      bestPractices: row.best_practices,
      seo: row.seo,
    },
    metrics: { lcpMs: row.lcp_ms, cls: row.cls },
  };
}

const SNAPSHOT_SQL = `
  SELECT sr.site_id,
         sr.status,
         sr.home_http_status,
         sr.cert_days_remaining,
         lr.strategy,
         lr.performance,
         lr.accessibility,
         lr.best_practices,
         lr.seo,
         lr.lcp_ms,
         lr.cls
    FROM site_runs sr
    LEFT JOIN lighthouse_results lr ON lr.site_run_id = sr.id
   WHERE sr.run_id = $1
`;

/** Fotografía de una corrida: un SiteSnapshot por sitio. */
export async function fetchRunSnapshot(runId: number): Promise<Map<string, SiteSnapshot>> {
  const { rows } = await db().query<SnapshotRow>(SNAPSHOT_SQL, [runId]);
  const out = new Map<string, SiteSnapshot>();

  // El LEFT JOIN devuelve hasta dos filas por sitio (desktop y mobile), o una
  // con strategy en null si Lighthouse no corrió.
  for (const row of rows) {
    const existing = out.get(row.site_id) ?? emptySnapshot(row);
    if (row.strategy === 'desktop') existing.desktop = strategyFrom(row);
    else if (row.strategy === 'mobile') existing.mobile = strategyFrom(row);
    out.set(row.site_id, existing);
  }

  return out;
}

/**
 * La corrida anterior a `runId`: la más reciente que ya terminó.
 * null si esta es la primera, y entonces no hay deltas que calcular.
 */
export async function fetchPreviousRunSnapshot(
  runId: number,
): Promise<{ runId: number; sites: Map<string, SiteSnapshot> } | null> {
  const { rows } = await db().query<{ id: number }>(
    `SELECT id FROM runs
      WHERE id < $1 AND status <> 'running'
      ORDER BY id DESC LIMIT 1`,
    [runId],
  );
  const previousId = rows[0]?.id;
  if (previousId === undefined) return null;
  return { runId: previousId, sites: await fetchRunSnapshot(previousId) };
}

/**
 * ¿Hubo hoy una corrida que terminara bien? Lo usa la corrida de recuperación al
 * arrancar el worker. "Hoy" se evalúa en la zona horaria del contenedor, que es
 * la de Ciudad de México: a las 00:30 locales el día apenas empezó, aunque en UTC
 * ya sea otro.
 */
export async function hasSuccessfulRunToday(timezone: string): Promise<boolean> {
  const { rows } = await db().query<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM runs
        WHERE status IN ('ok', 'partial')
          AND (started_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
     ) AS existe`,
    [timezone],
  );
  return rows[0]?.existe === true;
}

/**
 * Valores de la corrida anterior de un sitio en una estrategia, para la tabla
 * de comparación del informe. null si es la primera vez que se mide.
 */
export async function fetchPreviousForReport(
  siteId: string,
  strategy: 'desktop' | 'mobile',
  beforeSiteRunId: number,
): Promise<{ scores: { performance: number | null }; metrics: { lcpMs: number | null; tbtMs: number | null } } | null> {
  const { rows } = await db().query<{ performance: number | null; lcp_ms: number | null; tbt_ms: number | null }>(
    `SELECT lr.performance, lr.lcp_ms, lr.tbt_ms
       FROM lighthouse_results lr
      WHERE lr.site_id = $1
        AND lr.strategy = $2
        AND lr.ok
        AND lr.site_run_id < $3
      ORDER BY lr.site_run_id DESC
      LIMIT 1`,
    [siteId, strategy, beforeSiteRunId],
  );
  const r = rows[0];
  if (r === undefined) return null;
  return { scores: { performance: r.performance }, metrics: { lcpMs: r.lcp_ms, tbtMs: r.tbt_ms } };
}
