import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRobotsGroups, rulesFor, isAllowed, evaluateBots, analyzeHtml, parseLlmsTxt, looksLikeChallenge,
  aiFindings, MIN_RAW_WORDS, type AiReadiness,
} from './ai-readiness.js';

describe('robots.txt para bots de IA', () => {
  const robots = [
    'User-agent: *',
    'Disallow: /admin',
    '',
    'User-agent: GPTBot',
    'User-agent: ClaudeBot',
    'Disallow: /',
    '',
    'Sitemap: https://x.example/sitemap.xml',
    'User-agent: PerplexityBot/1.0',
    'Disallow: /privado',
    'Allow: /privado/publico',
  ].join('\n');

  test('varias líneas user-agent seguidas comparten las reglas', () => {
    const g = parseRobotsGroups(robots);
    assert.equal(g.length, 3);
    assert.deepEqual(g[1]?.agents, ['gptbot', 'claudebot']);
  });

  test('un bot sin grupo propio hereda el de «*»', () => {
    const r = rulesFor(parseRobotsGroups(robots), 'OAI-SearchBot');
    assert.equal(r.explicit, false);
    assert.deepEqual(r.rules, [{ allow: false, path: '/admin' }]);
  });

  test('el producto se compara sin versión y sin importar mayúsculas', () => {
    assert.equal(rulesFor(parseRobotsGroups(robots), 'perplexitybot').explicit, true);
  });

  test('gana la regla más larga, y Allow en empate', () => {
    const rules = parseRobotsGroups(robots)[2]?.rules ?? [];
    assert.equal(isAllowed(rules, '/privado/x'), false);
    assert.equal(isAllowed(rules, '/privado/publico/y'), true);
    assert.equal(isAllowed([{ allow: false, path: '/a' }, { allow: true, path: '/a' }], '/a'), true);
  });

  test('comodines y fin de ruta', () => {
    assert.equal(isAllowed([{ allow: false, path: '/*.pdf$' }], '/doc.pdf'), false);
    assert.equal(isAllowed([{ allow: false, path: '/*.pdf$' }], '/doc.pdf?x'), true);
  });

  test('veredicto por bot sobre la home', () => {
    const v = Object.fromEntries(evaluateBots(robots, '/').map((b) => [b.token, b.verdict]));
    assert.equal(v.GPTBot, 'blocked');
    assert.equal(v.ClaudeBot, 'blocked');
    assert.equal(v['OAI-SearchBot'], 'partial');
    assert.equal(v.PerplexityBot, 'partial');
  });

  test('sin robots.txt todos pasan', () => {
    assert.ok(evaluateBots(null, '/').every((b) => b.verdict === 'allowed'));
  });

  test('«Disallow:» vacío no prohíbe nada', () => {
    assert.ok(evaluateBots('User-agent: *\nDisallow:', '/').every((b) => b.verdict === 'allowed'));
  });
});

describe('HTML sin JavaScript', () => {
  test('cuenta solo el texto visible y lee las señales del head', () => {
    const html = `<!doctype html><html lang="es-MX"><head><title> Hule &amp; más </title>
      <meta name="description" content="Venta de hule">
      <link rel="canonical" href="https://x.example/">
      <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["LocalBusiness","Store"]}]}</script>
      </head><body><h1>Hola mundo</h1><script>var a = "no cuenta nada";</script><style>.x{}</style>
      <p>Tres palabras más</p><svg><text>tampoco</text></svg></body></html>`;
    const s = analyzeHtml(html);
    assert.equal(s.words, 5);
    assert.equal(s.title, 'Hule & más');
    assert.equal(s.description, 'Venta de hule');
    assert.equal(s.canonical, 'https://x.example/');
    assert.equal(s.lang, 'es-MX');
    assert.equal(s.h1, 1);
    assert.deepEqual(s.jsonLdTypes, ['LocalBusiness', 'Organization', 'Store']);
  });

  test('un JSON-LD roto no rompe el análisis', () => {
    assert.deepEqual(analyzeHtml('<script type="application/ld+json">{roto</script>').jsonLdTypes, []);
  });
});

describe('llms.txt', () => {
  const h = (t: string): Headers => new Headers({ 'content-type': t });

  test('uno válido', () => {
    const r = parseLlmsTxt({ status: 200, body: '# Mi sitio\n\n- [Productos](https://x.example/p)', headers: h('text/plain') });
    assert.deepEqual([r.present, r.valid, r.links], [true, true, 1]);
  });

  test('un 200 con la home en HTML no cuenta', () => {
    assert.equal(parseLlmsTxt({ status: 200, body: '<!doctype html><html>', headers: h('text/html') }).present, false);
  });

  test('presente sin encabezado', () => {
    const r = parseLlmsTxt({ status: 200, body: 'hola', headers: h('text/plain') });
    assert.deepEqual([r.present, r.valid], [true, false]);
  });
});

describe('páginas de reto del firewall', () => {
  test('Cloudflare por encabezado y por cuerpo', () => {
    assert.ok(looksLikeChallenge({ status: 403, body: '', headers: new Headers({ 'cf-mitigated': 'challenge' }) }));
    assert.ok(looksLikeChallenge({ status: 503, body: '<title>Just a moment...</title>', headers: null }));
    assert.ok(!looksLikeChallenge({ status: 200, body: '<html>hola</html>', headers: null }));
  });
});

describe('hallazgos', () => {
  const base = (): Omit<AiReadiness, 'findings'> => ({
    checkedAt: '2026-10-17T00:00:00Z',
    homeUrl: 'https://x.example/',
    robots: { status: 200, error: null, bots: evaluateBots('', '/') },
    baseline: { status: 200, error: null, challenge: false },
    probes: [{ token: 'ChatGPT-User', status: 200, blocked: false, reason: null }],
    llmsTxt: { status: 200, present: true, valid: true, bytes: 10, links: 1 },
    html: { words: 800, title: 't', description: 'd', canonical: null, lang: 'es', h1: 1, jsonLdTypes: ['Organization'], metaRobots: null },
    xRobotsTag: null,
  });

  test('un sitio en orden no tiene hallazgos', () => {
    assert.deepEqual(aiFindings(base()), []);
  });

  test('bloquear un bot de búsqueda es crítico; uno de entrenamiento, informativo', () => {
    const r = base();
    r.robots.bots = evaluateBots('User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /', '/');
    const f = aiFindings(r);
    assert.equal(f.filter((x) => x.level === 'critical').length, 1);
    assert.match(f.find((x) => x.level === 'critical')?.message ?? '', /OAI-SearchBot/);
    assert.match(f.find((x) => x.level === 'info')?.message ?? '', /GPTBot/);
  });

  test('el firewall solo cuenta si el navegador sí pasó', () => {
    const r = base();
    r.probes = [{ token: 'ChatGPT-User', status: 403, blocked: true, reason: '403' }];
    assert.equal(aiFindings(r).filter((x) => x.level === 'critical').length, 1);
    r.baseline = { status: 403, error: null, challenge: false };
    assert.equal(aiFindings(r).filter((x) => x.level === 'critical').length, 0);
  });

  test('poco texto sin JS, noindex y robots caído', () => {
    const r = base();
    r.html = { ...(r.html as NonNullable<typeof r.html>), words: MIN_RAW_WORDS - 1, metaRobots: 'noindex, follow' };
    r.robots = { ...r.robots, status: 503 };
    const textos = aiFindings(r).map((x) => x.message).join('\n');
    assert.match(textos, /Sin JavaScript/);
    assert.match(textos, /noindex/);
    assert.match(textos, /robots\.txt no responde/);
  });
});
