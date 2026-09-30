import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { finalizeUrlList, chooseAuditList, CANDIDATE_CAP } from './index.js';
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
    // Si un patrón coincidiera con la home perderíamos Lighthouse y los informes.
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

describe('finalizeUrlList: el catálogo de candidatas', () => {
  test('el catálogo conserva lo que el recorte a maxPages tira', () => {
    // Es la razón de existir del catálogo: con maxPages = 5 el selector del
    // dashboard no tendría de dónde escoger si solo guardáramos lo auditado.
    const muchas = Array.from({ length: 40 }, (_, i) => `https://x.example/p${i}`);
    const { urls, candidates } = finalizeUrlList('https://x.example', muchas, {
      maxPages: 5,
      exclude: [],
    });
    assert.equal(urls.length, 5);
    assert.equal(candidates.length, 41, 'home + las 40, sin recortar a maxPages');
    assert.deepEqual(candidates.slice(0, 5), urls, 'lo auditado es el prefijo del catálogo');
  });

  test('el catálogo se recorta a CANDIDATE_CAP', () => {
    const muchisimas = Array.from({ length: CANDIDATE_CAP + 80 }, (_, i) => `https://x.example/p${i}`);
    const { candidates } = finalizeUrlList('https://x.example', muchisimas, {
      maxPages: 5,
      exclude: [],
    });
    assert.equal(candidates.length, CANDIDATE_CAP);
  });

  test('exclude también saca del catálogo, no solo de lo auditado', () => {
    const { candidates } = finalizeUrlList(
      'https://x.example',
      ['https://x.example/blog/tag/hule', 'https://x.example/productos'],
      { maxPages: 5, exclude: ['/blog/tag/'] },
    );
    assert.deepEqual(candidates, ['https://x.example/', 'https://x.example/productos']);
  });
});

describe('chooseAuditList', () => {
  const automatico = {
    urls: ['https://x.example/', 'https://x.example/a', 'https://x.example/b'],
    method: 'sitemap' as const,
    truncated: true,
  };
  const sitio = { url: 'https://x.example', maxPages: 5, exclude: [] as string[], pages: [] as string[] };

  test('sin selección manual devuelve intacto lo del automático', () => {
    const r = chooseAuditList(sitio, automatico);
    assert.deepEqual(r, automatico);
  });

  test('una lista vacía no cuenta como selección: sigue el automático', () => {
    // Es lo que queda en el YAML al deseleccionar todo desde el dashboard.
    const r = chooseAuditList({ ...sitio, pages: [] }, automatico);
    assert.equal(r.method, 'sitemap');
  });

  test('la selección manual reemplaza lo descubierto y se marca manual', () => {
    const r = chooseAuditList(
      { ...sitio, pages: ['https://x.example/productos', 'https://x.example/contacto'] },
      automatico,
    );
    assert.deepEqual(r.urls, [
      'https://x.example/',
      'https://x.example/productos',
      'https://x.example/contacto',
    ]);
    assert.equal(r.method, 'manual');
  });

  test('la home entra aunque no se haya elegido: es la única que recibe Lighthouse', () => {
    const r = chooseAuditList({ ...sitio, pages: ['https://x.example/contacto'] }, automatico);
    assert.equal(r.urls[0], 'https://x.example/');
  });

  test('la home elegida a mano no se duplica', () => {
    const r = chooseAuditList(
      { ...sitio, pages: ['https://x.example/', 'https://x.example/contacto'] },
      automatico,
    );
    assert.deepEqual(r.urls, ['https://x.example/', 'https://x.example/contacto']);
  });

  test('una lista elegida a mano nunca queda truncada', () => {
    // truncated significa «la muestra quedó incompleta por el tope». Aquí la
    // lista es deliberada, y heredar el truncated del automático haría que el
    // informe advirtiera de un recorte que no existe.
    const r = chooseAuditList({ ...sitio, pages: ['https://x.example/a'] }, automatico);
    assert.equal(automatico.truncated, true);
    assert.equal(r.truncated, false);
  });

  test('la selección se recorta a maxPages si alguien editó el YAML a mano', () => {
    const r = chooseAuditList(
      {
        ...sitio,
        maxPages: 3,
        pages: ['https://x.example/a', 'https://x.example/b', 'https://x.example/c', 'https://x.example/d'],
      },
      automatico,
    );
    assert.equal(r.urls.length, 3);
    assert.equal(r.urls[0], 'https://x.example/', 'la home sobrevive al recorte');
  });
});
