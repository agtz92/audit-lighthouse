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
import { addSite, removeSite, setSiteEnabled, siteInputSchema, SitesFileError } from '@/lib/sites-file';

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

export async function crearSitio(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  const parsed = siteInputSchema.safeParse({
    id: form.get('id'),
    name: form.get('name'),
    url: form.get('url'),
    sitemap: form.get('sitemap'),
    maxPages: form.get('maxPages'),
    enabled: form.get('enabled') === 'on',
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const campo = String(issue.path[0] ?? '');
      fieldErrors[campo] ??= issue.message;
    }
    return { ok: false, message: 'Revisa los campos marcados.', fieldErrors };
  }

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
