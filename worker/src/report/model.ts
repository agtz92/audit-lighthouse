/**
 * Los datos que necesita un informe, ya resueltos.
 *
 * Es deliberadamente plano y sin dependencias: la plantilla solo formatea lo que
 * recibe aquí, y armar este objeto se puede probar sin navegador ni PDF.
 */

import type { LighthouseStrategy } from '../audit/lighthouse.js';
import type { Opportunity, Finding } from './extract.js';

export interface Consultant {
  name: string;
  role: string;
  credentials: string;
}

export interface ScoreSet {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface MetricSet {
  lcpMs: number | null;
  clsValue: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  speedIndexMs: number | null;
  ttiMs: number | null;
}

export interface PageRow {
  path: string;
  isHome: boolean;
  httpStatus: number | null;
  ttfbMs: number | null;
  loadMs: number | null;
  transferBytes: number | null;
  requestCount: number | null;
  ok: boolean;
}

export interface CertRow {
  issuer: string | null;
  validTo: Date | null;
  daysRemaining: number | null;
  valid: boolean | null;
}

export interface Priority {
  title: string;
  detail: string;
  /** Texto corto del impacto, ya formateado. */
  impact: string;
  severity: 'critical' | 'warning';
}

export interface Comparison {
  label: string;
  previous: string;
  current: string;
  delta: string;
  /** null cuando no hay corrida anterior con qué comparar. */
  trend: 'better' | 'worse' | 'flat' | null;
  note: string;
}

export interface ReportData {
  consultant: Consultant;
  site: { name: string; url: string };
  strategy: LighthouseStrategy;
  runId: number;
  runAt: Date;
  folio: string;
  lighthouseVersion: string | null;

  scores: ScoreSet;
  metrics: MetricSet;
  opportunities: Opportunity[];
  findings: Finding[];
  priorities: Priority[];
  comparisons: Comparison[];

  pages: PageRow[];
  pagesDiscovered: number;
  pagesAudited: number;
  cert: CertRow | null;
}

/**
 * Topes de cada lista del informe.
 *
 * Existen para que un sitio con cien hallazgos no produzca un documento
 * inmanejable, NO para forzar un número fijo de hojas: el informe ocupa las que
 * necesite y Chromium numera las páginas de verdad. Son generosos a propósito —
 * esconder un hallazgo real para ganar media hoja es el peor intercambio
 * posible en un informe técnico. Lo que sí se recorta se anuncia en el documento.
 */
export const LIMITS = {
  priorities: 4,
  priorityDetailChars: 260,
  opportunities: 10,
  accessibilityFindings: 15,
  otherFindings: 10,
  findingDescriptionChars: 320,
  pageRows: 60,
} as const;

/** Umbrales oficiales de Core Web Vitals y de los scores de Lighthouse. */
export const THRESHOLDS = {
  lcpMs: { good: 2500, poor: 4000 },
  clsValue: { good: 0.1, poor: 0.25 },
  tbtMs: { good: 200, poor: 600 },
  fcpMs: { good: 1800, poor: 3000 },
  speedIndexMs: { good: 3400, poor: 5800 },
  ttiMs: { good: 3800, poor: 7300 },
} as const;

export type Rating = 'good' | 'warning' | 'bad' | 'none';

/** Estado de una métrica donde menos es mejor. */
export function rate(value: number | null, t: { good: number; poor: number }): Rating {
  if (value === null) return 'none';
  if (value <= t.good) return 'good';
  if (value <= t.poor) return 'warning';
  return 'bad';
}

/** Estado de un score de Lighthouse, donde más es mejor. */
export function rateScore(value: number | null): Rating {
  if (value === null) return 'none';
  if (value >= 90) return 'good';
  if (value >= 50) return 'warning';
  return 'bad';
}

export const RATING_LABEL: Record<Rating, string> = {
  good: 'Bueno',
  warning: 'Mejorable',
  bad: 'Deficiente',
  none: 'Sin dato',
};
