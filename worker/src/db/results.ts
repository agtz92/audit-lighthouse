/**
 * Escritura de page_results.
 *
 * Todas las páginas de un sitio se insertan de un golpe con jsonb_to_recordset:
 * son hasta 50 filas con 15 columnas, y mandarlas una por una serían 50 viajes
 * a la base por sitio. Construir 15 arrays paralelos para unnest() sería la
 * alternativa, pero un jsonb es más difícil de desalinear al editar.
 */

import { db } from './pool.js';
import type { PageMetrics } from '../audit/page-metrics.js';

export interface PageRow extends PageMetrics {
  isHome: boolean;
}

export async function insertPageResults(
  siteRunId: number,
  siteId: string,
  pages: PageRow[],
): Promise<number> {
  if (pages.length === 0) return 0;

  const payload = pages.map((p) => ({
    url: p.url,
    final_url: p.finalUrl,
    is_home: p.isHome,
    http_status: p.httpStatus,
    redirect_chain: p.redirectChain,
    ttfb_ms: p.ttfbMs,
    load_ms: p.loadMs,
    dcl_ms: p.dclMs,
    transfer_bytes: p.transferBytes,
    request_count: p.requestCount,
    ok: p.ok,
    error_category: p.errorCategory,
    error_message: p.errorMessage,
    attempt_count: p.attemptCount,
    degraded_wait: p.degradedWait,
  }));

  const { rowCount } = await db().query(
    `
    INSERT INTO page_results (
      site_run_id, site_id, url, final_url, is_home, http_status, redirect_chain,
      ttfb_ms, load_ms, dcl_ms, transfer_bytes, request_count,
      ok, error_category, error_message, attempt_count, degraded_wait
    )
    SELECT $1, $2, r.url, r.final_url, r.is_home, r.http_status, r.redirect_chain,
           r.ttfb_ms, r.load_ms, r.dcl_ms, r.transfer_bytes, r.request_count,
           r.ok, r.error_category::error_category, r.error_message,
           r.attempt_count, r.degraded_wait
      FROM jsonb_to_recordset($3::jsonb) AS r(
        url text, final_url text, is_home boolean, http_status integer,
        redirect_chain jsonb, ttfb_ms integer, load_ms integer, dcl_ms integer,
        transfer_bytes bigint, request_count integer, ok boolean,
        error_category text, error_message text, attempt_count smallint,
        degraded_wait boolean
      )
    ON CONFLICT (site_run_id, url) DO NOTHING
    `,
    [siteRunId, siteId, JSON.stringify(payload)],
  );

  return rowCount ?? 0;
}
