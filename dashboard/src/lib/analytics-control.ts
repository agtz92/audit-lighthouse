/**
 * Cliente del endpoint de control del servicio analytics.
 *
 * Igual que con el worker: el dashboard no habla con Google ni tiene la llave
 * de la cuenta de servicio. Le pide al servicio analytics, por la red interna
 * de Compose, que sincronice, que pruebe una conexión o que liste las
 * propiedades disponibles. Nada de esto lanza: todo vuelve como un resultado
 * con su mensaje, porque quien lo usa es una pantalla.
 */

const ANALYTICS_URL = process.env.ANALYTICS_URL ?? 'http://analytics:8098';

export interface AnalyticsHealth {
  alcanzable: boolean;
  corriendo: boolean;
  cuentaServicio: string | null;
  credencialesError: string | null;
}

export async function analyticsHealth(): Promise<AnalyticsHealth> {
  try {
    const res = await fetch(`${ANALYTICS_URL}/health`, { signal: AbortSignal.timeout(4000), cache: 'no-store' });
    const body = (await res.json()) as Partial<AnalyticsHealth>;
    return {
      alcanzable: res.ok,
      corriendo: body.corriendo === true,
      cuentaServicio: body.cuentaServicio ?? null,
      credencialesError: body.credencialesError ?? null,
    };
  } catch {
    return { alcanzable: false, corriendo: false, cuentaServicio: null, credencialesError: null };
  }
}

export interface SyncRequestResult {
  ok: boolean;
  message: string;
  runId?: number;
}

export async function requestSync(siteId?: string): Promise<SyncRequestResult> {
  let res: Response;
  try {
    res = await fetch(`${ANALYTICS_URL}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ siteId: siteId ?? null }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    return {
      ok: false,
      message: `No se pudo hablar con el servicio analytics (${err instanceof Error ? err.message : String(err)}). Revisa que su contenedor esté arriba.`,
    };
  }
  const body = (await res.json().catch(() => ({}))) as { runId?: number; error?: string };
  if (res.status === 202 && typeof body.runId === 'number') return { ok: true, message: '', runId: body.runId };
  if (res.status === 409) return { ok: false, message: 'Ya hay una sincronización en curso. Espera a que termine.' };
  return { ok: false, message: body.error ?? `El servicio analytics respondió ${res.status}.` };
}

export interface SourceCheck {
  ok: boolean;
  message: string;
  latestDate?: string | null;
}

export interface ConnectionCheck {
  ok: boolean;
  error?: string;
  searchConsole: SourceCheck | null;
  ga4: (SourceCheck & { keyEvents: string[]; keyEventsError: string | null }) | null;
}

export async function testConnection(input: { searchConsole: string | null; ga4Property: string | null }): Promise<ConnectionCheck> {
  try {
    const res = await fetch(`${ANALYTICS_URL}/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await res.json()) as Partial<ConnectionCheck> & { error?: string };
    if (!res.ok) return { ok: false, error: body.error ?? `respondió ${res.status}`, searchConsole: null, ga4: null };
    return { ok: true, searchConsole: body.searchConsole ?? null, ga4: body.ga4 ?? null };
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo hablar con el servicio analytics (${err instanceof Error ? err.message : String(err)}).`,
      searchConsole: null,
      ga4: null,
    };
  }
}

export interface AvailableProperties {
  searchConsole: Array<{ siteUrl: string; permissionLevel: string }>;
  searchConsoleError: string | null;
  ga4: Array<{ id: string; name: string; account: string }>;
  ga4Error: string | null;
}

/** Lo que la cuenta de servicio ve. Vacío si el servicio no responde: los campos siguen siendo de texto libre. */
export async function availableProperties(): Promise<AvailableProperties> {
  const vacio: AvailableProperties = { searchConsole: [], searchConsoleError: null, ga4: [], ga4Error: null };
  try {
    const res = await fetch(`${ANALYTICS_URL}/properties`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
    if (!res.ok) return vacio;
    const body = (await res.json()) as Partial<AvailableProperties>;
    return {
      searchConsole: body.searchConsole ?? [],
      searchConsoleError: body.searchConsoleError ?? null,
      ga4: body.ga4 ?? [],
      ga4Error: body.ga4Error ?? null,
    };
  } catch {
    return vacio;
  }
}
