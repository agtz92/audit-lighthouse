/**
 * Escritura de lighthouse_results: una fila por sitio, por corrida, por estrategia.
 */

import { db } from './pool.js';
import type { LighthouseOutcome } from '../audit/lighthouse.js';

export async function insertLighthouseResult(
  siteRunId: number,
  siteId: string,
  outcome: LighthouseOutcome,
): Promise<void> {
  await db().query(
    `
    INSERT INTO lighthouse_results (
      site_run_id, site_id, url, strategy,
      performance, accessibility, best_practices, seo,
      lcp_ms, cls, tbt_ms, inp_ms, fcp_ms, speed_index_ms, tti_ms,
      lighthouse_version, raw_report, raw_report_bytes, ok, error_message
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    ON CONFLICT (site_run_id, strategy) DO UPDATE SET
      performance      = EXCLUDED.performance,
      accessibility    = EXCLUDED.accessibility,
      best_practices   = EXCLUDED.best_practices,
      seo              = EXCLUDED.seo,
      lcp_ms           = EXCLUDED.lcp_ms,
      cls              = EXCLUDED.cls,
      tbt_ms           = EXCLUDED.tbt_ms,
      fcp_ms           = EXCLUDED.fcp_ms,
      speed_index_ms   = EXCLUDED.speed_index_ms,
      tti_ms           = EXCLUDED.tti_ms,
      raw_report       = EXCLUDED.raw_report,
      raw_report_bytes = EXCLUDED.raw_report_bytes,
      ok               = EXCLUDED.ok,
      error_message    = EXCLUDED.error_message
    `,
    [
      siteRunId,
      siteId,
      outcome.url,
      outcome.strategy,
      outcome.scores.performance,
      outcome.scores.accessibility,
      outcome.scores.bestPractices,
      outcome.scores.seo,
      outcome.metrics.lcpMs,
      outcome.metrics.cls,
      outcome.metrics.tbtMs,
      outcome.metrics.inpMs,
      outcome.metrics.fcpMs,
      outcome.metrics.speedIndexMs,
      outcome.metrics.ttiMs,
      outcome.version,
      outcome.rawGzip,
      outcome.rawGzip?.byteLength ?? null,
      outcome.ok,
      outcome.error,
    ],
  );
}
