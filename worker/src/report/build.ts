/**
 * Arma el objeto del informe a partir del reporte de Lighthouse y de lo que
 * midió el propio sistema.
 *
 * Todo aquí es puro: recibe datos, devuelve datos. Es donde vive el criterio
 * —qué se considera prioritario, cómo se redacta el impacto— y por eso conviene
 * que se pueda probar sin navegador.
 */

import type { LighthouseStrategy } from '../audit/lighthouse.js';
import { opportunities, findings, metric, type Lhr, type Opportunity } from './extract.js';
import type {
  ReportData, Consultant, ScoreSet, MetricSet, PageRow, CertRow, Priority, Comparison,
} from './model.js';
import { THRESHOLDS, LIMITS, rate } from './model.js';
import { folio, ms, bytes } from './format.js';

export interface BuildInput {
  consultant: Consultant;
  site: { name: string; url: string };
  strategy: LighthouseStrategy;
  runId: number;
  runAt: Date;
  lhr: Lhr;
  pages: PageRow[];
  pagesDiscovered: number;
  cert: CertRow | null;
  /** Valores de la misma estrategia en la corrida anterior, si la hubo. */
  previous: { scores: Partial<ScoreSet>; metrics: Partial<MetricSet> } | null;
}

function scoreOf(lhr: Lhr, id: string): number | null {
  const s = lhr.categories?.[id]?.score;
  return typeof s === 'number' ? Math.round(s * 100) : null;
}

/**
 * Las tres o cuatro cosas que conviene atender primero.
 *
 * El orden no es el de Lighthouse: primero lo que tiene un ahorro de tiempo
 * medido, porque es lo único cuyo beneficio se puede cuantificar de antemano;
 * después los hallazgos de accesibilidad, que son concretos y suelen ser
 * baratos de corregir. Lo que no tiene impacto estimado no compite con lo que sí.
 */
export function derivePriorities(opps: Opportunity[], finds: ReturnType<typeof findings>): Priority[] {
  const out: Priority[] = [];

  for (const opp of opps.slice(0, 2)) {
    out.push({
      title: opp.title,
      detail: clamp(
        opp.savingsBytes > 0
          ? `Se descargan ${bytes(opp.savingsBytes)} que no hacen falta para pintar la página. Recortarlos ahorra alrededor de ${ms(opp.savingsMs)} en la carga.`
          : `Ahorro estimado de ${ms(opp.savingsMs)} en la carga.`,
      ),
      impact: opp.savingsBytes > 0 ? `−${ms(opp.savingsMs)} · ${bytes(opp.savingsBytes)}` : `−${ms(opp.savingsMs)}`,
      severity: opp.savingsMs >= 500 ? 'critical' : 'warning',
    });
  }

  const accesibilidad = finds.filter((f) => f.category === 'accessibility');
  for (const f of accesibilidad.slice(0, Math.max(1, LIMITS.priorities - out.length))) {
    out.push({ title: f.title, detail: clamp(f.description), impact: 'Accesibilidad', severity: 'warning' });
  }

  if (out.length === 0) {
    const resto = finds[0];
    if (resto !== undefined) {
      out.push({ title: resto.title, detail: clamp(resto.description), impact: 'Calidad', severity: 'warning' });
    }
  }

  return out.slice(0, LIMITS.priorities);
}

/** Recorta un detalle al tope de la lista de prioridades, en el último espacio. */
function clamp(text: string, max = LIMITS.priorityDetailChars): string {
  if (text.length <= max) return text;
  const corte = text.lastIndexOf(' ', max);
  return `${text.slice(0, corte > 40 ? corte : max).replace(/[.,;:]$/, '')}…`;
}

function compare(
  label: string,
  previous: number | null | undefined,
  current: number | null,
  fmt: (v: number | null) => string,
  lowerIsBetter: boolean,
  note: (delta: number | null) => string,
): Comparison {
  const prev = previous ?? null;
  const delta = prev === null || current === null ? null : Number((current - prev).toFixed(3));
  let trend: Comparison['trend'] = null;
  if (delta !== null) {
    if (delta === 0) trend = 'flat';
    else trend = (delta < 0) === lowerIsBetter ? 'better' : 'worse';
  }
  return {
    label,
    previous: fmt(prev),
    current: fmt(current),
    delta: delta === null ? '—' : `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}`,
    trend,
    note: note(delta),
  };
}

export function buildReportData(input: BuildInput): ReportData {
  const { lhr } = input;

  const scores: ScoreSet = {
    performance: scoreOf(lhr, 'performance'),
    accessibility: scoreOf(lhr, 'accessibility'),
    bestPractices: scoreOf(lhr, 'best-practices'),
    seo: scoreOf(lhr, 'seo'),
  };

  const metrics: MetricSet = {
    lcpMs: metric(lhr, 'largest-contentful-paint'),
    clsValue: metric(lhr, 'cumulative-layout-shift'),
    tbtMs: metric(lhr, 'total-blocking-time'),
    fcpMs: metric(lhr, 'first-contentful-paint'),
    speedIndexMs: metric(lhr, 'speed-index'),
    ttiMs: metric(lhr, 'interactive'),
  };

  const opps = opportunities(lhr);
  const finds = findings(lhr);

  const comparisons: Comparison[] = [
    compare('Rendimiento', input.previous?.scores.performance, scores.performance,
      (v) => (v === null ? '—' : String(Math.round(v))), false,
      (d) => (d === null ? 'primera medición' : Math.abs(d) <= 3 ? 'dentro del ruido normal' : d < 0 ? 'caída significativa' : 'mejora significativa')),
    compare('LCP', input.previous?.metrics.lcpMs, metrics.lcpMs, (v) => ms(v), true,
      (d) => (d === null ? 'primera medición' : Math.abs(d) < 300 ? 'estable' : d < 0 ? 'más rápido' : 'más lento')),
    compare('TBT', input.previous?.metrics.tbtMs, metrics.tbtMs, (v) => ms(v), true,
      (d) => (d === null ? 'primera medición' : Math.abs(d) < 50 ? 'estable' : d < 0 ? 'menos bloqueo' : 'más bloqueo')),
  ];

  return {
    consultant: input.consultant,
    site: input.site,
    strategy: input.strategy,
    runId: input.runId,
    runAt: input.runAt,
    folio: folio(input.runAt, input.runId),
    lighthouseVersion: lhr.lighthouseVersion ?? null,
    scores,
    metrics,
    opportunities: opps,
    findings: finds,
    priorities: derivePriorities(opps, finds),
    comparisons,
    pages: input.pages,
    pagesDiscovered: input.pagesDiscovered,
    pagesAudited: input.pages.length,
    cert: input.cert,
  };
}

/**
 * Párrafo de conclusión, redactado a partir de los números.
 *
 * Se arma por reglas y no con una plantilla fija porque un informe que dice
 * "el rendimiento es 59" no concluye nada; lo que el cliente necesita leer es
 * qué está bien, qué no, y cuál es la causa dominante.
 */
export function verdict(data: ReportData): string {
  const partes: string[] = [];
  const modo = data.strategy === 'desktop' ? 'escritorio' : 'móvil';
  const perf = data.scores.performance;

  const calidad = [data.scores.accessibility, data.scores.bestPractices, data.scores.seo]
    .filter((v): v is number => v !== null);
  const calidadAlta = calidad.length > 0 && calidad.every((v) => v >= 90);

  if (perf === null) {
    partes.push(`No fue posible calcular el rendimiento en ${modo} en esta corrida.`);
  } else if (perf >= 90) {
    partes.push(`El rendimiento en ${modo} es bueno: <b>${perf} de 100</b>.`);
  } else if (perf >= 50) {
    partes.push(`El rendimiento en ${modo} es mejorable: <b>${perf} de 100</b>.`);
  } else {
    partes.push(`El rendimiento en ${modo} es deficiente: <b>${perf} de 100</b>.`);
  }

  const lcp = data.metrics.lcpMs;
  if (lcp !== null && rate(lcp, THRESHOLDS.lcpMs) !== 'good') {
    const veces = (lcp / THRESHOLDS.lcpMs.good).toFixed(1);
    partes.push(
      `El contenido principal tarda <b>${ms(lcp)}</b> en aparecer, ${veces} veces el umbral recomendado de ${ms(THRESHOLDS.lcpMs.good)}.`,
    );
  }

  const top = data.opportunities[0];
  if (top !== undefined) {
    partes.push(`La causa con mayor impacto medido es «${top.title}», que por sí sola explica cerca de ${ms(top.savingsMs)} del retraso.`);
  }

  if (calidadAlta) {
    partes.push('Accesibilidad, buenas prácticas y SEO están en buen estado.');
  } else if (data.findings.length > 0) {
    partes.push(`Hay ${data.findings.length} ${data.findings.length === 1 ? 'auditoría no aprobada' : 'auditorías no aprobadas'} fuera del rendimiento.`);
  }

  return partes.join(' ');
}
