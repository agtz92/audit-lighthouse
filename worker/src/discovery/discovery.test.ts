import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeUrlList } from './index.js';
import { extractLinks } from './crawl.js';
import { parseRobotsSitemaps } from './robots.js';

describe('finalizeUrlList', () => {
  const opts = { maxPages: 50, exclude: [] as string[] };

  test('la home queda siempre primero aunque el sitemap la liste al final', () => {
    const { urls } = finalizeUrlList('https://x.example', ['https://x.example/a', 'https://x.example/'], opts);
    assert.equal(urls[0], 'https://x.example/');
  });

  test('la home no se duplica si el sitemap ya la trae', () => {
    const { urls, discovered } = finalizeUrlList(
      'https://x.example',
      ['https://x.example/', 'https://x.example/a'],
      opts,
    );
    assert.deepEqual(urls, ['https://x.example/', 'https://x.example/a']);
    assert.equal(discovered, 2);
  });

  test('deduplica variantes que normalizan igual', () => {
    const { urls } = finalizeUrlList(
      'https://x.example',
      ['https://x.example/a/', 'https://x.example/a', 'https://x.example/a?utm=1', 'https://x.example/a#f'],
      opts,
    );
    assert.deepEqual(urls, ['https://x.example/', 'https://x.example/a']);
  });

  test('aplica los patrones de exclude por subcadena', () => {
    const { urls } = finalizeUrlList(
      'https://x.example',
      ['https://x.example/blog/tag/hule', 'https://x.example/productos'],
      { maxPages: 50, exclude: ['/blog/tag/'] },
    );
    assert.deepEqual(urls, ['https://x.example/', 'https://x.example/productos']);
  });

  test('exclude nunca puede eliminar la home', () => {
    // Si un patrón coincidiera con la home perderíamos Lighthouse y home.pdf.
    const { urls } = finalizeUrlList('https://x.example/', ['https://x.example/a'], {
      maxPages: 50,
      exclude: ['x.example'],
    });
    assert.equal(urls[0], 'https://x.example/');
  });

  test('recorta a maxPages y marca truncated, conservando la home', () => {
    const many = Array.from({ length: 120 }, (_, i) => `https://x.example/p${i}`);
    const { urls, discovered, truncated } = finalizeUrlList('https://x.example', many, {
      maxPages: 50,
      exclude: [],
    });
    assert.equal(urls.length, 50);
    assert.equal(urls[0], 'https://x.example/');
    assert.equal(discovered, 121, 'discovered cuenta antes del recorte, incluyendo la home');
    assert.equal(truncated, true);
  });

  test('no marca truncated cuando cabe justo', () => {
    const { truncated } = finalizeUrlList('https://x.example', ['https://x.example/a'], {
      maxPages: 2,
      exclude: [],
    });
    assert.equal(truncated, false);
  });

  test('un sitemap vacío deja solo la home', () => {
    const { urls, truncated } = finalizeUrlList('https://x.example', [], opts);
    assert.deepEqual(urls, ['https://x.example/']);
    assert.equal(truncated, false);
  });
});

describe('extractLinks', () => {
  test('lee href con comillas dobles, simples y sin comillas', () => {
    const html = `<a href="/a">1</a><a href='/b'>2</a><a href=/c>3</a>`;
    assert.deepEqual(extractLinks(html, 'https://x.example/'), [
      'https://x.example/a',
      'https://x.example/b',
      'https://x.example/c',
    ]);
  });

  test('resuelve rutas relativas contra la página, no contra la raíz', () => {
    assert.deepEqual(extractLinks(`<a href="d">x</a>`, 'https://x.example/a/b/'), [
      'https://x.example/a/b/d',
    ]);
  });

  test('respeta <base href>', () => {
    const html = `<head><base href="https://x.example/es/"></head><a href="a">x</a>`;
    assert.deepEqual(extractLinks(html, 'https://x.example/'), ['https://x.example/es/a']);
  });

  test('descarta anclas, mailto, tel y javascript', () => {
    const html = `<a href="#top">a</a><a href="mailto:x@y.com">b</a><a href="tel:+52">c</a><a href="javascript:void(0)">d</a>`;
    assert.deepEqual(extractLinks(html, 'https://x.example/'), []);
  });

  test('lee href aunque haya otros atributos antes y clases con comillas', () => {
    const html = `<a class="btn" data-x='y' href="/a" target="_blank">x</a>`;
    assert.deepEqual(extractLinks(html, 'https://x.example/'), ['https://x.example/a']);
  });
});

describe('parseRobotsSitemaps', () => {
  test('lee la directiva Sitemap sin importar mayúsculas ni espacios', () => {
    const txt = 'User-agent: *\nDisallow: /admin\nSitemap: https://x.example/sitemap.xml\nSITEMAP:   https://x.example/news.xml\n';
    assert.deepEqual(parseRobotsSitemaps(txt), [
      'https://x.example/sitemap.xml',
      'https://x.example/news.xml',
    ]);
  });

  test('ignora comentarios', () => {
    assert.deepEqual(parseRobotsSitemaps('# Sitemap: https://x.example/no.xml\nSitemap: https://x.example/si.xml'), [
      'https://x.example/si.xml',
    ]);
  });

  test('un robots.txt sin la directiva devuelve lista vacía', () => {
    assert.deepEqual(parseRobotsSitemaps('User-agent: *\nDisallow:\n'), []);
  });
});

describe('finalizeUrlList: apex contra www', () => {
  test('la home en www no se duplica cuando el sitemap lista el apex', () => {
    // El caso exacto de grupohule.com: sitemap en el apex, home en www.
    const { urls, discovered } = finalizeUrlList(
      'https://www.grupohule.com',
      ['https://grupohule.com/', 'https://grupohule.com/productos'],
      { maxPages: 50, exclude: [] },
    );
    assert.deepEqual(urls, ['https://www.grupohule.com/', 'https://grupohule.com/productos']);
    assert.equal(discovered, 2, 'la home cuenta una vez, no dos');
  });

  test('tampoco se duplica al revés: home en apex y sitemap en www', () => {
    const { urls } = finalizeUrlList(
      'https://grupohule.com',
      ['https://www.grupohule.com/', 'https://www.grupohule.com/a'],
      { maxPages: 50, exclude: [] },
    );
    assert.deepEqual(urls, ['https://grupohule.com/', 'https://www.grupohule.com/a']);
  });

  test('http y https de la misma ruta son la misma página', () => {
    const { urls } = finalizeUrlList(
      'https://x.example',
      ['http://x.example/a', 'https://x.example/a'],
      { maxPages: 50, exclude: [] },
    );
    assert.equal(urls.length, 2, 'home + una sola versión de /a');
  });

  test('un puerto distinto sí es otra página', () => {
    const { urls } = finalizeUrlList(
      'https://x.example',
      ['https://x.example:8443/a', 'https://x.example/a'],
      { maxPages: 50, exclude: [] },
    );
    assert.equal(urls.length, 3);
  });
});
