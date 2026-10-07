/**
 * Plantilla del informe de búsqueda y tráfico (analitica.pdf).
 *
 * Mismo membrete que los informes de Lighthouse; las hojas son funciones aparte
 * porque el informe integral las reutiliza.
 */

import {
  type AnalyticsReportData, type PageTrafficRow, type ShareRow,
  analyticsVerdict, relChange, pageProblem,
} from './analytics-model.js';
import { brandHeader, coverSheet, documentHtml, Sections } from './brand.js';
import { int, compact, pct, ms, isoDate, esc, longDate } from './format.js';
import { lineChartSvg, barCell } from './svg.js';

export const ANALYTICS_CSS = `
.kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); }
.kpis > div { background:var(--paper); padding:8px 10px; }
.kpis dt { font-family:Archivo,sans-serif; font-weight:600; font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.kpis dd { margin:2px 0 0; font-family:Archivo,sans-serif; font-size:15pt; font-weight:700; letter-spacing:-.03em; }
.kpis .d { font-family:"Roboto Mono",monospace; font-size:7.5pt; color:var(--muted); }
.kpis .d.g { color:var(--good); } .kpis .d.b { color:var(--bad); }
.kpis .src { grid-column:1/-1; background:var(--wash); font-family:Archivo,sans-serif; font-size:6.5pt; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--muted); padding:4px 10px; }
.chart { margin:2px 0 0; }
.legend { display:flex; gap:14px; font-size:8pt; color:var(--muted); margin-top:2px; }
.legend i { display:inline-block; width:14px; height:0; vertical-align:middle; margin-right:5px; border-top:2px solid var(--accent); }
.legend i.prev { border-top:2px dashed var(--faint); }
.hbar { display:block; height:5px; background:var(--hair); min-width:36px; }
.share td:first-child { white-space:nowrap; }
.hbar i { display:block; height:100%; }
.cut { max-width:0; width:46%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.two { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
.chips { display:flex; flex-wrap:wrap; gap:5px; margin-top:6px; }
.chips span { font-family:"Roboto Mono",monospace; font-size:7.5pt; border:1px solid var(--rule); padding:1px 5px; color:var(--muted); }
`;

/**
 * Cambio contra el periodo anterior, con la convención del dashboard: la
 * flecha dice si mejoró (▲) o empeoró (▼), el signo hacia dónde se movió el
 * número, y el color lo refuerza.
 */
function delta(current: number | null, previous: number | null, opts: { lowerIsBetter?: boolean; absolute?: boolean; digits?: number } = {}): string {
  if (current === null || previous === null) return '<span class="d">sin comparación</span>';
  if (opts.absolute === true) {
    const d = current - previous;
    if (Math.abs(d) < 0.05) return '<span class="d">sin cambio</span>';
    const mejora = opts.lowerIsBetter === true ? d < 0 : d > 0;
    return `<span class="d ${mejora ? 'g' : 'b'}">${mejora ? '▲' : '▼'} ${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(opts.digits ?? 1)}</span>`;
  }
  const r = relChange(current, previous);
  if (r === null) return '<span class="d">sin comparación</span>';
  if (Math.abs(r) < 0.005) return '<span class="d">sin cambio</span>';
  const mejora = opts.lowerIsBetter === true ? r < 0 : r > 0;
  return `<span class="d ${mejora ? 'g' : 'b'}">${mejora ? '▲' : '▼'} ${r > 0 ? '+' : '−'}${pct(Math.abs(r), 1)}</span>`;
}

function kpi(label: string, valor: string, cambio: string): string {
  return `<div><dt>${label}</dt><dd>${valor}</dd>${cambio}</div>`;
}

function estado(p: PageTrafficRow): string {
  const problema = pageProblem(p);
  if (p.health === null) return '<span class="hint">no auditada</span>';
  if (problema === 'down') return `<span class="tag tag-b">${p.health.httpStatus ?? 'error'}</span>`;
  if (problema === 'slow') return `<span class="tag tag-w">${ms(p.health.loadMs)}</span>`;
  return `<span class="g">${p.health.httpStatus ?? 'ok'}</span> <span class="hint">${ms(p.health.loadMs)}</span>`;
}

export function trafficFooterText(data: AnalyticsReportData, kind = 'Búsqueda y tráfico'): string {
  return `${data.site.name} · ${kind} · ${data.period.label}`;
}

/** Indicadores y tendencia. `conVeredicto` lo apaga en el integral, que tiene el suyo. */
export function summarySheet(data: AnalyticsReportData, s: Sections, conVeredicto = true, titulo = 'Búsqueda y tráfico'): string {
  const g = data.gsc;
  const a = data.ga;
  const tasa = (t: { sessions: number; engagedSessions: number } | null): number | null =>
    t === null || t.sessions === 0 ? null : t.engagedSessions / t.sessions;

  return `<section class="sheet">
  ${brandHeader(data.consultant, titulo, data.site.name)}

  ${conVeredicto ? `${s.sec('Conclusión')}
  <p class="verdict">${analyticsVerdict(data)}</p>` : ''}

  ${s.sec('Indicadores', `${esc(data.period.label)} contra ${esc(data.period.previousLabel)}`)}
  <dl class="kpis">
    ${g === null ? '' : `<div class="src">Search Console · ${esc(g.property)}</div>
    ${kpi('Clics', int(g.totals.clicks), delta(g.totals.clicks, g.previousTotals.clicks))}
    ${kpi('Impresiones', compact(g.totals.impressions), delta(g.totals.impressions, g.previousTotals.impressions))}
    ${kpi('CTR', pct(g.totals.ctr), delta(g.totals.ctr, g.previousTotals.ctr))}
    ${kpi('Posición media', g.totals.position?.toFixed(1) ?? '—', delta(g.totals.position, g.previousTotals.position, { absolute: true, lowerIsBetter: true }))}`}
    ${a === null ? '' : `<div class="src">Google Analytics 4 · propiedad ${esc(a.property)}</div>
    ${kpi('Sesiones', int(a.totals.sessions), delta(a.totals.sessions, a.previousTotals?.sessions ?? null))}
    ${kpi('Usuarios', int(a.totals.totalUsers), delta(a.totals.totalUsers, a.previousTotals?.totalUsers ?? null))}
    ${kpi('Interacción', pct(tasa(a.totals), 0), delta(tasa(a.totals), tasa(a.previousTotals)))}
    ${kpi('Eventos clave', int(a.totals.keyEvents), delta(a.totals.keyEvents, a.previousTotals?.keyEvents ?? null))}`}
  </dl>
  ${g?.coverageNote === null || g === null ? '' : `<p class="hint" style="margin:6px 0 0">${esc(g.coverageNote)}</p>`}

  ${g === null ? '' : `${s.sec('Clics desde Google por día')}
  <div class="chart">${lineChartSvg({
    current: g.dailyClicks,
    previous: g.previousDailyClicks,
    first: isoDate(data.period.current.start, false),
    last: isoDate(data.period.current.end, false),
  })}</div>
  <div class="legend"><span><i></i>${esc(data.period.label)}</span><span><i class="prev"></i>${esc(data.period.previousLabel)}</span></div>`}

  ${a === null ? '' : `${s.sec('Sesiones por día')}
  <div class="chart">${lineChartSvg({
    current: a.dailySessions,
    previous: a.previousDailySessions,
    first: isoDate(data.period.current.start, false),
    last: isoDate(data.period.current.end, false),
  })}</div>
  <div class="legend"><span><i></i>${esc(data.period.label)}</span><span><i class="prev"></i>${esc(data.period.previousLabel)}</span></div>`}
</section>`;
}

export function searchSheet(data: AnalyticsReportData, s: Sections): string {
  const g = data.gsc;
  if (g === null) return '';
  const consultas = g.queries.slice(0, 18);
  const paginas = g.pages.slice(0, 12);

  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Búsqueda en Google', data.site.name)}

  ${s.sec('Consultas principales', 'por clics · cambio de posición contra el periodo anterior')}
  ${consultas.length === 0 ? '<p class="empty">Search Console no reporta consultas en el periodo.</p>' : `<table>
    <thead><tr><th>Consulta</th><th class="num">Clics</th><th class="num">Impr.</th><th class="num">CTR</th><th class="num">Posición</th><th class="num">Cambio</th></tr></thead>
    <tbody>${consultas.map((q) => `<tr>
      <td class="cut">${esc(q.key)}</td>
      <td class="num">${int(q.clicks)}</td>
      <td class="num">${int(q.impressions)}</td>
      <td class="num">${pct(q.ctr)}</td>
      <td class="num">${q.position?.toFixed(1) ?? '—'}</td>
      <td class="num ${q.positionGain === null ? '' : q.positionGain > 0 ? 'g' : q.positionGain < 0 ? 'b' : ''}">${q.positionGain === null ? '<span class="hint">nueva</span>' : q.positionGain === 0 ? '·' : `${q.positionGain > 0 ? '▲' : '▼'} ${Math.abs(q.positionGain).toFixed(1)}`}</td>
    </tr>`).join('')}</tbody>
  </table>`}
  <p class="hint" style="margin-top:6px">Google oculta las consultas muy poco frecuentes por privacidad, así que la suma de esta tabla es menor que el total de clics.</p>

  ${s.sec('Páginas que más clics reciben', 'con su estado en la última auditoría')}
  ${paginas.length === 0 ? '<p class="empty">Sin páginas con clics en el periodo.</p>' : `<table>
    <thead><tr><th>Página</th><th class="num">Clics</th><th class="num">Impr.</th><th class="num">CTR</th><th>Estado</th></tr></thead>
    <tbody>${paginas.map((p) => `<tr>
      <td class="path cut">${esc(p.path)}</td>
      <td class="num">${int(p.clicks)}</td>
      <td class="num">${int(p.impressions)}</td>
      <td class="num">${pct(p.clicks !== null && p.impressions ? p.clicks / p.impressions : null)}</td>
      <td>${estado(p)}</td>
    </tr>`).join('')}</tbody>
  </table>`}
</section>`;
}

function shareTable(rows: ShareRow[], titulo: string): string {
  const max = Math.max(0, ...rows.map((r) => r.sessions));
  return `<table class="share">
    <thead><tr><th>${titulo}</th><th class="num">Sesiones</th><th style="width:20%"></th><th class="num">Interacción</th></tr></thead>
    <tbody>${rows.slice(0, 8).map((r) => `<tr>
      <td>${esc(r.key)}</td>
      <td class="num">${int(r.sessions)} <span class="hint">${pct(r.share, 0)}</span></td>
      <td>${barCell(r.sessions, max)}</td>
      <td class="num">${pct(r.engagementRate, 0)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

/** Canales, dispositivos, páginas de entrada y eventos clave. `conMetodo` lo apaga en el integral. */
export function trafficSheet(data: AnalyticsReportData, s: Sections, conMetodo = true): string {
  const a = data.ga;
  if (a === null) return conMetodo ? methodSheet(data, s) : '';
  const entrada = a.landing.filter((l) => l.path !== '(not set)').slice(0, 12);
  const sinOcurrir = a.keyEventsDefined.filter((n) => !a.keyEvents.some((k) => k.name === n));

  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Visitas', data.site.name)}

  <div class="two">
    <div>${s.sec('De dónde llegan')}${shareTable(a.channels, 'Canal')}</div>
    <div>${s.sec('En qué dispositivo')}${shareTable(a.devices, 'Dispositivo')}</div>
  </div>

  ${s.sec('Páginas de entrada', 'cruzadas con la última auditoría')}
  ${entrada.length === 0 ? '<p class="empty">Sin páginas de entrada en el periodo.</p>' : `<table>
    <thead><tr><th>Página</th><th class="num">Sesiones</th><th class="num">Interacción</th><th class="num">Ev. clave</th><th>Estado</th></tr></thead>
    <tbody>${entrada.map((l) => `<tr>
      <td class="path cut">${esc(l.path)}</td>
      <td class="num">${int(l.sessions)}</td>
      <td class="num">${pct(l.engagementRate, 0)}</td>
      <td class="num">${int(l.keyEvents)}</td>
      <td>${estado(l)}</td>
    </tr>`).join('')}</tbody>
  </table>`}

  ${s.sec('Eventos clave', a.keyEventsDefined.length === 0 ? 'ninguno definido en la propiedad' : `${a.keyEventsDefined.length} definidos en la propiedad`)}
  ${a.keyEvents.length === 0
    ? `<p class="empty">${a.keyEventsDefined.length === 0
      ? 'La propiedad no tiene eventos clave. Sin ellos GA4 no puede decir cuántas visitas terminaron en un contacto o una venta: conviene marcar como clave el envío de formularios, los clics a WhatsApp y las llamadas.'
      : 'Ningún evento clave ocurrió en el periodo.'}</p>`
    : `<table>
    <thead><tr><th>Evento</th><th class="num">Veces</th></tr></thead>
    <tbody>${a.keyEvents.slice(0, 10).map((k) => `<tr><td class="path">${esc(k.name)}</td><td class="num">${int(k.count)}</td></tr>`).join('')}</tbody>
  </table>`}
  ${sinOcurrir.length > 0 ? `<p class="hint" style="margin:8px 0 0">Definidos pero sin ocurrencias en el periodo:</p><div class="chips">${sinOcurrir.map((n) => `<span>${esc(n)}</span>`).join('')}</div>` : ''}

  ${conMetodo ? methodBlock(data, s) : ''}
</section>`;
}

function methodBlock(data: AnalyticsReportData, s: Sections): string {
  return `${s.sec('Fuentes y método')}
  <p class="method">
    Datos de ${data.gsc !== null ? 'Google Search Console' : ''}${data.gsc !== null && data.ga !== null ? ' y ' : ''}${data.ga !== null ? 'Google Analytics 4' : ''},
    consultados por API el ${longDate(data.generatedAt)}. El periodo es ${esc(data.period.label)} y se compara contra ${esc(data.period.previousLabel)}.
    Search Console cuenta las búsquedas en Google; GA4 cuenta todas las visitas que cargaron su etiqueta,
    vengan de donde vengan. Por eso los clics y las sesiones no coinciden, y no deben coincidir.
  </p>
  <p class="method">
    La posición media pondera cada día por sus impresiones. La interacción es la proporción de sesiones
    que duraron más de 10 segundos, vieron dos páginas o completaron un evento clave. El estado de cada página
    viene de la auditoría diaria de este sistema.
  </p>`;
}

function methodSheet(data: AnalyticsReportData, s: Sections): string {
  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Método', data.site.name)}
  ${methodBlock(data, s)}
</section>`;
}

export async function renderAnalyticsHtml(data: AnalyticsReportData): Promise<string> {
  const s = new Sections();
  const fuentes = [data.gsc !== null ? 'Search Console' : null, data.ga !== null ? 'GA4' : null].filter(Boolean).join(' · ');
  const body = [
    coverSheet({
      consultant: data.consultant,
      kind: 'Informe de búsqueda y tráfico',
      site: data.site,
      facts: [
        ['Periodo', data.period.label],
        ['Fuentes', fuentes],
        ['Emitido', longDate(data.generatedAt)],
        ['Folio', data.folio],
      ],
    }),
    summarySheet(data, s),
    searchSheet(data, s),
    trafficSheet(data, s),
  ].filter((x) => x !== '').join('\n\n');
  return documentHtml(`${data.site.name} — Búsqueda y tráfico`, ANALYTICS_CSS, body);
}
