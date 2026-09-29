/**
 * Comparación contra la corrida anterior y las banderas del webhook.
 *
 * Todo aquí es puro: recibe dos fotografías y devuelve diferencias. Así se puede
 * probar sin base de datos, que importa porque estas banderas son las que
 * despiertan a alguien a media noche y un falso positivo cuesta credibilidad.
 */

import type { SiteRunStatus } from '../db/runs.js';

export interface ScoreSet {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface MetricSet {
  lcpMs: number | null;
  cls: number | null;
}

export interface StrategySnapshot {
  scores: ScoreSet;
  metrics: MetricSet;
}

export interface SiteSnapshot {
  status: SiteRunStatus | null;
  homeHttpStatus: number | null;
  certDaysRemaining: number | null;
  desktop: StrategySnapshot | null;
  mobile: StrategySnapshot | null;
}

export interface SiteFlags {
  isDown: boolean;
  performanceDropped: boolean;
  certExpiringSoon: boolean;
}

export interface FlagThresholds {
  /** Puntos de caída de performance que disparan la bandera. */
  perfDropThreshold: number;
  /** Días restantes de certificado por debajo de los cuales avisar. */
  certWarnDays: number;
}

/**
 * Diferencia actual - anterior. null si falta cualquiera de los dos: un sitio
 * nuevo no "mejoró desde cero", simplemente no tiene con qué comparar.
 */
export function diff(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return Number((current - previous).toFixed(4));
}

export interface StrategyDelta {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
}

export function strategyDelta(
  current: StrategySnapshot | null,
  previous: StrategySnapshot | null,
): StrategyDelta {
  return {
    performance: diff(current?.scores.performance ?? null, previous?.scores.performance ?? null),
    accessibility: diff(current?.scores.accessibility ?? null, previous?.scores.accessibility ?? null),
    bestPractices: diff(current?.scores.bestPractices ?? null, previous?.scores.bestPractices ?? null),
    seo: diff(current?.scores.seo ?? null, previous?.scores.seo ?? null),
    lcpMs: diff(current?.metrics.lcpMs ?? null, previous?.metrics.lcpMs ?? null),
    cls: diff(current?.metrics.cls ?? null, previous?.metrics.cls ?? null),
  };
}

export interface SiteDeltas {
  desktop: StrategyDelta;
  mobile: StrategyDelta;
}

export function computeSiteDeltas(current: SiteSnapshot, previous: SiteSnapshot | null): SiteDeltas {
  return {
    desktop: strategyDelta(current.desktop, previous?.desktop ?? null),
    mobile: strategyDelta(current.mobile, previous?.mobile ?? null),
  };
}

/**
 * Banderas del payload.
 *
 * performanceDropped exige una caída ESTRICTAMENTE mayor al umbral: con el
 * default de 10, bajar exactamente 10 puntos no dispara. Lighthouse varía uno o
 * dos puntos entre corridas idénticas, y un umbral inclusivo generaría avisos por
 * ruido.
 */
export function evaluateFlags(
  current: SiteSnapshot,
  deltas: SiteDeltas,
  thresholds: FlagThresholds,
): SiteFlags {
  const isDown =
    current.status === 'failed' ||
    current.homeHttpStatus === null ||
    current.homeHttpStatus >= 400;

  const drops = [deltas.desktop.performance, deltas.mobile.performance]
    .filter((d): d is number => d !== null)
    .map((d) => -d);

  return {
    isDown,
    performanceDropped: drops.some((drop) => drop > thresholds.perfDropThreshold),
    certExpiringSoon:
      current.certDaysRemaining !== null && current.certDaysRemaining < thresholds.certWarnDays,
  };
}
