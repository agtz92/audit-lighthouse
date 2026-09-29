import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, sameSite, bareHost, looksLikePage } from './url.js';

describe('normalizeUrl', () => {
  test('quita el hash y el query string', () => {
    assert.equal(normalizeUrl('https://x.example/a?utm_source=fb#top'), 'https://x.example/a');
  });

  test('conserva el query si se lo pides', () => {
    assert.equal(
      normalizeUrl('https://x.example/a?id=3', undefined, { stripQuery: false }),
      'https://x.example/a?id=3',
    );
  });

  test('quita la diagonal final salvo en la raíz', () => {
    assert.equal(normalizeUrl('https://x.example/a/'), 'https://x.example/a');
    assert.equal(normalizeUrl('https://x.example/'), 'https://x.example/');
  });

  test('baja el host a minúsculas pero no la ruta', () => {
    assert.equal(normalizeUrl('https://X.Example/Ruta'), 'https://x.example/Ruta');
  });

  test('quita el puerto default del esquema', () => {
    assert.equal(normalizeUrl('https://x.example:443/a'), 'https://x.example/a');
    assert.equal(normalizeUrl('http://x.example:80/a'), 'http://x.example/a');
    assert.equal(normalizeUrl('https://x.example:8443/a'), 'https://x.example:8443/a');
  });

  test('resuelve rutas relativas contra la base', () => {
    assert.equal(normalizeUrl('/b', 'https://x.example/a/c'), 'https://x.example/b');
    assert.equal(normalizeUrl('d', 'https://x.example/a/'), 'https://x.example/a/d');
  });

  test('devuelve null para esquemas que no son http', () => {
    assert.equal(normalizeUrl('mailto:a@b.com'), null);
    assert.equal(normalizeUrl('javascript:void(0)'), null);
    assert.equal(normalizeUrl('tel:+521234'), null);
    assert.equal(normalizeUrl('no es una url'), null);
  });
});

describe('sameSite', () => {
  test('trata www y apex como el mismo sitio', () => {
    // El caso de grupohule: sitemap en www, URLs en el apex.
    assert.equal(sameSite('https://www.grupohule.com/sitemap.xml', 'https://grupohule.com/a'), true);
  });

  test('distingue sitios distintos y subdominios que no son www', () => {
    assert.equal(sameSite('https://a.example', 'https://b.example'), false);
    assert.equal(sameSite('https://www.x.example', 'https://blog.x.example'), false);
  });

  test('ignora el esquema y el puerto', () => {
    assert.equal(sameSite('http://x.example', 'https://x.example:8443/a'), true);
  });

  test('bareHost quita solo el www inicial', () => {
    assert.equal(bareHost('WWW.X.example'), 'x.example');
    assert.equal(bareHost('wwwx.example'), 'wwwx.example');
  });
});

describe('looksLikePage', () => {
  test('descarta archivos que no son páginas', () => {
    for (const u of [
      'https://x.example/doc.pdf',
      'https://x.example/img.JPG',
      'https://x.example/style.css',
      'https://x.example/feed.xml',
    ]) {
      assert.equal(looksLikePage(u), false, u);
    }
  });

  test('acepta rutas normales, con o sin extensión', () => {
    for (const u of ['https://x.example/', 'https://x.example/productos/hule', 'https://x.example/a.html']) {
      assert.equal(looksLikePage(u), true, u);
    }
  });
});
