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
  SitesFileError,
} from '@/lib/sites-file';

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
