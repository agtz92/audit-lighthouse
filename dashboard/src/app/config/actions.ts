'use server';

/**
 * Acciones de servidor para administrar sites.yaml.
 *
 * El dashboard no tiene autenticación porque vive en una red local de confianza;
 * estas acciones escriben un archivo de configuración, así que son la parte con
 * más consecuencias de toda la aplicación. Por eso validan igual que el worker
 * antes de tocar el disco: si algo pasara aquí y fallara allá, la auditoría de
 * las 06:00 se caería completa y nadie se enteraría hasta la mañana.
 */

import { revalidatePath } from 'next/cache';
import {
  addSite,
  editSite,
  removeSite,
  setSiteEnabled,
  setSitePages,
  siteInputSchema,
  siteEditSchema,
  pagesInputSchema,
  googleInputSchema,
  setSiteGoogle,
  SitesFileError,
} from '@/lib/sites-file';
import { requestRun } from '@/lib/worker-control';
import { requestSync, testConnection, type ConnectionCheck } from '@/lib/analytics-control';

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Errores por campo, para señalar el input exacto en el formulario. */
  fieldErrors?: Record<string, string>;
}

function fail(err: unknown): ActionResult {
  if (err instanceof SitesFileError) return { ok: false, message: err.message };
  return { ok: false, message: err instanceof Error ? err.message : String(err) };
}

/** Los campos del sitio tal como los manda cualquiera de los dos formularios. */
function camposDe(form: FormData): Record<string, unknown> {
  return {
    id: form.get('id'),
    name: form.get('name'),
    url: form.get('url'),
    sitemap: form.get('sitemap'),
    maxPages: form.get('maxPages'),
    enabled: form.get('enabled') === 'on',
  };
}

function porCampo(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): ActionResult {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues) {
    const campo = String(issue.path[0] ?? '');
    fieldErrors[campo] ??= issue.message;
  }
  return { ok: false, message: 'Revisa los campos marcados.', fieldErrors };
}

export async function crearSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = siteInputSchema.safeParse(camposDe(form));
  if (!parsed.success) return porCampo(parsed.error);

  try {
    await addSite(parsed.data);
  } catch (err) {
    return fail(err);
  }

  revalidatePath('/config');
  revalidatePath('/');
  return {
    ok: true,
    message: `"${parsed.data.name}" quedó agregado. Se auditará en la próxima corrida; no hace falta reiniciar nada.`,
  };
}

export async function quitarSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get('id') ?? '');
  try {
    await removeSite(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath('/config');
  revalidatePath('/');
  return {
    ok: true,
    message: `"${id}" salió de la lista. Su historial y sus PDFs se conservan; si lo vuelves a agregar con el mismo identificador, los recupera.`,
  };
}

export async function alternarSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get('id') ?? '');
  const enabled = form.get('enabled') === 'true';
  try {
    await setSiteEnabled(id, enabled);
  } catch (err) {
    return fail(err);
  }
  revalidatePath('/config');
  revalidatePath('/');
  return { ok: true, message: enabled ? `"${id}" quedó habilitado.` : `"${id}" quedó en pausa: deja de auditarse pero conserva su historial.` };
}

export async function editarSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = siteEditSchema.safeParse(camposDe(form));
  if (!parsed.success) return porCampo(parsed.error);

  try {
    await editSite(parsed.data);
  } catch (err) {
    return fail(err);
  }

  revalidatePath('/config');
  revalidatePath(`/config/${parsed.data.id}`);
  revalidatePath('/');
  revalidatePath(`/sites/${parsed.data.id}`);
  return {
    ok: true,
    message: `"${parsed.data.name}" quedó actualizado. Los cambios aplican en la próxima corrida.`,
  };
}

/**
 * Guarda las páginas elegidas para un sitio.
 *
 * Llegan como varios campos "pages" del mismo formulario, que es lo que manda un
 * grupo de checkboxes. Ninguno marcado es una petición válida y explícita: quiere
 * decir «vuelve al descubrimiento automático».
 */
export async function guardarPaginas(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = pagesInputSchema.safeParse({
    id: form.get('id'),
    pages: form.getAll('pages').map(String).filter((u) => u !== ''),
  });

  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'La selección no es válida.' };
  }

  try {
    await setSitePages(parsed.data);
  } catch (err) {
    return fail(err);
  }

  revalidatePath('/config');
  revalidatePath(`/config/${parsed.data.id}`);
  revalidatePath(`/sites/${parsed.data.id}`);
  return {
    ok: true,
    message:
      parsed.data.pages.length === 0
        ? 'Sin páginas elegidas: el sitio vuelve a descubrirlas solo en la próxima corrida.'
        : `${parsed.data.pages.length} página(s) elegidas. Se auditarán en la próxima corrida.`,
  };
}

/**
 * Pide al worker auditar un sitio ahora mismo.
 *
 * La acción vuelve en cuanto la corrida queda registrada, no cuando termina: una
 * auditoría completa de un sitio toma varios minutos —descubrimiento, páginas,
 * Lighthouse en escritorio y móvil, los dos PDFs— y dejar el formulario colgado
 * todo ese rato no le sirve a nadie. El avance se ve en Panorama.
 */
export async function auditarSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get('id') ?? '');
  if (id === '') return { ok: false, message: 'Falta el identificador del sitio.' };

  const r = await requestRun(id);
  if (!r.ok) return { ok: false, message: r.message };

  // La corrida escribe en la base conforme avanza; estas vistas la leen.
  revalidatePath('/');
  revalidatePath('/config');
  revalidatePath(`/config/${id}`);
  revalidatePath(`/sites/${id}`);

  return {
    ok: true,
    message: `Auditoría #${r.runId ?? '?'} en marcha. Toma unos minutos; puedes seguirla en Panorama.`,
  };
}

export interface GoogleActionResult extends ActionResult {
  /** Resultado de «Probar conexión», cuando eso fue lo que se pidió. */
  check?: ConnectionCheck;
}

/**
 * Guarda o prueba la conexión con Search Console y GA4.
 *
 * Es una sola acción con dos botones —`intent` dice cuál se presionó— porque
 * los dos trabajan sobre los mismos campos: lo natural es escribir, probar y,
 * si salió bien, guardar sin volver a teclear nada.
 */
export async function conexionGoogle(_prev: GoogleActionResult | null, form: FormData): Promise<GoogleActionResult> {
  const parsed = googleInputSchema.safeParse({
    id: form.get('id'),
    searchConsole: form.get('searchConsole'),
    ga4Property: form.get('ga4Property'),
  });
  if (!parsed.success) return porCampo(parsed.error);

  if (form.get('intent') === 'probar') {
    if (parsed.data.searchConsole === undefined && parsed.data.ga4Property === undefined) {
      return { ok: false, message: 'Escribe al menos una de las dos propiedades para probarla.' };
    }
    const check = await testConnection({
      searchConsole: parsed.data.searchConsole ?? null,
      ga4Property: parsed.data.ga4Property ?? null,
    });
    if (!check.ok) return { ok: false, message: check.error ?? 'No se pudo probar la conexión.' };
    const fuentes = [check.searchConsole, check.ga4].filter((c) => c !== null);
    const bien = fuentes.every((c) => c.ok);
    return {
      ok: bien,
      message: bien ? 'Conexión confirmada. Ya puedes guardar.' : 'Hay algo que corregir antes de guardar.',
      check,
    };
  }

  try {
    await setSiteGoogle(parsed.data);
  } catch (err) {
    return fail(err);
  }

  revalidatePath(`/config/${parsed.data.id}`);
  revalidatePath(`/sites/${parsed.data.id}`);
  revalidatePath('/trafico');
  const conectado = parsed.data.searchConsole !== undefined || parsed.data.ga4Property !== undefined;
  return {
    ok: true,
    message: conectado
      ? 'Guardado. La próxima sincronización trae su historial completo; puedes pedirla ahora con «Sincronizar ahora».'
      : 'Conexión quitada. El historial de tráfico ya guardado se conserva.',
  };
}

/** Pide al servicio analytics sincronizar un sitio, o todos, ahora mismo. */
export async function sincronizarTrafico(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const id = String(form.get('id') ?? '');
  const r = await requestSync(id === '' ? undefined : id);
  if (!r.ok) return { ok: false, message: r.message };
  revalidatePath('/trafico');
  revalidatePath('/runs');
  if (id !== '') revalidatePath(`/sites/${id}/trafico`);
  return {
    ok: true,
    message: `Sincronización #${r.runId ?? '?'} en marcha. Toma uno o dos minutos; la primera de un sitio, un poco más.`,
  };
}
