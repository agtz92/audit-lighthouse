import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diff, strategyDelta, computeSiteDeltas, evaluateFlags, type SiteSnapshot, type StrategySnapshot } from './deltas.js';

const UMBRALES = { perfDropThreshold: 10, certWarnDays: 21 };

function snap(performance: number | null, lcpMs: number | null = null, cls: number | null = null): StrategySnapshot {
  return {
    scores: { performance, accessibility: null, bestPractices: null, seo: null },
    metrics: { lcpMs, cls },
  };
}

function site(over: Partial<SiteSnapshot> = {}): SiteSnapshot {
  return {
    status: 'ok',
    homeHttpStatus: 200,
    certDaysRemaining: 60,
    desktop: null,
    mobile: null,
    ...over,
  };
}

describe('diff', () => {
  test('resta actual menos anterior', () => {
    assert.equal(diff(90, 75), 15);
    assert.equal(diff(60, 88), -28);
    assert.equal(diff(50, 50), 0);
  });

  test('sin valor anterior no hay delta: un sitio nuevo no mejoró desde cero', () => {
    assert.equal(diff(90, null), null);
    assert.equal(diff(null, 90), null);
    assert.equal(diff(null, null), null);
  });

  test('un cero anterior es un dato real, no ausencia de dato', () => {
    assert.equal(diff(30, 0), 30);
    assert.equal(diff(0, 30), -30);
  });

  test('no arrastra basura de punto flotante con CLS', () => {
    // 0.31 - 0.1 en binario da 0.20999999999999999
    assert.equal(diff(0.31, 0.1), 0.21);
  });
});

describe('strategyDelta', () => {
  test('calcula scores y métricas juntas', () => {
    const d = strategyDelta(snap(80, 2500, 0.2), snap(65, 1800, 0.05));
    assert.equal(d.performance, 15);
    assert.equal(d.lcpMs, 700);
    assert.equal(d.cls, 0.15);
  });

  test('todo null si falta la corrida anterior', () => {
    const d = strategyDelta(snap(80, 2500), null);
    assert.deepEqual(Object.values(d), [null, null, null, null, null, null]);
  });
});

describe('computeSiteDeltas', () => {
  test('desktop y mobile se comparan por separado', () => {
    const actual = site({ desktop: snap(90), mobile: snap(40) });
    const anterior = site({ desktop: snap(85), mobile: snap(55) });
    const d = computeSiteDeltas(actual, anterior);
    assert.equal(d.desktop.performance, 5);
    assert.equal(d.mobile.performance, -15);
  });
});

describe('evaluateFlags: isDown', () => {
  test('un sitio failed está caído', () => {
    assert.equal(evaluateFlags(site({ status: 'failed' }), computeSiteDeltas(site(), null), UMBRALES).isDown, true);
  });

  test('un 503 está caído aunque el estado diga otra cosa', () => {
    // El caso de rollospvc.
    const s = site({ status: 'ok', homeHttpStatus: 503 });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).isDown, true);
  });

  test('un 409 también cuenta como caído', () => {
    // El caso de kawaiimx.
    const s = site({ homeHttpStatus: 409 });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).isDown, true);
  });

  test('sin status HTTP está caído: no se pudo medir', () => {
    const s = site({ homeHttpStatus: null });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).isDown, true);
  });

  test('un 200 y un 301 no están caídos', () => {
    for (const st of [200, 204, 301, 302]) {
      const s = site({ homeHttpStatus: st });
      assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).isDown, false, String(st));
    }
  });

  test('partial no es caído: respondió y dejó datos', () => {
    const s = site({ status: 'partial' });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).isDown, false);
  });
});

describe('evaluateFlags: performanceDropped', () => {
  const conCaida = (de: number, a: number) => {
    const actual = site({ desktop: snap(a) });
    const anterior = site({ desktop: snap(de) });
    return evaluateFlags(actual, computeSiteDeltas(actual, anterior), UMBRALES).performanceDropped;
  };

  test('una caída de más de 10 puntos dispara', () => {
    assert.equal(conCaida(90, 79), true);
    assert.equal(conCaida(90, 50), true);
  });

  test('exactamente 10 puntos NO dispara: Lighthouse varía solo por ruido', () => {
    assert.equal(conCaida(90, 80), false);
  });

  test('una caída menor no dispara', () => {
    assert.equal(conCaida(90, 85), false);
    assert.equal(conCaida(90, 90), false);
  });

  test('una mejora nunca dispara', () => {
    assert.equal(conCaida(50, 95), false);
  });

  test('basta que caiga una de las dos estrategias', () => {
    const actual = site({ desktop: snap(95), mobile: snap(30) });
    const anterior = site({ desktop: snap(94), mobile: snap(60) });
    assert.equal(evaluateFlags(actual, computeSiteDeltas(actual, anterior), UMBRALES).performanceDropped, true);
  });

  test('sin corrida anterior no dispara', () => {
    const actual = site({ desktop: snap(20) });
    assert.equal(evaluateFlags(actual, computeSiteDeltas(actual, null), UMBRALES).performanceDropped, false);
  });

  test('respeta un umbral distinto', () => {
    const actual = site({ desktop: snap(95) });
    const anterior = site({ desktop: snap(98) });
    const d = computeSiteDeltas(actual, anterior);
    assert.equal(evaluateFlags(actual, d, { ...UMBRALES, perfDropThreshold: 2 }).performanceDropped, true);
    assert.equal(evaluateFlags(actual, d, { ...UMBRALES, perfDropThreshold: 3 }).performanceDropped, false);
  });
});

describe('evaluateFlags: certExpiringSoon', () => {
  test('menos de 21 días dispara', () => {
    for (const dias of [20, 5, 0, -3]) {
      const s = site({ certDaysRemaining: dias });
      assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).certExpiringSoon, true, String(dias));
    }
  });

  test('21 días exactos no dispara', () => {
    const s = site({ certDaysRemaining: 21 });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).certExpiringSoon, false);
  });

  test('sin dato de certificado no se inventa una alerta', () => {
    const s = site({ certDaysRemaining: null });
    assert.equal(evaluateFlags(s, computeSiteDeltas(s, null), UMBRALES).certExpiringSoon, false);
  });
});
