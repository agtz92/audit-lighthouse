/**
 * Cliente del endpoint de control del worker.
 *
 * El dashboard no puede auditar: no tiene Chromium ni escribe en la base. Lo que
 * hace es pedírselo al worker por la red interna de Compose, donde `worker` es
 * un nombre que solo resuelve ahí dentro.
 *
 * Las respuestas se traducen a mensajes en español para la pantalla, porque un
 * 409 crudo no le dice nada a quien está mirando la lista de sitios.
 */

const WORKER_URL = process.env.WORKER_URL ?? 'http://worker:8099';

/** Tope de espera. El worker contesta en cuanto registra la corrida, no al terminarla. */
const TIMEOUT_MS = 15_000;

export interface RunRequestResult {
  ok: boolean;
  message: string;
  runId?: number;
}

interface WorkerResponse {
  ok?: boolean;
  runId?: number;
  error?: string;
}

/**
 * Pide una auditoría. Sin siteId, pide la corrida completa.
 *
 * Nunca lanza: todos los fallos —worker apagado, timeout, respuesta rara—
 * salen como un resultado con ok en false, porque quien llama es una acción de
 * formulario y lo que necesita es un mensaje que mostrar.
 */
export async function requestRun(siteId?: string): Promise<RunRequestResult> {
  let res: Response;
  try {
    res = await fetch(`${WORKER_URL}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: siteId ?? null }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `No se pudo hablar con el worker (${motivo}). Revisa que su contenedor esté arriba.`,
    };
  }

  let body: WorkerResponse;
  try {
    body = (await res.json()) as WorkerResponse;
  } catch {
    return { ok: false, message: `El worker respondió ${res.status} sin un cuerpo entendible.` };
  }

  if (res.status === 202 && typeof body.runId === 'number') {
    return { ok: true, message: '', runId: body.runId };
  }
  if (res.status === 409) {
    return {
      ok: false,
      message: 'Ya hay una auditoría en curso. Espera a que termine: el worker corre una a la vez.',
    };
  }
  return { ok: false, message: body.error ?? `El worker respondió ${res.status}.` };
}

/** Si el worker está vivo y si está ocupado. Para pintar el botón, no para decidir nada. */
export async function workerHealth(): Promise<{ alcanzable: boolean; corriendo: boolean }> {
  try {
    const res = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { alcanzable: false, corriendo: false };
    const body = (await res.json()) as { corriendo?: boolean };
    return { alcanzable: true, corriendo: body.corriendo === true };
  } catch {
    return { alcanzable: false, corriendo: false };
  }
}
