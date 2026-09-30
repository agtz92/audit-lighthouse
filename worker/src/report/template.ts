/**
 * Plantilla del informe. Devuelve el HTML que Chromium imprime.
 *
 * El diseño viene de la propuesta aprobada: portada con los datos del consultor
 * y el sitio, y cuatro hojas de contenido. Cada documento cubre UNA estrategia,
 * escritorio o móvil, por eso no hay columnas comparativas entre ambas.
 *
 * Los saltos de página son explícitos (`page-break-after`) en lugar de dejar que
 * Chromium decida: un informe donde una tabla se parte a la mitad entre dos
 * hojas se ve descuidado, y aquí sabemos exactamente dónde debe cortar.
 */

import { fontFaceCss } from './fonts.js';
import { verdict } from './build.js';
import {
  type ReportData, type Rating, THRESHOLDS, LIMITS, rate, rateScore, RATING_LABEL,
} from './model.js';
import { ms, bytes, cls, num, longDate, time, esc } from './format.js';

import type { LighthouseStrategy } from '../audit/lighthouse.js';

/** Tipado por estrategia y no como Record<string,…>: así el índice no es opcional. */
const ESTRATEGIA: Record<LighthouseStrategy, string> = { desktop: 'Escritorio', mobile: 'Móvil' };

/** Recorta la descripción de un hallazgo para que su bloque no crezca de más. */
function corto(text: string, max = LIMITS.findingDescriptionChars): string {
  if (text.length <= max) return text;
  const corte = text.lastIndexOf(' ', max);
  return `${text.slice(0, corte > 40 ? corte : max).replace(/[.,;:]$/, '')}…`;
}

function tag(rating: Rating): string {
  if (rating === 'none') return '';
  const clase = rating === 'good' ? 'tag-g' : rating === 'warning' ? 'tag-w' : 'tag-b';
  return `<span class="tag ${clase}">${RATING_LABEL[rating]}</span>`;
}

function colorClass(rating: Rating): string {
  return rating === 'good' ? 'g' : rating === 'warning' ? 'w' : rating === 'bad' ? 'b' : '';
}

function scoreRow(label: string, value: number | null): string {
  const r = rateScore(value);
  const ancho = value ?? 0;
  const barra = r === 'good' ? 'bg-g' : r === 'warning' ? 'bg-w' : 'bg-b';
  return `<div class="srow">
    <span class="lbl">${label}</span>
    <span class="val ${colorClass(r)}">${num(value)}</span>
    <span class="bar2"><i class="${barra}" style="width:${ancho}%"></i></span>
  </div>`;
}

function vital(label: string, valor: string, rating: Rating, umbral: string): string {
  return `<div>
    <dt>${label}</dt>
    <dd class="${colorClass(rating)}">${valor}</dd>
    <div class="u">${tag(rating)} umbral ${umbral}</div>
  </div>`;
}

function metricRow(label: string, hint: string, valor: string, umbral: string, rating: Rating): string {
  return `<tr>
    <td>${label}<br><span class="hint">${hint}</span></td>
    <td class="num ${colorClass(rating)}">${valor}</td>
    <td class="num">${umbral}</td>
    <td>${tag(rating)}</td>
  </tr>`;
}

function header(data: ReportData, titulo: string, hoja: number): string {
  return `<header class="brand">
    <div class="who">
      <strong>${esc(data.consultant.name)}</strong>
      <span>${esc(data.consultant.role)}</span>
    </div>
    <div class="doc">
      <b>${titulo}</b>
      <span>${esc(data.site.name)} · hoja ${hoja}</span>
    </div>
  </header>`;
}

/**
 * El pie de página ya NO lo pone la plantilla: lo dibuja Chromium en el margen,
 * con la numeración real. Un "Hoja 2 de 5" escrito a mano miente en cuanto el
 * contenido ocupa una hoja más, y el informe debe poder crecer según lo que
 * encuentre en cada sitio.
 */
export function footerLeftText(data: ReportData): string {
  return `${data.site.name} · ${ESTRATEGIA[data.strategy]} · ${longDate(data.runAt)}`;
}

export async function renderReportHtml(data: ReportData): Promise<string> {
  const fuentes = await fontFaceCss();

  const m = data.metrics;
  const rLcp = rate(m.lcpMs, THRESHOLDS.lcpMs);
  const rCls = rate(m.clsValue, THRESHOLDS.clsValue);
  const rTbt = rate(m.tbtMs, THRESHOLDS.tbtMs);

  const maxAhorro = data.opportunities[0]?.savingsMs ?? 1;

  const a11yTodos = data.findings.filter((f) => f.category === 'accessibility');
  const otrosTodos = data.findings.filter((f) => f.category !== 'accessibility');
  const a11y = a11yTodos.slice(0, LIMITS.accessibilityFindings);
  const otros = otrosTodos.slice(0, LIMITS.otherFindings);
  const paginas = data.pages.slice(0, LIMITS.pageRows);
  const paginasOcultas = data.pages.length - paginas.length;

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${esc(data.site.name)} — Auditoría ${ESTRATEGIA[data.strategy]}</title>
<style>
${fuentes}

@page { size: A4; margin: 0; }

:root {
  --ink:#141b26; --muted:#656f7d; --faint:#98a1ad;
  --rule:#dde2e8; --hair:#ebeef2; --accent:#16355e;
  --paper:#ffffff; --wash:#f4f6f9;
  --good:#0c7a3e; --warn:#a8700a; --bad:#b8332f;
  --good-bg:#e8f4ed; --warn-bg:#fdf3e0; --bad-bg:#fbeceb;
  --desktop:#2a78d6; --mobile:#eb6834;
}
* { box-sizing:border-box; }
body {
  margin:0; background:var(--paper); color:var(--ink);
  font-family:"Source Sans 3",sans-serif; font-size:10.5pt; line-height:1.5;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.sheet {
  /* 285mm = A4 menos los 12mm de margen inferior donde Chromium dibuja el pie. */
  width:210mm; min-height:283mm; padding:16mm 15mm 8mm;
  display:flex; flex-direction:column; page-break-after:always;
}
.sheet:last-child { page-break-after:auto; }

/* Portada ------------------------------------------------------------------ */
.cover { justify-content:space-between; }
.cover .name { font-family:Archivo,sans-serif; font-weight:700; font-size:19pt; letter-spacing:-.025em; line-height:1.1; margin:0; }
.cover .role { font-size:10.5pt; color:var(--muted); margin:6px 0 0; max-width:62ch; }
.cover .cred { font-family:Archivo,sans-serif; font-weight:600; font-size:7.5pt; letter-spacing:.13em; color:var(--faint); margin:8px 0 0; }
.cover .bar { height:3px; background:var(--accent); width:62px; margin:18px 0 0; }
.cover .kind { font-family:Archivo,sans-serif; font-weight:600; font-size:8pt; letter-spacing:.22em; text-transform:uppercase; color:var(--accent); margin:0 0 14px; }
.cover .site { font-family:Archivo,sans-serif; font-weight:700; font-size:40pt; line-height:.98; letter-spacing:-.04em; margin:0; }
.cover .url { font-family:"Roboto Mono",monospace; font-size:10pt; color:var(--muted); margin:12px 0 0; }
.cover .bottom { border-top:1px solid var(--rule); padding-top:12px; display:flex; justify-content:space-between; gap:16px; }
.cover .bottom dt { font-family:Archivo,sans-serif; font-weight:600; font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:var(--faint); }
.cover .bottom dd { margin:3px 0 0; font-family:"Roboto Mono",monospace; font-size:9.5pt; color:var(--ink); }

/* Encabezado interior ------------------------------------------------------- */
.brand { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; padding-bottom:9px; border-bottom:2px solid var(--accent); }
.brand .who strong { display:block; font-family:Archivo,sans-serif; font-size:10.5pt; font-weight:600; letter-spacing:-.015em; line-height:1.2; }
.brand .who span { display:block; font-size:8.5pt; color:var(--muted); margin-top:1px; }
.brand .doc { text-align:right; }
.brand .doc b { display:block; font-family:Archivo,sans-serif; font-size:8pt; font-weight:600; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); }
.brand .doc span { display:block; font-family:"Roboto Mono",monospace; font-size:7.5pt; color:var(--muted); margin-top:2px; }

.sec { display:flex; align-items:baseline; gap:8px; margin:18px 0 9px; padding-bottom:4px; border-bottom:1px solid var(--rule); }
.sec .n { font-family:Archivo,sans-serif; font-size:8pt; font-weight:600; color:var(--accent); }
.sec h3 { font-family:Archivo,sans-serif; font-size:8.5pt; font-weight:600; letter-spacing:.08em; text-transform:uppercase; margin:0; }
.sec .note { margin-left:auto; font-size:8pt; color:var(--faint); }

.verdict { font-size:11.5pt; line-height:1.5; margin:0; max-width:64ch; }
.verdict b { font-weight:600; }

.scores { display:grid; grid-template-columns:1fr; gap:0; max-width:78%; }
.scores h4 { font-family:Archivo,sans-serif; font-size:7.5pt; font-weight:600; letter-spacing:.16em; text-transform:uppercase; margin:2px 0 7px; display:flex; align-items:center; gap:6px; color:var(--muted); }
.scores h4 i { width:14px; height:2px; display:inline-block; }
.srow { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:8px; padding:4px 0; }
.srow + .srow { border-top:1px solid var(--hair); }
.srow .lbl { font-size:10pt; }
.srow .val { font-family:"Roboto Mono",monospace; font-size:11pt; font-weight:500; }
.bar2 { grid-column:1/-1; height:3px; background:var(--hair); }
.bar2 i { display:block; height:100%; }
.g{color:var(--good)} .w{color:var(--warn)} .b{color:var(--bad)}
.bg-g{background:var(--good)} .bg-w{background:var(--warn)} .bg-b{background:var(--bad)}

.vitals { display:grid; grid-template-columns:repeat(3,1fr); gap:1px; background:var(--rule); border:1px solid var(--rule); }
.vitals > div { background:var(--paper); padding:8px 10px; }
.vitals dt { font-family:Archivo,sans-serif; font-weight:600; font-size:7pt; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
.vitals dd { margin:2px 0 0; font-family:Archivo,sans-serif; font-size:16pt; font-weight:700; letter-spacing:-.03em; }
.vitals .u { font-size:8pt; color:var(--muted); margin-top:2px; }

.tag { display:inline-block; font-family:Archivo,sans-serif; font-size:6.5pt; font-weight:600; letter-spacing:.1em; text-transform:uppercase; padding:1px 4px; }
.tag-g{background:var(--good-bg); color:var(--good)}
.tag-w{background:var(--warn-bg); color:var(--warn)}
.tag-b{background:var(--bad-bg); color:var(--bad)}

.prio { list-style:none; margin:0; padding:0; counter-reset:p; }
.prio li { display:grid; grid-template-columns:16px 1fr auto; gap:10px; padding:8px 0; align-items:start; }
.prio li + li { border-top:1px solid var(--hair); }
.prio li::before { counter-increment:p; content:counter(p); font-family:Archivo,sans-serif; font-weight:600; font-size:8pt; color:var(--accent); padding-top:2px; }
.prio b { display:block; font-family:Archivo,sans-serif; font-size:10pt; font-weight:600; letter-spacing:-.01em; }
.prio p { margin:2px 0 0; font-size:9pt; color:var(--muted); line-height:1.4; max-width:58ch; }
.prio .impact { font-family:"Roboto Mono",monospace; font-size:8pt; text-align:right; white-space:nowrap; padding-top:2px; }

table { width:100%; border-collapse:collapse; font-size:9.5pt; }
thead th { font-family:Archivo,sans-serif; font-size:7pt; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); text-align:left; padding:0 6px 4px 0; border-bottom:1px solid var(--rule); }
thead th:last-child, tbody td:last-child { padding-left:12px; }
tbody td { padding:5px 6px 5px 0; border-bottom:1px solid var(--hair); vertical-align:baseline; }
tbody tr:last-child td { border-bottom:none; }
.num { text-align:right; font-family:"Roboto Mono",monospace; font-size:9pt; }
.path { font-family:"Roboto Mono",monospace; font-size:8.5pt; }
.hint { font-size:8pt; color:var(--faint); }

.opp { display:flex; flex-direction:column; gap:7px; }
.opp .row { display:grid; grid-template-columns:1fr auto; gap:10px; align-items:baseline; }
.opp .row .t { font-size:10pt; }
.opp .row .m { font-family:"Roboto Mono",monospace; font-size:8.5pt; color:var(--muted); }
.opp .track { grid-column:1/-1; height:4px; background:var(--wash); }
.opp .track i { display:block; height:100%; background:var(--${data.strategy}); }

.find { list-style:none; margin:0; padding:0; }
.find li { padding:9px 0; border-bottom:1px solid var(--hair); }
.find li:last-child { border-bottom:none; }
.find .head { display:flex; gap:8px; align-items:baseline; }
.find b { font-family:Archivo,sans-serif; font-size:9.5pt; font-weight:600; letter-spacing:-.01em; }
.find p { margin:3px 0 0; font-size:9pt; color:var(--muted); line-height:1.45; max-width:62ch; }

.callout { background:var(--wash); border-left:3px solid var(--accent); padding:9px 11px; font-size:9pt; color:var(--muted); line-height:1.45; }
.callout b { color:var(--ink); font-weight:600; }

.empty { font-size:9.5pt; color:var(--muted); font-style:italic; }
</style></head><body>

<!-- ═══════════ PORTADA ═══════════ -->
<section class="sheet cover">
  <div>
    <p class="name">${esc(data.consultant.name)}</p>
    <p class="role">${esc(data.consultant.role)}</p>
    <p class="cred">${esc(data.consultant.credentials)}</p>
    <div class="bar"></div>
  </div>
  <div>
    <p class="kind">Auditoría de rendimiento web · ${ESTRATEGIA[data.strategy]}</p>
    <h1 class="site">${esc(data.site.name)}</h1>
    <p class="url">${esc(data.site.url)}</p>
  </div>
  <dl class="bottom">
    <div><dt>Fecha</dt><dd>${longDate(data.runAt)}</dd></div>
    <div><dt>Hora</dt><dd>${time(data.runAt)} CDMX</dd></div>
    <div><dt>Folio</dt><dd>${data.folio}</dd></div>
    
  </dl>
</section>

<!-- ═══════════ DIAGNÓSTICO ═══════════ -->
<section class="sheet">
  ${header(data, 'Diagnóstico', 2)}

  <div class="sec"><span class="n">1</span><h3>Conclusión</h3></div>
  <p class="verdict">${verdict(data)}</p>

  <div class="sec"><span class="n">2</span><h3>Calificaciones</h3><span class="note">Lighthouse ${data.lighthouseVersion ?? ''} · 0 a 100</span></div>
  <div class="scores"><div>
    <h4><i style="background:var(--${data.strategy})"></i>${ESTRATEGIA[data.strategy]}</h4>
    ${scoreRow('Rendimiento', data.scores.performance)}
    ${scoreRow('Accesibilidad', data.scores.accessibility)}
    ${scoreRow('Buenas prácticas', data.scores.bestPractices)}
    ${scoreRow('SEO', data.scores.seo)}
  </div></div>

  <div class="sec"><span class="n">3</span><h3>Core Web Vitals</h3><span class="note">lo que Google usa para posicionar</span></div>
  <dl class="vitals">
    ${vital('LCP', ms(m.lcpMs), rLcp, ms(THRESHOLDS.lcpMs.good))}
    ${vital('CLS', cls(m.clsValue), rCls, THRESHOLDS.clsValue.good.toFixed(2))}
    ${vital('TBT', ms(m.tbtMs), rTbt, ms(THRESHOLDS.tbtMs.good))}
  </dl>

  <div class="sec"><span class="n">4</span><h3>Atender primero</h3><span class="note">ordenado por impacto medido</span></div>
  ${data.priorities.length === 0
    ? '<p class="empty">No se detectaron acciones pendientes con impacto medible.</p>'
    : `<ol class="prio">${data.priorities.map((p) => `<li>
        <div><b>${esc(p.title)}</b><p>${esc(p.detail)}</p></div>
        <span class="impact ${p.severity === 'critical' ? 'b' : 'w'}">${esc(p.impact)}</span>
      </li>`).join('')}</ol>`}
</section>

<!-- ═══════════ RENDIMIENTO ═══════════ -->
<section class="sheet">
  ${header(data, 'Rendimiento', 3)}

  <div class="sec"><span class="n">5</span><h3>Métricas de carga</h3><span class="note">${ESTRATEGIA[data.strategy].toLowerCase()} contra el umbral recomendado</span></div>
  <table>
    <thead><tr><th style="width:44%">Métrica</th><th class="num">Medido</th><th class="num">Umbral</th><th style="width:18%">Estado</th></tr></thead>
    <tbody>
      ${metricRow('Largest Contentful Paint', 'cuándo aparece el elemento más grande', ms(m.lcpMs), ms(THRESHOLDS.lcpMs.good), rLcp)}
      ${metricRow('Total Blocking Time', 'hilo principal bloqueado', ms(m.tbtMs), ms(THRESHOLDS.tbtMs.good), rTbt)}
      ${metricRow('Cumulative Layout Shift', 'cuánto se mueve el contenido al cargar', cls(m.clsValue), THRESHOLDS.clsValue.good.toFixed(2), rCls)}
      ${metricRow('First Contentful Paint', 'primer contenido visible', ms(m.fcpMs), ms(THRESHOLDS.fcpMs.good), rate(m.fcpMs, THRESHOLDS.fcpMs))}
      ${metricRow('Speed Index', 'qué tan rápido se llena la pantalla', ms(m.speedIndexMs), ms(THRESHOLDS.speedIndexMs.good), rate(m.speedIndexMs, THRESHOLDS.speedIndexMs))}
      ${metricRow('Time to Interactive', 'cuándo responde a un clic', ms(m.ttiMs), ms(THRESHOLDS.ttiMs.good), rate(m.ttiMs, THRESHOLDS.ttiMs))}
    </tbody>
  </table>

  <div class="sec"><span class="n">6</span><h3>Oportunidades</h3><span class="note">ahorro estimado por Lighthouse</span></div>
  ${data.opportunities.length === 0
    ? '<p class="empty">Lighthouse no encontró ahorros significativos que proponer.</p>'
    : `<div class="opp">${data.opportunities.slice(0, LIMITS.opportunities).map((o) => `<div class="row">
        <span class="t">${esc(o.title)}</span>
        <span class="m">${ms(o.savingsMs)}${o.savingsBytes > 0 ? ` · ${bytes(o.savingsBytes)}` : ''}</span>
        ${/* La barra compara entre sí. Con una sola oportunidad siempre mediría
              el 100% de sí misma, o sea nada, y se omite. */ ''}
        ${data.opportunities.length > 1
          ? `<span class="track"><i style="width:${Math.max(3, Math.round((o.savingsMs / maxAhorro) * 100))}%"></i></span>`
          : ''}
      </div>`).join('')}</div>`}

  <div class="sec"><span class="n">7</span><h3>Comparación con la corrida anterior</h3></div>
  <table>
    <thead><tr><th style="width:36%">Métrica</th><th class="num">Anterior</th><th class="num">Hoy</th><th class="num">Cambio</th><th></th></tr></thead>
    <tbody>
      ${data.comparisons.map((c) => `<tr>
        <td>${esc(c.label)}</td>
        <td class="num">${esc(c.previous)}</td>
        <td class="num">${esc(c.current)}</td>
        <td class="num ${c.trend === 'worse' ? 'b' : c.trend === 'better' ? 'g' : ''}">${esc(c.delta)}</td>
        <td class="hint">${esc(c.note)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
</section>

<!-- ═══════════ CALIDAD ═══════════ -->
<section class="sheet">
  ${header(data, 'Calidad', 4)}

  <div class="sec"><span class="n">8</span><h3>Hallazgos de accesibilidad</h3><span class="note">score ${num(data.scores.accessibility)} · ${a11y.length} ${a11y.length === 1 ? 'auditoría' : 'auditorías'} no ${a11y.length === 1 ? 'aprobada' : 'aprobadas'}</span></div>
  ${a11y.length === 0
    ? '<p class="empty">Todas las auditorías automáticas de accesibilidad pasaron.</p>'
    : `<ul class="find">${a11y.map((f) => `<li>
        <div class="head"><span class="tag tag-w">Mejorable</span><b>${esc(f.title)}</b></div>
        <p>${esc(corto(f.description))}</p>
      </li>`).join('')}</ul>${a11yTodos.length > a11y.length
        ? `<p class="hint" style="margin-top:6px">Se listan las ${a11y.length} primeras de ${a11yTodos.length}; el resto está en el reporte completo de Lighthouse.</p>`
        : ''}`}

  <div class="sec"><span class="n">9</span><h3>Buenas prácticas y SEO</h3></div>
  <dl class="vitals">
    <div><dt>Buenas prácticas</dt><dd class="${colorClass(rateScore(data.scores.bestPractices))}">${num(data.scores.bestPractices)}</dd><div class="u">${tag(rateScore(data.scores.bestPractices))}</div></div>
    <div><dt>SEO</dt><dd class="${colorClass(rateScore(data.scores.seo))}">${num(data.scores.seo)}</dd><div class="u">${tag(rateScore(data.scores.seo))}</div></div>
    <div><dt>Accesibilidad</dt><dd class="${colorClass(rateScore(data.scores.accessibility))}">${num(data.scores.accessibility)}</dd><div class="u">${tag(rateScore(data.scores.accessibility))}</div></div>
  </dl>

  ${otros.length > 0 ? `
  <div class="sec"><span class="n">10</span><h3>Otros hallazgos</h3></div>
  <ul class="find">${otros.slice(0, 5).map((f) => `<li>
    <div class="head"><span class="tag tag-w">Mejorable</span><b>${esc(f.title)}</b></div>
    <p>${esc(f.description)}</p>
  </li>`).join('')}</ul>` : ''}

  <div class="callout" style="margin-top:16px">
    <b>Qué significa un 100 aquí.</b> Lighthouse verifica lo que se puede comprobar de forma automática:
    HTTPS, metadatos, errores de consola, enlaces rastreables. Un 100 no sustituye una revisión manual
    de accesibilidad ni una estrategia de contenidos: significa que no hay nada roto en lo medible.
  </div>
</section>

<!-- ═══════════ INFRAESTRUCTURA ═══════════ -->
<section class="sheet">
  ${header(data, 'Infraestructura', 5)}

  <div class="sec"><span class="n">11</span><h3>Disponibilidad por página</h3><span class="note">${data.pagesAudited} de ${data.pagesDiscovered} URLs del sitio</span></div>
  <table>
    <thead><tr><th style="width:30%">Ruta</th><th class="num">HTTP</th><th class="num">TTFB</th><th class="num">Carga</th><th class="num">Peso</th><th class="num">Solicitudes</th></tr></thead>
    <tbody>
      ${paginas.map((p) => `<tr>
        <td class="path">${esc(p.path)}${p.isHome ? ' <span class="tag tag-g">portada</span>' : ''}</td>
        <td class="num ${p.ok ? 'g' : 'b'}">${num(p.httpStatus)}</td>
        <td class="num">${ms(p.ttfbMs)}</td>
        <td class="num">${ms(p.loadMs)}</td>
        <td class="num">${bytes(p.transferBytes)}</td>
        <td class="num">${num(p.requestCount)}</td>
      </tr>`).join('')}
    </tbody>
  </table>
  ${paginasOcultas > 0 ? `<p class="hint" style="margin-top:6px">Se listan ${paginas.length} de ${data.pages.length} páginas medidas.</p>` : ''}

  <div class="sec"><span class="n">12</span><h3>Certificado TLS</h3></div>
  ${data.cert === null
    ? '<p class="empty">No fue posible leer el certificado del dominio.</p>'
    : `<dl class="vitals">
        <div><dt>Emisor</dt><dd style="font-size:11pt">${esc(data.cert.issuer ?? '—')}</dd><div class="u">${data.cert.valid === false ? 'la cadena no valida' : 'cadena válida'}</div></div>
        <div><dt>Vence</dt><dd style="font-size:11pt">${data.cert.validTo === null ? '—' : longDate(data.cert.validTo)}</dd><div class="u">&nbsp;</div></div>
        <div><dt>Días restantes</dt><dd class="${(data.cert.daysRemaining ?? 999) < 21 ? 'b' : 'g'}">${num(data.cert.daysRemaining)}</dd><div class="u">${(data.cert.daysRemaining ?? 999) < 21 ? '<span class="tag tag-b">Renovar</span>' : '<span class="tag tag-g">Sin riesgo</span>'} aviso a los 21</div></div>
      </dl>`}

  <div class="sec"><span class="n">13</span><h3>Alcance y método</h3></div>
  <p style="font-size:9pt;color:var(--muted);line-height:1.55;max-width:64ch;margin:0">
    Medición automatizada del ${longDate(data.runAt)} a las ${time(data.runAt)}, hora de Ciudad de México.
    Lighthouse ${data.lighthouseVersion ?? ''} sobre Chromium en modo ${ESTRATEGIA[data.strategy].toLowerCase()},
    ejecutado de forma aislada para que las cifras sean comparables entre días. Las métricas de
    disponibilidad provienen de cargas reales de cada página en el navegador, no de estimaciones.
    El sitio declara ${data.pagesDiscovered} ${data.pagesDiscovered === 1 ? 'URL' : 'URLs'}; esta corrida auditó ${data.pagesAudited}.
  </p>
  <p style="font-size:9pt;color:var(--muted);line-height:1.55;max-width:64ch;margin:8px 0 0">
    Las cifras de rendimiento son de laboratorio, no de usuarios reales. Sirven para comparar contra días
    anteriores y detectar regresiones; la experiencia de cada visitante depende además de su dispositivo
    y su conexión.
  </p>
</section>

</body></html>`;
}
