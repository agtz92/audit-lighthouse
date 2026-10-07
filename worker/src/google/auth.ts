/**
 * Autenticación con una cuenta de servicio de Google.
 *
 * Cuenta de servicio y no OAuth de usuario: el dashboard vive en la LAN, sin
 * HTTPS, y Google no acepta una IP privada como destino de regreso de OAuth.
 * Con una cuenta de servicio no hay pantalla de consentimiento ni tokens que
 * caduquen: basta con agregar su correo como usuario de lectura en cada
 * propiedad de Search Console y de GA4.
 *
 * El intercambio se hace a mano —firmar un JWT con la llave privada y
 * cambiarlo por un token de acceso— en lugar de traer google-auth-library: son
 * cuarenta líneas de node:crypto contra una dependencia con su propio árbol.
 */

import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Lo que importa del JSON que descarga la consola de Google Cloud. */
export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

/** Solo lectura en ambas APIs. Nunca hace falta escribir nada en Google. */
export const SCOPES = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

export class CredentialsError extends Error {
  override readonly name = 'CredentialsError';
}

export function parseServiceAccountKey(raw: string, source = 'la llave'): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new CredentialsError(`${source} no es JSON válido`);
  }
  if (json.type !== undefined && json.type !== 'service_account') {
    throw new CredentialsError(
      `${source} es de tipo "${String(json.type)}"; hace falta la llave de una cuenta de servicio`,
    );
  }
  const email = json.client_email;
  const key = json.private_key;
  if (typeof email !== 'string' || typeof key !== 'string') {
    throw new CredentialsError(`${source} no trae client_email y private_key`);
  }
  return {
    client_email: email,
    private_key: key,
    token_uri: typeof json.token_uri === 'string' ? json.token_uri : 'https://oauth2.googleapis.com/token',
    ...(typeof json.project_id === 'string' ? { project_id: json.project_id } : {}),
  };
}

export async function loadServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new CredentialsError(
      `no se encontró la llave de la cuenta de servicio en ${path}. Descárgala de Google Cloud y déjala en secrets/google-sa.json`,
    );
  }
  return parseServiceAccountKey(raw, path);
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

/** JWT firmado con RS256, listo para cambiarse por un token de acceso. */
export function signAssertion(key: ServiceAccountKey, scopes: string[], nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: key.token_uri,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const firma = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(firma)}`;
}

/**
 * Entrega tokens de acceso y los reutiliza mientras sirvan.
 *
 * Un token dura una hora; una sincronización completa dura un par de minutos y
 * hace cientos de llamadas. Pedir uno por llamada sería tirar la cuota de la
 * cuenta de servicio a la basura.
 */
export class TokenSource {
  #token: string | null = null;
  #expiresAt = 0;
  #pending: Promise<string> | null = null;

  constructor(
    readonly key: ServiceAccountKey,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get email(): string {
    return this.key.client_email;
  }

  async token(): Promise<string> {
    // Cinco minutos de margen: un token que vence a media petición da un 401
    // que parece un problema de permisos.
    if (this.#token !== null && Date.now() < this.#expiresAt - 300_000) return this.#token;
    // Varias llamadas en paralelo comparten la misma petición de token.
    this.#pending ??= this.#refresh().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }

  async #refresh(): Promise<string> {
    const res = await this.fetchImpl(this.key.token_uri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signAssertion(this.key, SCOPES),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || typeof body.access_token !== 'string') {
      throw new CredentialsError(
        `Google rechazó la cuenta de servicio (${body.error ?? res.status}): ${body.error_description ?? 'sin detalle'}. ¿La llave sigue activa en Google Cloud?`,
      );
    }
    this.#token = body.access_token;
    this.#expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return this.#token;
  }
}
