/**
 * Lighthouse sobre el mismo Chromium que ya levantó Playwright.
 *
 * Se conecta por el puerto CDP que se le pasó al navegador al lanzarlo, así que
 * no se abre un segundo Chromium por sitio. Solo corre sobre la URL principal:
 * hacerlo en las 50 páginas de cada sitio multiplicaría por 100 la corrida y
 * haría imposible la ventana de las 6am.
 *
 * Sobre el paralelismo: aunque Lighthouse 13 usa throttling simulado (analiza el
 * trace en vez de frenar la máquina de verdad), el trace sí sale de una carga
 * real. Dos corridas compitiendo por CPU producen scores que bailan varios puntos
 * entre días sin que el sitio haya cambiado, y eso envenenaría justo la bandera
 * performanceDropped del webhook. Por eso LIGHTHOUSE_CONCURRENCY viene en 1.
 */

import { gzipSync } from 'node:zlib';
import lighthouse, { desktopConfig } from 'lighthouse';

export type LighthouseStrategy = 'desktop' | 'mobile';

export interface LighthouseScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface LighthouseMetrics {
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  /** Siempre null: INP es métrica de campo (CrUX), no la da una corrida de lab. */
  inpMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  ttiMs: number | null;
}

export interface LighthouseOutcome {
  strategy: LighthouseStrategy;
  url: string;
  ok: boolean;
  scores: LighthouseScores;
  metrics: LighthouseMetrics;
  version: string | null;
  /** Reporte JSON completo comprimido con gzip: ~50 KB en vez de ~600 KB. */
  rawGzip: Buffer | null;
  error: string | null;
}

const EMPTY_SCORES: LighthouseScores = {
  performance: null, accessibility: null, bestPractices: null, seo: null,
};

const EMPTY_METRICS: LighthouseMetrics = {
  lcpMs: null, cls: null, tbtMs: null, inpMs: null,
  fcpMs: null, speedIndexMs: null, ttiMs: null,
};

/** Los scores de Lighthouse vienen en 0..1; el esquema los guarda en 0..100. */
function toScore(value: number | null | undefined): number | null {
  return value === null || value === undefined ? null : Math.round(value * 100);
}

function numericValue(
  audits: Record<string, { numericValue?: number } | undefined>,
  id: string,
): number | null {
  const v = audits[id]?.numericValue;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export async function runLighthouse(
  url: string,
  cdpPort: number,
  strategy: LighthouseStrategy,
  timeoutMs: number,
): Promise<LighthouseOutcome> {
  const base: Omit<LighthouseOutcome, 'ok' | 'error'> = {
    strategy, url, scores: EMPTY_SCORES, metrics: EMPTY_METRICS, version: null, rawGzip: null,
  };

  try {
    const run = lighthouse(
      url,
      {
        port: cdpPort,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      },
      // El config de escritorio cambia viewport, user agent y el perfil de red;
      // sin él, "desktop" mediría exactamente lo mismo que mobile.
      strategy === 'desktop' ? desktopConfig : undefined,
    );

    // Lighthouse no acepta AbortSignal. La carrera evita que un sitio que nunca
    // termina de cargar se coma el presupuesto completo de la corrida.
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Lighthouse excedió ${timeoutMs} ms`)), timeoutMs).unref(),
      ),
    ]);

    if (result === undefined) {
      return { ...base, ok: false, error: 'Lighthouse no devolvió resultado' };
    }

    const { lhr } = result;
    const audits = lhr.audits as Record<string, { numericValue?: number } | undefined>;
    const cats = lhr.categories;

    const cls = numericValue(audits, 'cumulative-layout-shift');

    return {
      ...base,
      ok: true,
      version: lhr.lighthouseVersion ?? null,
      scores: {
        performance: toScore(cats.performance?.score),
        accessibility: toScore(cats.accessibility?.score),
        bestPractices: toScore(cats['best-practices']?.score),
        seo: toScore(cats.seo?.score),
      },
      metrics: {
        lcpMs: roundOrNull(numericValue(audits, 'largest-contentful-paint')),
        // CLS es adimensional y pequeño: redondearlo a entero lo destruiría.
        cls: cls === null ? null : Number(cls.toFixed(4)),
        tbtMs: roundOrNull(numericValue(audits, 'total-blocking-time')),
        inpMs: null,
        fcpMs: roundOrNull(numericValue(audits, 'first-contentful-paint')),
        speedIndexMs: roundOrNull(numericValue(audits, 'speed-index')),
        ttiMs: roundOrNull(numericValue(audits, 'interactive')),
      },
      rawGzip: gzipSync(Buffer.from(JSON.stringify(lhr), 'utf8')),
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
