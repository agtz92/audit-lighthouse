/**
 * «Probar conexión» y la lista de propiedades disponibles, para la pantalla
 * de configuración de cada sitio.
 *
 * Prueba lo que el usuario escribió, no lo guardado: la idea es saber si
 * funciona ANTES de guardarlo en sites.yaml.
 */

import { fetchGscDaily, listGscSites, type GscSiteEntry } from '../google/search-console.js';
import { fetchGaDaily, fetchKeyEventNames, listGaProperties, type GaPropertySummary } from '../google/ga4.js';
import { GoogleApiError, type GoogleClient } from '../google/client.js';
import { GSC_PROPERTY, GA4_PROPERTY } from '../config/sites.js';
import { addDays } from './periods.js';

export interface SourceCheck {
  ok: boolean;
  message: string;
  /** Último día con datos que encontró la prueba. */
  latestDate?: string | null;
}

export interface ConnectionCheck {
  searchConsole: SourceCheck | null;
  ga4: (SourceCheck & { keyEvents: string[]; keyEventsError: string | null }) | null;
}

function mensaje(err: unknown): string {
  return err instanceof GoogleApiError || err instanceof Error ? err.message : String(err);
}

export async function testConnection(
  client: GoogleClient,
  input: { searchConsole?: string | null; ga4Property?: string | null },
  today: string,
): Promise<ConnectionCheck> {
  const out: ConnectionCheck = { searchConsole: null, ga4: null };
  const desde = addDays(today, -10);
  const hasta = addDays(today, -1);

  const gsc = input.searchConsole?.trim() ?? '';
  if (gsc !== '') {
    if (!GSC_PROPERTY.test(gsc)) {
      out.searchConsole = { ok: false, message: 'Escríbela como sc-domain:dominio.com o como URL completa terminada en /.' };
    } else {
      try {
        const filas = await fetchGscDaily(client, gsc, desde, hasta);
        const ultimo = filas[filas.length - 1]?.date ?? null;
        out.searchConsole = {
          ok: true,
          latestDate: ultimo,
          message: ultimo === null
            ? 'Hay acceso, pero la propiedad no tiene datos de los últimos 10 días.'
            : `Acceso confirmado. Hay datos hasta el ${ultimo}.`,
        };
      } catch (err) {
        out.searchConsole = { ok: false, message: mensaje(err) };
      }
    }
  }

  const ga = (input.ga4Property ?? '').trim().replace(/^properties\//, '');
  if (ga !== '') {
    if (!GA4_PROPERTY.test(ga)) {
      out.ga4 = {
        ok: false,
        message: 'Es el número de la propiedad (Administrar › Detalles de la propiedad), no el ID de medición G-XXXX.',
        keyEvents: [],
        keyEventsError: null,
      };
    } else {
      try {
        const filas = await fetchGaDaily(client, ga, desde, hasta);
        const sesiones = filas.reduce((a, r) => a + r.sessions, 0);
        let keyEvents: string[] = [];
        let keyEventsError: string | null = null;
        try {
          keyEvents = await fetchKeyEventNames(client, ga);
        } catch (err) {
          keyEventsError = mensaje(err);
        }
        out.ga4 = {
          ok: true,
          latestDate: filas[filas.length - 1]?.date ?? null,
          message: sesiones === 0
            ? 'Hay acceso, pero la propiedad no registró sesiones en los últimos 10 días. ¿La etiqueta está instalada?'
            : `Acceso confirmado. ${sesiones.toLocaleString('es-MX')} sesiones en los últimos 10 días.`,
          keyEvents,
          keyEventsError,
        };
      } catch (err) {
        out.ga4 = { ok: false, message: mensaje(err), keyEvents: [], keyEventsError: null };
      }
    }
  }

  return out;
}

export interface AvailableProperties {
  searchConsole: GscSiteEntry[];
  searchConsoleError: string | null;
  ga4: GaPropertySummary[];
  ga4Error: string | null;
}

/** Lo que la cuenta de servicio puede ver, para ofrecerlo en una lista y no a mano. */
export async function availableProperties(client: GoogleClient): Promise<AvailableProperties> {
  const [gsc, ga] = await Promise.allSettled([listGscSites(client), listGaProperties(client)]);
  return {
    searchConsole: gsc.status === 'fulfilled' ? gsc.value : [],
    searchConsoleError: gsc.status === 'rejected' ? mensaje(gsc.reason) : null,
    ga4: ga.status === 'fulfilled' ? ga.value : [],
    ga4Error: ga.status === 'rejected' ? mensaje(ga.reason) : null,
  };
}
