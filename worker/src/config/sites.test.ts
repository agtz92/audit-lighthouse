import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitesConfig, SitesConfigError } from './sites.js';

/** assert.throws no devuelve el error, así que lo capturamos para inspeccionarlo. */
function catchError(fn: () => unknown): SitesConfigError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SitesConfigError, `se esperaba SitesConfigError, llegó ${String(err)}`);
    return err;
  }
  assert.fail('se esperaba un error y no hubo ninguno');
}

const MINIMAL = `
sites:
  - id: uno
    name: Uno
    url: https://uno.example
`;

describe('parseSitesConfig', () => {
  test('aplica los defaults de fábrica cuando el YAML no declara defaults', () => {
    const [site] = parseSitesConfig(MINIMAL);
    assert.ok(site);
    assert.equal(site.maxPages, 50);
    assert.equal(site.timeoutMs, 30_000);
    assert.equal(site.waitUntil, 'networkidle');
    assert.deepEqual(site.viewport, { width: 1440, height: 900 });
    assert.deepEqual(site.exclude, []);
    assert.equal(site.enabled, true, 'enabled debe ser true si no se declara');
    assert.equal(site.sitemap, undefined);
  });

  test('el bloque defaults gana sobre los de fábrica', () => {
    const [site] = parseSitesConfig(`
defaults:
  maxPages: 80
  waitUntil: load
sites:
  - id: uno
    name: Uno
    url: https://uno.example
`);
    assert.equal(site?.maxPages, 80);
    assert.equal(site?.waitUntil, 'load');
    // Lo que defaults no menciona sigue viniendo de fábrica.
    assert.equal(site?.timeoutMs, 30_000);
  });

  test('el sitio gana sobre defaults', () => {
    const [site] = parseSitesConfig(`
defaults:
  maxPages: 80
sites:
  - id: uno
    name: Uno
    url: https://uno.example
    maxPages: 5
`);
    assert.equal(site?.maxPages, 5);
  });

  test('rechaza un id con mayúsculas o caracteres de ruta', () => {
    for (const bad of ['Uno', 'con espacio', '../fuga', 'a/b', '-empieza-con-guion']) {
      assert.throws(
        () => parseSitesConfig(`sites:\n  - id: "${bad}"\n    name: X\n    url: https://x.example\n`),
        SitesConfigError,
        `debió rechazar el id ${JSON.stringify(bad)}`,
      );
    }
  });

  test('acepta ids que empiezan con dígito, como 10datos y 3minread', () => {
    const sites = parseSitesConfig(`
sites:
  - id: 10datos
    name: 10 Datos
    url: https://www.10datos.com
  - id: 3minread
    name: 3 Min Read
    url: https://www.3minread.com
`);
    assert.deepEqual(sites.map((s) => s.id), ['10datos', '3minread']);
  });

  test('detecta ids duplicados y dice en qué posiciones', () => {
    const err = catchError(
      () =>
        parseSitesConfig(`
sites:
  - id: repe
    name: A
    url: https://a.example
  - id: otro
    name: B
    url: https://b.example
  - id: repe
    name: C
    url: https://c.example
`));
    assert.match(err.message, /sites\[0\]/);
    assert.match(err.message, /sites\[2\]/);
  });

  test('rechaza URLs sin esquema o con esquema que no es http', () => {
    for (const bad of ['matmarkt.com', 'ftp://x.example', 'javascript:alert(1)', '']) {
      assert.throws(
        () => parseSitesConfig(`sites:\n  - id: uno\n    name: X\n    url: "${bad}"\n`),
        SitesConfigError,
        `debió rechazar la url ${JSON.stringify(bad)}`,
      );
    }
  });

  test('rechaza una llave desconocida en vez de ignorarla en silencio', () => {
    // Un "sitmap:" mal escrito debe explotar, no dejarte sin sitemap sin avisar.
    const err = catchError(
      () =>
        parseSitesConfig(`
sites:
  - id: uno
    name: X
    url: https://x.example
    sitmap: https://x.example/sitemap.xml
`));
    assert.match(err.message, /sitmap/);
  });

  test('rechaza un waitUntil que Playwright no conoce', () => {
    assert.throws(
      () =>
        parseSitesConfig(`sites:\n  - id: uno\n    name: X\n    url: https://x.example\n    waitUntil: cuandoSea\n`),
      SitesConfigError,
    );
  });

  test('rechaza maxPages cero, negativo o no entero', () => {
    for (const bad of ['0', '-3', '2.5']) {
      assert.throws(
        () =>
          parseSitesConfig(`sites:\n  - id: uno\n    name: X\n    url: https://x.example\n    maxPages: ${bad}\n`),
        SitesConfigError,
      );
    }
  });

  test('rechaza un archivo sin sitios', () => {
    assert.throws(() => parseSitesConfig('sites: []\n'), SitesConfigError);
    assert.throws(() => parseSitesConfig('defaults: {}\n'), SitesConfigError);
  });

  test('rechaza YAML mal formado y archivo vacío', () => {
    assert.throws(() => parseSitesConfig('sites:\n  - id: [sin cerrar\n'), SitesConfigError);
    assert.throws(() => parseSitesConfig(''), SitesConfigError);
  });

  test('el mensaje de error incluye el nombre del archivo que se le pasa', () => {
    const err = catchError(
      () => parseSitesConfig('sites: []\n', '/app/sites.yaml'));
    assert.match(err.message, /\/app\/sites\.yaml/);
  });

  test('conserva enabled: false', () => {
    const [site] = parseSitesConfig(`
sites:
  - id: uno
    name: Uno
    url: https://uno.example
    enabled: false
`);
    assert.equal(site?.enabled, false);
  });
});
