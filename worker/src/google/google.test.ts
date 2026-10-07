import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { parseServiceAccountKey, signAssertion, TokenSource, CredentialsError, SCOPES } from './auth.js';
import { classifyGoogleError, GoogleClient, GoogleApiError } from './client.js';
import { parseDailyRows, parseDimensionRows } from './search-console.js';
import { parseDaily, parsePeriodReports, gaDate, namedRows } from './ga4.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const KEY = { client_email: 'sm@proyecto.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.example/token' };

function respuesta(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('llave de la cuenta de servicio', () => {
  test('lee el JSON que descarga Google Cloud', () => {
    const k = parseServiceAccountKey(JSON.stringify({ type: 'service_account', ...KEY, project_id: 'p' }));
    assert.equal(k.client_email, KEY.client_email);
    assert.equal(k.project_id, 'p');
  });

  test('rechaza una credencial de OAuth de usuario con un mensaje claro', () => {
    assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: 'authorized_user' })), CredentialsError);
  });

  test('el JWT va firmado con la llave y trae los dos alcances de solo lectura', () => {
    const jwt = signAssertion(KEY, SCOPES, 1_700_000_000);
    const [h, c, s] = jwt.split('.');
    assert.ok(h !== undefined && c !== undefined && s !== undefined);
    const ok = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'));
    assert.ok(ok, 'la firma no valida con la llave pública');
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as { scope: string; aud: string; exp: number; iat: number };
    assert.match(claims.scope, /webmasters\.readonly/);
    assert.match(claims.scope, /analytics\.readonly/);
    assert.equal(claims.aud, KEY.token_uri);
    assert.equal(claims.exp - claims.iat, 3600);
  });

  test('reutiliza el token mientras no esté por vencer', async () => {
    let pedidos = 0;
    const fake = (async () => {
      pedidos += 1;
      return respuesta(200, { access_token: `t${pedidos}`, expires_in: 3600 });
    }) as typeof fetch;
    const ts = new TokenSource(KEY, fake);
    assert.equal(await ts.token(), 't1');
    assert.equal(await ts.token(), 't1');
    assert.equal(pedidos, 1);
  });

  test('llamadas en paralelo comparten una sola petición de token', async () => {
    let pedidos = 0;
    const fake = (async () => {
      pedidos += 1;
      return respuesta(200, { access_token: 't', expires_in: 3600 });
    }) as typeof fetch;
    const ts = new TokenSource(KEY, fake);
    await Promise.all([ts.token(), ts.token(), ts.token()]);
    assert.equal(pedidos, 1);
  });
});

describe('classifyGoogleError', () => {
  test('API sin habilitar: dice dónde habilitarla', () => {
    const e = classifyGoogleError(403, {
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Analytics Data API has not been used in project 123 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] },
    }, 'API de Google Analytics Data');
    assert.equal(e.kind, 'api_disabled');
    assert.match(e.message, /Biblioteca/);
  });

  test('sin permiso sobre la propiedad: dice que hay que agregar la cuenta', () => {
    const e = classifyGoogleError(403, { error: { status: 'PERMISSION_DENIED', message: "User does not have sufficient permission for site 'sc-domain:x.mx'." } }, 'API');
    assert.equal(e.kind, 'permission');
    assert.match(e.message, /Agrégala/);
  });

  test('404 es una propiedad mal escrita', () => {
    assert.equal(classifyGoogleError(404, {}, 'API').kind, 'not_found');
  });
});

describe('GoogleClient', () => {
  const tokens = { token: async () => 't' };

  test('reintenta un 429 y un 503, y devuelve la respuesta buena', async () => {
    const codigos = [429, 503, 200];
    let llamadas = 0;
    const fake = (async () => {
      const c = codigos[llamadas] ?? 200;
      llamadas += 1;
      return respuesta(c, c === 200 ? { rows: [1] } : { error: { status: 'X' } });
    }) as typeof fetch;
    const client = new GoogleClient(tokens, { fetchImpl: fake, sleep: async () => {} });
    assert.deepEqual(await client.request('API', 'https://x/y', {}), { rows: [1] });
    assert.equal(llamadas, 3);
  });

  test('un 403 no se reintenta: repetir no da permisos', async () => {
    let llamadas = 0;
    const fake = (async () => {
      llamadas += 1;
      return respuesta(403, { error: { status: 'PERMISSION_DENIED', message: 'no' } });
    }) as typeof fetch;
    const client = new GoogleClient(tokens, { fetchImpl: fake, sleep: async () => {} });
    await assert.rejects(client.request('API', 'https://x/y'), (e: unknown) => e instanceof GoogleApiError && e.kind === 'permission');
    assert.equal(llamadas, 1);
  });

  test('manda el token y usa POST solo cuando hay cuerpo', async () => {
    const vistos: Array<{ method: string; auth: string }> = [];
    const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
      vistos.push({ method: init?.method ?? '', auth: new Headers(init?.headers).get('authorization') ?? '' });
      return respuesta(200, {});
    }) as typeof fetch;
    const client = new GoogleClient(tokens, { fetchImpl: fake });
    await client.request('API', 'https://x/a');
    await client.request('API', 'https://x/b', { a: 1 });
    assert.deepEqual(vistos, [{ method: 'GET', auth: 'Bearer t' }, { method: 'POST', auth: 'Bearer t' }]);
  });
});

describe('Search Console', () => {
  test('convierte filas por día y redondea la posición', () => {
    assert.deepEqual(parseDailyRows([{ keys: ['2026-10-01'], clicks: 12, impressions: 340, ctr: 0.035, position: 7.23456 }]), [
      { date: '2026-10-01', clicks: 12, impressions: 340, position: 7.23 },
    ]);
  });

  test('una respuesta sin filas es una lista vacía, no un error', () => {
    assert.deepEqual(parseDailyRows(undefined), []);
    assert.deepEqual(parseDimensionRows([]), []);
  });
});

describe('GA4', () => {
  const diario = {
    dimensionHeaders: [{ name: 'date' }],
    metricHeaders: ['sessions', 'engagedSessions', 'totalUsers', 'newUsers', 'screenPageViews', 'keyEvents'].map((name) => ({ name })),
    rows: [
      { dimensionValues: [{ value: '20261002' }], metricValues: ['40', '22', '35', '20', '90', '1.5'].map((value) => ({ value })) },
      { dimensionValues: [{ value: '20261001' }], metricValues: ['30', '15', '28', '17', '70', '0'].map((value) => ({ value })) },
    ],
  };

  test('la fecha 20261004 se vuelve 2026-10-04', () => {
    assert.equal(gaDate('20261004'), '2026-10-04');
  });

  test('las filas diarias salen ordenadas por fecha y con nombres', () => {
    const d = parseDaily(diario);
    assert.deepEqual(d.map((r) => r.date), ['2026-10-01', '2026-10-02']);
    assert.equal(d[1]?.keyEvents, 1.5);
    assert.equal(d[1]?.engagedSessions, 22);
  });

  test('los cinco informes de un periodo se reparten en su lugar', () => {
    const r = parsePeriodReports([
      { metricHeaders: [{ name: 'sessions' }, { name: 'totalUsers' }], rows: [{ metricValues: [{ value: '500' }, { value: '420' }] }] },
      { dimensionHeaders: [{ name: 'sessionDefaultChannelGroup' }], metricHeaders: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }], rows: [{ dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '300' }, { value: '200' }, { value: '4' }] }] },
      { dimensionHeaders: [{ name: 'deviceCategory' }], metricHeaders: [{ name: 'sessions' }], rows: [] },
      { dimensionHeaders: [{ name: 'landingPage' }], metricHeaders: [{ name: 'sessions' }], rows: [{ dimensionValues: [{ value: '/' }], metricValues: [{ value: '120' }] }] },
      { dimensionHeaders: [{ name: 'eventName' }], metricHeaders: [{ name: 'keyEvents' }], rows: [
        { dimensionValues: [{ value: 'generate_lead' }], metricValues: [{ value: '9' }] },
        { dimensionValues: [{ value: 'page_view' }], metricValues: [{ value: '0' }] },
      ] },
    ]);
    assert.equal(r.totals.sessions, 500);
    assert.equal(r.totals.totalUsers, 420);
    assert.equal(r.channels[0]?.key, 'Organic Search');
    assert.equal(r.landing[0]?.sessions, 120);
    // Un evento que no es clave viene con 0 y no se lista.
    assert.deepEqual(r.keyEvents, [{ name: 'generate_lead', count: 9 }]);
  });

  test('un informe que no llegó no rompe nada', () => {
    assert.deepEqual(namedRows(undefined), []);
    assert.equal(parsePeriodReports([]).totals.sessions, 0);
  });
});
