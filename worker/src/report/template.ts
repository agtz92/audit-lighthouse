/**
 * Plantilla del informe de Lighthouse. Devuelve el HTML que Chromium imprime.
 *
 * El diseño viene de la propuesta aprobada: portada con los datos del consultor
 * y el sitio, y cuatro hojas de contenido. Cada documento cubre UNA estrategia,
 * escritorio o móvil, por eso no hay columnas comparativas entre ambas.
 *
 * Cada hoja es una función aparte porque el informe integral reutiliza algunas
 * —el diagnóstico de cada estrategia y la disponibilidad por página— junto a
 * las de tráfico. El membrete y la hoja de estilos base viven en brand.ts.
 *
 * Los saltos de página son explícitos (`page-break-after`) en lugar de dejar que
 * Chromium decida: un informe donde una tabla se parte a la mitad entre dos
 * hojas se ve descuidado, y aquí sabemos exactamente dónde debe cortar.
 */

import { verdict } from './build.js';
import {
  type ReportData, type Rating, THRESHOLDS, LIMITS, rate, rateScore, RATING_LABEL,
} from './model.js';
import { ms, bytes, cls, num, longDate, time, esc } from './format.js';
import { brandHeader, coverSheet, documentHtml, Sections } from './brand.js';

import type { LighthouseStrategy } from '../audit/lighthouse.js';

/** Tipado por estrategia y no como Record<string,…>: así el índice no es opcional. */
export const ESTRATEGIA: Record<LighthouseStrategy, string> = { desktop: 'Escritorio', mobile: 'Móvil' };

/** Lo que solo usan las hojas de Lighthouse; lo común está en BRAND_CSS. */
export const LIGHTHOUSE_CSS = `
.scores { display:grid; grid-template-columns:1fr; gap:0; max-width:78%; }
.scores h4 { font-family:Archivo,sans-serif; font-size:7.5pt; font-weight:600; letter-spacing:.16em; text-transform:uppercase; margin:2px 0 7px; display:flex; align-items:center; gap:6px; color:var(--muted); }
.scores h4 i { width:14px; height:2px; display:inline-block; }
.srow { display:grid; grid-template-columns:1fr auto; align-items:baseline; gap:8px; padding:4px 0; }
.srow + .srow { border-top:1px solid var(--hair); }
.srow .lbl { font-size:10pt; }
.srow .val { font-family:"Roboto Mono",monospace; font-size:11pt; font-weight:500; }
.bar2 { grid-column:1/-1; height:3px; background:var(--hair); }
.bar2 i { display:block; height:100%; }

.opp { display:flex; flex-direction:column; gap:7px; }
.opp .row { display:grid; grid-template-columns:1fr auto; gap:10px; align-items:baseline; }
.opp .row .t { font-size:10pt; }
.opp .row .m { font-family:"Roboto Mono",monospace; font-size:8.5pt; color:var(--muted); }
.opp .track { grid-column:1/-1; height:4px; background:var(--wash); }
.opp .track i { display:block; height:100%; }

.find { list-style:none; margin:0; padding:0; }
.find li { padding:9px 0; border-bottom:1px solid var(--hair); }
.find li:last-child { border-bottom:none; }
.find .head { display:flex; gap:8px; align-items:baseline; }
.find b { font-family:Archivo,sans-serif; font-size:9.5pt; font-weight:600; letter-spacing:-.01em; }
.find p { margin:3px 0 0; font-size:9pt; color:var(--muted); line-height:1.45; max-width:62ch; }
`;

/** Recorta la descripción de un hallazgo para que su bloque no crezca de más. */
function corto(text: string, max = LIMITS.findingDescriptionChars): string {
  if (text.length <= max) return text;
  const corte = text.lastIndexOf(' ', max);
  return `${text.slice(0, corte > 40 ? corte : max).replace(/[.,;:]$/, '')}…`;
}

export function tag(rating: Rating): string {
  if (rating === 'none') return '';
  const clase = rating === 'good' ? 'tag-g' : rating === 'warning' ? 'tag-w' : 'tag-b';
  return `<span class="tag ${clase}">${RATING_LABEL[rating]}</span>`;
}

export function colorClass(rating: Rating): string {
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

/**
 * El pie de página ya NO lo pone la plantilla: lo dibuja Chromium en el margen,
 * con la numeración real. Un "Hoja 2 de 5" escrito a mano miente en cuanto el
 * contenido ocupa una hoja más, y el informe debe poder crecer según lo que
 * encuentre en cada sitio.
 */
export function footerLeftText(data: ReportData): string {
  return `${data.site.name} · ${ESTRATEGIA[data.strategy]} · ${longDate(data.runAt)}`;
}

/**
 * Conclusión, calificaciones, Core Web Vitals y prioridades de una estrategia.
 * `titulo` permite que el integral la encabece como «Diagnóstico · Móvil».
 */
export function diagnosticSheet(data: ReportData, s: Sections, titulo = 'Diagnóstico'): string {
  const m = data.metrics;
  return `<section class="sheet">
  ${brandHeader(data.consultant, titulo, data.site.name)}

  ${s.sec('Conclusión')}
  <p class="verdict">${verdict(data)}</p>

  ${s.sec('Calificaciones', `Lighthouse ${esc(data.lighthouseVersion ?? '')} · 0 a 100`)}
  <div class="scores"><div>
    <h4><i style="background:var(--${data.strategy})"></i>${ESTRATEGIA[data.strategy]}</h4>
    ${scoreRow('Rendimiento', data.scores.performance)}
    ${scoreRow('Accesibilidad', data.scores.accessibility)}
    ${scoreRow('Buenas prácticas', data.scores.bestPractices)}
    ${scoreRow('SEO', data.scores.seo)}
  </div></div>

  ${s.sec('Core Web Vitals', 'lo que Google usa para posicionar')}
  <dl class="vitals">
    ${vital('LCP', ms(m.lcpMs), rate(m.lcpMs, THRESHOLDS.lcpMs), ms(THRESHOLDS.lcpMs.good))}
    ${vital('CLS', cls(m.clsValue), rate(m.clsValue, THRESHOLDS.clsValue), THRESHOLDS.clsValue.good.toFixed(2))}
    ${vital('TBT', ms(m.tbtMs), rate(m.tbtMs, THRESHOLDS.tbtMs), ms(THRESHOLDS.tbtMs.good))}
  </dl>

  ${s.sec('Atender primero', 'ordenado por impacto medido')}
  ${data.priorities.length === 0
    ? '<p class="empty">No se detectaron acciones pendientes con impacto medible.</p>'
    : `<ol class="prio">${data.priorities.map((p) => `<li>
        <div><b>${esc(p.title)}</b><p>${esc(p.detail)}</p></div>
        <span class="impact ${p.severity === 'critical' ? 'b' : 'w'}">${esc(p.impact)}</span>
      </li>`).join('')}</ol>`}
</section>`;
}

export function performanceSheet(data: ReportData, s: Sections): string {
  const m = data.metrics;
  const maxAhorro = data.opportunities[0]?.savingsMs ?? 1;
  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Rendimiento', data.site.name)}

  ${s.sec('Métricas de carga', `${ESTRATEGIA[data.strategy].toLowerCase()} contra el umbral recomendado`)}
  <table>
    <thead><tr><th style="width:44%">Métrica</th><th class="num">Medido</th><th class="num">Umbral</th><th style="width:18%">Estado</th></tr></thead>
    <tbody>
      ${metricRow('Largest Contentful Paint', 'cuándo aparece el elemento más grande', ms(m.lcpMs), ms(THRESHOLDS.lcpMs.good), rate(m.lcpMs, THRESHOLDS.lcpMs))}
      ${metricRow('Total Blocking Time', 'hilo principal bloqueado', ms(m.tbtMs), ms(THRESHOLDS.tbtMs.good), rate(m.tbtMs, THRESHOLDS.tbtMs))}
      ${metricRow('Cumulative Layout Shift', 'cuánto se mueve el contenido al cargar', cls(m.clsValue), THRESHOLDS.clsValue.good.toFixed(2), rate(m.clsValue, THRESHOLDS.clsValue))}
      ${metricRow('First Contentful Paint', 'primer contenido visible', ms(m.fcpMs), ms(THRESHOLDS.fcpMs.good), rate(m.fcpMs, THRESHOLDS.fcpMs))}
      ${metricRow('Speed Index', 'qué tan rápido se llena la pantalla', ms(m.speedIndexMs), ms(THRESHOLDS.speedIndexMs.good), rate(m.speedIndexMs, THRESHOLDS.speedIndexMs))}
      ${metricRow('Time to Interactive', 'cuándo responde a un clic', ms(m.ttiMs), ms(THRESHOLDS.ttiMs.good), rate(m.ttiMs, THRESHOLDS.ttiMs))}
    </tbody>
  </table>

  ${s.sec('Oportunidades', 'ahorro estimado por Lighthouse')}
  ${data.opportunities.length === 0
    ? '<p class="empty">Lighthouse no encontró ahorros significativos que proponer.</p>'
    : `<div class="opp">${data.opportunities.slice(0, LIMITS.opportunities).map((o) => `<div class="row">
        <span class="t">${esc(o.title)}</span>
        <span class="m">${ms(o.savingsMs)}${o.savingsBytes > 0 ? ` · ${bytes(o.savingsBytes)}` : ''}</span>
        ${/* La barra compara entre sí. Con una sola oportunidad siempre mediría
              el 100% de sí misma, o sea nada, y se omite. */ ''}
        ${data.opportunities.length > 1
          ? `<span class="track"><i style="width:${Math.max(3, Math.round((o.savingsMs / maxAhorro) * 100))}%;background:var(--${data.strategy})"></i></span>`
          : ''}
      </div>`).join('')}</div>`}

  ${s.sec('Comparación con la corrida anterior')}
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
</section>`;
}

export function qualitySheet(data: ReportData, s: Sections): string {
  const a11yTodos = data.findings.filter((f) => f.category === 'accessibility');
  const otros = data.findings.filter((f) => f.category !== 'accessibility').slice(0, LIMITS.otherFindings);
  const a11y = a11yTodos.slice(0, LIMITS.accessibilityFindings);

  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Calidad', data.site.name)}

  ${s.sec('Hallazgos de accesibilidad', `score ${num(data.scores.accessibility)} · ${a11y.length} ${a11y.length === 1 ? 'auditoría' : 'auditorías'} no ${a11y.length === 1 ? 'aprobada' : 'aprobadas'}`)}
  ${a11y.length === 0
    ? '<p class="empty">Todas las auditorías automáticas de accesibilidad pasaron.</p>'
    : `<ul class="find">${a11y.map((f) => `<li>
        <div class="head"><span class="tag tag-w">Mejorable</span><b>${esc(f.title)}</b></div>
        <p>${esc(corto(f.description))}</p>
      </li>`).join('')}</ul>${a11yTodos.length > a11y.length
        ? `<p class="hint" style="margin-top:6px">Se listan las ${a11y.length} primeras de ${a11yTodos.length}; el resto está en el reporte completo de Lighthouse.</p>`
        : ''}`}

  ${s.sec('Buenas prácticas y SEO')}
  <dl class="vitals">
    <div><dt>Buenas prácticas</dt><dd class="${colorClass(rateScore(data.scores.bestPractices))}">${num(data.scores.bestPractices)}</dd><div class="u">${tag(rateScore(data.scores.bestPractices))}</div></div>
    <div><dt>SEO</dt><dd class="${colorClass(rateScore(data.scores.seo))}">${num(data.scores.seo)}</dd><div class="u">${tag(rateScore(data.scores.seo))}</div></div>
    <div><dt>Accesibilidad</dt><dd class="${colorClass(rateScore(data.scores.accessibility))}">${num(data.scores.accessibility)}</dd><div class="u">${tag(rateScore(data.scores.accessibility))}</div></div>
  </dl>

  ${otros.length > 0 ? `
  ${s.sec('Otros hallazgos')}
  <ul class="find">${otros.slice(0, 5).map((f) => `<li>
    <div class="head"><span class="tag tag-w">Mejorable</span><b>${esc(f.title)}</b></div>
    <p>${esc(f.description)}</p>
  </li>`).join('')}</ul>` : ''}

  <div class="callout" style="margin-top:16px">
    <b>Qué significa un 100 aquí.</b> Lighthouse verifica lo que se puede comprobar de forma automática:
    HTTPS, metadatos, errores de consola, enlaces rastreables. Un 100 no sustituye una revisión manual
    de accesibilidad ni una estrategia de contenidos: significa que no hay nada roto en lo medible.
  </div>
</section>`;
}

/** Disponibilidad por página, certificado y método. `conMetodo` lo apaga en el integral. */
export function infraSheet(data: ReportData, s: Sections, conMetodo = true): string {
  const paginas = data.pages.slice(0, LIMITS.pageRows);
  const paginasOcultas = data.pages.length - paginas.length;

  return `<section class="sheet">
  ${brandHeader(data.consultant, 'Infraestructura', data.site.name)}

  ${s.sec('Disponibilidad por página', `${data.pagesAudited} de ${data.pagesDiscovered} URLs del sitio`)}
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

  ${s.sec('Certificado TLS')}
  ${data.cert === null
    ? '<p class="empty">No fue posible leer el certificado del dominio.</p>'
    : `<dl class="vitals">
        <div><dt>Emisor</dt><dd style="font-size:11pt">${esc(data.cert.issuer ?? '—')}</dd><div class="u">${data.cert.valid === false ? 'la cadena no valida' : 'cadena válida'}</div></div>
        <div><dt>Vence</dt><dd style="font-size:11pt">${data.cert.validTo === null ? '—' : longDate(data.cert.validTo)}</dd><div class="u">&nbsp;</div></div>
        <div><dt>Días restantes</dt><dd class="${(data.cert.daysRemaining ?? 999) < 21 ? 'b' : 'g'}">${num(data.cert.daysRemaining)}</dd><div class="u">${(data.cert.daysRemaining ?? 999) < 21 ? '<span class="tag tag-b">Renovar</span>' : '<span class="tag tag-g">Sin riesgo</span>'} aviso a los 21</div></div>
      </dl>`}

  ${conMetodo ? `
  ${s.sec('Alcance y método')}
  <p class="method">
    Medición automatizada del ${longDate(data.runAt)} a las ${time(data.runAt)}, hora de Ciudad de México.
    Lighthouse ${esc(data.lighthouseVersion ?? '')} sobre Chromium en modo ${ESTRATEGIA[data.strategy].toLowerCase()},
    ejecutado de forma aislada para que las cifras sean comparables entre días. Las métricas de
    disponibilidad provienen de cargas reales de cada página en el navegador, no de estimaciones.
    El sitio declara ${data.pagesDiscovered} ${data.pagesDiscovered === 1 ? 'URL' : 'URLs'}; esta corrida auditó ${data.pagesAudited}.
  </p>
  <p class="method">
    Las cifras de rendimiento son de laboratorio, no de usuarios reales. Sirven para comparar contra días
    anteriores y detectar regresiones; la experiencia de cada visitante depende además de su dispositivo
    y su conexión.
  </p>` : ''}
</section>`;
}

export async function renderReportHtml(data: ReportData): Promise<string> {
  const s = new Sections();
  const body = [
    coverSheet({
      consultant: data.consultant,
      kind: `Auditoría de rendimiento web · ${ESTRATEGIA[data.strategy]}`,
      site: data.site,
      facts: [
        ['Fecha', longDate(data.runAt)],
        ['Hora', `${time(data.runAt)} CDMX`],
        ['Folio', data.folio],
      ],
    }),
    diagnosticSheet(data, s),
    performanceSheet(data, s),
    qualitySheet(data, s),
    infraSheet(data, s),
  ].join('\n\n');

  return documentHtml(`${data.site.name} — Auditoría ${ESTRATEGIA[data.strategy]}`, LIGHTHOUSE_CSS, body);
}
