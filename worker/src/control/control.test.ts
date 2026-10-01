import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRunRequest } from './server.js';

describe('parseRunRequest', () => {
  test('un cuerpo vacío pide la corrida completa', () => {
    assert.deepEqual(parseRunRequest(''), { ok: true, siteId: undefined });
    assert.deepEqual(parseRunRequest('   '), { ok: true, siteId: undefined });
  });

  test('un objeto vacío también pide la corrida completa', () => {
    assert.deepEqual(parseRunRequest('{}'), { ok: true, siteId: undefined });
  });

  test('lee el sitio pedido', () => {
    assert.deepEqual(parseRunRequest('{"siteId":"hule-mx"}'), { ok: true, siteId: 'hule-mx' });
  });

  test('cadena vacía o null se leen como "todos"', () => {
    assert.deepEqual(parseRunRequest('{"siteId":""}'), { ok: true, siteId: undefined });
    assert.deepEqual(parseRunRequest('{"siteId":null}'), { ok: true, siteId: undefined });
  });

  test('rechaza JSON mal formado', () => {
    const r = parseRunRequest('{siteId:');
    assert.equal(r.ok, false);
  });

  test('rechaza un cuerpo que no es objeto', () => {
    assert.equal(parseRunRequest('"hule-mx"').ok, false);
    assert.equal(parseRunRequest('42').ok, false);
  });

  test('rechaza un siteId que no es cadena', () => {
    assert.equal(parseRunRequest('{"siteId":42}').ok, false);
  });

  test('rechaza identificadores fuera del contrato del YAML', () => {
    // El id acaba nombrando una carpeta de PDFs: aquí es donde se corta
    // cualquier intento de meter rutas o mayúsculas por la puerta de atrás.
    for (const malo of ['../otro', 'con espacio', 'MAYUSCULAS', 'con/barra', '-empieza-con-guion', 'acentuadó']) {
      const r = parseRunRequest(JSON.stringify({ siteId: malo }));
      assert.equal(r.ok, false, `debería rechazar "${malo}"`);
    }
  });

  test('acepta los identificadores que el YAML permite', () => {
    for (const bueno of ['corthw', 'hule-mx', '3minread', '10datos']) {
      const r = parseRunRequest(JSON.stringify({ siteId: bueno }));
      assert.equal(r.ok, true, `debería aceptar "${bueno}"`);
    }
  });

  test('rechaza un identificador más largo que el tope del YAML', () => {
    const r = parseRunRequest(JSON.stringify({ siteId: 'a'.repeat(65) }));
    assert.equal(r.ok, false);
  });
});
