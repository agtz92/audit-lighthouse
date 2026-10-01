/**
 * Escritura del ciclo de vida de una corrida: runs y site_runs.
 */

import { db } from './pool.js';
import type { ErrorCategory } from '../audit/page-metrics.js';
import type { DiscoveryMethod } from '../discovery/index.js';
import type { CertInfo } from '../audit/tls.js';

export type RunTrigger = 'scheduled' | 'manual' | 'recovery';
export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';
export type SiteRunStatus = 'running' | 'ok' | 'partial' | 'failed' | 'skipped_timeout';

/**
 * Cierra las corridas que quedaron marcadas como en curso.
 *
 * Se llama al arrancar el worker, y ahí "en curso" solo puede significar una
 * cosa: el proceso murió a media corrida y nadie escribió su final. El worker es
 * lo único que crea corridas y corre una a la vez, así que al arrancar no puede
 * haber ninguna viva.
 *
 * Sin esto quedan huérfanas para siempre: pasó de verdad con la corrida
 * programada del 1 de octubre, que se quedó en 'running' con cero sitios cuando
 * el worker se reinició a los catorce minutos. Ensucian el histórico y, peor,
 * hacen que cualquier consulta de "¿qué está corriendo?" conteste que sí.
 *
 * Una corrida lanzada desde el CLI en otro contenedor se corregiría sola al
 * terminar, porque finishRun escribe su estado sin consultar el anterior.
 */
export async function closeOrphanRuns(): Promise<{ runs: number; siteRuns: number }> {
  const sitios = await db().query(
    `UPDATE site_runs
        SET status = 'failed',
            finished_at = now(),
            error_category = 'unknown',
            error_message = 'el worker se reinició durante la corrida'
      WHERE status = 'running'`,
  );

  const corridas = await db().query(
    `UPDATE runs
        SET status = 'failed',
            finished_at = now(),
            duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
            notes = 'el worker se reinició durante la corrida; quedó sin terminar'
      WHERE status = 'running'`,
  );

  return { runs: corridas.rowCount ?? 0, siteRuns: sitios.rowCount ?? 0 };
}

export async function startRun(trigger: RunTrigger): Promise<number> {
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO runs (trigger, status) VALUES ($1, 'running') RETURNING id`,
    [trigger],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT en runs no devolvió id');
  return id;
}

export interface RunOutcome {
  status: RunStatus;
  sitesTotal: number;
  sitesOk: number;
  sitesFailed: number;
  sitesSkipped: number;
  budgetExceeded: boolean;
  notes?: string | null;
}

export async function finishRun(runId: number, outcome: RunOutcome): Promise<void> {
  await db().query(
    `UPDATE runs SET
       status          = $2,
       finished_at     = now(),
       duration_ms     = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
       sites_total     = $3,
       sites_ok        = $4,
       sites_failed    = $5,
       sites_skipped   = $6,
       budget_exceeded = $7,
       notes           = $8
     WHERE id = $1`,
    [
      runId,
      outcome.status,
      outcome.sitesTotal,
      outcome.sitesOk,
      outcome.sitesFailed,
      outcome.sitesSkipped,
      outcome.budgetExceeded,
      outcome.notes ?? null,
    ],
  );
}

export async function startSiteRun(runId: number, siteId: string): Promise<number> {
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO site_runs (run_id, site_id, status) VALUES ($1, $2, 'running')
     ON CONFLICT (run_id, site_id) DO UPDATE SET status = 'running', started_at = now()
     RETURNING id`,
    [runId, siteId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('INSERT en site_runs no devolvió id');
  return id;
}

export interface SiteRunOutcome {
  status: SiteRunStatus;
  discovery: DiscoveryMethod | null;
  pagesDiscovered: number;
  pagesAudited: number;
  pagesFailed: number;
  maxPages: number;
  truncated: boolean;
  /** Catálogo de URLs descubiertas, para el selector de páginas del dashboard. */
  candidateUrls: string[];
  homeHttpStatus: number | null;
  cert: CertInfo | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
}

export async function finishSiteRun(siteRunId: number, outcome: SiteRunOutcome): Promise<void> {
  await db().query(
    `UPDATE site_runs SET
       status              = $2,
       finished_at         = now(),
       duration_ms         = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::integer,
       discovery           = $3,
       pages_discovered    = $4,
       pages_audited       = $5,
       pages_failed        = $6,
       max_pages           = $7,
       truncated           = $8,
       candidate_urls      = $9::jsonb,
       home_http_status    = $10,
       cert_valid          = $11,
       cert_issuer         = $12,
       cert_valid_from     = $13,
       cert_valid_to       = $14,
       cert_days_remaining = $15,
       cert_error          = $16,
       error_category      = $17,
       error_message       = $18
     WHERE id = $1`,
    [
      siteRunId,
      outcome.status,
      outcome.discovery,
      outcome.pagesDiscovered,
      outcome.pagesAudited,
      outcome.pagesFailed,
      outcome.maxPages,
      outcome.truncated,
      JSON.stringify(outcome.candidateUrls),
      outcome.homeHttpStatus,
      outcome.cert?.valid ?? null,
      outcome.cert?.issuer ?? null,
      outcome.cert?.validFrom ?? null,
      outcome.cert?.validTo ?? null,
      outcome.cert?.daysRemaining ?? null,
      outcome.cert?.error ?? null,
      outcome.errorCategory,
      outcome.errorMessage,
    ],
  );
}

/** Metadatos de un PDF ya escrito en su lugar definitivo. */
export interface PdfMeta {
  bytes: number;
  pages: number;
  generatedAt: Date;
}

/**
 * Registra el PDF de una estrategia. Se llama una vez por estrategia, conforme
 * cada reporte se imprime, y no al final: si la corrida se corta a la mitad,
 * lo que sí se generó queda registrado.
 *
 * El COALESCE conserva lo que ya hubiera: un reporte que no se pudo imprimir
 * deja el metadato del día anterior, igual que deja el archivo del día anterior.
 */
export async function recordPdfMeta(
  siteRunId: number,
  strategy: 'desktop' | 'mobile',
  meta: PdfMeta | null,
): Promise<void> {
  if (meta === null) return;
  const cols = strategy === 'desktop'
    ? ['desktop_pdf_bytes', 'desktop_pdf_pages', 'desktop_pdf_generated_at']
    : ['mobile_pdf_bytes', 'mobile_pdf_pages', 'mobile_pdf_generated_at'];

  await db().query(
    `UPDATE site_runs SET ${cols[0]} = $2, ${cols[1]} = $3, ${cols[2]} = $4 WHERE id = $1`,
    [siteRunId, meta.bytes, meta.pages, meta.generatedAt],
  );
}
