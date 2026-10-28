import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoogleError, GoogleClient, networkError } from './client.js';
import {
  field, metricsOf, parseDaily, parseCampaigns, parseKeywords, parseSearchTerms, mergeAds, parseAdInventory,
  labeledBy, parseSchedule, gaql, parseConversionActions, parseConversionActionInventory, parsePmaxAssets,
  parseAssetGroups, parseAudiences,
} from './ads.js';

/** El cuerpo real que devolvió Google con un token de prueba contra una cuenta de verdad. */
const NO_APROBADO = {
  error: {
    code: 403,
    message: 'The caller does not have permission',
    status: 'PERMISSION_DENIED',
    details: [{
      '@type': 'type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure',
      errors: [{
        errorCode: { authorizationError: 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' },
        message: 'The Google Cloud project is only approved for use with test accounts.',
      }],
    }],
  },
};

const conCodigo = (status: number, errorCode: Record<string, string>, message = 'x') => ({
  error: { code: status, status: 'X', details: [{ errors: [{ errorCode, message }] }] },
});

describe('errores de Google Ads', () => {
  test('token sin aprobar dice qué nivel de acceso pedir', () => {
    const e = classifyGoogleError(403, NO_APROBADO, 'API de Google Ads');
    assert.equal(e.kind, 'permission');
    assert.match(e.message, /Explorer o Basic/);
    assert.match(e.raw, /CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION/);
  });

  test('sin acceso a la cuenta apunta al MCC, no al token', () => {
    const e = classifyGoogleError(403, conCodigo(403, { authorizationError: 'USER_PERMISSION_DENIED' }), 'API de Google Ads');
    assert.equal(e.kind, 'permission');
    assert.match(e.message, /MCC/);
  });

  test('cuenta cancelada es not_found', () => {
    assert.equal(classifyGoogleError(403, conCodigo(403, { authorizationError: 'CUSTOMER_NOT_ENABLED' }), 'API').kind, 'not_found');
  });

  test('una consulta mal escrita trae el mensaje de Google', () => {
    const e = classifyGoogleError(400, conCodigo(400, { queryError: 'UNRECOGNIZED_FIELD' }, "Unrecognized field 'metrics.foo'"), 'API');
    assert.equal(e.kind, 'invalid');
    assert.match(e.message, /metrics\.foo/);
  });

  test('los errores de Search Console y GA4 siguen igual', () => {
    assert.equal(classifyGoogleError(403, { error: { status: 'PERMISSION_DENIED', message: 'no' } }, 'API').kind, 'permission');
  });
});

describe('cliente de Ads', () => {
  test('manda developer-token y login-customer-id, y junta los lotes de searchStream', async () => {
    let headers: Record<string, string> = {};
    let url = '';
    const fake = (async (u: string, init: RequestInit) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify([{ results: [{ a: 1 }] }, { results: [{ a: 2 }] }]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new GoogleClient({ token: async () => 't' }, {
      fetchImpl: fake, headers: { 'developer-token': 'dev', 'login-customer-id': '9112983235' },
    });
    const filas = await gaql(client, '2248451770', 'SELECT customer.id FROM customer');
    assert.deepEqual(filas, [{ a: 1 }, { a: 2 }]);
    assert.match(url, /customers\/2248451770\/googleAds:searchStream$/);
    assert.equal(headers['developer-token'], 'dev');
    assert.equal(headers['login-customer-id'], '9112983235');
    assert.equal(headers.authorization, 'Bearer t');
  });

  test('el error de searchStream llega dentro de un arreglo y se traduce igual', async () => {
    const fake = (async () => new Response(JSON.stringify([NO_APROBADO]), { status: 403 })) as unknown as typeof fetch;
    const client = new GoogleClient({ token: async () => 't' }, { fetchImpl: fake });
    await assert.rejects(gaql(client, '2248451770', 'SELECT customer.id FROM customer'), /Explorer o Basic/);
  });
});

const m = (impr: number, clicks: number, costMicros: number, conv: number) => ({
  metrics: { impressions: String(impr), clicks: String(clicks), costMicros: String(costMicros), conversions: conv, conversionsValue: 0 },
});

describe('lectura de filas', () => {
  test('field lee rutas anidadas y no truena con huecos', () => {
    assert.equal(field({ a: { b: { c: 3 } } }, 'a.b.c'), 3);
    assert.equal(field({ a: null }, 'a.b'), undefined);
  });

  test('los int64 llegan como texto y el costo sale en pesos', () => {
    assert.deepEqual(metricsOf(m(17503, 1963, 35_248_760_000, 156)), {
      impressions: 17503, clicks: 1963, cost: 35248.76, conversions: 156, conversionsValue: 0,
    });
  });

  test('la serie diaria conserva las millonésimas exactas', () => {
    const [d] = parseDaily([{ segments: { date: '2026-10-13' }, campaign: { id: '1503969492', name: 'Cortinas' }, ...m(10, 2, 35_910_000, 1) }]);
    assert.equal(d?.costMicros, 35_910_000);
    assert.equal(d?.campaignId, '1503969492');
  });

  test('campañas: cuota de impresiones como fracción, y null fuera de búsqueda', () => {
    const [busqueda, pmax] = parseCampaigns([
      { campaign: { id: '1', name: 'S', status: 'ENABLED' }, campaignBudget: { amountMicros: '1200000000' }, ...m(10, 1, 2_000_000, 0), metrics: { ...m(10, 1, 2_000_000, 0).metrics, searchImpressionShare: 0.558, searchBudgetLostImpressionShare: 0.177 } },
      { campaign: { id: '2', name: 'P', status: 'ENABLED' }, ...m(5, 1, 1_000_000, 0) },
    ]);
    assert.equal(busqueda?.dailyBudget, 1200);
    assert.equal(busqueda?.impressionShare, 0.558);
    assert.equal(busqueda?.budgetLostShare, 0.177);
    assert.equal(pmax?.impressionShare, null);
  });

  test('keywords: QS y sus tres componentes; sin datos queda null', () => {
    const [k, sinQs] = parseKeywords([
      { adGroupCriterion: { criterionId: '809516853572', keyword: { text: 'PVC Transparente', matchType: 'PHRASE' }, qualityInfo: { qualityScore: 3, creativeQualityScore: 'ABOVE_AVERAGE', postClickQualityScore: 'BELOW_AVERAGE', searchPredictedCtr: 'BELOW_AVERAGE' } }, ...m(2817, 428, 7_924_840_000, 21) },
      { adGroupCriterion: { criterionId: '1', keyword: { text: 'tiras', matchType: 'PHRASE' }, qualityInfo: {} }, ...m(169, 13, 263_260_000, 0) },
    ]);
    assert.equal(k?.qualityScore, 3);
    assert.equal(k?.landingPage, 'BELOW_AVERAGE');
    assert.equal(sinQs?.qualityScore, null);
    assert.equal(sinQs?.adRelevance, null);
  });

  test('un término que entró por dos grupos de anuncios se suma en una fila', () => {
    const t = parseSearchTerms([
      { searchTermView: { searchTerm: 'cortinas hawaianas', status: 'NONE' }, segments: { searchTermMatchType: 'EXACT' }, ...m(491, 42, 752_270_000, 7) },
      { searchTermView: { searchTerm: 'cortinas hawaianas', status: 'ADDED' }, segments: { searchTermMatchType: 'EXACT' }, ...m(297, 16, 285_340_000, 1) },
      { searchTermView: { searchTerm: 'pvc', status: 'NONE' }, segments: { searchTermMatchType: 'BROAD' }, ...m(246, 10, 220_440_000, 0) },
    ]);
    assert.equal(t.length, 2);
    assert.deepEqual(
      { term: t[0]?.term, clicks: t[0]?.clicks, cost: t[0]?.cost, conv: t[0]?.conversions, status: t[0]?.status },
      { term: 'cortinas hawaianas', clicks: 58, cost: 1037.61, conv: 8, status: 'ADDED' },
    );
  });

  test('un anuncio rechazado sin impresiones sigue apareciendo, en cero', () => {
    const inventario = parseAdInventory([
      { campaign: { id: '1' }, adGroup: { id: '10', name: 'G' }, adGroupAd: { ad: { id: '100', type: 'RESPONSIVE_SEARCH_AD', responsiveSearchAd: { headlines: [{ text: 'Cortina Hawaiana de PVC' }] }, finalUrls: ['https://www.corthw.com'] }, status: 'ENABLED', policySummary: { approvalStatus: 'APPROVED' }, adStrength: 'EXCELLENT' } },
      { campaign: { id: '1' }, adGroup: { id: '10', name: 'G' }, adGroupAd: { ad: { id: '200', type: 'RESPONSIVE_SEARCH_AD' }, status: 'ENABLED', policySummary: { approvalStatus: 'DISAPPROVED' } } },
    ]);
    const ads = mergeAds(inventario, [{ adGroupAd: { ad: { id: '100' } }, ...m(10, 2, 3_000_000, 1) }]);
    assert.equal(ads.length, 2);
    assert.equal(ads[0]?.headlines[0], 'Cortina Hawaiana de PVC');
    const rechazado = ads.find((a) => a.adId === '200');
    assert.equal(rechazado?.approval, 'DISAPPROVED');
    assert.equal(rechazado?.cost, 0);
  });

  test('género y edad se suman entre grupos de anuncios: una fila por valor', () => {
    const g = labeledBy([
      { adGroupCriterion: { gender: { type: 'MALE' } }, ...m(1, 1, 7_686_870_000, 0) },
      { adGroupCriterion: { gender: { type: 'MALE' } }, ...m(1, 1, 3_305_620_000, 0) },
      { adGroupCriterion: { gender: { type: 'FEMALE' } }, ...m(1, 1, 4_514_400_000, 0) },
    ], (r) => String(field(r, 'adGroupCriterion.gender.type')));
    assert.deepEqual(g.map((x) => [x.key, x.cost]), [['MALE', 10992.49], ['FEMALE', 4514.4]]);
  });

  test('día y hora salen en orden de calendario, no de costo', () => {
    const s = parseSchedule([
      { segments: { dayOfWeek: 'SUNDAY', hour: 13 }, ...m(1, 1, 9_000_000, 0) },
      { segments: { dayOfWeek: 'MONDAY', hour: 9 }, ...m(1, 1, 1_000_000, 0) },
    ]);
    assert.deepEqual(s.byDay.map((d) => d.key), ['MONDAY', 'SUNDAY']);
    assert.deepEqual(s.byHour.map((h) => h.key), ['9', '13']);
  });
});

describe('inventario y PMax', () => {
  test('las conversiones por acción llevan su tipo y si cuentan en «Conversiones»', () => {
    const inv = parseConversionActionInventory([
      { conversionAction: { name: 'Enviar Whatsapp', type: 'WEBPAGE', category: 'CONTACT', status: 'ENABLED', includeInConversionsMetric: true } },
    ]);
    const [wa, vieja] = parseConversionActions([
      { campaign: { id: '1' }, segments: { conversionActionName: 'Enviar Whatsapp', conversionActionCategory: 'CONTACT' }, metrics: { conversions: 129, allConversions: 129 } },
      { campaign: { id: '1' }, segments: { conversionActionName: 'Borrada', conversionActionCategory: 'LEAD' }, metrics: { conversions: 0, allConversions: 2 } },
    ], inv);
    assert.equal(wa?.type, 'WEBPAGE');
    assert.equal(wa?.primary, true);
    assert.equal(vieja?.type, null);
  });

  test('una acción con conversiones cuenta en «Conversiones» aunque la configuración diga que no', () => {
    const inv = parseConversionActionInventory([
      { conversionAction: { name: 'Enviar Whatsapp', type: 'WEBPAGE', category: 'CONTACT', status: 'ENABLED' } },
    ]);
    assert.equal(inv[0]?.primary, false, 'sin primaryForGoal ni includeInConversionsMetric');
    const [wa] = parseConversionActions([
      { campaign: { id: '1' }, segments: { conversionActionName: 'Enviar Whatsapp', conversionActionCategory: 'CONTACT' }, metrics: { conversions: 142, allConversions: 142 } },
    ], inv);
    assert.equal(wa?.primary, true);
  });

  test('primary_for_goal es el que dice si una acción es primaria', () => {
    const [a] = parseConversionActionInventory([{ conversionAction: { name: 'x', primaryForGoal: true } }]);
    assert.equal(a?.primary, true);
  });

  test('cada asset group trae sus assets', () => {
    const assets = parsePmaxAssets([
      { assetGroup: { id: '7' }, asset: { type: 'TEXT', textAsset: { text: 'Cortinas a la medida' } }, assetGroupAsset: { fieldType: 'HEADLINE', primaryStatus: 'ELIGIBLE' } },
      { assetGroup: { id: '8' }, asset: { type: 'IMAGE' }, assetGroupAsset: { fieldType: 'MARKETING_IMAGE', primaryStatus: 'NOT_ELIGIBLE' } },
    ]);
    const [g] = parseAssetGroups([{ campaign: { id: '1' }, assetGroup: { id: '7', name: 'Todo', status: 'ENABLED', adStrength: 'GOOD' }, ...m(10, 1, 1_000_000, 0) }], assets);
    assert.equal(g?.assets.length, 1);
    assert.equal(g?.assets[0]?.text, 'Cortinas a la medida');
    assert.equal(assets[1]?.text, null);
  });

  test('audiencias de campaña y de grupo no se mezclan', () => {
    const a = parseAudiences(
      [{ campaign: { id: '1' }, campaignCriterion: { displayName: 'Compradores', type: 'USER_INTEREST' }, ...m(5, 1, 2_000_000, 1) }],
      [{ campaign: { id: '1' }, adGroupCriterion: { displayName: 'Compradores', type: 'USER_INTEREST' }, ...m(5, 1, 1_000_000, 0) }],
    );
    assert.deepEqual(a.map((x) => [x.level, x.cost]), [['campaign', 2], ['ad_group', 1]]);
  });
});

/** Como los arma undici: «fetch failed» arriba y la causa real en `cause`. */
function fetchFailed(cause: Record<string, unknown>): TypeError {
  return Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(String(cause.message ?? '')), cause) });
}

describe('errores de red', () => {
  const URL_ADS = 'https://googleads.googleapis.com/v26/customers/1/googleAds:searchStream';

  test('un DNS que no resuelve el dominio de Ads apunta al bloqueador de anuncios', () => {
    const e = networkError(fetchFailed({ code: 'ENOTFOUND', hostname: 'googleads.googleapis.com', message: 'getaddrinfo ENOTFOUND googleads.googleapis.com' }), URL_ADS);
    assert.equal(e.kind, 'network');
    assert.match(e.message, /googleads\.googleapis\.com/);
    assert.match(e.message, /Pi-hole/);
    assert.match(e.raw, /ENOTFOUND/);
  });

  test('un DNS que contesta 0.0.0.0 también es bloqueo', () => {
    const e = networkError(fetchFailed({ code: 'ECONNREFUSED', address: '0.0.0.0', message: 'connect ECONNREFUSED 0.0.0.0:443' }), URL_ADS);
    assert.match(e.message, /bloqueador/);
  });

  test('otra falla de red dice el código y el host, no solo «fetch failed»', () => {
    const e = networkError(fetchFailed({ code: 'ECONNRESET', message: 'other side closed' }), URL_ADS);
    assert.equal(e.message, 'No se pudo contactar a googleads.googleapis.com (ECONNRESET): other side closed');
  });

  test('un tiempo de espera se dice así', () => {
    const e = networkError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), URL_ADS);
    assert.match(e.message, /no respondió a tiempo/);
  });

  test('el cliente reporta la causa después de agotar los reintentos', async () => {
    const fake = (async () => { throw fetchFailed({ code: 'ENOTFOUND', hostname: 'googleads.googleapis.com', message: 'x' }); }) as unknown as typeof fetch;
    const client = new GoogleClient({ token: async () => 't' }, { fetchImpl: fake, attempts: 2, sleep: async () => {} });
    await assert.rejects(gaql(client, '1', 'SELECT customer.id FROM customer'), /DNS de este servidor no deja llegar a googleads\.googleapis\.com/);
  });
});
