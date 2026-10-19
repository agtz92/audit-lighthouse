/**
 * Acceso de los asistentes de IA, para el informe integral.
 *
 * El dashboard muestra la revisión completa bot por bot; aquí se resume por
 * asistente, que es lo que entiende un cliente: «¿ChatGPT puede leer mi
 * sitio?». Los bots de solo entrenamiento no entran en la tabla, porque
 * bloquearlos no impide salir citado.
 */

import type { AiReadiness } from '../audit/ai-readiness.js';
import { MIN_RAW_WORDS } from '../audit/ai-readiness.js';
import type { Priority } from './model.js';
import type { Sections } from './brand.js';
import { esc, int } from './format.js';

/** Los bots que deciden si cada asistente puede citar el sitio. */
const ASISTENTES: Array<{ name: string; bots: string[] }> = [
  { name: 'ChatGPT', bots: ['OAI-SearchBot', 'ChatGPT-User'] },
  { name: 'Claude', bots: ['Claude-SearchBot', 'Claude-User'] },
  { name: 'Perplexity', bots: ['PerplexityBot', 'Perplexity-User'] },
  { name: 'Copilot', bots: ['Bingbot'] },
];

export type AccessVerdict = 'ok' | 'robots' | 'firewall';

export interface AssistantAccess {
  name: string;
  verdict: AccessVerdict;
  /** El bot que está bloqueado y cómo, para la tabla. */
  detail: string | null;
}

/** Si el navegador tampoco pasó, la prueba del firewall no dice nada. */
function baselineOk(r: AiReadiness): boolean {
  return r.baseline.status !== null && r.baseline.status < 400 && !r.baseline.challenge;
}

export function assistantAccess(r: AiReadiness): AssistantAccess[] {
  return ASISTENTES.map((a) => {
    const robots = r.robots.bots.find((b) => a.bots.includes(b.token) && b.verdict === 'blocked');
    if (robots !== undefined) return { name: a.name, verdict: 'robots', detail: `robots.txt bloquea ${robots.token}` };
    const fw = baselineOk(r) ? r.probes.find((p) => a.bots.includes(p.token) && p.blocked) : undefined;
    if (fw !== undefined) return { name: a.name, verdict: 'firewall', detail: `el servidor responde ${fw.reason ?? 'error'} a ${fw.token}` };
    return { name: a.name, verdict: 'ok', detail: null };
  });
}

/** Lo que el informe integral pone en «Atender primero». */
export function aiAccessPriorities(r: AiReadiness | null): Priority[] {
  if (r === null) return [];
  const out: Priority[] = [];

  const bloqueados = assistantAccess(r).filter((a) => a.verdict !== 'ok');
  const noindex = /\b(noindex|none)\b/i.test(`${r.html?.metaRobots ?? ''} ${r.xRobotsTag ?? ''}`);
  if (bloqueados.length > 0) {
    const firewall = bloqueados.some((a) => a.verdict === 'firewall');
    out.push({
      title: `Dejar entrar a ${bloqueados.map((a) => a.name).join(', ')}`,
      detail: `${bloqueados.map((a) => `${a.name}: ${a.detail}`).join('; ')}. Mientras siga así, el sitio no puede aparecer citado en sus respuestas.${firewall ? ' El rechazo del servidor suele venir de «bloquear bots de IA» en Cloudflare o de una regla del firewall; conviene confirmarlo en sus registros.' : ''}`,
      impact: 'sin citas en IA',
      severity: 'critical',
    });
  } else if (noindex) {
    out.push({
      title: 'Quitar el noindex de la home',
      detail: 'La home le pide a los buscadores que no la indexen. Eso la saca de Google y también de los índices de los que citan los asistentes de IA.',
      impact: 'fuera de índices',
      severity: 'critical',
    });
  }

  const legibilidad: string[] = [];
  if (r.html !== null && r.html.words < MIN_RAW_WORDS) {
    legibilidad.push(`sin JavaScript la home tiene ${int(r.html.words)} palabras, y los asistentes no ejecutan JavaScript`);
  }
  if (r.html !== null && r.html.jsonLdTypes.length === 0) {
    legibilidad.push('no tiene datos estructurados que digan qué negocio es');
  }
  if (legibilidad.length > 0) {
    out.push({
      title: 'Hacer la home legible para los asistentes de IA',
      detail: `${legibilidad.join('; ')}. Lo que un asistente no puede leer, no lo puede citar.`,
      impact: 'legibilidad IA',
      severity: 'warning',
    });
  }
  return out;
}

const TAG: Record<AccessVerdict, string> = {
  ok: '<span class="tag tag-g">Puede leer</span>',
  robots: '<span class="tag tag-b">Bloqueado</span>',
  firewall: '<span class="tag tag-b">Rechazado</span>',
};

/** Tabla por asistente y lo que lee sin JavaScript. */
export function aiAccessBlock(r: AiReadiness | null, s: Sections): string {
  if (r === null) return '';
  const acceso = assistantAccess(r);
  const entrenamiento = r.robots.bots.filter((b) => b.role === 'training' && b.verdict === 'blocked').map((b) => b.token);

  return `${s.sec('Si los asistentes pueden leer el sitio', 'robots.txt y respuesta del servidor a cada bot')}
  <table>
    <thead><tr><th>Asistente</th><th>Resultado</th><th>Detalle</th></tr></thead>
    <tbody>${acceso.map((a) => `<tr>
      <td>${esc(a.name)}</td>
      <td>${TAG[a.verdict]}</td>
      <td class="hint">${a.detail === null ? 'robots.txt lo permite y el servidor responde' : esc(a.detail)}</td>
    </tr>`).join('')}</tbody>
  </table>
  ${r.html === null ? '' : `<table style="margin-top:10px">
    <tbody>
      <tr><td>Texto de la home sin JavaScript</td><td class="num">${int(r.html.words)} palabras</td><td>${r.html.words < MIN_RAW_WORDS ? '<span class="tag tag-w">Muy poco</span>' : '<span class="tag tag-g">Suficiente</span>'}</td></tr>
      <tr><td>Datos estructurados</td><td class="num">${r.html.jsonLdTypes.length === 0 ? '—' : esc(r.html.jsonLdTypes.slice(0, 3).join(', '))}</td><td>${r.html.jsonLdTypes.length === 0 ? '<span class="tag tag-w">No tiene</span>' : '<span class="tag tag-g">Tiene</span>'}</td></tr>
      <tr><td>/llms.txt</td><td class="num">${r.llmsTxt.present ? `${int(r.llmsTxt.links)} enlaces` : '—'}</td><td>${r.llmsTxt.present ? '<span class="tag tag-g">Tiene</span>' : '<span class="hint">opcional</span>'}</td></tr>
    </tbody>
  </table>`}
  <p class="method" style="margin-top:10px">
    La prueba pide la home con el user-agent de cada bot desde el servidor de monitoreo, no desde las IPs del
    asistente: un firewall que verifica IPs puede rechazarla y dejar pasar al bot real.${entrenamiento.length > 0
      ? ` Bloqueados solo para entrenamiento, sin efecto en las citas: ${esc(entrenamiento.join(', '))}.`
      : ''}
  </p>`;
}
