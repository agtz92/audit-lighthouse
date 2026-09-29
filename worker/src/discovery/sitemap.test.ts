import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { parseSitemapXml, decodeXmlEntities, decodeSitemapBody } from './sitemap.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.example/</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://x.example/productos</loc></url>
</urlset>`;

// La forma exacta que sirven grupohule.com y mexgamer.com (Next.js en Vercel).
const INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://grupohule.com/sitemap-0.xml</loc></sitemap>
</sitemapindex>`;

describe('parseSitemapXml', () => {
  test('distingue urlset de sitemapindex', () => {
    assert.equal(parseSitemapXml(URLSET).kind, 'urlset');
    assert.equal(parseSitemapXml(INDEX).kind, 'sitemapindex');
  });

  test('extrae las URLs de un urlset en orden', () => {
    assert.deepEqual(parseSitemapXml(URLSET).locs, [
      'https://x.example/',
      'https://x.example/productos',
    ]);
  });

  test('el <loc> de un lastmod no se confunde con el de la URL', () => {
    const { locs } = parseSitemapXml(URLSET);
    assert.equal(locs.length, 2, 'solo debe haber dos loc, no capturar lastmod');
  });

  test('lee CDATA', () => {
    const { locs } = parseSitemapXml(
      `<urlset><url><loc><![CDATA[https://x.example/a]]></loc></url></urlset>`,
    );
    assert.deepEqual(locs, ['https://x.example/a']);
  });

  test('decodifica entidades en las URLs', () => {
    const { locs } = parseSitemapXml(
      `<urlset><url><loc>https://x.example/a?b=1&amp;c=2</loc></url></urlset>`,
    );
    assert.deepEqual(locs, ['https://x.example/a?b=1&c=2']);
  });

  test('tolera saltos de línea y espacios dentro del loc', () => {
    const { locs } = parseSitemapXml(
      `<urlset><url><loc>\n    https://x.example/a\n  </loc></url></urlset>`,
    );
    assert.deepEqual(locs, ['https://x.example/a']);
  });

  test('tolera un BOM al inicio del archivo', () => {
    const { kind, locs } = parseSitemapXml(`﻿${URLSET}`);
    assert.equal(kind, 'urlset', 'el BOM no debe romper la detección del tipo');
    assert.equal(locs.length, 2);
  });

  test('tolera etiquetas con espacios raros y mayúsculas', () => {
    const { locs } = parseSitemapXml(`<URLSET><url>< loc >https://x.example/a</ loc ></url></URLSET>`);
    assert.deepEqual(locs, ['https://x.example/a']);
  });

  test('un documento sin urlset ni sitemapindex es unknown', () => {
    // El caso de compatips: /sitemap.xml devuelve HTML.
    assert.equal(parseSitemapXml('<!doctype html><html><body>404</body></html>').kind, 'unknown');
    assert.equal(parseSitemapXml('').kind, 'unknown');
  });

  test('un sitemap vacío devuelve lista vacía, no error', () => {
    const { kind, locs } = parseSitemapXml('<urlset></urlset>');
    assert.equal(kind, 'urlset');
    assert.deepEqual(locs, []);
  });

  test('si aparecen ambas etiquetas gana la que venga primero', () => {
    // Un índice cuyos hijos van inline no debe tratarse como urlset.
    const xml = `<sitemapindex><sitemap><loc>https://x.example/s1.xml</loc></sitemap></sitemapindex><urlset/>`;
    assert.equal(parseSitemapXml(xml).kind, 'sitemapindex');
  });
});

describe('decodeXmlEntities', () => {
  test('entidades nombradas, decimales y hexadecimales', () => {
    assert.equal(decodeXmlEntities('a&amp;b'), 'a&b');
    assert.equal(decodeXmlEntities('&lt;x&gt;'), '<x>');
    assert.equal(decodeXmlEntities('&#233;'), 'é');
    assert.equal(decodeXmlEntities('&#xE9;'), 'é');
  });

  test('deja intacto lo que no reconoce', () => {
    assert.equal(decodeXmlEntities('&noexiste;'), '&noexiste;');
    assert.equal(decodeXmlEntities('100% & algo'), '100% & algo');
  });
});

describe('decodeSitemapBody', () => {
  test('descomprime un .xml.gz', () => {
    const gz = gzipSync(Buffer.from(URLSET, 'utf8'));
    assert.match(decodeSitemapBody(new Uint8Array(gz)), /<urlset/);
  });

  test('deja pasar XML sin comprimir', () => {
    assert.match(decodeSitemapBody(new Uint8Array(Buffer.from(URLSET, 'utf8'))), /<urlset/);
  });
});
