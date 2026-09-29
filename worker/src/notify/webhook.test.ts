import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deliverWebhook, backoffMs, shouldRetry, type WebhookPayload } from './webhook.js';
import { Logger } from '../lib/logger.js';

// Logger silencioso: los tests no deben ensuciar la salida.
const silencio = new Logger({}, 'error');
const sinEspera = async (): Promise<void> => {};

const PAYLOAD = {
  event: 'run.finished',
  run: { id: 1, trigger: 'manual', status: 'ok', startedAt: '', finishedAt: '', durationMs: 0,
         sitesTotal: 1, sitesOk: 1, sitesFailed: 0, sitesSkipped: 0, budgetExceeded: false },
  comparedToRunId: null,
  sites: [],
} as unknown as WebhookPayload;

function respondedor(...codigos: number[]): { impl: typeof fetch; llamadas: () => number } {
  let i = 0;
  const impl = (async () => {
    const code = codigos[Math.min(i, codigos.length - 1)] ?? 200;
    i += 1;
    return new Response(null, { status: code });
  }) as unknown as typeof fetch;
  return { impl, llamadas: () => i };
}

describe('backoffMs', () => {
  test('crece exponencialmente desde 1s', () => {
    assert.equal(backoffMs(1), 1000);
    assert.equal(backoffMs(2), 2000);
    assert.equal(backoffMs(3), 4000);
  });
});

describe('shouldRetry', () => {
  test('reintenta 5xx, 408 y 429', () => {
    for (const s of [500, 502, 503, 408, 429]) assert.equal(shouldRetry(s), true, String(s));
  });

  test('no reintenta 4xx normales: el payload o la URL están mal', () => {
    for (const s of [400, 401, 403, 404, 422]) assert.equal(shouldRetry(s), false, String(s));
  });
});

describe('deliverWebhook', () => {
  test('entrega al primer intento con un 200', async () => {
    const r = respondedor(200);
    const res = await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: r.impl, log: silencio, sleep: sinEspera });
    assert.deepEqual({ ...res, error: res.error }, { delivered: true, attempts: 1, status: 200, error: null });
    assert.equal(r.llamadas(), 1);
  });

  test('reintenta un 503 y entrega cuando el destino se recupera', async () => {
    const r = respondedor(503, 503, 200);
    const res = await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: r.impl, log: silencio, sleep: sinEspera });
    assert.equal(res.delivered, true);
    assert.equal(res.attempts, 3);
    assert.equal(r.llamadas(), 3);
  });

  test('se rinde tras tres intentos', async () => {
    const r = respondedor(500);
    const res = await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: r.impl, log: silencio, sleep: sinEspera });
    assert.equal(res.delivered, false);
    assert.equal(res.attempts, 3);
    assert.equal(r.llamadas(), 3, 'exactamente 3 intentos, ni uno más');
  });

  test('un 404 corta de inmediato sin gastar reintentos', async () => {
    const r = respondedor(404);
    const res = await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: r.impl, log: silencio, sleep: sinEspera });
    assert.equal(res.delivered, false);
    assert.equal(res.attempts, 1);
    assert.equal(r.llamadas(), 1);
  });

  test('un error de red se reintenta y se reporta', async () => {
    let i = 0;
    const impl = (async () => {
      i += 1;
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: impl, log: silencio, sleep: sinEspera });
    assert.equal(res.delivered, false);
    assert.equal(i, 3);
    assert.match(res.error ?? '', /ECONNREFUSED/);
  });

  test('espera con backoff entre intentos, no de golpe', async () => {
    const esperas: number[] = [];
    const r = respondedor(500);
    await deliverWebhook(PAYLOAD, {
      url: 'https://x.example/hook',
      fetchImpl: r.impl,
      log: silencio,
      sleep: async (ms) => { esperas.push(ms); },
    });
    // Dos esperas para tres intentos: no se espera después del último.
    assert.deepEqual(esperas, [1000, 2000]);
  });

  test('manda el cuerpo como JSON con el content-type correcto', async () => {
    let visto: RequestInit | undefined;
    const impl = (async (_url: string, init: RequestInit) => {
      visto = init;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    await deliverWebhook(PAYLOAD, { url: 'https://x.example/hook', fetchImpl: impl, log: silencio, sleep: sinEspera });
    assert.equal(visto?.method, 'POST');
    assert.equal((visto?.headers as Record<string, string>)['content-type'], 'application/json');
    assert.equal(JSON.parse(visto?.body as string).event, 'run.finished');
  });
});
