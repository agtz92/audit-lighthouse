import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { categorizeNavigationError, categorizeStatus } from './page-metrics.js';
import { daysUntil } from './tls.js';
import { cdpPortForSlot } from './browser.js';

describe('categorizeNavigationError', () => {
  test('reconoce las causas concretas que reporta Chromium', () => {
    const casos: Array<[string, string]> = [
      ['page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example/', 'dns'],
      ['page.goto: net::ERR_CERT_DATE_INVALID at https://x.example/', 'tls'],
      ['page.goto: net::ERR_SSL_PROTOCOL_ERROR at https://x.example/', 'tls'],
      ['page.goto: net::ERR_CONNECTION_REFUSED at https://x.example/', 'navigation'],
      ['page.goto: net::ERR_TOO_MANY_REDIRECTS at https://x.example/', 'navigation'],
      ['page.goto: net::ERR_EMPTY_RESPONSE at https://x.example/', 'navigation'],
      ['Timeout 30000ms exceeded.', 'timeout'],
      ['algo completamente inesperado', 'unknown'],
    ];
    for (const [message, esperada] of casos) {
      assert.equal(categorizeNavigationError(new Error(message)).category, esperada, message);
    }
  });

  test('conserva el mensaje original para poder depurar', () => {
    const msg = 'page.goto: net::ERR_NAME_NOT_RESOLVED at https://x.example/';
    assert.equal(categorizeNavigationError(new Error(msg)).message, msg);
  });

  test('tolera que le pasen algo que no es Error', () => {
    assert.equal(categorizeNavigationError('texto suelto').category, 'unknown');
    assert.equal(categorizeNavigationError(undefined).category, 'unknown');
  });
});

describe('categorizeStatus', () => {
  test('2xx y 3xx no son error', () => {
    for (const s of [200, 201, 204, 301, 302, 304, 399]) {
      assert.equal(categorizeStatus(s), null, String(s));
    }
  });

  test('separa 4xx de 5xx', () => {
    assert.equal(categorizeStatus(404), 'http_4xx');
    assert.equal(categorizeStatus(409), 'http_4xx', 'el 409 de kawaiimx');
    assert.equal(categorizeStatus(499), 'http_4xx');
    assert.equal(categorizeStatus(500), 'http_5xx');
    assert.equal(categorizeStatus(503), 'http_5xx', 'el 503 de rollospvc');
  });
});

describe('daysUntil', () => {
  const ahora = new Date('2026-09-29T12:00:00Z');

  test('cuenta días completos hacia el futuro', () => {
    assert.equal(daysUntil(new Date('2026-10-29T12:00:00Z'), ahora), 30);
    assert.equal(daysUntil(new Date('2026-09-30T11:00:00Z'), ahora), 0, 'menos de 24h es 0 días');
  });

  test('un certificado vencido da días negativos, no cero ni error', () => {
    assert.equal(daysUntil(new Date('2026-09-19T12:00:00Z'), ahora), -10);
  });

  test('el umbral de 21 días del webhook cae donde debe', () => {
    assert.ok(daysUntil(new Date('2026-10-19T12:00:00Z'), ahora) < 21);
    assert.ok(daysUntil(new Date('2026-10-21T12:00:00Z'), ahora) >= 21);
  });
});

describe('cdpPortForSlot', () => {
  test('cada slot de concurrencia recibe un puerto propio', () => {
    assert.equal(cdpPortForSlot(0), 9222);
    assert.equal(cdpPortForSlot(1), 9223);
    assert.notEqual(cdpPortForSlot(0), cdpPortForSlot(1));
  });
});
