/**
 * Endpoint de control del servicio analytics.
 *
 * Mismo modelo que el del worker: solo existe dentro de la red de Compose
 * (`expose`, no `ports`) y quien lo llama es el dashboard. Rutas:
 *
 *   GET  /health       vivo, ocupado, y el correo de la cuenta de servicio
 *   POST /run          sincronizar ahora (todos, o { siteId })
 *   POST /test         probar { searchConsole, ga4Property } sin guardarlos
 *   GET  /properties   propiedades a las que la cuenta tiene acceso
 */

import { createServer, type Server, type ServerResponse } from 'node:http';
import { log } from '../lib/logger.js';
import { parseRunRequest, readBody } from '../control/server.js';
import type { ConnectionCheck, AvailableProperties } from './connection.js';

export interface AnalyticsControlDeps {
  isRunning: () => boolean;
  start: (siteId: string | undefined) => Promise<{ runId: number | null; error?: string }>;
  account: () => Promise<{ email: string | null; error: string | null }>;
  test: (input: { searchConsole: string | null; ga4Property: string | null }) => Promise<ConnectionCheck>;
  properties: () => Promise<AvailableProperties>;
}

/** Cuerpo de POST /test. Se acepta texto y nada más: va directo a una URL de Google. */
export function parseTestRequest(raw: string): { ok: true; searchConsole: string | null; ga4Property: string | null } | { ok: false; error: string } {
  let body: unknown;
  try {
    body = JSON.parse(raw === '' ? '{}' : raw);
  } catch {
    return { ok: false, error: 'el cuerpo no es JSON válido' };
  }
  if (body === null || typeof body !== 'object') return { ok: false, error: 'el cuerpo tiene que ser un objeto JSON' };
  const b = body as Record<string, unknown>;
  const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 200) : null);
  return { ok: true, searchConsole: texto(b.searchConsole), ga4Property: texto(b.ga4Property) };
}

function responder(res: ServerResponse, code: number, body: Record<string, unknown>): void {
  const texto = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(texto) });
  res.end(texto);
}

export function startAnalyticsControl(port: number, deps: AnalyticsControlDeps): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const ruta = (req.url ?? '/').split('?')[0];
      try {
        if (req.method === 'GET' && ruta === '/health') {
          const cuenta = await deps.account();
          responder(res, 200, { ok: true, corriendo: deps.isRunning(), cuentaServicio: cuenta.email, credencialesError: cuenta.error });
          return;
        }

        if (req.method === 'POST' && ruta === '/run') {
          const parsed = parseRunRequest(await readBody(req));
          if (!parsed.ok) return responder(res, 400, { ok: false, error: parsed.error });
          if (deps.isRunning()) return responder(res, 409, { ok: false, error: 'ya hay una sincronización en curso' });
          const { runId, error } = await deps.start(parsed.siteId);
          if (runId === null) return responder(res, 422, { ok: false, error: error ?? 'no se pudo arrancar la sincronización' });
          log.info('sincronización pedida desde el dashboard', { analytics_run_id: runId, site_id: parsed.siteId ?? 'todos' });
          return responder(res, 202, { ok: true, runId });
        }

        if (req.method === 'POST' && ruta === '/test') {
          const parsed = parseTestRequest(await readBody(req));
          if (!parsed.ok) return responder(res, 400, { ok: false, error: parsed.error });
          const resultado = await deps.test({ searchConsole: parsed.searchConsole, ga4Property: parsed.ga4Property });
          return responder(res, 200, { ok: true, ...resultado });
        }

        if (req.method === 'GET' && ruta === '/properties') {
          return responder(res, 200, { ok: true, ...(await deps.properties()) });
        }

        responder(res, 404, { ok: false, error: 'ruta desconocida' });
      } catch (err) {
        // Las credenciales que faltan llegan aquí: es información, no un 500 mudo.
        responder(res, 503, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  server.listen(port, '0.0.0.0', () => log.info('endpoint de control de analytics escuchando', { puerto: port }));
  server.on('error', (err) => log.error('el endpoint de control de analytics falló', err));
  return server;
}
