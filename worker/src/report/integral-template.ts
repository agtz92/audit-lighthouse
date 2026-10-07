/**
 * Informe integral (integral.pdf): rendimiento técnico y tráfico en un solo
 * documento, con el mismo membrete que los demás.
 *
 * No es un engrapado de los otros informes. Abre con un resumen ejecutivo que
 * cruza las dos miradas —qué páginas reciben visitas y en qué estado están,
 * qué conviene atender primero de todo junto— y después reutiliza las hojas de
 * diagnóstico y de tráfico tal como son, con la numeración de secciones
 * corrida de principio a fin.
 */

import type { ReportData, Priority } from './model.js';
import { rateScore, rate, THRESHOLDS } from './model.js';
import { type AnalyticsReportData, mergedPages, pageProblem, relChange } from './analytics-model.js';
import { brandHeader, coverSheet, documentHtml, Sections } from './brand.js';
import { LIGHTHOUSE_CSS, diagnosticSheet, infraSheet, colorClass } from './template.js';
import { ANALYTICS_CSS, summarySheet, searchSheet, trafficSheet } from './analytics-template.js';
import { int, pct, ms, esc, longDate, time } from './format.js';

export interface IntegralInput {
  desktop: ReportData | null;
  mobile: ReportData | null;
  traffic: AnalyticsReportData;
}

const INTEGRAL_CSS = `
.mix { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); }
.mix > div { background:var(--paper); padding:8px 10px; }
.mix dt { font-family:Archivo,sans-serif; font-weight:600; font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.mix dd { margin:2px 0 0; font-family:Archivo,sans-serif; font-size:16pt; font-weight:700; letter-spacing:-.03em; }
.mix .u { font-size:8pt; color:var(--muted); }
`;

/** El documento sale de la medición de Lighthouse; si no hay ninguna, no hay integral. */
function base(input: IntegralInput): ReportData {
  const d = input.mobile ?? input.desktop;
  if (d === null) throw new Error('el informe integral necesita al menos una medición de Lighthouse');
  return d;
}

export function integralFooterText(input: IntegralInput): string {
  const d = base(input);
  return `${d.site.name} · Integral · ${longDate(d.runAt)}`;
}

/**
 * Prioridades de todo junto. Primero lo que pierde visitas hoy (páginas con
 * tráfico rotas, caídas de clics), luego lo que Lighthouse midió con impacto
 * —móvil antes que escritorio, porque es donde llega la mayoría—, y al final
 * las oportunidades de búsqueda.
 */
export function integralPriorities(input: IntegralInput, max = 5): Priority[] {
  const trafico = input.traffic.priorities;
  const urgentes = trafico.filter((p) => p.severity === 'critical');
  const resto = trafico.filter((p) => p.severity !== 'critical');
  const lh = [
    ...(input.mobile?.priorities.slice(0, 2).map((p) => ({ ...p, impact: `móvil · ${p.impact}` })) ?? []),
    ...(input.desktop?.priorities.slice(0, 1).map((p) => ({ ...p, impact: `escritorio · ${p.impact}` })) ?? []),
  ];

  const out: Priority[] = [];
  const vistos = new Set<string>();
  for (const p of [...urgentes, ...lh, ...resto]) {
    // La misma recomendación de Lighthouse sale en las dos estrategias.
    if (vistos.has(p.title)) continue;
    vistos.add(p.title);
    out.push(p);
  }
  return out.slice(0, max);
}

/** Párrafo de cierre que junta las dos miradas. */
export function integralVerdict(input: IntegralInput): string {
  const partes: string[] = [];
  const t = input.traffic;
  const pm = input.mobile?.scores.performance ?? null;
  const pd = input.desktop?.scores.performance ?? null;

  if (pm !== null && pd !== null) {
    partes.push(`El rendimiento es de <b>${pm}</b> en móvil y <b>${pd}</b> en escritorio.`);
  } else if (pm !== null || pd !== null) {
    partes.push(`El rendimiento medido es de <b>${pm ?? pd}</b> de 100.`);
  }

  const movil = t.ga?.devices.find((d) => d.key === 'Móvil');
  if (movil !== undefined && pm !== null && movil.share >= 0.5 && pm < 90) {
    partes.push(`El ${pct(movil.share, 0)} de las visitas llega desde el celular, justo donde el sitio es más lento: mejorar el rendimiento móvil es lo que más visitantes alcanza.`);
  }

  if (t.gsc !== null) {
    const c = relChange(t.gsc.totals.clicks, t.gsc.previousTotals.clicks);
    partes.push(c === null
      ? `En ${t.period.label} recibió ${int(t.gsc.totals.clicks)} clics desde Google.`
      : `Los clics desde Google ${Math.abs(c) < 0.03 ? 'se mantuvieron' : c > 0 ? 'subieron' : 'bajaron'}${Math.abs(c) < 0.03 ? '' : ` ${pct(Math.abs(c), 1)}`} (${int(t.gsc.totals.clicks)} en ${t.period.label}).`);
  }
  if (t.ga !== null && t.ga.totals.keyEvents > 0) {
    partes.push(`Se registraron ${int(t.ga.totals.keyEvents)} eventos clave.`);
  }

  const rotas = mergedPages(t, 30).filter((p) => pageProblem(p) === 'down');
  if (rotas.length > 0) {
    partes.push(`${rotas.length === 1 ? 'Una página con tráfico no responde bien' : `${rotas.length} páginas con tráfico no responden bien`}: es lo primero que hay que atender.`);
  }
  return partes.join(' ');
}

function executiveSheet(input: IntegralInput, s: Sections): string {
  const d = base(input);
  const t = input.traffic;
  const paginas = mergedPages(t, 10);
  const prioridades = integralPriorities(input);
  const pm = input.mobile?.scores.performance ?? null;
  const pd = input.desktop?.scores.performance ?? null;
  const tasa = t.ga === null || t.ga.totals.sessions === 0 ? null : t.ga.totals.engagedSessions / t.ga.totals.sessions;

  const caja = (dt: string, dd: string, u: string, clase = ''): string =>
    `<div><dt>${dt}</dt><dd class="${clase}">${dd}</dd><div class="u">${u}</div></div>`;

  return `<section class="sheet">
  ${brandHeader(d.consultant, 'Resumen ejecutivo', d.site.name)}

  ${s.sec('Conclusión')}
  <p class="verdict">${integralVerdict(input)}</p>

  ${s.sec('Salud técnica y tráfico', `medición del ${longDate(d.runAt)} · tráfico de ${esc(t.period.label)}`)}
  <dl class="mix">
    ${caja('Rendimiento móvil', pm === null ? '—' : String(pm), 'Lighthouse, 0 a 100', colorClass(rateScore(pm)))}
    ${caja('Rendimiento escritorio', pd === null ? '—' : String(pd), 'Lighthouse, 0 a 100', colorClass(rateScore(pd)))}
    ${caja('LCP móvil', ms(input.mobile?.metrics.lcpMs ?? null), `umbral ${ms(THRESHOLDS.lcpMs.good)}`, colorClass(rate(input.mobile?.metrics.lcpMs ?? null, THRESHOLDS.lcpMs)))}
    ${caja('Clics desde Google', t.gsc === null ? '—' : int(t.gsc.totals.clicks), t.gsc === null ? 'Search Console sin conectar' : `posición media ${t.gsc.totals.position?.toFixed(1) ?? '—'}`)}
    ${caja('Sesiones', t.ga === null ? '—' : int(t.ga.totals.sessions), t.ga === null ? 'GA4 sin conectar' : `interacción ${pct(tasa, 0)}`)}
    ${caja('Eventos clave', t.ga === null ? '—' : int(t.ga.totals.keyEvents), t.ga === null ? '' : t.ga.keyEventsDefined.length === 0 ? 'ninguno definido' : `${t.ga.keyEventsDefined.length} definidos`)}
  </dl>

  ${s.sec('Páginas con tráfico y su estado', 'clics de Google, sesiones de GA4 y la auditoría de hoy')}
  ${paginas.length === 0 ? '<p class="empty">Todavía no hay páginas con tráfico en el periodo.</p>' : `<table>
    <thead><tr><th>Página</th><th class="num">Clics</th><th class="num">Sesiones</th><th class="num">Carga</th><th>Estado</th></tr></thead>
    <tbody>${paginas.map((p) => {
      const problema = pageProblem(p);
      return `<tr>
      <td class="path">${esc(p.path)}</td>
      <td class="num">${int(p.clicks)}</td>
      <td class="num">${int(p.sessions)}</td>
      <td class="num ${problema === 'slow' ? 'w' : ''}">${ms(p.health?.loadMs ?? null)}</td>
      <td>${p.health === null ? '<span class="hint">no auditada</span>' : problema === 'down' ? `<span class="tag tag-b">${p.health.httpStatus ?? 'error'}</span>` : problema === 'slow' ? '<span class="tag tag-w">lenta</span>' : `<span class="g">${p.health.httpStatus ?? 'ok'}</span>`}</td>
    </tr>`;
    }).join('')}</tbody>
  </table>
  ${paginas.some((p) => p.health === null)
    ? '<p class="hint" style="margin-top:6px">«No auditada» significa que la página recibe tráfico pero no está entre las que mide la auditoría diaria. Se puede agregar desde el dashboard.</p>'
    : ''}`}

  ${s.sec('Atender primero', 'tráfico y rendimiento juntos')}
  ${prioridades.length === 0
    ? '<p class="empty">No hay acciones pendientes con impacto medible.</p>'
    : `<ol class="prio">${prioridades.map((p) => `<li>
        <div><b>${esc(p.title)}</b><p>${esc(p.detail)}</p></div>
        <span class="impact ${p.severity === 'critical' ? 'b' : 'w'}">${esc(p.impact)}</span>
      </li>`).join('')}</ol>`}
</section>`;
}

function methodSheet(input: IntegralInput, s: Sections): string {
  const d = base(input);
  const t = input.traffic;
  return `<section class="sheet">
  ${brandHeader(d.consultant, 'Método', d.site.name)}
  ${s.sec('Fuentes y método')}
  <p class="method">
    El rendimiento viene de Lighthouse ${esc(d.lighthouseVersion ?? '')}, ejecutado el ${longDate(d.runAt)} a las ${time(d.runAt)}
    (hora de Ciudad de México) de forma aislada, en escritorio y en móvil, para que las cifras sean comparables
    entre días. Son mediciones de laboratorio: sirven para detectar regresiones y comparar, no describen la
    experiencia exacta de cada visitante.
  </p>
  <p class="method">
    El tráfico viene de ${t.gsc !== null ? 'Google Search Console' : ''}${t.gsc !== null && t.ga !== null ? ' y ' : ''}${t.ga !== null ? 'Google Analytics 4' : ''}
    para ${esc(t.period.label)}, comparado contra ${esc(t.period.previousLabel)}. Search Console cuenta las búsquedas
    en Google; GA4 cuenta todas las visitas que cargaron su etiqueta. Por eso clics y sesiones no coinciden.
  </p>
  <p class="method">
    El estado de cada página cruza las dos fuentes por su ruta: una página que recibe tráfico y en la auditoría
    respondió con error o tardó más de 4 segundos en cargar aparece marcada.
  </p>
</section>`;
}

export async function renderIntegralHtml(input: IntegralInput): Promise<string> {
  const d = base(input);
  const t = input.traffic;
  const s = new Sections();

  const body = [
    coverSheet({
      consultant: d.consultant,
      kind: 'Informe integral · rendimiento y tráfico',
      site: d.site,
      facts: [
        ['Medición', longDate(d.runAt)],
        ['Tráfico', t.period.label],
        ['Folio', d.folio],
      ],
    }),
    executiveSheet(input, s),
    input.mobile === null ? '' : diagnosticSheet(input.mobile, s, 'Diagnóstico · Móvil'),
    input.desktop === null ? '' : diagnosticSheet(input.desktop, s, 'Diagnóstico · Escritorio'),
    t.gsc === null && t.ga === null ? '' : summarySheet(t, s, false, 'Tráfico'),
    searchSheet(t, s),
    t.ga === null ? '' : trafficSheet(t, s, false),
    infraSheet(d, s, false),
    methodSheet(input, s),
  ].filter((x) => x !== '').join('\n\n');

  return documentHtml(`${d.site.name} — Informe integral`, `${LIGHTHOUSE_CSS}\n${ANALYTICS_CSS}\n${INTEGRAL_CSS}`, body);
}
