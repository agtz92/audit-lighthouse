import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withTimeout, withTimeoutOr, TimeoutError } from './timeout.js';

/**
 * Trabajo simulado. Sin unref() a propósito: el timer tiene que sostener el
 * event loop, o node:test cierra la prueba antes de que la promesa resuelva.
 * El unref() de la implementación sí es correcto: el timer del tope no debe
 * mantener vivo al proceso.
 */
const lento = (ms: number, valor = 'listo') =>
  new Promise<string>((r) => { setTimeout(() => r(valor), ms); });

describe('withTimeout', () => {
  test('deja pasar lo que termina a tiempo', async () => {
    assert.equal(await withTimeout(lento(5), 200, 'prueba'), 'listo');
  });

  test('lanza TimeoutError con la etiqueta y el tope', async () => {
    await assert.rejects(
      () => withTimeout(lento(500), 20, 'render del PDF'),
      (err: unknown) => {
        assert.ok(err instanceof TimeoutError);
        assert.equal(err.label, 'render del PDF');
        assert.equal(err.ms, 20);
        assert.match(err.message, /render del PDF excedió 20 ms/);
        return true;
      },
    );
  });

  test('propaga el error original si la promesa falla antes del tope', async () => {
    await assert.rejects(
      () => withTimeout(Promise.reject(new Error('fallo real')), 500, 'x'),
      /fallo real/,
    );
  });
});

describe('withTimeoutOr', () => {
  test('devuelve el fallback al agotarse en vez de lanzar', async () => {
    assert.equal(await withTimeoutOr(lento(500), 20, 'paso opcional', 'respaldo'), 'respaldo');
  });

  test('avisa por el callback cuando usa el fallback', async () => {
    let avisado: TimeoutError | undefined;
    await withTimeoutOr(lento(500), 20, 'paso', null, (e) => { avisado = e; });
    assert.ok(avisado instanceof TimeoutError);
    assert.equal(avisado.label, 'paso');
  });

  test('un error que NO es timeout sigue propagándose', async () => {
    // Un fallo real no debe confundirse con lentitud ni silenciarse.
    await assert.rejects(
      () => withTimeoutOr(Promise.reject(new Error('fallo real')), 500, 'x', 'respaldo'),
      /fallo real/,
    );
  });
});
