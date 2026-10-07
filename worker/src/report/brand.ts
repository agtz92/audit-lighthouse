/**
 * Membrete compartido por todos los informes: portada, encabezado de las hojas
 * interiores, numeración de secciones y la hoja de estilos base.
 *
 * Vive aparte para que los cuatro documentos —escritorio, móvil, tráfico e
 * integral— salgan del mismo código y no de cuatro copias que con el tiempo
 * dejarían de parecerse. Cambiar el membrete es cambiar este archivo.
 */

import { fontFaceCss } from './fonts.js';
import { esc } from './format.js';
import type { Consultant } from './model.js';

/** Hoja de estilos base. Cada informe agrega encima solo lo suyo. */
export const BRAND_CSS = `
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

.callout { background:var(--wash); border-left:3px solid var(--accent); padding:9px 11px; font-size:9pt; color:var(--muted); line-height:1.45; }
.callout b { color:var(--ink); font-weight:600; }

.empty { font-size:9.5pt; color:var(--muted); font-style:italic; }
.method { font-size:9pt; color:var(--muted); line-height:1.55; max-width:64ch; margin:0; }
.method + .method { margin-top:8px; }
`;

export interface CoverInput {
  consultant: Consultant;
  /** Tipo de informe, en la línea pequeña sobre el nombre del sitio. */
  kind: string;
  site: { name: string; url: string };
  /** Los datos del pie de la portada: [etiqueta, valor]. */
  facts: Array<[string, string]>;
}

export function coverSheet(c: CoverInput): string {
  return `<section class="sheet cover">
  <div>
    <p class="name">${esc(c.consultant.name)}</p>
    <p class="role">${esc(c.consultant.role)}</p>
    <p class="cred">${esc(c.consultant.credentials)}</p>
    <div class="bar"></div>
  </div>
  <div>
    <p class="kind">${esc(c.kind)}</p>
    <h1 class="site">${esc(c.site.name)}</h1>
    <p class="url">${esc(c.site.url)}</p>
  </div>
  <dl class="bottom">
    ${c.facts.map(([dt, dd]) => `<div><dt>${esc(dt)}</dt><dd>${esc(dd)}</dd></div>`).join('\n    ')}
  </dl>
</section>`;
}

/**
 * Encabezado de las hojas interiores.
 *
 * NO lleva número de hoja: la numeración vive en un solo lugar, el pie que
 * dibuja Chromium, que es el único que sabe cuántas páginas tiene el documento.
 * Tener el número en dos lados terminó como tenía que terminar —el encabezado
 * decía "hoja 3" mientras el pie decía "Hoja 4 de 7"— porque uno se calculaba
 * a mano y el otro de verdad.
 */
export function brandHeader(consultant: Consultant, titulo: string, siteName: string): string {
  return `<header class="brand">
    <div class="who">
      <strong>${esc(consultant.name)}</strong>
      <span>${esc(consultant.role)}</span>
    </div>
    <div class="doc">
      <b>${esc(titulo)}</b>
      <span>${esc(siteName)}</span>
    </div>
  </header>`;
}

/**
 * Numerador de secciones de un documento.
 *
 * El número lo da el orden en que se piden, no un literal en la plantilla: el
 * informe integral junta hojas de los otros informes, y con números escritos a
 * mano saldrían dos «Sección 1».
 */
export class Sections {
  #n = 0;

  sec(titulo: string, nota?: string): string {
    this.#n += 1;
    return `<div class="sec"><span class="n">${this.#n}</span><h3>${titulo}</h3>${nota === undefined ? '' : `<span class="note">${nota}</span>`}</div>`;
  }
}

/** Documento completo: fuentes embebidas, estilos base, los del informe y su cuerpo. */
export async function documentHtml(titulo: string, extraCss: string, body: string): Promise<string> {
  const fuentes = await fontFaceCss();
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${esc(titulo)}</title>
<style>
${fuentes}
${BRAND_CSS}
${extraCss}
</style></head><body>
${body}
</body></html>`;
}
