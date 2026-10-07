/**
 * Cliente de Google del servicio analytics, creado una vez por proceso.
 *
 * La llave se lee al primer uso y no al arrancar: así el servicio puede estar
 * arriba —con su endpoint de salud diciendo qué falta— aunque todavía nadie
 * haya puesto el archivo en secrets/. Si falta, cada intento lo vuelve a buscar,
 * para que dejarlo ahí funcione sin reiniciar nada.
 */

import { loadServiceAccountKey, TokenSource } from '../google/auth.js';
import { GoogleClient } from '../google/client.js';

let cache: { client: GoogleClient; email: string } | null = null;

export async function googleClient(credentialsFile: string): Promise<{ client: GoogleClient; email: string }> {
  if (cache !== null) return cache;
  const key = await loadServiceAccountKey(credentialsFile);
  const tokens = new TokenSource(key);
  cache = { client: new GoogleClient(tokens), email: key.client_email };
  return cache;
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
