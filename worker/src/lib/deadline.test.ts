import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Deadline, SlotPool } from './deadline.js';

describe('Deadline', () => {
  test('un presupuesto amplio no está vencido y reporta tiempo restante', () => {
    const d = new Deadline(60_000);
    assert.equal(d.expired, false);
    assert.ok(d.remainingMs > 59_000 && d.remainingMs <= 60_000);
  });

  test('un presupuesto de cero está vencido de inmediato', () => {
    const d = new Deadline(0);
    assert.equal(d.expired, true);
    assert.equal(d.remainingMs, 0);
  });

  test('remainingMs nunca es negativo', () => {
    assert.equal(new Deadline(-5000).remainingMs, 0);
  });
});

describe('SlotPool', () => {
  test('entrega índices distintos y reutiliza los liberados', () => {
    const pool = new SlotPool(2);
    const a = pool.acquire();
    const b = pool.acquire();
    assert.notEqual(a, b);
    assert.deepEqual([a, b].sort(), [0, 1]);
    pool.release(a);
    assert.equal(pool.acquire(), a, 'debe reutilizar el slot liberado');
  });

  test('siempre da el slot libre más bajo, para que los puertos sean estables', () => {
    const pool = new SlotPool(3);
    const [a, b, c] = [pool.acquire(), pool.acquire(), pool.acquire()];
    pool.release(c);
    pool.release(a);
    assert.equal(pool.acquire(), a, 'el 0 antes que el 2');
    assert.equal(pool.acquire(), c);
    assert.equal(b, 1);
  });

  test('falla claro si se piden más slots de los que hay', () => {
    const pool = new SlotPool(1);
    pool.acquire();
    assert.throws(() => pool.acquire(), /SlotPool agotado/);
  });
});
