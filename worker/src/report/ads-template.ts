/**
 * Plantillas de los informes de Google Ads: ads-cliente.pdf y ads-admin.pdf.
 *
 * Mismo membrete que los demás. Las cifras salen del modelo con reglas; el
 * texto de Claude, cuando lo hay, va debajo de la tabla que interpreta. Sin él
 * el informe sale completo: la conclusión la escribe adsVerdict y las acciones
 * son las alertas.
 */

import {
  type AdsReportData, type AdsKpis, type AdsShareLine, type AdsBlockId, type AdsAlert,
  adsLabel, adsVerdict,
} from './ads-model.js';
import type { ReportText } from '../ai/ads-writer.js';
import { brandHeader, coverSheet, documentHtml, Sections } from './brand.js';
import { int, compact, pct, money, ms, isoDate, esc, longDate } from './format.js';
import { lineChartSvg, barCell } from './svg.js';
import { ANALYTICS_CSS, delta, kpi } from './analytics-template.js';

export type AdsAudienceKind = 'cliente' | 'admin';

export interface AdsTextInput {
  content: ReportText;
  model: string;
}

const ADS_CSS = `
${ANALYTICS_CSS}
.ai { font-size:9.5pt; line-height:1.5; margin:8px 0 0; }
.ai + .ai { margin-top:6px; }
.kpis.k3 { grid-template-columns:repeat(3,1fr); }
.qs { font-family:"Roboto Mono",monospace; font-size:8.5pt; }
.qs.b { font-weight:600; }
.mini td, .mini th { font-size:8.5pt; }
.half td.num { white-space:nowrap; }
.hours { display:grid; grid-template-columns:repeat(12,1fr); gap:2px; margin-top:4px; }
.hours div { text-align:center; font-family:"Roboto Mono",monospace; font-size:6.5pt; color:var(--muted); }
.hours i { display:block; height:26px; background:var(--hair); position:relative; margin-bottom:2px; }
.hours i b { position:absolute; left:0; right:0; bottom:0; background:var(--accent); }
`;

/** Párrafos del texto de Claude, escapados: llega como texto plano. */
function prosa(texto: string | undefined): string {
  if (texto === undefined || texto.trim() === '') return '';
  return texto.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '').map((p) => `<p class="ai">${esc(p)}</p>`).join('');
}

function bloque(text: AdsTextInput | null, id: AdsBlockId): string {
  return prosa(text?.content.bloques.find((b) => b.id === id)?.texto);
}

const fmtCuenta = (id: string): string => (/^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

function kpiGrid(d: AdsReportData, $: (v: number | null) => string, conRoas: boolean): string {
  const t = d.totals;
  const p = d.previousTotals;
  return `<dl class="kpis">
    ${kpi('Inversión', $(t.cost), delta(t.cost, p?.cost ?? null, { neutral: true }))}
    ${kpi('Conversiones', int(t.conversions), delta(t.conversions, p?.conversions ?? null))}
    ${kpi('Costo por conversión', $(t.cpa), delta(t.cpa, p?.cpa ?? null, { lowerIsBetter: true }))}
    ${conRoas && t.roas !== null ? kpi('Retorno (ROAS)', `${t.roas.toFixed(2)}×`, delta(t.roas, p?.roas ?? null)) : kpi('Tasa de conversión', pct(t.convRate), delta(t.convRate, p?.convRate ?? null))}
    ${kpi('Clics', int(t.clicks), delta(t.clicks, p?.clicks ?? null))}
    ${kpi('Impresiones', compact(t.impressions), delta(t.impressions, p?.impressions ?? null))}
    ${kpi('CTR', pct(t.ctr, 2), delta(t.ctr, p?.ctr ?? null))}
    ${kpi('Costo por clic', $(t.cpc), delta(t.cpc, p?.cpc ?? null, { lowerIsBetter: true }))}
  </dl>`;
}

function weekGrid(d: AdsReportData, $: (v: number | null) => string): string {
  const w = d.week;
  return `<dl class="kpis k3">
    <div class="src">Últimos 7 días (${esc(isoDate(w.range.start, false))} – ${esc(isoDate(w.range.end))}) contra los 7 previos</div>
    ${kpi('Inversión', $(w.current.cost), delta(w.current.cost, w.previous.cost, { neutral: true }))}
    ${kpi('Conversiones', int(w.current.conversions), delta(w.current.conversions, w.previous.conversions))}
    ${kpi('Costo por conversión', $(w.current.cpa), delta(w.current.cpa, w.previous.cpa, { lowerIsBetter: true }))}
  </dl>`;
}

function costChart(d: AdsReportData): string {
  return `<div class="chart">${lineChartSvg({
    current: d.dailyCost,
    previous: d.previousDailyCost,
    first: isoDate(d.period.current.start, false),
    last: isoDate(d.period.current.end, false),
    tick: (v) => compact(v),
  })}</div>
  <div class="legend"><span><i></i>${esc(d.period.label)}</span><span><i class="prev"></i>${esc(d.period.previousLabel)}</span></div>`;
}

/**
 * Reparto de la inversión. `half` es para las tablas a media hoja: sin barra
 * ni columna de conversiones, que a dos columnas no caben.
 */
function shareTable(rows: AdsShareLine[], titulo: string, $: (v: number | null) => string, limit = 8, half = false): string {
  if (rows.length === 0) return '<p class="empty">Sin datos en el periodo.</p>';
  if (half) {
    return `<table class="share mini half">
    <thead><tr><th>${titulo}</th><th class="num">Inversión</th><th class="num">Costo/conv.</th></tr></thead>
    <tbody>${rows.slice(0, limit).map((r) => `<tr>
      <td>${esc(r.key)}</td>
      <td class="num">${$(r.cost)} <span class="hint">${pct(r.costShare, 0)}</span></td>
      <td class="num">${$(r.cpa)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
  }
  const max = Math.max(0, ...rows.map((r) => r.cost));
  return `<table class="share mini">
    <thead><tr><th>${titulo}</th><th class="num">Inversión</th><th style="width:18%"></th><th class="num">Conv.</th><th class="num">Costo/conv.</th></tr></thead>
    <tbody>${rows.slice(0, limit).map((r) => `<tr>
      <td>${esc(r.key)}</td>
      <td class="num">${$(r.cost)} <span class="hint">${pct(r.costShare, 0)}</span></td>
      <td>${barCell(r.cost, max)}</td>
      <td class="num">${int(r.conversions)}</td>
      <td class="num">${$(r.cpa)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function campaignTable(d: AdsReportData, $: (v: number | null) => string, admin: boolean): string {
  if (d.campaigns.length === 0) return '<p class="empty">Sin campañas con actividad en el periodo.</p>';
  return `<table class="mini">
    <thead><tr><th>Campaña</th><th class="num">Inversión</th><th class="num">Conv.</th><th class="num">Costo/conv.</th>${admin
      ? '<th class="num">Ppto./día</th><th class="num">Uso</th><th class="num">Cuota impr.</th><th class="num">Perd. ppto.</th><th class="num">Perd. rank</th>'
      : '<th class="num">Cambio conv.</th>'}</tr></thead>
    <tbody>${d.campaigns.map((c) => `<tr>
      <td>${esc(c.name)}<br><span class="hint">${esc(adsLabel(c.channel))}${admin ? ` · ${esc(adsLabel(c.bidding))}` : ''}${c.status === 'ENABLED' ? '' : ` · ${esc(adsLabel(c.status))}`}</span></td>
      <td class="num">${$(c.cost)}</td>
      <td class="num">${int(c.conversions)}</td>
      <td class="num">${$(c.cpa)}</td>
      ${admin ? `<td class="num">${$(c.dailyBudget)}</td>
      <td class="num ${c.budgetUse !== null && c.budgetUse >= 0.95 ? 'w' : ''}">${pct(c.budgetUse, 0)}</td>
      <td class="num">${pct(c.impressionShare, 0)}</td>
      <td class="num ${c.budgetLostShare !== null && c.budgetLostShare >= 0.1 ? 'w' : ''}">${pct(c.budgetLostShare, 0)}</td>
      <td class="num ${c.rankLostShare !== null && c.rankLostShare >= 0.3 ? 'w' : ''}">${pct(c.rankLostShare, 0)}</td>`
      : `<td class="num">${delta(c.conversions, c.previous?.conversions ?? null)}</td>`}
    </tr>`).join('')}</tbody>
  </table>`;
}

function conversionTable(d: AdsReportData, $: (v: number | null) => string): string {
  if (d.conversionActions.length === 0) return '';
  // Las acciones vienen por campaña; aquí se suman por nombre.
  const porNombre = new Map<string, { name: string; category: string; primary: boolean | null; conversions: number; all: number; value: number }>();
  for (const a of d.conversionActions) {
    const x = porNombre.get(a.name) ?? { name: a.name, category: a.category, primary: a.primary, conversions: 0, all: 0, value: 0 };
    x.conversions += a.conversions;
    x.all += a.allConversions;
    x.value += a.conversionsValue;
    porNombre.set(a.name, x);
  }
  const filas = [...porNombre.values()].sort((a, b) => b.all - a.all);
  return `<table class="mini">
    <thead><tr><th>Acción de conversión</th><th class="num">Conversiones</th><th class="num">Todas</th><th class="num">Valor</th></tr></thead>
    <tbody>${filas.map((a) => `<tr>
      <td>${esc(a.name)} <span class="hint">${esc(adsLabel(a.category))}${a.primary === false ? ' · no cuenta en «Conversiones»' : ''}</span></td>
      <td class="num">${int(a.conversions)}</td>
      <td class="num">${int(a.all)}</td>
      <td class="num">${a.value > 0 ? $(a.value) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function alertList(alerts: AdsAlert[], limite = 8): string {
  if (alerts.length === 0) return '<p class="empty">Ninguna alerta con las reglas de este informe.</p>';
  return `<ol class="prio">${alerts.slice(0, limite).map((a) => `<li>
    <div><b>${esc(a.title)}</b><p>${esc(a.detail)}</p></div>
    <span class="impact ${a.severity === 'critical' ? 'b' : 'w'}">${esc(a.impact)}</span>
  </li>`).join('')}</ol>`;
}

function actionList(text: AdsTextInput | null, alerts: AdsAlert[]): string {
  const acciones = text?.content.acciones ?? [];
  if (acciones.length === 0) return alertList(alerts);
  const orden = { alta: 0, media: 1, baja: 2 } as const;
  return `<ol class="prio">${[...acciones].sort((a, b) => orden[a.prioridad] - orden[b.prioridad]).map((a) => `<li>
    <div><b>${esc(a.titulo)}</b><p>${esc(a.detalle)}</p></div>
    <span class="impact ${a.prioridad === 'alta' ? 'b' : a.prioridad === 'media' ? 'w' : ''}">${a.prioridad}</span>
  </li>`).join('')}</ol>`;
}

function conclusion(d: AdsReportData, text: AdsTextInput | null): string {
  const c = text?.content.conclusion.trim();
  return c === undefined || c === '' ? `<p class="verdict">${adsVerdict(d)}</p>` : `<p class="verdict">${esc(c)}</p>`;
}

function metodo(d: AdsReportData, text: AdsTextInput | null, s: Sections): string {
  return `${s.sec('Fuentes y método')}
  <p class="method">
    Datos de la API de Google Ads de la cuenta ${esc(fmtCuenta(d.customerId))}, sincronizados el ${longDate(d.generatedAt)}.
    El periodo es ${esc(d.period.label)} y se compara contra ${esc(d.period.previousLabel)}; la semana, los últimos siete días
    con datos contra los siete previos. Los importes están en ${esc(d.currency)}. Google Ads atribuye cada conversión al día del
    clic, así que los últimos días todavía pueden subir.
  </p>
  <p class="method">
    Las cifras, las tablas y las alertas se calculan directamente de los datos.
    ${text === null
      ? 'Este informe no incluye texto de interpretación: la conclusión y las acciones salen de las mismas reglas que las alertas.'
      : `Los párrafos de interpretación y las acciones los redactó Claude (${esc(text.model)}) a partir de esos mismos datos; conviene leerlos junto a las tablas.`}
    El estado de cada página de destino viene de la auditoría diaria de este sistema.
  </p>`;
}

// ── Informe para el cliente ─────────────────────────────────────────────────

function clienteHtml(d: AdsReportData, text: AdsTextInput | null): string[] {
  const s = new Sections();
  const $ = (v: number | null): string => money(v, d.currency);
  const H = (t: string): string => brandHeader(d.consultant, t, d.site.name);
  return [
    `<section class="sheet">
  ${H('Google Ads')}
  ${s.sec('Conclusión')}
  ${conclusion(d, text)}
  ${s.sec('Resultados', `${esc(d.period.label)} contra ${esc(d.period.previousLabel)}`)}
  ${kpiGrid(d, $, true)}
  ${bloque(text, 'resumen')}
  ${s.sec('Inversión por día')}
  ${costChart(d)}
  ${bloque(text, 'tendencia')}
</section>`,
    `<section class="sheet">
  ${H('Dónde está su inversión')}
  ${s.sec('Por campaña')}
  ${campaignTable(d, $, false)}
  ${bloque(text, 'eficiencia')}
  ${d.conversionActions.length === 0 ? '' : `${s.sec('Qué cuenta como resultado')}
  ${conversionTable(d, $)}
  ${bloque(text, 'conversiones')}`}
  <div class="two">
    <div>${s.sec('Por dispositivo')}${shareTable(d.devices, 'Dispositivo', $, 4, true)}</div>
    <div>${s.sec('Por región')}${shareTable(d.geo, 'Región', $, 6, true)}</div>
  </div>
  ${bloque(text, 'dispositivo')}
  ${bloque(text, 'geografia')}
</section>`,
    `<section class="sheet">
  ${H('Recomendaciones')}
  ${s.sec('Qué recomendamos', text === null ? 'según las alertas de este periodo' : '')}
  ${actionList(text, d.alerts)}
  ${bloque(text, 'landing')}
  ${metodo(d, text, s)}
</section>`,
  ];
}

// ── Informe para el administrador ───────────────────────────────────────────

function keywordTable(d: AdsReportData, $: (v: number | null) => string): string {
  if (d.keywords.length === 0) return '<p class="empty">Sin keywords con actividad en el periodo.</p>';
  const comp = (v: string | null): string => (v === null ? '—' : v === 'BELOW_AVERAGE' ? '<span class="b">▼</span>' : v === 'ABOVE_AVERAGE' ? '<span class="g">▲</span>' : '·');
  return `<table class="mini">
    <thead><tr><th>Keyword</th><th class="num">QS</th><th class="num" title="Relevancia, página, CTR esperado">Rel · Pág · CTR</th><th class="num">Clics</th><th class="num">CPC</th><th class="num">Inversión</th><th class="num">Conv.</th><th class="num">Costo/conv.</th></tr></thead>
    <tbody>${d.keywords.slice(0, 22).map((k) => `<tr>
      <td>${esc(k.text)} <span class="hint">${esc(adsLabel(k.matchType))}</span></td>
      <td class="num qs ${k.qualityScore !== null && k.qualityScore <= 3 ? 'b' : ''}">${k.qualityScore ?? '—'}</td>
      <td class="num">${comp(k.adRelevance)} ${comp(k.landingPage)} ${comp(k.expectedCtr)}</td>
      <td class="num">${int(k.clicks)}</td>
      <td class="num">${$(k.cpc)}</td>
      <td class="num">${$(k.cost)}</td>
      <td class="num ${k.conversions === 0 && k.cost > 0 ? 'b' : ''}">${int(k.conversions)}</td>
      <td class="num">${$(k.cpa)}</td>
    </tr>`).join('')}</tbody>
  </table>
  <p class="hint" style="margin-top:4px">▲ superior al promedio · ▼ inferior al promedio · · promedio. Las de más inversión; ${int(d.keywords.length)} en total con actividad.</p>`;
}

function termTable(d: AdsReportData, $: (v: number | null) => string): string {
  if (d.searchTerms.length === 0) return '<p class="empty">Sin términos de búsqueda en el periodo.</p>';
  const estado = (s: string): string => (s === 'ADDED' ? '<span class="tag tag-g">keyword</span>' : s === 'EXCLUDED' ? '<span class="tag tag-w">negativa</span>' : '');
  return `<table class="mini">
    <thead><tr><th>Término</th><th>Concord.</th><th class="num">Clics</th><th class="num">Inversión</th><th class="num">Conv.</th><th></th></tr></thead>
    <tbody>${d.searchTerms.slice(0, 16).map((t) => `<tr>
      <td>${esc(t.term)}</td>
      <td class="hint">${esc(adsLabel(t.matchType))}</td>
      <td class="num">${int(t.clicks)}</td>
      <td class="num">${$(t.cost)}</td>
      <td class="num ${t.conversions === 0 && t.cost > 0 ? 'b' : ''}">${int(t.conversions)}</td>
      <td>${estado(t.status)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function adTable(d: AdsReportData, $: (v: number | null) => string): string {
  if (d.ads.length === 0) return '<p class="empty">La cuenta no tiene anuncios activos.</p>';
  const tagAprob = (a: string): string => (a === 'DISAPPROVED' ? 'tag-b' : a === 'APPROVED' ? 'tag-g' : 'tag-w');
  return `<table class="mini">
    <thead><tr><th>Anuncio</th><th>Fuerza</th><th>Estado</th><th class="num">Inversión</th><th class="num">Conv.</th></tr></thead>
    <tbody>${d.ads.slice(0, 10).map((a) => `<tr>
      <td>${esc(a.headlines.slice(0, 3).join(' / ') || adsLabel(a.type))}<br><span class="hint">${esc(a.adGroup)}</span></td>
      <td class="${a.strength === 'POOR' ? 'b' : ''}">${esc(adsLabel(a.strength))}</td>
      <td><span class="tag ${tagAprob(a.approval)}">${esc(adsLabel(a.approval))}</span></td>
      <td class="num">${$(a.cost)}</td>
      <td class="num">${int(a.conversions)}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

function landingTable(d: AdsReportData, $: (v: number | null) => string): string {
  if (d.landing.length === 0) return '<p class="empty">Sin páginas de destino con inversión en el periodo.</p>';
  return `<table class="mini">
    <thead><tr><th>Página</th><th class="num">Inversión</th><th class="num">Conv.</th><th class="num">Tasa conv.</th><th>Auditoría</th></tr></thead>
    <tbody>${d.landing.slice(0, 10).map((l) => {
      const caida = l.health !== null && (!l.health.ok || (l.health.httpStatus !== null && l.health.httpStatus >= 400));
      const lenta = !caida && l.health?.loadMs !== null && l.health?.loadMs !== undefined && l.health.loadMs > 4000;
      return `<tr>
      <td class="path cut">${esc(l.path)}${l.url.startsWith('http://') ? ' <span class="tag tag-w">http</span>' : ''}</td>
      <td class="num">${$(l.cost)}</td>
      <td class="num ${l.conversions === 0 && l.cost > 0 ? 'b' : ''}">${int(l.conversions)}</td>
      <td class="num">${pct(l.convRate)}</td>
      <td>${l.health === null ? '<span class="hint">no auditada</span>' : caida ? `<span class="tag tag-b">${l.health.httpStatus ?? 'error'}</span>` : lenta ? `<span class="tag tag-w">${ms(l.health.loadMs)}</span>` : `<span class="g">${l.health.httpStatus ?? 'ok'}</span> <span class="hint">${ms(l.health.loadMs)}</span>`}</td>
    </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function hoursStrip(d: AdsReportData): string {
  const porHora = new Map(d.schedule.byHour.map((h) => [Number(h.key), h]));
  const max = Math.max(0, ...d.schedule.byHour.map((h) => h.cost));
  if (max === 0) return '';
  return `<div class="hours">${Array.from({ length: 24 }, (_, h) => {
    const x = porHora.get(h);
    const alto = x === undefined ? 0 : Math.round((x.cost / max) * 100);
    return `<div><i><b style="height:${alto}%"></b></i>${h}</div>`;
  }).join('')}</div><p class="hint" style="margin-top:2px">Inversión por hora del día.</p>`;
}

function pmaxBlock(d: AdsReportData, $: (v: number | null) => string, s: Sections, text: AdsTextInput | null): string {
  if (d.assetGroups.length === 0) return '';
  return `${s.sec('Performance Max')}
  <table class="mini">
    <thead><tr><th>Asset group</th><th>Fuerza</th><th class="num">Inversión</th><th class="num">Conv.</th><th class="num">Assets no elegibles</th></tr></thead>
    <tbody>${d.assetGroups.map((g) => {
      const malos = g.assets.filter((a) => a.status === 'NOT_ELIGIBLE').length;
      return `<tr><td>${esc(g.name)}</td><td>${esc(adsLabel(g.strength))}</td><td class="num">${$(g.cost)}</td><td class="num">${int(g.conversions)}</td><td class="num ${malos > 0 ? 'b' : ''}">${malos} de ${g.assets.length}</td></tr>`;
    }).join('')}</tbody>
  </table>
  ${d.pmaxTerms.length === 0 ? '' : `<p class="hint" style="margin:6px 0 2px">Categorías de búsqueda con más conversiones:</p><div class="chips">${[...d.pmaxTerms].sort((a, b) => b.conversions - a.conversions).slice(0, 12).map((t) => `<span>${esc(t.category)} · ${int(t.conversions)}</span>`).join('')}</div>`}
  ${bloque(text, 'pmax')}`;
}

function adminHtml(d: AdsReportData, text: AdsTextInput | null): string[] {
  const s = new Sections();
  const $ = (v: number | null): string => money(v, d.currency);
  const H = (t: string): string => brandHeader(d.consultant, t, d.site.name);
  return [
    `<section class="sheet">
  ${H('Google Ads · Administración')}
  ${s.sec('Conclusión')}
  ${conclusion(d, text)}
  ${s.sec('Indicadores', `${esc(d.period.label)} contra ${esc(d.period.previousLabel)}`)}
  ${kpiGrid(d, $, d.totals.roas !== null)}
  <div style="margin-top:10px">${weekGrid(d, $)}</div>
  ${bloque(text, 'tendencia')}
  ${s.sec('Atender primero', `${d.alerts.filter((a) => a.severity === 'critical').length} críticas · ${d.alerts.filter((a) => a.severity === 'warning').length} avisos`)}
  ${alertList(d.alerts, 7)}
</section>`,
    `<section class="sheet">
  ${H('Campañas y presupuesto')}
  ${s.sec('Inversión por día')}
  ${costChart(d)}
  ${s.sec('Campañas')}
  ${campaignTable(d, $, true)}
  ${bloque(text, 'eficiencia')}
  ${bloque(text, 'cobertura')}
  ${bloque(text, 'presupuesto')}
  ${bloque(text, 'puja')}
  ${d.conversionActions.length === 0 ? '' : `${s.sec('Acciones de conversión')}${conversionTable(d, $)}${bloque(text, 'conversiones')}`}
</section>`,
    `<section class="sheet">
  ${H('Keywords y búsquedas')}
  ${s.sec('Keywords', 'con Quality Score y sus tres componentes')}
  ${keywordTable(d, $)}
  ${bloque(text, 'keywords')}
  ${s.sec('Términos de búsqueda', 'lo que la gente escribió')}
  ${termTable(d, $)}
  ${bloque(text, 'terminos')}
</section>`,
    `<section class="sheet">
  ${H('Anuncios y páginas de destino')}
  ${s.sec('Anuncios')}
  ${adTable(d, $)}
  ${bloque(text, 'anuncios')}
  ${s.sec('Páginas de destino', 'cruzadas con la última auditoría')}
  ${landingTable(d, $)}
  ${bloque(text, 'landing')}
  ${pmaxBlock(d, $, s, text)}
</section>`,
    `<section class="sheet">
  ${H('Segmentación')}
  <div class="two">
    <div>${s.sec('Dispositivo')}${shareTable(d.devices, 'Dispositivo', $, 4, true)}</div>
    <div>${s.sec('Región')}${shareTable(d.geo, 'Región', $, 8, true)}</div>
  </div>
  ${bloque(text, 'dispositivo')}
  ${bloque(text, 'geografia')}
  ${d.schedule.byDay.length === 0 ? '' : `${s.sec('Día y hora')}
  <div class="two"><div>${shareTable(d.schedule.byDay, 'Día', $, 7, true)}</div><div>${hoursStrip(d)}</div></div>
  ${bloque(text, 'horario')}`}
  ${d.age.length === 0 && d.gender.length === 0 ? '' : `${s.sec('Edad y género')}
  <div class="two"><div>${shareTable(d.age, 'Edad', $, 7, true)}</div><div>${shareTable(d.gender, 'Género', $, 3, true)}</div></div>
  ${bloque(text, 'demografia')}`}
  ${d.audiences.length === 0 ? '' : `${s.sec('Audiencias')}
  <table class="mini"><thead><tr><th>Audiencia</th><th>Nivel</th><th class="num">Inversión</th><th class="num">Conv.</th><th class="num">Costo/conv.</th></tr></thead>
  <tbody>${d.audiences.slice(0, 8).map((a) => `<tr><td>${esc(a.name)}</td><td class="hint">${a.level === 'campaign' ? 'campaña' : 'grupo'}</td><td class="num">${$(a.cost)}</td><td class="num">${int(a.conversions)}</td><td class="num">${$(a.cpa)}</td></tr>`).join('')}</tbody></table>
  ${bloque(text, 'audiencias')}`}
</section>`,
    `<section class="sheet">
  ${H('Acciones')}
  ${s.sec('Qué hacer', text === null ? 'según las alertas' : 'ordenadas por impacto')}
  ${actionList(text, d.alerts)}
  ${bloque(text, 'salud')}
  ${metodo(d, text, s)}
</section>`,
  ];
}

export function adsFooterText(d: AdsReportData, audience: AdsAudienceKind): string {
  return `${d.site.name} · Google Ads${audience === 'admin' ? ' · Administración' : ''} · ${d.period.label}`;
}

export async function renderAdsHtml(d: AdsReportData, audience: AdsAudienceKind, text: AdsTextInput | null): Promise<string> {
  const cover = coverSheet({
    consultant: d.consultant,
    kind: audience === 'cliente' ? 'Informe de Google Ads' : 'Informe de Google Ads · Administración',
    site: d.site,
    facts: [
      ['Periodo', d.period.label],
      ['Cuenta', fmtCuenta(d.customerId)],
      ['Emitido', longDate(d.generatedAt)],
      ['Folio', d.folio],
    ],
  });
  const hojas = audience === 'cliente' ? clienteHtml(d, text) : adminHtml(d, text);
  return documentHtml(`${d.site.name} — Google Ads`, ADS_CSS, [cover, ...hojas].join('\n\n'));
}
