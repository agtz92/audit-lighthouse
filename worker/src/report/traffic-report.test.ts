import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnalyticsReport, gscTotals, dailySeries, queryRows, mergedPages, pageProblem, analyticsVerdict,
  relChange, channelLabel, type BuildAnalyticsInput, type PageHealth,
} from './analytics-model.js';
import { renderAnalyticsHtml } from './analytics-template.js';
import { renderIntegralHtml, integralPriorities } from './integral-template.js';
import { renderReportHtml } from './template.js';
import { niceTicks, lineChartSvg } from './svg.js';
import { Sections } from './brand.js';
import type { ReportData } from './model.js';

const consultant = { name: 'José Alfredo Gutiérrez Guerra', role: 'Consultor', credentials: 'ITE 2016' };

function dias(start: string, n: number, f: (i: number) => number): Array<{ date: string; clicks: number; impressions: number; position: number }> {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { date: d.toISOString().slice(0, 10), clicks: f(i), impressions: f(i) * 25, position: 8 };
  });
}

function input(over: Partial<BuildAnalyticsInput> = {}): BuildAnalyticsInput {
  const health = new Map<string, PageHealth>([
    ['/', { httpStatus: 200, loadMs: 1800, ok: true }],
    ['/catalogo-2025', { httpStatus: 404, loadMs: null, ok: false }],
    ['/pisos-gimnasio', { httpStatus: 200, loadMs: 6900, ok: true }],
  ]);
  return {
    consultant,
    site: { name: 'MatMarkt', url: 'https://www.matmarkt.mx' },
    generatedAt: new Date('2026-10-07T11:00:00Z'),
    folio: '20261007-012',
    mode: 'month',
    current: { start: '2026-09-01', end: '2026-09-30' },
    previous: { start: '2026-08-01', end: '2026-08-31' },
    gsc: {
      property: 'sc-domain:matmarkt.mx',
      latestDate: '2026-10-04',
      daily: dias('2026-09-01', 30, () => 100),
      previousDaily: dias('2026-08-01', 31, () => 150),
      queries: [
        { key: 'tapete de hule', clicks: 1284, impressions: 31902, position: 3.1 },
        { key: 'piso de hule para gimnasio', clicks: 741, impressions: 26115, position: 6.7 },
      ],
      previousQueries: [{ key: 'tapete de hule', clicks: 1100, impressions: 30000, position: 3.9 }],
      pages: [
        { key: 'https://www.matmarkt.mx/', clicks: 2310, impressions: 50000, position: 4 },
        { key: 'https://www.matmarkt.mx/catalogo-2025/', clicks: 204, impressions: 3000, position: 9 },
      ],
    },
    ga: {
      property: '345678901',
      daily: [],
      previousDaily: [],
      totals: { sessions: 11240, engagedSessions: 6400, totalUsers: 8905, newUsers: 6000, pageViews: 30000, keyEvents: 214, avgSessionSeconds: 95 },
      previousTotals: { sessions: 10900, engagedSessions: 6200, totalUsers: 8700, newUsers: 5900, pageViews: 29000, keyEvents: 200, avgSessionSeconds: 90 },
      channels: [{ key: 'Organic Search', sessions: 6410, engagedSessions: 4000, keyEvents: 120 }],
      devices: [
        { key: 'mobile', sessions: 7643, engagedSessions: 4000, keyEvents: 100 },
        { key: 'desktop', sessions: 3597, engagedSessions: 2400, keyEvents: 114 },
      ],
      landing: [{ key: '/pisos-gimnasio', sessions: 1204, engagedSessions: 470, keyEvents: 3 }],
      keyEvents: [{ name: 'generate_lead', count: 180 }],
      keyEventsDefined: ['generate_lead', 'click_whatsapp'],
    },
    health,
    dropThreshold: 20,
    ...over,
  };
}

describe('cálculos de Search Console', () => {
  test('la posición media se pondera por impresiones', () => {
    const t = gscTotals([
      { date: 'a', clicks: 10, impressions: 100, position: 2 },
      { date: 'b', clicks: 0, impressions: 900, position: 12 },
    ]);
    assert.equal(t.position, 11);
    assert.equal(t.ctr, 0.01);
  });

  test('sin impresiones no hay CTR ni posición que inventar', () => {
    assert.deepEqual(gscTotals([]), { clicks: 0, impressions: 0, ctr: null, position: null });
  });

  test('un día sin filas ya pasado vale cero; uno que Google no ha publicado, null', () => {
    const serie = dailySeries([{ date: '2026-10-01', v: 5 }], { start: '2026-10-01', end: '2026-10-04' }, (r) => r.v, '2026-10-02');
    assert.deepEqual(serie, [5, 0, null, null]);
  });

  test('el cambio de posición es positivo cuando sube', () => {
    const [q] = queryRows([{ key: 'a', clicks: 1, impressions: 10, position: 3 }], [{ key: 'a', clicks: 1, impressions: 10, position: 5.5 }]);
    assert.equal(q?.positionGain, 2.5);
  });

  test('sin base no hay cambio relativo', () => {
    assert.equal(relChange(10, 0), null);
    assert.equal(relChange(80, 100), -0.2);
  });

  test('los canales se traducen y lo desconocido se queda igual', () => {
    assert.equal(channelLabel('Organic Search'), 'Búsqueda orgánica');
    assert.equal(channelLabel('Algo nuevo'), 'Algo nuevo');
  });
});

describe('buildAnalyticsReport', () => {
  const data = buildAnalyticsReport(input());

  test('cruza las páginas con tráfico con su estado en la auditoría', () => {
    const catalogo = data.gsc?.pages.find((p) => p.path === '/catalogo-2025');
    assert.equal(catalogo?.health?.httpStatus, 404);
    assert.equal(pageProblem(catalogo!), 'down');
  });

  test('avisa cuando Search Console todavía no publica todo el periodo', () => {
    const d = buildAnalyticsReport(input({ current: { start: '2026-09-08', end: '2026-10-05' } }));
    assert.match(d.gsc?.coverageNote ?? '', /hasta el/);
    assert.equal(data.gsc?.coverageNote, null);
  });

  test('las prioridades empiezan por la página con tráfico que responde error', () => {
    assert.equal(data.priorities[0]?.title, 'Corregir /catalogo-2025');
    assert.equal(data.priorities[0]?.severity, 'critical');
  });

  test('una caída de clics mayor al umbral entra como prioridad', () => {
    assert.ok(data.priorities.some((p) => p.title.startsWith('Investigar la caída')));
  });

  test('una página lenta con tráfico se propone acelerar', () => {
    assert.ok(data.priorities.some((p) => p.title === 'Acelerar /pisos-gimnasio'));
  });

  test('las páginas de las dos fuentes se juntan por ruta', () => {
    const paginas = mergedPages(data);
    assert.ok(paginas.some((p) => p.path === '/pisos-gimnasio' && p.sessions === 1204));
    assert.equal(new Set(paginas.map((p) => p.path)).size, paginas.length);
  });

  test('la conclusión dice la caída, la consulta principal y el peso del celular', () => {
    const v = analyticsVerdict(data);
    assert.match(v, /bajaron/);
    assert.match(v, /tapete de hule/);
    assert.match(v, /celular/);
  });

  test('sin eventos clave definidos lo dice, en vez de reportar cero conversiones', () => {
    const base = input();
    const d = buildAnalyticsReport(input({ ga: { ...base.ga!, keyEventsDefined: [], keyEvents: [], totals: { ...base.ga!.totals!, keyEvents: 0 } } }));
    assert.match(analyticsVerdict(d), /no tiene eventos clave/);
  });
});

describe('gráficas', () => {
  test('las marcas del eje son redondas y cubren el máximo', () => {
    const t = niceTicks(327);
    assert.deepEqual(t, [0, 200, 400]);
  });

  test('sin datos dibuja un aviso y no un eje vacío', () => {
    assert.match(lineChartSvg({ current: [null, null], previous: [], first: 'a', last: 'b' }), /Sin datos/);
  });
});

describe('Sections', () => {
  test('numera en el orden en que se piden', () => {
    const s = new Sections();
    assert.match(s.sec('Uno'), /<span class="n">1<\/span>/);
    assert.match(s.sec('Dos', 'nota'), /<span class="n">2<\/span>.*nota/);
  });
});

function lighthouseData(strategy: 'desktop' | 'mobile'): ReportData {
  return {
    consultant,
    site: { name: 'MatMarkt', url: 'https://www.matmarkt.mx' },
    strategy,
    runId: 12,
    runAt: new Date('2026-10-07T12:00:00Z'),
    folio: '20261007-012',
    lighthouseVersion: '13.5.0',
    scores: { performance: strategy === 'mobile' ? 71 : 94, accessibility: 92, bestPractices: 100, seo: 100 },
    metrics: { lcpMs: 3100, clsValue: 0.02, tbtMs: 180, fcpMs: 1500, speedIndexMs: 2800, ttiMs: 3500 },
    opportunities: [],
    findings: [],
    priorities: [{ title: 'Reduce el JavaScript sin usar', detail: 'x', impact: '−430 ms', severity: 'warning' }],
    comparisons: [],
    pages: [{ path: '/', isHome: true, httpStatus: 200, ttfbMs: 200, loadMs: 1800, transferBytes: 900_000, requestCount: 40, ok: true }],
    pagesDiscovered: 10,
    pagesAudited: 1,
    cert: null,
  };
}

describe('plantillas', () => {
  test('el informe de tráfico lleva el mismo membrete que los de Lighthouse', async () => {
    const trafico = await renderAnalyticsHtml(buildAnalyticsReport(input()));
    const lh = await renderReportHtml(lighthouseData('mobile'));
    for (const html of [trafico, lh]) {
      assert.match(html, /José Alfredo Gutiérrez Guerra/);
      assert.match(html, /class="sheet cover"/);
      assert.match(html, /class="brand"/);
    }
    assert.match(trafico, /Informe de búsqueda y tráfico/);
    assert.match(trafico, /septiembre de 2026/);
  });

  test('el texto del sitio se escapa', async () => {
    const base = input();
    const html = await renderAnalyticsHtml(buildAnalyticsReport(input({
      gsc: { ...base.gsc!, queries: [{ key: '<script>alert(1)</script>', clicks: 3, impressions: 9, position: 2 }] },
    })));
    assert.ok(!html.includes('<script>alert(1)</script>'));
  });

  test('sin GA4 el informe sale solo con Search Console', async () => {
    const html = await renderAnalyticsHtml(buildAnalyticsReport(input({ ga: null })));
    assert.ok(!html.includes('Google Analytics 4 · propiedad'));
    assert.match(html, /Consultas principales/);
  });

  test('el integral numera las secciones corridas de principio a fin', async () => {
    const html = await renderIntegralHtml({
      desktop: lighthouseData('desktop'),
      mobile: lighthouseData('mobile'),
      traffic: buildAnalyticsReport(input()),
    });
    const numeros = [...html.matchAll(/<span class="n">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    assert.deepEqual(numeros, numeros.map((_, i) => i + 1));
    assert.match(html, /Informe integral/);
    assert.match(html, /Diagnóstico · Móvil/);
    assert.match(html, /Diagnóstico · Escritorio/);
  });

  test('las prioridades del integral ponen primero lo que pierde visitas y no repiten', () => {
    const p = integralPriorities({
      desktop: lighthouseData('desktop'),
      mobile: lighthouseData('mobile'),
      traffic: buildAnalyticsReport(input()),
    });
    assert.equal(p[0]?.title, 'Corregir /catalogo-2025');
    assert.equal(p.filter((x) => x.title === 'Reduce el JavaScript sin usar').length, 1);
    assert.ok(p.length <= 5);
  });
});
