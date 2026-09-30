import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { opportunities, findings, stripMarkdown, firstSentences, type Lhr } from './extract.js';
import { derivePriorities } from './build.js';
import { rate, rateScore, THRESHOLDS } from './model.js';
import { folio, ms, bytes, cls, esc } from './format.js';

describe('opportunities', () => {
  test('descarta las auditorías que el sitio ya aprueba', () => {
    // Lighthouse marca server-response-time como "oportunidad" y le pone un
    // ahorro estimado aunque el servidor haya respondido rápido (score 1).
    // Sin este filtro, el informe pedía corregir algo que estaba bien.
    const lhr: Lhr = {
      audits: {
        'server-response-time': {
          title: 'El tiempo de respuesta inicial del servidor fue breve',
          score: 1,
          details: { type: 'opportunity', overallSavingsMs: 62 },
        },
        'unused-javascript': {
          title: 'Reduce el código JavaScript sin usar',
          score: 0.5,
          details: { type: 'opportunity', overallSavingsMs: 430, overallSavingsBytes: 162000 },
        },
      },
    };
    const out = opportunities(lhr);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.title, 'Reduce el código JavaScript sin usar');
  });

  test('ordena de mayor a menor ahorro', () => {
    const lhr: Lhr = {
      audits: {
        a: { title: 'chica', score: 0, details: { type: 'opportunity', overallSavingsMs: 100 } },
        b: { title: 'grande', score: 0, details: { type: 'opportunity', overallSavingsMs: 900 } },
      },
    };
    assert.deepEqual(opportunities(lhr).map((o) => o.title), ['grande', 'chica']);
  });

  test('ignora ahorros insignificantes', () => {
    const lhr: Lhr = {
      audits: { a: { title: 'x', score: 0, details: { type: 'opportunity', overallSavingsMs: 10 } } },
    };
    assert.deepEqual(opportunities(lhr), []);
  });

  test('ignora auditorías que no son de tipo oportunidad', () => {
    const lhr: Lhr = { audits: { a: { title: 'x', score: 0, numericValue: 5000 } } };
    assert.deepEqual(opportunities(lhr), []);
  });
});

describe('findings', () => {
  const lhr: Lhr = {
    categories: {
      accessibility: { auditRefs: [{ id: 'contraste' }, { id: 'pasa' }] },
      seo: { auditRefs: [{ id: 'meta' }] },
    },
    audits: {
      contraste: { title: 'Contraste insuficiente', description: 'Explicación.', score: 0, scoreDisplayMode: 'binary' },
      pasa: { title: 'Todo bien', score: 1, scoreDisplayMode: 'binary' },
      meta: { title: 'Falta descripción', description: 'Otra.', score: 0, scoreDisplayMode: 'binary' },
      informativa: { title: 'Solo informa', score: null, scoreDisplayMode: 'informative' },
    },
  };

  test('solo trae las no aprobadas, con su categoría', () => {
    const out = findings(lhr);
    assert.deepEqual(out.map((f) => f.category), ['accessibility', 'seo']);
    assert.equal(out[0]?.title, 'Contraste insuficiente');
  });

  test('las informativas y las que no aplican no son hallazgos', () => {
    assert.equal(findings(lhr).some((f) => f.title === 'Solo informa'), false);
  });

  test('accesibilidad va antes que SEO: se corrige antes lo que excluye gente', () => {
    assert.equal(findings(lhr)[0]?.category, 'accessibility');
  });
});

describe('stripMarkdown', () => {
  test('deja el texto del enlace y tira la URL', () => {
    assert.equal(
      stripMarkdown('Obtén más información sobre [el contraste](https://web.dev/contrast).'),
      'Obtén más información sobre el contraste.',
    );
  });

  test('quita las comillas de código', () => {
    assert.equal(stripMarkdown('Usa `<main>` aquí'), 'Usa <main> aquí');
  });
});

describe('firstSentences', () => {
  test('deja intacto lo que ya es corto', () => {
    assert.equal(firstSentences('Corto.'), 'Corto.');
  });

  test('corta en el punto y no a media palabra', () => {
    const largo = `${'a'.repeat(100)}. ${'b'.repeat(300)}`;
    const out = firstSentences(largo);
    assert.ok(out.endsWith('.'), 'debe terminar en punto');
    assert.ok(out.length < largo.length);
  });
});

describe('derivePriorities', () => {
  test('lo que tiene ahorro medido va antes que lo que no', () => {
    const out = derivePriorities(
      [{ title: 'JS sin usar', savingsMs: 800, savingsBytes: 160000 }],
      [{ title: 'Contraste', description: 'x', category: 'accessibility' }],
    );
    assert.equal(out[0]?.title, 'JS sin usar');
    assert.equal(out[1]?.title, 'Contraste');
  });

  test('un ahorro grande es crítico; uno chico, mejorable', () => {
    const grande = derivePriorities([{ title: 'a', savingsMs: 800, savingsBytes: 0 }], []);
    const chico = derivePriorities([{ title: 'b', savingsMs: 120, savingsBytes: 0 }], []);
    assert.equal(grande[0]?.severity, 'critical');
    assert.equal(chico[0]?.severity, 'warning');
  });

  test('nunca más de cuatro: una lista de prioridades de diez no prioriza nada', () => {
    const muchas = Array.from({ length: 9 }, (_, i) => ({ title: `o${i}`, savingsMs: 900 - i, savingsBytes: 0 }));
    const hallazgos = Array.from({ length: 9 }, (_, i) => ({ title: `h${i}`, description: 'x', category: 'accessibility' as const }));
    assert.ok(derivePriorities(muchas, hallazgos).length <= 4);
  });

  test('sin nada que reportar devuelve lista vacía, no un relleno', () => {
    assert.deepEqual(derivePriorities([], []), []);
  });
});

describe('umbrales', () => {
  test('LCP se clasifica por los cortes oficiales de Core Web Vitals', () => {
    assert.equal(rate(2000, THRESHOLDS.lcpMs), 'good');
    assert.equal(rate(3000, THRESHOLDS.lcpMs), 'warning');
    assert.equal(rate(5000, THRESHOLDS.lcpMs), 'bad');
    assert.equal(rate(null, THRESHOLDS.lcpMs), 'none');
  });

  test('en los scores más es mejor', () => {
    assert.equal(rateScore(95), 'good');
    assert.equal(rateScore(60), 'warning');
    assert.equal(rateScore(20), 'bad');
  });
});

describe('formato', () => {
  test('milisegundos pasan a segundos al rebasar el segundo', () => {
    assert.equal(ms(430), '430 ms');
    assert.equal(ms(6753), '6.75 s');
    assert.equal(ms(null), '—');
  });

  test('CLS conserva tres decimales: redondearlo a entero lo destruiría', () => {
    assert.equal(cls(0.0412), '0.041');
    assert.equal(cls(0), '0.000');
  });

  test('bytes en unidades legibles', () => {
    assert.equal(bytes(500), '500 B');
    assert.equal(bytes(162000), '158 kB');
  });

  test('el folio lleva fecha y número de corrida', () => {
    assert.equal(folio(new Date('2026-09-29T21:00:00Z'), 19), '20260929-019');
  });

  test('escapa el HTML que venga del sitio auditado', () => {
    assert.equal(esc('<script>"x"&</script>'), '&lt;script&gt;&quot;x&quot;&amp;&lt;/script&gt;');
  });
});
