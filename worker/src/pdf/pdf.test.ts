import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { mergePdfs, buildFullPdf, type PdfPart } from './merge.js';
import { countIndexPages, layoutIndex, buildIndexPdf } from './index-page.js';
import { compressTimeoutFor } from './compress.js';

/** PDF de prueba con `pages` hojas. */
async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) doc.addPage([595.28, 841.89]);
  return doc.save();
}

const META = {
  siteName: 'Sitio de prueba',
  siteUrl: 'https://x.example',
  generatedAt: new Date('2026-09-29T12:00:00Z'),
  discovered: 3,
  truncated: false,
  maxPages: 50,
  failed: 0,
};

describe('mergePdfs', () => {
  test('une varios documentos y reporta cuántas hojas aportó cada uno', async () => {
    const { bytes, pageCounts } = await mergePdfs([await makePdf(1), await makePdf(3), await makePdf(2)]);
    assert.deepEqual(pageCounts, [1, 3, 2]);
    const merged = await PDFDocument.load(bytes);
    assert.equal(merged.getPageCount(), 6);
  });

  test('unir una lista vacía no explota', async () => {
    // Caso inalcanzable desde buildFullPdf, que nunca llama aquí con cero partes,
    // pero conviene que no lance. pdf-lib reporta 1 página al releer un documento
    // guardado sin ninguna: un PDF de cero páginas no es un PDF válido.
    const { bytes, pageCounts } = await mergePdfs([]);
    assert.deepEqual(pageCounts, []);
    assert.ok(bytes.byteLength > 0);
  });
});

describe('layoutIndex', () => {
  test('pocas entradas caben en una hoja', () => {
    assert.equal(countIndexPages(1), 1);
    assert.equal(countIndexPages(40), 1);
  });

  test('muchas entradas se reparten en varias hojas', () => {
    assert.ok(countIndexPages(200) > 1);
  });

  test('la distribución suma exactamente las entradas que se le dieron', () => {
    for (const n of [0, 1, 7, 50, 51, 120, 999]) {
      const dist = layoutIndex(n);
      assert.equal(dist.reduce((a, b) => a + b, 0), n, `${n} entradas`);
    }
  });

  test('ninguna hoja queda vacía salvo cuando no hay entradas', () => {
    for (const n of [1, 50, 51, 120]) {
      assert.ok(layoutIndex(n).every((rows) => rows > 0), `${n} entradas`);
    }
  });
});

describe('buildFullPdf', () => {
  test('el total de páginas es el índice más el cuerpo', async () => {
    const parts: PdfPart[] = [
      { url: 'https://x.example/', bytes: await makePdf(2) },
      { url: 'https://x.example/a', bytes: await makePdf(1) },
      { url: 'https://x.example/b', bytes: await makePdf(3) },
    ];
    const { bytes, totalPages, entries } = await buildFullPdf(parts, META);
    const indexPages = countIndexPages(parts.length);

    assert.equal(totalPages, indexPages + 6);
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), totalPages);
    assert.equal(entries.length, 3);
  });

  test('los números del índice apuntan a la página real de cada documento', async () => {
    const parts: PdfPart[] = [
      { url: 'https://x.example/', bytes: await makePdf(2) },
      { url: 'https://x.example/a', bytes: await makePdf(1) },
      { url: 'https://x.example/b', bytes: await makePdf(3) },
    ];
    const { entries } = await buildFullPdf(parts, META);
    const idx = countIndexPages(parts.length);

    // Primer documento justo después del índice; los siguientes desplazados por
    // las hojas que ocupó el anterior.
    assert.equal(entries[0]?.page, idx + 1);
    assert.equal(entries[1]?.page, idx + 3, 'el primero ocupa 2 hojas');
    assert.equal(entries[2]?.page, idx + 4);
  });

  test('con un índice de varias hojas los números siguen cuadrando', async () => {
    // 120 entradas fuerzan un índice de más de una hoja: es el caso donde una
    // estimación ingenua del tamaño del índice corre todos los números.
    const parts: PdfPart[] = await Promise.all(
      Array.from({ length: 120 }, async (_, i) => ({
        url: `https://x.example/p${i}`,
        bytes: await makePdf(1),
      })),
    );
    const { totalPages, entries } = await buildFullPdf(parts, { ...META, discovered: 120 });
    const idx = countIndexPages(120);

    assert.ok(idx > 1, 'el índice debe ocupar más de una hoja para que la prueba valga');
    assert.equal(totalPages, idx + 120);
    assert.equal(entries[0]?.page, idx + 1);
    assert.equal(entries[119]?.page, idx + 120, 'la última entrada apunta a la última hoja');
  });

  test('un cuerpo vacío produce solo el índice', async () => {
    const { totalPages, entries } = await buildFullPdf([], { ...META, discovered: 0 });
    assert.equal(entries.length, 0);
    assert.equal(totalPages, countIndexPages(0));
  });

  test('el aviso de truncado no rompe la paginación', async () => {
    const parts: PdfPart[] = [{ url: 'https://x.example/', bytes: await makePdf(1) }];
    const { totalPages } = await buildFullPdf(parts, {
      ...META,
      truncated: true,
      discovered: 1257,
      maxPages: 50,
      failed: 3,
    });
    assert.equal(totalPages, countIndexPages(1) + 1);
  });

  test('genera un índice legible por pdf-lib con URLs de caracteres raros', async () => {
    // Acentos sin escapar e IDN: Helvetica codifica WinAnsi y no los soporta.
    const bytes = await buildIndexPdf(
      [
        { url: 'https://x.example/categoría/niño', page: 2 },
        { url: 'https://xn--ncia-4ma.example/страница', page: 3 },
      ],
      META,
    );
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  });
});

describe('compressTimeoutFor', () => {
  test('el tope crece con el tamaño del documento', () => {
    const chico = compressTimeoutFor(1_000_000, 60_000);
    const grande = compressTimeoutFor(100_000_000, 60_000);
    assert.ok(grande > chico, 'un documento de 100 MB necesita más tiempo que uno de 1 MB');
  });

  test('nunca baja de la base', () => {
    assert.ok(compressTimeoutFor(0, 60_000) >= 60_000);
  });

  test('el documento que falló en la corrida real ahora sí alcanza', () => {
    // grupohule: full.pdf de ~104 MB se pasó del tope fijo de 180 s.
    assert.ok(compressTimeoutFor(104_569_414, 60_000) > 180_000);
  });

  test('tiene techo: un documento absurdo no bloquea la corrida para siempre', () => {
    assert.equal(compressTimeoutFor(10_000_000_000, 60_000), 900_000);
  });
});
