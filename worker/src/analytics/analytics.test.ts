import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isoToday, addDays, daysInclusive, syncWindow, periodRanges, reportPeriods, eachDay,
} from './periods.js';
import { selectAnalyticsSites, siteStatus, analyticsFlags, type AnalyticsSiteResult } from './sync.js';
import { parseTestRequest } from './control.js';
import { parseSitesConfig } from '../config/sites.js';
import { pathKey } from '../db/analytics.js';

describe('fechas', () => {
  test('hoy es el día de Ciudad de México, no el de UTC', () => {
    // 03:00 UTC del 8 de octubre son las 21:00 del 7 en CDMX.
    assert.equal(isoToday('America/Mexico_City', new Date('2026-10-08T03:00:00Z')), '2026-10-07');
  });

  test('sumar días cruza meses y años', () => {
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  });

  test('cuenta los dos extremos', () => {
    assert.equal(daysInclusive('2026-09-08', '2026-10-05'), 28);
  });
});

describe('syncWindow', () => {
  const base = { today: '2026-10-07', refreshDays: 5, backfillDays: 486 };

  test('la primera vez carga 16 meses hacia atrás y termina ayer', () => {
    const w = syncWindow({ ...base, maxStored: null });
    assert.equal(w.backfill, true);
    assert.equal(w.end, '2026-10-06');
    assert.equal(w.start, addDays('2026-10-07', -486));
  });

  test('con datos al día vuelve a pedir los últimos días, que Google sigue ajustando', () => {
    const w = syncWindow({ ...base, maxStored: '2026-10-04' });
    assert.equal(w.start, '2026-10-02');
    assert.equal(w.end, '2026-10-06');
  });

  test('si el servicio estuvo apagado, rellena el hueco completo', () => {
    const w = syncWindow({ ...base, maxStored: '2026-09-10' });
    assert.equal(w.start, '2026-09-11');
  });

  test('nunca pide un rango al revés', () => {
    const w = syncWindow({ ...base, maxStored: '2026-10-06', refreshDays: 0 });
    assert.ok(w.start <= w.end);
  });
});

describe('periodRanges', () => {
  test('los 28 días se anclan en el último día publicado, no en ayer', () => {
    const r = periodRanges('2026-10-07', '2026-10-04');
    assert.deepEqual(r.last28, { start: '2026-09-07', end: '2026-10-04' });
    assert.deepEqual(r.prev28, { start: '2026-08-10', end: '2026-09-06' });
    assert.equal(daysInclusive(r.last28.start, r.last28.end), 28);
    assert.equal(daysInclusive(r.prev28.start, r.prev28.end), 28);
  });

  test('el mes es el último calendario completo y el anterior a ese', () => {
    const r = periodRanges('2026-10-07', '2026-10-04');
    assert.deepEqual(r.month, { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(r.prev_month, { start: '2026-08-01', end: '2026-08-31' });
  });

  test('en enero, el mes anterior es diciembre del año pasado', () => {
    const r = periodRanges('2027-01-03', '2026-12-31');
    assert.deepEqual(r.month, { start: '2026-12-01', end: '2026-12-31' });
    assert.deepEqual(r.prev_month, { start: '2026-11-01', end: '2026-11-30' });
  });

  test('febrero bisiesto termina el 29', () => {
    assert.equal(periodRanges('2028-03-10', '2028-03-07').month.end, '2028-02-29');
  });

  test('REPORT_PERIOD elige el par de periodos', () => {
    assert.deepEqual(reportPeriods('month'), { current: 'month', previous: 'prev_month' });
    assert.deepEqual(reportPeriods('28d'), { current: 'last28', previous: 'prev28' });
  });

  test('eachDay incluye los dos extremos', () => {
    assert.deepEqual(eachDay({ start: '2026-09-29', end: '2026-10-02' }), ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
  });
});

describe('google en sites.yaml', () => {
  test('acepta el id de GA4 sin comillas y lo guarda como texto', () => {
    const [s] = parseSitesConfig(`
sites:
  - id: uno
    name: Uno
    url: https://uno.example
    google:
      searchConsole: sc-domain:uno.example
      ga4Property: 345678901
`);
    assert.equal(s?.google.ga4Property, '345678901');
    assert.equal(s?.google.searchConsole, 'sc-domain:uno.example');
  });

  test('sin bloque google, las dos fuentes quedan en null', () => {
    const [s] = parseSitesConfig('sites:\n  - id: uno\n    name: Uno\n    url: https://uno.example\n');
    assert.deepEqual(s?.google, { searchConsole: null, ga4Property: null });
  });

  test('rechaza el ID de medición G-XXXX con un mensaje que dice qué poner', () => {
    assert.throws(
      () => parseSitesConfig('sites:\n  - id: uno\n    name: Uno\n    url: https://uno.example\n    google:\n      ga4Property: G-ABC123\n'),
      /id numérico de la propiedad/,
    );
  });

  test('una propiedad de prefijo de URL necesita su diagonal final', () => {
    assert.throws(
      () => parseSitesConfig('sites:\n  - id: uno\n    name: Uno\n    url: https://uno.example\n    google:\n      searchConsole: https://uno.example\n'),
      /terminada en \//,
    );
  });

  test('una llave mal escrita dentro de google falla en lugar de ignorarse', () => {
    assert.throws(() => parseSitesConfig('sites:\n  - id: uno\n    name: Uno\n    url: https://uno.example\n    google:\n      ga4: "345678901"\n'));
  });
});

describe('selectAnalyticsSites', () => {
  const sites = parseSitesConfig(`
sites:
  - id: conectado
    name: A
    url: https://a.example
    google: { searchConsole: "sc-domain:a.example" }
  - id: pausado
    name: B
    url: https://b.example
    enabled: false
    google: { ga4Property: "123456789" }
  - id: sin-google
    name: C
    url: https://c.example
`);

  test('la corrida programada toma los conectados y habilitados', () => {
    assert.deepEqual(selectAnalyticsSites(sites, undefined).map((s) => s.id), ['conectado']);
  });

  test('a mano se puede sincronizar uno en pausa', () => {
    assert.deepEqual(selectAnalyticsSites(sites, 'pausado').map((s) => s.id), ['pausado']);
  });

  test('un sitio sin Google no se sincroniza aunque se pida', () => {
    assert.deepEqual(selectAnalyticsSites(sites, 'sin-google'), []);
  });
});

describe('siteStatus', () => {
  test('las fuentes no conectadas no cuentan', () => {
    assert.equal(siteStatus('ok', 'off'), 'ok');
    assert.equal(siteStatus('off', 'error'), 'failed');
  });
  test('una de dos es parcial', () => {
    assert.equal(siteStatus('ok', 'error'), 'partial');
  });
});

describe('analyticsFlags', () => {
  const base = (cambios: Partial<AnalyticsSiteResult['gsc']>, ga: Partial<AnalyticsSiteResult['ga']> = {}): AnalyticsSiteResult => ({
    siteId: 'x', siteRunId: 1, status: 'ok',
    gsc: { property: 'sc-domain:x', status: 'ok', error: null, rows: 1, latestDate: null, kind: null, clicks: 100, previousClicks: 100, ...cambios },
    ga: { property: null, status: 'off', error: null, rows: 0, latestDate: null, kind: null, sessions: null, previousSessions: null, ...ga },
  });

  test('una caída igual al umbral dispara la bandera', () => {
    assert.equal(analyticsFlags(base({ clicks: 80, previousClicks: 100 }), 20).trafficDropped, true);
    assert.equal(analyticsFlags(base({ clicks: 81, previousClicks: 100 }), 20).trafficDropped, false);
  });

  test('perder el permiso avisa; una cuota agotada no, porque se arregla sola', () => {
    assert.equal(analyticsFlags(base({}, { status: 'error', kind: 'permission' }), 20).accessLost, true);
    assert.equal(analyticsFlags(base({}, { status: 'error', kind: 'quota' }), 20).accessLost, false);
  });
});

describe('parseTestRequest', () => {
  test('toma los dos campos y descarta vacíos', () => {
    assert.deepEqual(parseTestRequest('{"searchConsole":" sc-domain:a.mx ","ga4Property":""}'), {
      ok: true, searchConsole: 'sc-domain:a.mx', ga4Property: null,
    });
  });
  test('solo texto: un objeto no llega a la URL de Google', () => {
    assert.deepEqual(parseTestRequest('{"ga4Property":{"x":1}}'), { ok: true, searchConsole: null, ga4Property: null });
  });
  test('JSON roto es un error, no una prueba vacía', () => {
    assert.equal(parseTestRequest('{').ok, false);
  });
});

describe('pathKey', () => {
  test('la URL de Search Console y la ruta de GA4 dan la misma llave', () => {
    assert.equal(pathKey('https://www.matmarkt.mx/tapetes/'), pathKey('/tapetes'));
    assert.equal(pathKey('https://www.matmarkt.mx/'), '/');
    assert.equal(pathKey('/pisos?utm=x'), '/pisos');
  });
});
