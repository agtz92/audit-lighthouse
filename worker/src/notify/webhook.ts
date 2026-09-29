/**
 * Webhook de fin de corrida.
 *
 * Regla que manda sobre todas: una falla del webhook NUNCA marca la corrida como
 * fallida. La auditoría ya ocurrió y los datos ya están guardados; que el
 * destinatario no conteste es problema del destinatario. Se reintenta tres veces
 * con backoff y se registra, nada más.
 */

import { log as rootLog, type Logger } from '../lib/logger.js';
import type { RunSummary } from '../run/orchestrator.js';
import type { SiteSnapshot, SiteDeltas, SiteFlags } from '../run/deltas.js';

export interface WebhookSitePayload {
  id: string;
  status: string;
  httpStatus: number | null;
  certDaysRemaining: number | null;
  lighthouse: {
    desktop: SiteSnapshot['desktop'];
    mobile: SiteSnapshot['mobile'];
  };
  deltas: SiteDeltas;
  flags: SiteFlags;
}

export interface WebhookPayload {
  event: 'run.finished';
  run: {
    id: number | null;
    trigger: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    sitesTotal: number;
    sitesOk: number;
    sitesFailed: number;
    sitesSkipped: number;
    budgetExceeded: boolean;
  };
  /** Corrida contra la que se compararon los deltas; null si es la primera. */
  comparedToRunId: number | null;
  sites: WebhookSitePayload[];
}

export interface DeliverOptions {
  url: string;
  timeoutMs?: number;
  attempts?: number;
  log?: Logger;
  /** Inyectable para poder probar sin red. */
  fetchImpl?: typeof fetch;
  /** Inyectable para no dormir de verdad en los tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface DeliverResult {
  delivered: boolean;
  attempts: number;
  status: number | null;
  error: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Backoff exponencial: 1s, 2s, 4s... */
export function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

/** Un 4xx no se reintenta: el payload o la URL están mal y repetir no ayuda. */
export function shouldRetry(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function deliverWebhook(
  payload: WebhookPayload,
  opts: DeliverOptions,
): Promise<DeliverResult> {
  const log = opts.log ?? rootLog;
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const body = JSON.stringify(payload);

  let lastStatus: number | null = null;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'site-monitor/1.0',
          'x-site-monitor-event': payload.event,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      lastStatus = res.status;
      if (res.ok) {
        log.info('webhook entregado', { intento: attempt, status: res.status });
        return { delivered: true, attempts: attempt, status: res.status, error: null };
      }

      lastError = `el destino respondió HTTP ${res.status}`;
      if (!shouldRetry(res.status)) {
        log.warn('webhook rechazado, no se reintenta', { status: res.status });
        return { delivered: false, attempts: attempt, status: res.status, error: lastError };
      }
    } catch (err) {
      lastStatus = null;
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < attempts) {
      const espera = backoffMs(attempt);
      log.warn('webhook falló, reintentando', { intento: attempt, espera_ms: espera, motivo: lastError });
      await sleep(espera);
    }
  }

  log.warn('webhook no se pudo entregar', { intentos: attempts, motivo: lastError });
  return { delivered: false, attempts, status: lastStatus, error: lastError };
}

/** Arma el payload a partir del resumen de la corrida y las fotografías. */
export function buildPayload(
  summary: RunSummary,
  startedAt: Date,
  current: Map<string, SiteSnapshot>,
  previous: { runId: number; sites: Map<string, SiteSnapshot> } | null,
  perSite: Map<string, { deltas: SiteDeltas; flags: SiteFlags }>,
): WebhookPayload {
  const finishedAt = new Date();
  return {
    event: 'run.finished',
    run: {
      id: summary.runId,
      trigger: summary.trigger,
      status: summary.status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: summary.durationMs,
      sitesTotal: summary.sitesTotal,
      sitesOk: summary.sitesOk,
      sitesFailed: summary.sitesFailed,
      sitesSkipped: summary.sitesSkipped,
      budgetExceeded: summary.budgetExceeded,
    },
    comparedToRunId: previous?.runId ?? null,
    sites: summary.results.map((result) => {
      const snapshot = current.get(result.siteId);
      const computed = perSite.get(result.siteId);
      return {
        id: result.siteId,
        status: result.status,
        httpStatus: result.homeHttpStatus,
        certDaysRemaining: result.cert?.daysRemaining ?? null,
        lighthouse: {
          desktop: snapshot?.desktop ?? null,
          mobile: snapshot?.mobile ?? null,
        },
        deltas: computed?.deltas ?? {
          desktop: { performance: null, accessibility: null, bestPractices: null, seo: null, lcpMs: null, cls: null },
          mobile: { performance: null, accessibility: null, bestPractices: null, seo: null, lcpMs: null, cls: null },
        },
        flags: computed?.flags ?? { isDown: false, performanceDropped: false, certExpiringSoon: false },
      };
    }),
  };
}
