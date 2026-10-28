import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildAdsReport, kpisOf, adsLabel, adsVerdict, type BuildAdsInput, type AdsPeriodInput, type AdsDayTotals } from './ads-model.js';
import type { AdsKeywordRow, AdsSearchTermRow, AdsAdRow, AdsCampaignRow } from '../google/ads.js';
import { eachDay } from '../analytics/periods.js';

const M = (cost: number, conversions: number, clicks = 100, impressions = 1000) => ({ impressions, clicks, cost, conversions, conversionsValue: 0 });

const campana = (over: Partial<AdsCampaignRow> = {}): AdsCampaignRow => ({
  id: '1503969492', name: 'Cortinas Hawaianas', status: 'ENABLED', channel: 'SEARCH', bidding: 'TARGET_SPEND',
  dailyBudget: 1200, allConversions: 156, impressionShare: 0.558, rankLostShare: 0.265, budgetLostShare: 0.177,
  ...M(35248.76, 156, 1963, 17503), ...over,
});

const kw = (text: string, cost: number, conversions: number, qs: number | null, lp = 'BELOW_AVERAGE'): AdsKeywordRow => ({
  criterionId: text, text, matchType: 'PHRASE', status: 'ENABLED', adGroupId: '1', adGroup: 'G', campaignId: '1503969492',
  qualityScore: qs, adRelevance: 'ABOVE_AVERAGE', landingPage: lp, expectedCtr: 'BELOW_AVERAGE', ...M(cost, conversions),
});

const termino = (term: string, cost: number, conversions: number, status = 'NONE'): AdsSearchTermRow => ({
  term, matchType: 'EXACT', status, ...M(cost, conversions),
});

const anuncio = (adId: string, approval: string, strength = 'GOOD'): AdsAdRow => ({
  adId, adGroupId: '1', adGroup: 'Rollos de PVC', campaignId: '1', type: 'RESPONSIVE_SEARCH_AD', status: 'ENABLED',
  approval, strength, headlines: [], descriptions: [], finalUrl: null, ...M(0, 0, 0, 0),
});

function periodo(over: Partial<AdsPeriodInput> = {}): AdsPeriodInput {
  return {
    totals: M(35248.76, 156, 1963, 17503), campaigns: [campana()], conversionActions: [], adGroups: [], keywords: [],
    searchTerms: [], ads: [], assetGroups: [], pmaxTerms: [], audiences: [], devices: [], landing: [], geo: [],
    gender: [], age: [], schedule: null, ...over,
  };
}

/** Un día con gasto en todo el rango, salvo los que se indiquen. */
function dias(start: string, end: string, cost = 1100, sinGasto: string[] = []): AdsDayTotals[] {
  return eachDay({ start, end }).map((date) => ({ date, ...M(sinGasto.includes(date) ? 0 : cost, 5) }));
}

function entrada(over: Partial<BuildAdsInput> = {}): BuildAdsInput {
  return {
    consultant: { name: 'C', role: 'R', credentials: 'X' },
    site: { name: 'Cort HW', url: 'https://www.corthw.com' },
    generatedAt: new Date('2026-10-14T12:00:00Z'),
    folio: '20261014-001',
    customerId: '2248451770',
    currency: 'MXN',
    mode: '28d',
    current: { start: '2026-09-16', end: '2026-10-13' },
    previous: { start: '2026-08-19', end: '2026-09-15' },
    latestDate: '2026-10-13',
    days: dias('2026-08-19', '2026-10-13'),
    now: periodo(),
    before: periodo({ totals: M(35588, 159, 2000, 18000), campaigns: [campana({ ...M(35588, 159, 2000, 18000) })] }),
    health: new Map(),
    ...over,
  };
}

describe('métricas derivadas', () => {
  test('CPA, CTR y tasa de conversión; null si no hay denominador', () => {
    const k = kpisOf(M(35248.76, 156, 1963, 17503));
    assert.equal(Math.round((k.cpa ?? 0) * 100) / 100, 225.95);
    assert.equal(Math.round((k.ctr ?? 0) * 10_000) / 100, 11.22);
    assert.equal(kpisOf(M(10, 0)).cpa, null);
    assert.equal(kpisOf(M(10, 1)).roas, null, 'sin valor de conversión no hay ROAS');
  });

  test('etiquetas en español, edad incluida', () => {
    assert.equal(adsLabel('MOBILE'), 'Móvil');
    assert.equal(adsLabel('AGE_RANGE_25_34'), '25–34');
    assert.equal(adsLabel('AGE_RANGE_65_UP'), '65+');
    assert.equal(adsLabel('ALGO_NUEVO'), 'ALGO_NUEVO');
  });
});

describe('buildAdsReport', () => {
  test('la semana compara los últimos 7 días contra los 7 previos', () => {
    const d = buildAdsReport(entrada({ days: dias('2026-08-19', '2026-10-13', 1000, ['2026-10-01']) }));
    assert.deepEqual(d.week.range, { start: '2026-10-07', end: '2026-10-13' });
    assert.equal(d.week.current.cost, 7000);
    assert.equal(d.week.previous.cost, 6000, 'el 1 de octubre sin gasto cae en la semana previa');
  });

  test('uso del presupuesto: gasto diario promedio contra el diario', () => {
    const d = buildAdsReport(entrada());
    const uso = d.campaigns[0]?.budgetUse ?? 0;
    // 35,248.76 / 28 días / 1,200 ≈ 1.05
    assert.ok(uso > 1.04 && uso < 1.06, String(uso));
  });

  test('las campañas eliminadas sin actividad no salen; una activa sin impresiones sí', () => {
    const d = buildAdsReport(entrada({ now: periodo({ campaigns: [
      campana(),
      campana({ id: '2', name: 'Vieja', status: 'REMOVED', ...M(0, 0, 0, 0) }),
      campana({ id: '3', name: 'Sin entrega', status: 'ENABLED', ...M(0, 0, 0, 0) }),
    ] }) }));
    assert.deepEqual(d.campaigns.map((c) => c.name), ['Cortinas Hawaianas', 'Sin entrega']);
  });

  test('un día sin fila dentro del periodo es cero, no hueco', () => {
    const d = buildAdsReport(entrada({ days: dias('2026-08-19', '2026-10-13', 1000).filter((x) => x.date !== '2026-10-05') }));
    const i = eachDay(d.period.current).indexOf('2026-10-05');
    assert.equal(d.dailyCost[i], 0);
  });

  test('landing pages se cruzan con la auditoría por ruta', () => {
    const d = buildAdsReport(entrada({
      now: periodo({ landing: [{ key: 'https://www.corthw.com/productos/ch-armada', ...M(1123.08, 0) }] }),
      health: new Map([['/productos/ch-armada', { httpStatus: 404, loadMs: 300, ok: false }]]),
    }));
    assert.equal(d.landing[0]?.path, '/productos/ch-armada');
    assert.equal(d.landing[0]?.health?.httpStatus, 404);
  });
});

describe('alertas', () => {
  const titulos = (over: Partial<BuildAdsInput>): string[] => buildAdsReport(entrada(over)).alerts.map((a) => a.title);

  test('keywords que gastan más de 1.5× el CPA sin convertir', () => {
    const t = titulos({ now: periodo({ keywords: [kw('Cortina PVC', 565.29, 0, 3), kw('PVC Transparente', 7924.84, 21, 3), kw('tira', 100, 0, 3)] }) });
    assert.ok(t.includes('Keywords que gastan sin convertir'));
    const a = buildAdsReport(entrada({ now: periodo({ keywords: [kw('Cortina PVC', 565.29, 0, 3), kw('tira', 100, 0, 3)] }) }))
      .alerts.find((x) => x.title === 'Keywords que gastan sin convertir');
    assert.match(a?.detail ?? '', /Cortina PVC/);
    assert.doesNotMatch(a?.detail ?? '', /tira/, '100 pesos no llega a 1.5 veces el CPA de 225.95');
  });

  test('QS bajo es crítico cuando concentra una cuarta parte del gasto', () => {
    const a = buildAdsReport(entrada({ now: periodo({ keywords: [kw('PVC Transparente', 7924.84, 21, 3), kw('cortinas pvc', 4216.2, 10, 3)] }) }))
      .alerts.find((x) => /Quality Score/.test(x.title));
    assert.equal(a?.severity, 'critical');
    assert.match(a?.detail ?? '', /página de destino/);
  });

  test('anuncio rechazado es crítico; fuerza deficiente es aviso', () => {
    const al = buildAdsReport(entrada({ now: periodo({ ads: [anuncio('1', 'DISAPPROVED'), anuncio('2', 'APPROVED', 'POOR')] }) })).alerts;
    assert.equal(al.find((a) => /rechazado/.test(a.title))?.severity, 'critical');
    assert.equal(al.find((a) => /deficiente/.test(a.title))?.severity, 'warning');
  });

  test('una landing pagada que responde 404 es crítica', () => {
    const al = buildAdsReport(entrada({
      now: periodo({ landing: [{ key: 'https://www.corthw.com/productos/ch-armada', ...M(1123.08, 0) }] }),
      health: new Map([['/productos/ch-armada', { httpStatus: 404, loadMs: 300, ok: false }]]),
    })).alerts;
    assert.equal(al[0]?.title, 'Corregir /productos/ch-armada');
  });

  test('presupuesto: 17.7% perdido por presupuesto avisa', () => {
    assert.ok(titulos({}).includes('«Cortinas Hawaianas» se queda sin presupuesto'));
  });

  test('medición: muchos clics y cero conversiones', () => {
    const t = titulos({ now: periodo({ campaigns: [campana({ ...M(5000, 0, 300, 3000) })] }) });
    assert.ok(t.includes('Revisar la medición de «Cortinas Hawaianas»'));
  });

  test('la cuenta dejó de gastar los dos últimos días', () => {
    const t = titulos({ days: dias('2026-08-19', '2026-10-13', 1000, ['2026-10-12', '2026-10-13']) });
    assert.ok(t.includes('La cuenta dejó de gastar'));
  });

  test('el CPA que sube 30% es crítico; sin volumen previo no se compara', () => {
    const sube = buildAdsReport(entrada({ before: periodo({ totals: M(20000, 156) }) })).alerts.find((a) => a.title === 'El costo por conversión subió');
    assert.equal(sube?.severity, 'critical');
    const poco = titulos({ before: periodo({ totals: M(20000, 5) }) });
    assert.ok(!poco.includes('El costo por conversión subió'));
  });

  test('términos sin convertir que no son keyword ni negativa', () => {
    const al = buildAdsReport(entrada({ now: periodo({ searchTerms: [termino('pvc transparente', 697.35, 0), termino('cortinas hawaianas', 752.27, 7), termino('pvc', 300, 0, 'EXCLUDED')] }) }))
      .alerts.find((a) => a.title === 'Términos de búsqueda candidatos a negativa');
    assert.match(al?.detail ?? '', /pvc transparente/);
    assert.doesNotMatch(al?.detail ?? '', /«pvc»/, 'ya es negativa');
  });

  test('dispositivo con CPA 40% arriba del mejor', () => {
    const t = titulos({ now: periodo({ devices: [{ key: 'MOBILE', ...M(27912.84, 115) }, { key: 'DESKTOP', ...M(7301.49, 41) }] }) });
    assert.ok(!t.includes('Móvil: conversiones más caras'), 'CPA 242.7 contra 178.1 es 1.36×, debajo del umbral');
    const t2 = titulos({ now: periodo({ devices: [{ key: 'MOBILE', ...M(27912.84, 100) }, { key: 'DESKTOP', ...M(7301.49, 41) }] }) });
    assert.ok(t2.includes('Móvil: conversiones más caras'));
  });

  test('las críticas van primero', () => {
    const al = buildAdsReport(entrada({ now: periodo({ ads: [anuncio('2', 'APPROVED', 'POOR'), anuncio('1', 'DISAPPROVED')] }) })).alerts;
    const primeraAviso = al.findIndex((a) => a.severity === 'warning');
    assert.ok(al.slice(primeraAviso).every((a) => a.severity === 'warning'));
  });
});

test('la conclusión con reglas dice gasto, conversiones y cambio', () => {
  const v = adsVerdict(buildAdsReport(entrada()));
  assert.match(v, /35,248\.76/);
  assert.match(v, /156 conversiones/);
  assert.match(v, /bajaron 2%/);
});
