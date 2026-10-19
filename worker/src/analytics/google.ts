/**
 * Cliente de Google del servicio analytics, creado una vez por proceso.
 *
 * La llave se lee al primer uso y no al arrancar: así el servicio puede estar
 * arriba —con su endpoint de salud diciendo qué falta— aunque todavía nadie
 * haya puesto el archivo en secrets/. Si falta, cada intento lo vuelve a buscar,
 * para que dejarlo ahí funcione sin reiniciar nada.
 */

import { loadServiceAccountKey, TokenSource, ADS_SCOPES } from '../google/auth.js';
import { GoogleClient } from '../google/client.js';

let cache: { client: GoogleClient; email: string } | null = null;

export async function googleClient(credentialsFile: string): Promise<{ client: GoogleClient; email: string }> {
  if (cache !== null) return cache;
  const key = await loadServiceAccountKey(credentialsFile);
  const tokens = new TokenSource(key);
  cache = { client: new GoogleClient(tokens), email: key.client_email };
  return cache;
}

let adsCache: GoogleClient | null = null;

/**
 * Cliente de Google Ads: la misma llave, pero con su propio token (el alcance
 * de Ads no es de solo lectura) y los dos encabezados que Ads exige.
 */
export async function googleAdsClient(
  credentialsFile: string,
  developerToken: string,
  loginCustomerId: string | undefined,
): Promise<GoogleClient> {
  if (adsCache !== null) return adsCache;
  const key = await loadServiceAccountKey(credentialsFile);
  adsCache = new GoogleClient(new TokenSource(key, fetch, ADS_SCOPES), {
    headers: {
      'developer-token': developerToken,
      ...(loginCustomerId === undefined ? {} : { 'login-customer-id': loginCustomerId }),
    },
  });
  return adsCache;
}

/** Correo de la cuenta de servicio, o el motivo por el que no se puede leer. */
export async function serviceAccountStatus(credentialsFile: string): Promise<{ email: string | null; error: string | null }> {
  try {
    const { email } = await googleClient(credentialsFile);
    return { email, error: null };
  } catch (err) {
    return { email: null, error: err instanceof Error ? err.message : String(err) };
  }
}
