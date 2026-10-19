import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { AdsWriter, AdsWriterError, aiPayload, blocksWithData, reportUserPrompt, SYSTEM_BY_AUDIENCE } from './ads-writer.js';
import { buildAdsReport, type AdsReportData } from '../report/ads-model.js';
import { eachDay } from '../analytics/periods.js';

const M = (cost: number, conversions: number, clicks = 100, impressions = 1000) => ({ impressions, clicks, cost, conversions, conversionsValue: 0 });

function datos(): AdsReportData {
  return buildAdsReport({
    consultant: { name: 'C', role: 'R', credentials: 'X' },
    site: { name: 'Cort HW', url: 'https://www.corthw.com' },
    generatedAt: new Date('2026-10-14T12:00:00Z'),
    folio: 'f',
    customerId: '2248451770',
    currency: 'MXN',
    mode: '28d',
    current: { start: '2026-09-16', end: '2026-10-13' },
    previous: { start: '2026-08-19', end: '2026-09-15' },
    latestDate: '2026-10-13',
    days: eachDay({ start: '2026-08-19', end: '2026-10-13' }).map((date) => ({ date, ...M(1100, 5) })),
    now: {
      totals: M(35248.76, 156, 1963, 17503),
      campaigns: [{
        id: '1', name: 'Cortinas Hawaianas', status: 'ENABLED', channel: 'SEARCH', bidding: 'TARGET_SPEND', dailyBudget: 1200,
        allConversions: 156, impressionShare: 0.558, rankLostShare: 0.265, budgetLostShare: 0.177, ...M(35248.76, 156, 1963, 17503),
      }],
      conversionActions: [], adGroups: [], keywords: [], searchTerms: [], ads: [], assetGroups: [], pmaxTerms: [], audiences: [],
      devices: [{ key: 'MOBILE', ...M(27912.84, 115) }], landing: [], geo: [], gender: [], age: [], schedule: null,
    },
    before: null,
    health: new Map(),
  });
}

/** Un cliente cuyo fetch devuelve `body` y guarda lo que se le mandó. */
function fake(body: unknown): { client: Anthropic; sent: () => Record<string, unknown>; headers: () => Headers } {
  let enviado: Record<string, unknown> = {};
  let cabeceras = new Headers();
  const client = new Anthropic({
    apiKey: 'k',
    maxRetries: 0,
    fetch: (async (_url: string, init: RequestInit) => {
      enviado = JSON.parse(String(init.body)) as Record<string, unknown>;
      cabeceras = new Headers(init.headers);
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch,
  });
  return { client, sent: () => enviado, headers: () => cabeceras };
}

const mensaje = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
  content: [{ type: 'text', text }],
  usage: { input_tokens: 1000, output_tokens: 400, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
  ...extra,
});

describe('lo que se le manda a Claude', () => {
  test('montos en la moneda de la cuenta y fracciones sin convertir', () => {
    const p = aiPayload(datos()) as { totales: { actual: Record<string, number> }; campañas: Array<Record<string, number>> };
    assert.equal(p.totales.actual.gasto, 35248.76);
    assert.equal(p.campañas[0]?.perdida_por_presupuesto, 0.177);
  });

  test('solo se piden los bloques con datos', () => {
    const ids = blocksWithData(datos(), 'admin');
    assert.ok(ids.includes('eficiencia'));
    assert.ok(!ids.includes('pmax'), 'sin asset groups no hay bloque de PMax');
    assert.ok(!ids.includes('resumen'), 'el de admin no imprime el bloque de resumen');
    assert.ok(!blocksWithData(datos(), 'cliente').includes('keywords'), 'el de cliente no habla de keywords');
    assert.match(reportUserPrompt(datos(), 'admin', { profile: '', baseline: null }), /Bloques a escribir, en este orden: eficiencia, tendencia/);
  });

  test('el prompt de cliente y el de admin piden cosas distintas', () => {
    assert.match(SYSTEM_BY_AUDIENCE.cliente, /DUEÑO DEL NEGOCIO/);
    assert.match(SYSTEM_BY_AUDIENCE.admin, /ADMINISTRA/);
  });
});

describe('AdsWriter', () => {
  const salida = { conclusion: 'Va bien.', bloques: [{ id: 'resumen', texto: 'Gasto de $35,248.76.' }], acciones: [{ titulo: 'Negativizar', detalle: 'x', prioridad: 'alta' }] };

  test('pide salida estructurada, cachea el system prompt y activa el fallback', async () => {
    const f = fake(mensaje(JSON.stringify(salida)));
    const w = new AdsWriter({ model: 'claude-opus-5-5', effort: 'medium', client: f.client });
    const r = await w.report(datos(), 'cliente', { profile: 'Vende cortinas industriales.', baseline: null });
    assert.equal(r.content.conclusion, 'Va bien.');
    assert.equal(r.inputTokens, 1200);
    const body = f.sent() as { system: Array<{ cache_control?: unknown }>; output_config: { effort: string; format: { type: string } }; fallbacks: string; messages: Array<{ content: string }> };
    assert.deepEqual(body.system[0]?.cache_control, { type: 'ephemeral' });
    assert.equal(body.output_config.effort, 'medium');
    assert.equal(body.output_config.format.type, 'json_schema');
    assert.equal(body.fallbacks, 'default');
    assert.match(f.headers().get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    assert.match(body.messages[0]?.content ?? '', /Vende cortinas industriales/);
  });

  test('un rechazo es un error con la categoría, no un texto vacío', async () => {
    const f = fake({ ...mensaje(''), stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: 'cyber', explanation: null } });
    const w = new AdsWriter({ model: 'claude-opus-5-5', effort: 'medium', client: f.client });
    await assert.rejects(w.report(datos(), 'admin', { profile: '', baseline: null }), (e: unknown) => e instanceof AdsWriterError && /cyber/.test(e.message));
  });

  test('una respuesta cortada por longitud no se usa a medias', async () => {
    const f = fake({ ...mensaje('{"conclusion": "Va'), stop_reason: 'max_tokens' });
    const w = new AdsWriter({ model: 'claude-opus-5-5', effort: 'medium', client: f.client });
    await assert.rejects(w.report(datos(), 'admin', { profile: '', baseline: null }), AdsWriterError);
  });

  test('el análisis semanal trae el baseline nuevo', async () => {
    const semanal = { resumen: 'r', mejoro: ['CTR'], empeoro: [], alertas: [], acciones: ['a'], baseline: 'Cuenta de cortinas...' };
    const f = fake(mensaje(JSON.stringify(semanal)));
    const w = new AdsWriter({ model: 'claude-opus-5-5', effort: 'medium', client: f.client });
    const r = await w.weekly(datos(), { profile: '', baseline: 'Semana pasada: CPA 225.' });
    assert.equal(r.content.baseline, 'Cuenta de cortinas...');
    assert.match((f.sent() as { messages: Array<{ content: string }> }).messages[0]?.content ?? '', /Semana pasada: CPA 225/);
  });
});
