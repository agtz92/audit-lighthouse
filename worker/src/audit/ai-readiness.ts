/**
 * Preparación del sitio para los asistentes de IA (ChatGPT, Claude, Perplexity,
 * Gemini, Copilot).
 *
 * Ninguno publica cuántas veces mostró un sitio en sus respuestas, pero sí se
 * puede revisar lo que decide si PUEDEN mostrarlo:
 *
 *   1. robots.txt: qué bots de IA tienen permitido entrar a la home. Se
 *      interpreta como lo haría el bot (RFC 9309), a diferencia de robots.ts,
 *      que solo busca sitemaps.
 *   2. El firewall: se pide la home con el user-agent de cada bot que busca en
 *      vivo. Un «Bloquear bots de IA» encendido en Cloudflare, o una regla del
 *      WAF, contesta 403 aunque robots.txt diga que sí.
 *   3. El HTML sin JavaScript: los fetchers de los asistentes no ejecutan JS.
 *      Un sitio que pinta su texto en el navegador les llega vacío.
 *   4. llms.txt, datos estructurados y meta robots, como apoyo.
 *
 * Todo es red, sin navegador, y corre junto al descubrimiento. Nada de esto
 * hace fallar la auditoría: es un diagnóstico, igual que el certificado.
 */

export type BotRole = 'training' | 'search' | 'user';

export interface AiBot {
  token: string;
  vendor: string;
  role: BotRole;
  /** User-agent completo, para los bots que se prueban contra el firewall. */
  probeUa?: string;
}

/**
 * Los bots que importan, por su efecto:
 *   - search: arman el índice del que el asistente cita. Bloquearlo es no salir.
 *   - user: entra cuando una persona pregunta y el asistente trae la página.
 *   - training: solo entrenamiento. Bloquearlo es una decisión legítima.
 *
 * Bingbot va como search porque Copilot responde desde el índice de Bing.
 * Google-Extended no frena a Googlebot ni a AI Overviews: solo el uso del
 * contenido para entrenar y fundamentar Gemini.
 */
export const AI_BOTS: AiBot[] = [
  { token: 'OAI-SearchBot', vendor: 'OpenAI', role: 'search',
    probeUa: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot' },
  { token: 'ChatGPT-User', vendor: 'OpenAI', role: 'user',
    probeUa: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { token: 'GPTBot', vendor: 'OpenAI', role: 'training' },
  { token: 'Claude-SearchBot', vendor: 'Anthropic', role: 'search' },
  { token: 'Claude-User', vendor: 'Anthropic', role: 'user',
    probeUa: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)' },
  { token: 'ClaudeBot', vendor: 'Anthropic', role: 'training' },
  { token: 'PerplexityBot', vendor: 'Perplexity', role: 'search',
    probeUa: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { token: 'Perplexity-User', vendor: 'Perplexity', role: 'user' },
  { token: 'Bingbot', vendor: 'Microsoft (Copilot)', role: 'search' },
  { token: 'Google-Extended', vendor: 'Google (Gemini)', role: 'training' },
  { token: 'Applebot-Extended', vendor: 'Apple', role: 'training' },
  { token: 'meta-externalagent', vendor: 'Meta', role: 'training' },
  { token: 'CCBot', vendor: 'Common Crawl', role: 'training' },
];

/** El navegador de referencia: si a él tampoco lo dejan pasar, no hay comparación. */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

// ── robots.txt ──────────────────────────────────────────────────────────────

export interface RobotsRule { allow: boolean; path: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }

/**
 * Agrupa robots.txt como dice RFC 9309: varias líneas user-agent seguidas
 * comparten las reglas que vienen después; un user-agent después de reglas
 * abre grupo nuevo. Las líneas que no son de grupo (Sitemap) no lo cortan.
 */
export function parseRobotsGroups(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let actual: RobotsGroup | null = null;
  let enReglas = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = (raw.split('#')[0] ?? '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (m === null) continue;
    const key = (m[1] ?? '').toLowerCase();
    const value = (m[2] ?? '').trim();
    if (key === 'user-agent') {
      if (actual === null || enReglas) {
        actual = { agents: [], rules: [] };
        groups.push(actual);
        enReglas = false;
      }
      actual.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (actual === null) continue;
      enReglas = true;
      // «Disallow:» vacío no prohíbe nada: es la forma clásica de decir «pasa».
      if (value !== '') actual.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups;
}

/** Las reglas que aplican a un bot: las de sus grupos, o las de «*» si no tiene. */
export function rulesFor(groups: RobotsGroup[], token: string): { rules: RobotsRule[]; explicit: boolean } {
  const t = token.toLowerCase();
  // El valor puede venir con versión («GPTBot/1.1»); se compara el producto.
  const propios = groups.filter((g) => g.agents.some((a) => a.split('/')[0]?.trim() === t));
  if (propios.length > 0) return { rules: propios.flatMap((g) => g.rules), explicit: true };
  return { rules: groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules), explicit: false };
}

function patternMatches(pattern: string, path: string): boolean {
  const anclado = pattern.endsWith('$');
  const cuerpo = anclado ? pattern.slice(0, -1) : pattern;
  const re = cuerpo.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${re}${anclado ? '$' : ''}`).test(path);
}

/** Gana la regla más larga que coincide; en empate, Allow (RFC 9309 §2.2.2). */
export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let mejor: RobotsRule | null = null;
  for (const r of rules) {
    if (!patternMatches(r.path, path)) continue;
    if (mejor === null || r.path.length > mejor.path.length || (r.path.length === mejor.path.length && r.allow)) {
      mejor = r;
    }
  }
  return mejor === null || mejor.allow;
}

/** blocked = no puede entrar a la home; partial = entra, pero tiene rutas prohibidas. */
export type BotVerdict = 'allowed' | 'partial' | 'blocked';

export interface BotAccess {
  token: string;
  vendor: string;
  role: BotRole;
  verdict: BotVerdict;
  /** true si robots.txt lo nombra; false si hereda las reglas de «*». */
  explicit: boolean;
}

export function evaluateBots(robotsText: string | null, homePath: string): BotAccess[] {
  const groups = robotsText === null ? [] : parseRobotsGroups(robotsText);
  return AI_BOTS.map((b) => {
    const { rules, explicit } = rulesFor(groups, b.token);
    const verdict: BotVerdict = !isAllowed(rules, homePath)
      ? 'blocked'
      : rules.some((r) => !r.allow) ? 'partial' : 'allowed';
    return { token: b.token, vendor: b.vendor, role: b.role, verdict, explicit };
  });
}

// ── HTML sin JavaScript ─────────────────────────────────────────────────────

export interface HtmlSignals {
  /** Palabras de texto visible en el HTML tal como llega, sin ejecutar JS. */
  words: number;
  title: string | null;
  description: string | null;
  canonical: string | null;
  lang: string | null;
  h1: number;
  jsonLdTypes: string[];
  metaRobots: string | null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m === null ? null : (m[2] ?? m[3] ?? m[4] ?? '').trim();
}

function metaContent(html: string, name: string): string | null {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if ((attr(m[0], 'name') ?? '').toLowerCase() === name) return attr(m[0], 'content');
  }
  return null;
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  const t = o['@type'];
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  if (o['@graph'] !== undefined) collectTypes(o['@graph'], out);
}

export function analyzeHtml(html: string): HtmlSignals {
  const tipos = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectTypes(JSON.parse(m[1] ?? ''), tipos);
    } catch {
      // Un JSON-LD roto no le sirve a nadie; se cuenta como ausente.
    }
  }

  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const texto = decode(
    body
      .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
  const words = texto.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;

  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  let canonical: string | null = null;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase() === 'canonical') canonical = attr(m[0], 'href');
  }
  const htmlTag = /<html\b[^>]*>/i.exec(html)?.[0];

  return {
    words,
    title: title === undefined ? null : decode(title).replace(/\s+/g, ' ').trim() || null,
    description: metaContent(html, 'description') || null,
    canonical,
    lang: htmlTag === undefined ? null : attr(htmlTag, 'lang'),
    h1: (html.match(/<h1\b/gi) ?? []).length,
    jsonLdTypes: [...tipos].sort(),
    metaRobots: metaContent(html, 'robots'),
  };
}

// ── Red ─────────────────────────────────────────────────────────────────────

interface Fetched { status: number | null; body: string; headers: Headers | null; error: string | null }

async function get(url: string, ua: string, timeoutMs: number, signal?: AbortSignal): Promise<Fetched> {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': ua, accept: 'text/html,text/plain,*/*' },
      signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
    });
    // Tope de 2 MB: una home más pesada que eso ya tiene otros problemas.
    const body = (await res.text()).slice(0, 2_000_000);
    return { status: res.status, body, headers: res.headers, error: null };
  } catch (err) {
    return { status: null, body: '', headers: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Páginas de reto de Cloudflare, Akamai, Imperva y Sucuri: contestan 200 o 403 con un captcha. */
export function looksLikeChallenge(f: { status: number | null; body: string; headers: Headers | null }): boolean {
  if (f.headers?.get('cf-mitigated') === 'challenge') return true;
  const inicio = f.body.slice(0, 20_000);
  return /cf-chl-|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare|_Incapsula_Resource|Access Denied.*Reference #|sucuri-firewall/i.test(inicio);
}

export interface BotProbe {
  token: string;
  status: number | null;
  /** El bot recibe un no que el navegador no recibe. */
  blocked: boolean;
  reason: string | null;
}

export interface LlmsTxt {
  status: number | null;
  present: boolean;
  /** Empieza con un encabezado «# Nombre», como pide la propuesta de llmstxt.org. */
  valid: boolean;
  bytes: number;
  links: number;
}

export function parseLlmsTxt(f: { status: number | null; body: string; headers: Headers | null }): LlmsTxt {
  const tipo = f.headers?.get('content-type') ?? '';
  // Muchos sitios contestan 200 con su página de inicio a cualquier ruta: eso no es un llms.txt.
  const present = f.status === 200 && !/html/i.test(tipo) && !/^\s*</.test(f.body) && f.body.trim() !== '';
  const primera = f.body.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return {
    status: f.status,
    present,
    valid: present && /^#\s+\S/.test(primera),
    bytes: present ? Buffer.byteLength(f.body) : 0,
    links: present ? (f.body.match(/\[[^\]]+\]\([^)]+\)/g) ?? []).length : 0,
  };
}

export type FindingLevel = 'critical' | 'warning' | 'info';
export interface AiFinding { level: FindingLevel; message: string }

export interface AiReadiness {
  checkedAt: string;
  homeUrl: string;
  robots: { status: number | null; error: string | null; bots: BotAccess[] };
  baseline: { status: number | null; error: string | null; challenge: boolean };
  probes: BotProbe[];
  llmsTxt: LlmsTxt;
  /** null si la home no respondió HTML. */
  html: HtmlSignals | null;
  xRobotsTag: string | null;
  findings: AiFinding[];
}

/** Menos palabras que esto en el HTML crudo y la página depende de JS para tener contenido. */
export const MIN_RAW_WORDS = 150;

const ROL: Record<BotRole, string> = {
  search: 'el índice del que cita',
  user: 'la consulta en vivo',
  training: 'entrenamiento',
};

/** Lo que hay que decirle a una persona, en orden de gravedad. */
export function aiFindings(r: Omit<AiReadiness, 'findings'>): AiFinding[] {
  const out: AiFinding[] = [];
  const robots5xx = r.robots.status !== null && r.robots.status >= 500;

  if (robots5xx || (r.robots.status === null && r.robots.error !== null)) {
    out.push({
      level: 'critical',
      message: `robots.txt no responde (${r.robots.status ?? r.robots.error}). Ante eso los rastreadores asumen que todo está prohibido.`,
    });
  }

  for (const b of r.robots.bots.filter((x) => x.verdict === 'blocked' && x.role !== 'training')) {
    out.push({
      level: 'critical',
      message: `robots.txt bloquea a ${b.token} (${b.vendor}, ${ROL[b.role]}): el sitio no puede salir citado ahí.`,
    });
  }

  if (r.baseline.status !== null && r.baseline.status < 400 && !r.baseline.challenge) {
    for (const p of r.probes.filter((x) => x.blocked)) {
      out.push({
        level: 'critical',
        message: `El servidor le contesta ${p.reason} a ${p.token} y al navegador no. Suele ser «bloquear bots de IA» en Cloudflare o una regla del firewall. Puede ser también que el firewall detecte que la prueba no sale de las IPs del bot: confírmalo en sus registros.`,
      });
    }
  }

  const noindex = /\b(noindex|none)\b/i.test(`${r.html?.metaRobots ?? ''} ${r.xRobotsTag ?? ''}`);
  if (noindex) {
    out.push({ level: 'critical', message: 'La home tiene noindex: no entra a ningún índice, tampoco al de los asistentes.' });
  }

  if (r.html !== null && r.html.words < MIN_RAW_WORDS) {
    out.push({
      level: 'warning',
      message: `Sin JavaScript la home tiene ${r.html.words} palabras. Los asistentes leen el HTML sin ejecutarlo: lo que se pinta en el navegador no les llega.`,
    });
  }
  if (r.html !== null && r.html.jsonLdTypes.length === 0) {
    out.push({ level: 'warning', message: 'La home no tiene datos estructurados (JSON-LD). Organization, LocalBusiness o Product ayudan a que el asistente entienda quién es el negocio.' });
  }
  if (r.html !== null && r.html.description === null) {
    out.push({ level: 'warning', message: 'La home no tiene meta description.' });
  }

  const entrenamiento = r.robots.bots.filter((b) => b.verdict === 'blocked' && b.role === 'training');
  if (entrenamiento.length > 0) {
    out.push({
      level: 'info',
      message: `Bloqueados solo para entrenamiento: ${entrenamiento.map((b) => b.token).join(', ')}. No impide salir citado; es una decisión válida si es deliberada.`,
    });
  }
  if (!r.llmsTxt.present) {
    out.push({ level: 'info', message: 'No hay /llms.txt. Es una propuesta reciente que ningún asistente garantiza leer; útil, no urgente.' });
  } else if (!r.llmsTxt.valid) {
    out.push({ level: 'warning', message: '/llms.txt existe pero no empieza con un encabezado «# Nombre del sitio».' });
  }
  return out;
}

export interface AiReadinessOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  now?: Date;
}

export async function checkAiReadiness(homeUrl: string, opts: AiReadinessOptions): Promise<AiReadiness> {
  const origin = new URL(homeUrl).origin;
  const homePath = new URL(homeUrl).pathname || '/';
  const t = opts.timeoutMs;

  const probados = AI_BOTS.filter((b) => b.probeUa !== undefined);
  const [robots, llms, base, ...probes] = await Promise.all([
    get(`${origin}/robots.txt`, BROWSER_UA, t, opts.signal),
    get(`${origin}/llms.txt`, BROWSER_UA, t, opts.signal),
    get(homeUrl, BROWSER_UA, t, opts.signal),
    ...probados.map((b) => get(homeUrl, b.probeUa as string, t, opts.signal)),
  ]);

  // RFC 9309: un 4xx es «no hay robots.txt» y todo se permite; un 5xx o un
  // servidor que no contesta se toma como prohibición total.
  const robotsText = robots.status !== null && robots.status < 400
    ? robots.body
    : robots.status !== null && robots.status < 500 ? null : 'User-agent: *\nDisallow: /';

  const baseChallenge = looksLikeChallenge(base);
  const esHtml = /html/i.test(base.headers?.get('content-type') ?? '');

  const parcial: Omit<AiReadiness, 'findings'> = {
    checkedAt: (opts.now ?? new Date()).toISOString(),
    homeUrl,
    robots: { status: robots.status, error: robots.error, bots: evaluateBots(robotsText, homePath) },
    baseline: { status: base.status, error: base.error, challenge: baseChallenge },
    probes: probes.map((p, i) => {
      const token = probados[i]?.token ?? '';
      const reto = looksLikeChallenge(p);
      const blocked = p.status === null || p.status >= 400 || reto;
      const reason = p.status === null ? `un error (${p.error})` : reto ? `una página de reto (${p.status})` : String(p.status);
      return { token, status: p.status, blocked, reason: blocked ? reason : null };
    }),
    llmsTxt: parseLlmsTxt(llms),
    html: base.status !== null && base.status < 400 && esHtml && !baseChallenge ? analyzeHtml(base.body) : null,
    xRobotsTag: base.headers?.get('x-robots-tag') ?? null,
  };
  return { ...parcial, findings: aiFindings(parcial) };
}
