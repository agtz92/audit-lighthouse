import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compressTimeoutFor } from './compress.js';
import { writeFileAtomic, fileSize } from './atomic.js';
import { sitePdfPaths } from './site-pdfs.js';

describe('compressTimeoutFor', () => {
  test('el tope crece con el tamaño del documento', () => {
    assert.ok(compressTimeoutFor(100_000_000, 60_000) > compressTimeoutFor(1_000_000, 60_000));
  });

  test('nunca baja de la base', () => {
    assert.ok(compressTimeoutFor(0, 60_000) >= 60_000);
  });

  test('el documento que falló con el tope fijo ahora sí alcanza', () => {
    // Un full.pdf de ~104 MB se pasaba del tope fijo de 180 s y se guardaba
    // sin comprimir. Con el tope proporcional, no.
    assert.ok(compressTimeoutFor(104_569_414, 60_000) > 180_000);
  });

  test('tiene techo: un documento absurdo no bloquea la corrida para siempre', () => {
    assert.equal(compressTimeoutFor(10_000_000_000, 60_000), 900_000);
  });
});

describe('sitePdfPaths', () => {
  test('los dos archivos por sitio son los reportes de Lighthouse', () => {
    const p = sitePdfPaths('/data/pdfs', 'matmarkt', 7);
    assert.equal(p.desktop, '/data/pdfs/matmarkt/desktop.pdf');
    assert.equal(p.mobile, '/data/pdfs/matmarkt/mobile.pdf');
  });

  test('el temporal vive junto al destino, para que rename sea atómico', () => {
    const p = sitePdfPaths('/data/pdfs', 'matmarkt', 7);
    assert.ok(p.tmpDir.startsWith('/data/pdfs/matmarkt/'), 'cruzar sistemas de archivos rompería la atomicidad');
    assert.match(p.tmpDir, /\.tmp-7$/);
  });

  test('el servicio analytics usa temporales que la limpieza del worker no toca', () => {
    const w = sitePdfPaths('/data/pdfs', 'x', 7, 'worker').tmpDir;
    const a = sitePdfPaths('/data/pdfs', 'x', 7, 'analytics').tmpDir;
    assert.notEqual(w, a);
    assert.match(a, /\.tmp-analytics-7$/);
  });

  test('los cuatro documentos viven en la carpeta del sitio', () => {
    const p = sitePdfPaths('/data/pdfs', 'x', 1);
    assert.match(p.analitica, /analitica\.pdf$/);
    assert.match(p.integral, /integral\.pdf$/);
  });

  test('cada corrida usa su propio temporal', () => {
    assert.notEqual(
      sitePdfPaths('/data/pdfs', 'x', 1).tmpDir,
      sitePdfPaths('/data/pdfs', 'x', 2).tmpDir,
    );
  });
});

describe('writeFileAtomic', () => {
  test('escribe el archivo y devuelve su tamaño', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sitemon-'));
    try {
      const target = join(dir, 'a', 'b.pdf');
      const bytes = await writeFileAtomic(target, new Uint8Array([1, 2, 3, 4]));
      assert.equal(bytes, 4);
      assert.deepEqual([...(await readFile(target))], [1, 2, 3, 4]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reemplaza el archivo anterior de golpe, sin dejarlo a medias', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sitemon-'));
    try {
      const target = join(dir, 'x.pdf');
      await writeFileAtomic(target, new Uint8Array(100));
      await writeFileAtomic(target, new Uint8Array(20));
      assert.equal((await stat(target)).size, 20);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('no deja .tmp huérfanos que confundan a la siguiente corrida', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sitemon-'));
    try {
      const target = join(dir, 'x.pdf');
      await writeFileAtomic(target, new Uint8Array(10));
      assert.equal(await fileSize(`${target}.tmp`), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('si falla la escritura, el archivo anterior queda intacto', async () => {
    // Esta es LA garantía del sistema: una corrida rota nunca deja al usuario
    // sin PDF. Se fuerza el fallo poniendo un directorio donde va el .tmp.
    const dir = await mkdtemp(join(tmpdir(), 'sitemon-'));
    try {
      const target = join(dir, 'x.pdf');
      await writeFile(target, new Uint8Array([9, 9, 9]));
      const { mkdir } = await import('node:fs/promises');
      await mkdir(`${target}.tmp`);

      await assert.rejects(() => writeFileAtomic(target, new Uint8Array(50)));
      assert.deepEqual([...(await readFile(target))], [9, 9, 9], 'el contenido anterior debe sobrevivir');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('fileSize', () => {
  test('devuelve null en vez de lanzar cuando el archivo no existe', async () => {
    assert.equal(await fileSize('/no/existe/en/ningun/lado.pdf'), null);
  });
});
