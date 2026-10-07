/**
 * Llamadas a las APIs de Google con reintentos y errores legibles.
 *
 * Los errores de Google son precisos pero crípticos —"PERMISSION_DENIED",
 * "SERVICE_DISABLED"—, y quien los va a leer es una persona en la pantalla de
 * configuración de un sitio. Así que se traducen aquí, en un solo lugar, a lo
 * que hay que hacer para arreglarlos.
 */

import type { TokenSource } from './auth.js';

/** Qué salió mal, en términos de qué tiene que hacer quien lo lee. */
export type GoogleErrorKind =
  | 'permission'     // la cuenta de servicio no tiene acceso a la propiedad
  | 'not_found'      // la propiedad no existe o está mal escrita
  | 'api_disabled'   // la API no está habilitada en el proyecto de Google Cloud
  | 'auth'           // la llave no sirve
  | 'quota'          // se agotó la cuota; se reintentó y no alcanzó
  | 'invalid'        // la petición está mal formada
  | 'network'        // no hubo respuesta
  | 'unknown';

export class GoogleApiError extends Error {
  override readonly name = 'GoogleApiError';
  constructor(
    message: string,
    readonly kind: GoogleErrorKind,
    readonly status: number | null,
    /** El mensaje original de Google, para el log. */
    readonly raw: string,
  ) {
    super(message);
  }
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: Array<{ reason?: string; '@type'?: string }>;
  };
}

/**
 * Traduce una respuesta de error. Separado de la red para poder probarlo con
 * los cuerpos reales que devuelve Google.
 */
export function classifyGoogleError(status: number, body: GoogleErrorBody, api: string): GoogleApiError {
  const msg = body.error?.message ?? `HTTP ${status}`;
  const estado = body.error?.status ?? '';
  const razones = (body.error?.details ?? []).map((d) => d.reason ?? '').join(' ');

  if (razones.includes('SERVICE_DISABLED') || /has not been used in project|is disabled/i.test(msg)) {
    return new GoogleApiError(
      `La ${api} no está habilitada en el proyecto de Google Cloud de la cuenta de servicio. Habilítala en APIs y servicios › Biblioteca.`,
      'api_disabled', status, msg,
    );
  }
  if (status === 401 || estado === 'UNAUTHENTICATED') {
    return new GoogleApiError('Google no aceptó las credenciales de la cuenta de servicio.', 'auth', status, msg);
  }
  if (status === 403 || estado === 'PERMISSION_DENIED') {
    return new GoogleApiError(
      'La cuenta de servicio no tiene acceso a esta propiedad. Agrégala como usuario con permiso de lectura.',
      'permission', status, msg,
    );
  }
  if (status === 404 || estado === 'NOT_FOUND') {
    return new GoogleApiError('La propiedad no existe. Revisa que el identificador esté bien escrito.', 'not_found', status, msg);
  }
  if (status === 429 || estado === 'RESOURCE_EXHAUSTED') {
    return new GoogleApiError('Se agotó la cuota de la API de Google. Se reintentará en la próxima sincronización.', 'quota', status, msg);
  }
  if (status === 400 || estado === 'INVALID_ARGUMENT') {
    return new GoogleApiError(`Google rechazó la consulta: ${msg}`, 'invalid', status, msg);
  }
  return new GoogleApiError(`Error de Google (${status}): ${msg}`, 'unknown', status, msg);
}

function reintentable(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface GoogleClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  timeoutMs?: number;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

export class GoogleClient {
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #attempts: number;
  readonly #timeoutMs: number;

  constructor(
    private readonly tokens: Pick<TokenSource, 'token'>,
    opts: GoogleClientOptions = {},
  ) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? dormir;
    this.#attempts = opts.attempts ?? 4;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /**
   * GET o POST con JSON. `api` es el nombre legible de la API, para el
   * mensaje de error ("la API de Search Console no está habilitada").
   */
  async request<T>(api: string, url: string, body?: unknown): Promise<T> {
    let ultimo: GoogleApiError | null = null;

    for (let intento = 1; intento <= this.#attempts; intento += 1) {
      let res: Response;
      try {
        res = await this.#fetch(url, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${await this.tokens.token()}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'CredentialsError') throw err;
        ultimo = new GoogleApiError(
          `No se pudo contactar a Google: ${err instanceof Error ? err.message : String(err)}`,
          'network', null, String(err),
        );
        if (intento < this.#attempts) await this.#sleep(1000 * 2 ** (intento - 1));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      const cuerpo = (await res.json().catch(() => ({}))) as GoogleErrorBody;
      ultimo = classifyGoogleError(res.status, cuerpo, api);
      if (!reintentable(res.status)) throw ultimo;
      if (intento < this.#attempts) await this.#sleep(1000 * 2 ** (intento - 1));
    }

    throw ultimo ?? new GoogleApiError('Google no respondió', 'unknown', null, '');
  }
}
