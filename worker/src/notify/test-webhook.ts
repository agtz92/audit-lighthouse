/**
 * npm run webhook:test — dispara un payload de ejemplo contra WEBHOOK_URL.
 *
 * Usa la última corrida real si existe, para que lo que reciba el destinatario
 * tenga la forma exacta de lo que verá en producción. Si no hay ninguna, manda
 * un ejemplo sintético.
 */

import { env } from '../config/env.js';
import { db, closeDb } from '../db/pool.js';
import { fetchRunSnapshot, fetchPreviousRunSnapshot } from '../db/snapshots.js';
import { computeSiteDeltas, evaluateFlags, type SiteDeltas, type SiteFlags } from '../run/deltas.js';
import { buildPayload, deliverWebhook, type WebhookPayload } from './webhook.js';
import { log } from '../lib/logger.js';
import type { RunSummary } from '../run/orchestrator.js';

function ejemploSintetico(): WebhookPayload {
  const ahora = new Date();
  const sinDeltas: SiteDeltas = {
    desktop: { performance: null, accessibility: null, bestPractices: null, seo: null, lcpMs: null, cls: null },
    mobile: { performance: null, accessibility: null, bestPractices: null, seo: null, lcpMs: null, cls: null },
  };
  return {
    event: 'run.finished',
    run: {
      id: null, trigger: 'manual', status: 'partial',
      startedAt: new Date(ahora.getTime() - 900_000).toISOString(),
      finishedAt: ahora.toISOString(), durationMs: 900_000,
      sitesTotal: 2, sitesOk: 1, sitesFailed: 1, sitesSkipped: 0, budgetExceeded: false,
    },
    comparedToRunId: null,
    sites: [
      {
        id: 'ejemplo-ok', status: 'ok', httpStatus: 200, certDaysRemaining: 68,
        lighthouse: {
          desktop: { scores: { performance: 94, accessibility: 96, bestPractices: 100, seo: 100 }, metrics: { lcpMs: 1320, cls: 0.01 } },
          mobile: { scores: { performance: 71, accessibility: 96, bestPractices: 100, seo: 100 }, metrics: { lcpMs: 3410, cls: 0.04 } },
        },
        deltas: {
          desktop: { performance: 2, accessibility: 0, bestPractices: 0, seo: 0, lcpMs: -80, cls: 0 },
          mobile: { performance: -14, accessibility: 0, bestPractices: 0, seo: 0, lcpMs: 900, cls: 0.02 },
        },
        flags: { isDown: false, performanceDropped: true, certExpiringSoon: false },
      },
      {
        id: 'ejemplo-caido', status: 'failed', httpStatus: 503, certDaysRemaining: 12,
        lighthouse: { desktop: null, mobile: null },
        deltas: sinDeltas,
        flags: { isDown: true, performanceDropped: false, certExpiringSoon: true },
      },
    ],
  };
}

async function main(): Promise<void> {
  const cfg = env();
  if (cfg.WEBHOOK_URL === undefined) {
    log.error('WEBHOOK_URL no está definida: no hay a dónde mandar el payload');
    process.exit(1);
  }

  let payload: WebhookPayload;

  const { rows } = await db().query<{ id: number; trigger: string; status: string; started_at: Date; duration_ms: number | null; sites_total: number; sites_ok: number; sites_failed: number; sites_skipped: number; budget_exceeded: boolean }>(
    `SELECT id, trigger, status, started_at, duration_ms, sites_total, sites_ok,
            sites_failed, sites_skipped, budget_exceeded
       FROM runs WHERE status <> 'running' ORDER BY id DESC LIMIT 1`,
  );
  const ultima = rows[0];

  if (ultima === undefined) {
    log.info('no hay corridas en la base: se manda un payload sintético');
    payload = ejemploSintetico();
  } else {
    log.info('usando la última corrida real', { run_id: ultima.id });
    const current = await fetchRunSnapshot(ultima.id);
    const previous = await fetchPreviousRunSnapshot(ultima.id);
    const perSite = new Map<string, { deltas: SiteDeltas; flags: SiteFlags }>();
    for (const [siteId, snapshot] of current) {
      const deltas = computeSiteDeltas(snapshot, previous?.sites.get(siteId) ?? null);
      perSite.set(siteId, {
        deltas,
        flags: evaluateFlags(snapshot, deltas, {
          perfDropThreshold: cfg.PERF_DROP_THRESHOLD,
          certWarnDays: cfg.CERT_EXPIRY_WARN_DAYS,
        }),
      });
    }

    const summary: RunSummary = {
      runId: ultima.id,
      status: ultima.status as RunSummary['status'],
      trigger: ultima.trigger as RunSummary['trigger'],
      sitesTotal: ultima.sites_total,
      sitesOk: ultima.sites_ok,
      sitesFailed: ultima.sites_failed,
      sitesSkipped: ultima.sites_skipped,
      budgetExceeded: ultima.budget_exceeded,
      durationMs: ultima.duration_ms ?? 0,
      results: [...current.entries()].map(([siteId, snap]) => ({
        siteId,
        siteRunId: null,
        status: snap.status ?? 'ok',
        discovery: null,
        pagesDiscovered: 0, pagesAudited: 0, pagesFailed: 0,
        truncated: false, abortedByDeadline: false, candidateUrls: [],
        homeHttpStatus: snap.homeHttpStatus,
        cert: snap.certDaysRemaining === null ? null : {
          valid: true, issuer: null, validFrom: null, validTo: null,
          daysRemaining: snap.certDaysRemaining, error: null,
        },
        errorCategory: null, errorMessage: null, durationMs: 0,
        pages: [], homeUrl: null,
      })),
    };
    payload = buildPayload(summary, ultima.started_at, current, previous, perSite);
  }

  log.info('enviando', { url: cfg.WEBHOOK_URL, sitios: payload.sites.length, bytes: JSON.stringify(payload).length });
  const result = await deliverWebhook(payload, { url: cfg.WEBHOOK_URL, log });
  await closeDb();
  process.exit(result.delivered ? 0 : 1);
}

main().catch(async (err) => {
  log.error('webhook:test falló', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
