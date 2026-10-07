/**
 * Endpoint de control del worker.
 *
 * Existe para una sola cosa: que el dashboard pueda pedir una auditoría a mano
 * sin esperar a las 06:00. El dashboard no puede correrla él —no tiene Chromium
 * ni acceso a la base para escribir— y darle el socket de Docker a un servicio
 * expuesto en la LAN sería mucho peor que este servidor de tres rutas.
 *
 * NO se publica al host: en docker-compose el worker declara `expose`, no
 * `ports`, así que este puerto solo existe dentro de la red de Compose. Quien
 * puede llamarlo es el dashboard. Eso sí: el dashboard sí está en la LAN y sin
 * autenticación, así que cualquiera que lo alcance puede disparar una corrida.
 * Es el mismo nivel de acceso que ya tenía para editar sites.yaml, y el peor
 * caso es gastar unos minutos de CPU, no perder datos.
 *
 * Una corrida a la vez, igual que el scheduler: el guardia es compartido, así
 * que un disparo manual nunca se encima con el de las 06:00.
 */

import { createServer, type Server } from 'node:http';
import { log } from '../lib/logger.js';

export interface ControlDeps {
  /** true si hay una corrida en curso, venga de donde venga. */
  isRunning: () => boolean;
  /**
   * Arranca una corrida. Devuelve el id en cuanto existe en la base, sin
   * esperar a que termine: una auditoría tarda minutos y la petición HTTP no se
   * queda colgada tanto tiempo.
   *
   * Null significa que no se pudo arrancar; el motivo va en el mensaje.
   */
  start: (siteId: string | undefined) => Promise<{ runId: number | null; error?: string }>;
}

/** Cuerpo de POST /run. */
interface RunRequest {
  siteId?: unknown;
}

/**
 * Valida el cuerpo de una petición de corrida.
 *
 * Separado del servidor para poder probarlo sin abrir un puerto. El siteId se
 * valida con el mismo contrato que el YAML: si trae algo raro, el error sale
 * aquí y no al construir una ruta de archivo con él.
 */
export function parseRunRequest(raw: string): { ok: true; siteId: string | undefined } | { ok: false; error: string } {
  if (raw.trim() === '') return { ok: true, siteId: undefined };

  let body: RunRequest;
  try {
    body = JSON.parse(raw) as RunRequest;
  } catch {
    return { ok: false, error: 'el cuerpo no es JSON válido' };
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'el cuerpo tiene que ser un objeto JSON' };
  }

  const { siteId } = body;
  if (siteId === undefined || siteId === null || siteId === '') {
    return { ok: true, siteId: undefined };
  }
  if (typeof siteId !== 'string') {
    return { ok: false, error: 'siteId tiene que ser una cadena' };
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(siteId)) {
    return { ok: false, error: `"${siteId}" no es un identificador de sitio válido` };
  }
  return { ok: true, siteId };
}

/** Lee el cuerpo con un tope: nadie tiene por qué mandar más que un id aquí. */
export async function readBody(req: NodeJS.ReadableStream, maxBytes = 4096): Promise<string> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error('cuerpo demasiado grande');
    partes.push(buf);
  }
  return Buffer.concat(partes).toString('utf8');
}

export function startControlServer(port: number, deps: ControlDeps): Server {
  const server = createServer((req, res) => {
    const responder = (code: number, body: Record<string, unknown>): void => {
      const texto = JSON.stringify(body);
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(texto),
      });
      res.end(texto);
    };

    void (async () => {
      const ruta = (req.url ?? '/').split('?')[0];

      if (req.method === 'GET' && ruta === '/health') {
        responder(200, { ok: true, corriendo: deps.isRunning() });
        return;
      }

      if (req.method === 'POST' && ruta === '/run') {
        let crudo: string;
        try {
          crudo = await readBody(req);
        } catch (err) {
          responder(413, { ok: false, error: err instanceof Error ? err.message : String(err) });
          return;
        }

        const parsed = parseRunRequest(crudo);
        if (!parsed.ok) {
          responder(400, { ok: false, error: parsed.error });
          return;
        }

        // 409 y no 500: que ya haya una corrida no es un error del sistema, es
        // una respuesta legítima que el dashboard traduce a "espera a que acabe".
        if (deps.isRunning()) {
          responder(409, { ok: false, error: 'ya hay una corrida en curso' });
          return;
        }

        const { runId, error } = await deps.start(parsed.siteId);
        if (runId === null) {
          responder(422, { ok: false, error: error ?? 'no se pudo arrancar la corrida' });
          return;
        }

        log.info('corrida pedida desde el dashboard', { run_id: runId, site_id: parsed.siteId ?? 'todos' });
        // 202: aceptada y en marcha, pero sin terminar. El resultado se sigue
        // por la base, que es donde el dashboard ya mira todo lo demás.
        responder(202, { ok: true, runId, siteId: parsed.siteId ?? null });
        return;
      }

      responder(404, { ok: false, error: 'ruta desconocida' });
    })();
  });

  // Escucha en todas las interfaces del contenedor, que con `expose` y sin
  // `ports` son solo las de la red de Compose.
  server.listen(port, '0.0.0.0', () => {
    log.info('endpoint de control escuchando', { puerto: port });
  });

  server.on('error', (err) => {
    log.error('el endpoint de control falló', err);
  });

  return server;
}
