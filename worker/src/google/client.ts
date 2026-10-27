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
    details?: Array<{
      reason?: string;
      '@type'?: string;
      // Google Ads manda aquí su GoogleAdsFailure: el código preciso de cada error.
      errors?: Array<{ errorCode?: Record<string, string>; message?: string }>;
    }>;
  };
}

/**
 * Los errores de Google Ads traen un código propio por debajo del 403 o el 400
 * genérico: `authorizationError: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION`.
 * Es lo único que distingue «falta aprobar el token» de «la cuenta no está
 * vinculada al MCC», que se arreglan en lugares distintos.
 */
function classifyAdsFailure(status: number, body: GoogleErrorBody, api: string): GoogleApiError | null {
  const errores = (body.error?.details ?? []).flatMap((d) => d.errors ?? []);
  if (errores.length === 0) return null;
  const codigos = errores.flatMap((e) => Object.entries(e.errorCode ?? {}).map(([tipo, valor]) => `${tipo}.${valor}`));
  const msg = errores.map((e) => e.message ?? '').filter((m) => m !== '').join(' · ') || (body.error?.message ?? `HTTP ${status}`);
  const raw = `${codigos.join(', ')}: ${msg}`;
  const hay = (re: RegExp): boolean => codigos.some((c) => re.test(c));

  if (hay(/CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION|DEVELOPER_TOKEN_NOT_APPROVED/)) {
    return new GoogleApiError(
      'El developer token de Google Ads solo está aprobado para cuentas de prueba. Pide acceso Explorer o Basic en el Centro de API del MCC.',
      'permission', status, raw,
    );
  }
  if (hay(/DEVELOPER_TOKEN/)) {
    return new GoogleApiError('Google Ads rechazó el developer token. Revisa GOOGLE_ADS_DEVELOPER_TOKEN en .env.', 'auth', status, raw);
  }
  if (hay(/USER_PERMISSION_DENIED/)) {
    return new GoogleApiError(
      'La cuenta de servicio no tiene acceso a esta cuenta de Google Ads. Revisa que esté vinculada al MCC de GOOGLE_ADS_LOGIN_CUSTOMER_ID y que la cuenta de servicio sea usuaria del MCC.',
      'permission', status, raw,
    );
  }
  if (hay(/CUSTOMER_NOT_ENABLED|CUSTOMER_NOT_FOUND|INVALID_CUSTOMER_ID/)) {
    return new GoogleApiError('La cuenta de Google Ads no existe, está cancelada o no terminó de configurarse. Revisa adsCustomerId.', 'not_found', status, raw);
  }
  if (hay(/^authenticationError\./)) {
    return new GoogleApiError('Google Ads no aceptó las credenciales de la cuenta de servicio.', 'auth', status, raw);
  }
  if (hay(/^quotaError\./)) {
    return new GoogleApiError('Se agotó la cuota de la API de Google Ads. Se reintentará en la próxima sincronización.', 'quota', status, raw);
  }
  if (status === 400) {
    return new GoogleApiError(`Google Ads rechazó la consulta: ${msg}`, 'invalid', status, raw);
  }
  return new GoogleApiError(`Error de la ${api} (${status}): ${msg}`, 'unknown', status, raw);
}

/**
 * Traduce una respuesta de error. Separado de la red para poder probarlo con
 * los cuerpos reales que devuelve Google.
 */
export function classifyGoogleError(status: number, body: GoogleErrorBody, api: string): GoogleApiError {
  const ads = classifyAdsFailure(status, body, api);
  if (ads !== null) return ads;
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

/**
 * Un error de red, con la causa real. Node solo dice «fetch failed»; lo que
 * sirve —el código y el host— viene en `cause`, y sin eso no hay forma de
 * distinguir un DNS bloqueado de un tiempo de espera.
 */
export function networkError(err: unknown, url: string): GoogleApiError {
  const causa = (err as { cause?: { code?: unknown; hostname?: unknown; address?: unknown; message?: unknown } } | null)?.cause;
  const codigo = typeof causa?.code === 'string' ? causa.code : null;
  let host = typeof causa?.hostname === 'string' ? causa.hostname : null;
  if (host === null) {
    try {
      host = new URL(url).hostname;
    } catch {
      host = 'Google';
    }
  }
  const nombre = err instanceof Error ? err.name : '';
  const detalle = typeof causa?.message === 'string' ? causa.message : err instanceof Error ? err.message : String(err);
  const raw = `${err instanceof Error ? err.message : String(err)}${codigo === null ? '' : ` (${codigo})`}: ${detalle}`;

  if (nombre === 'TimeoutError' || nombre === 'AbortError') {
    return new GoogleApiError(`${host} no respondió a tiempo.`, 'network', null, raw);
  }
  // Un bloqueador de anuncios en la red (Pi-hole, AdGuard, NextDNS) contesta
  // «no existe» o 0.0.0.0 a los dominios con «googleads», y la API de Ads vive
  // justo en googleads.googleapis.com.
  const bloqueado = codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN'
    || (codigo === 'ECONNREFUSED' && (causa?.address === '0.0.0.0' || causa?.address === '::' || causa?.address === '127.0.0.1'));
  if (bloqueado) {
    return new GoogleApiError(
      `El DNS de este servidor no deja llegar a ${host} (${codigo}). Si la red tiene un bloqueador de anuncios (Pi-hole, AdGuard, NextDNS), agrega ${host} a su lista permitida.`,
      'network', null, raw,
    );
  }
  return new GoogleApiError(`No se pudo contactar a ${host}${codigo === null ? '' : ` (${codigo})`}: ${detalle}`, 'network', null, raw);
}

function reintentable(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface GoogleClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  timeoutMs?: number;
  /** Encabezados fijos de cada llamada: Google Ads pide developer-token y login-customer-id. */
  headers?: Record<string, string>;
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

export class GoogleClient {
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #attempts: number;
  readonly #timeoutMs: number;
  readonly #headers: Record<string, string>;

  constructor(
    private readonly tokens: Pick<TokenSource, 'token'>,
    opts: GoogleClientOptions = {},
  ) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#sleep = opts.sleep ?? dormir;
    this.#attempts = opts.attempts ?? 4;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#headers = opts.headers ?? {};
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
            ...this.#headers,
            authorization: `Bearer ${await this.tokens.token()}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (err instanceof Error && err.name === 'CredentialsError') throw err;
        ultimo = networkError(err, url);
        if (intento < this.#attempts) await this.#sleep(1000 * 2 ** (intento - 1));
        continue;
      }

      if (res.ok) return (await res.json()) as T;

      // searchStream de Google Ads manda el error dentro de un arreglo, como sus resultados.
      const crudo = (await res.json().catch(() => ({}))) as GoogleErrorBody | GoogleErrorBody[];
      const cuerpo = (Array.isArray(crudo) ? crudo[0] : crudo) ?? {};
      ultimo = classifyGoogleError(res.status, cuerpo, api);
      if (!reintentable(res.status)) throw ultimo;
      if (intento < this.#attempts) await this.#sleep(1000 * 2 ** (intento - 1));
    }

    throw ultimo ?? new GoogleApiError('Google no respondió', 'unknown', null, '');
  }
}
