/**
 * Paleta del dashboard. Un solo lugar, usado por tablas y gráficas.
 *
 * Validada con el script de la skill de dataviz sobre las dos superficies
 * (#fcfcfb claro, #1a1a19 oscuro). Las dos series que usan las gráficas
 * —desktop y mobile— pasan los seis checks en ambos modos sin ninguna
 * advertencia: banda de luminosidad, piso de croma, separación para
 * daltonismo (ΔE 24.7 protan en claro, 26.8 en oscuro), piso de visión
 * normal y contraste contra la superficie.
 *
 * Se eligió graficar 2 series por gráfica y usar una gráfica por métrica
 * (small multiples) en lugar de meter los 4 scores de Lighthouse juntos:
 * con 4 series, dos de los colores quedaban por debajo de 3:1 de contraste
 * en modo claro y exigían relieve. Con 2 no hace falta.
 */

/** Series categóricas. El orden es fijo: nunca se cicla ni se reasigna. */
export const SERIES = {
  desktop: { light: '#2a78d6', dark: '#3987e5', label: 'Escritorio' },
  mobile: { light: '#eb6834', dark: '#d95926', label: 'Móvil' },
} as const;

export type SeriesKey = keyof typeof SERIES;

/**
 * Estados. Reservados: nunca se reutilizan como color de serie, y siempre
 * viajan con un ícono y una etiqueta, porque en modo claro `warning` y
 * `serious` quedan por debajo de 3:1 a propósito y el color no puede cargar
 * el significado solo.
 */
export const STATUS = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

export type StatusKey = keyof typeof STATUS;

/** Umbrales oficiales de Core Web Vitals, para colorear un valor por su estado. */
export const THRESHOLDS = {
  lcpMs: { good: 2500, needsWork: 4000 },
  cls: { good: 0.1, needsWork: 0.25 },
  tbtMs: { good: 200, needsWork: 600 },
  score: { good: 90, needsWork: 50 },
} as const;

/** Estado de un valor según su umbral. Mayor es mejor solo para los scores. */
export function rateLowerIsBetter(value: number | null, t: { good: number; needsWork: number }): StatusKey | null {
  if (value === null) return null;
  if (value <= t.good) return 'good';
  if (value <= t.needsWork) return 'warning';
  return 'critical';
}

export function rateScore(value: number | null): StatusKey | null {
  if (value === null) return null;
  if (value >= THRESHOLDS.score.good) return 'good';
  if (value >= THRESHOLDS.score.needsWork) return 'warning';
  return 'critical';
}
