'use client';

import { useActionState } from 'react';
import { editarSitio, type ActionResult } from '@/app/config/actions';
import type { SiteEntry } from '@/lib/sites-file';

const INICIAL: ActionResult | null = null;

/**
 * Edición de un sitio que ya está en la lista.
 *
 * El identificador se muestra pero no se edita: nombra la carpeta de sus PDFs y
 * es la llave de su historial, así que cambiarlo no sería editar este sitio sino
 * crear otro y perder de vista el anterior. Va como campo oculto porque la acción
 * lo necesita para encontrar el nodo en el YAML.
 */
export function EditSiteForm({ site, defaultMaxPages }: { site: SiteEntry; defaultMaxPages: number | null }) {
  const [estado, accion, enviando] = useActionState(editarSitio, INICIAL);
  const err = estado?.fieldErrors ?? {};

  return (
    <form action={accion} className="site-form">
      <input type="hidden" name="id" value={site.id} />
      <div className="grid">
        <label>
          <span>Nombre</span>
          <input name="name" required defaultValue={site.name} aria-invalid={err.name !== undefined} />
          <small className={err.name !== undefined ? 'bad' : undefined}>
            {err.name ?? 'Como aparece en la tabla y en el informe'}
          </small>
        </label>

        <label>
          <span>URL principal</span>
          <input name="url" required type="url" defaultValue={site.url} aria-invalid={err.url !== undefined} />
          <small className={err.url !== undefined ? 'bad' : undefined}>
            {err.url ?? 'La que recibe Lighthouse y encabeza el informe'}
          </small>
        </label>

        <label>
          <span>Sitemap <em>(opcional)</em></span>
          <input
            name="sitemap"
            type="url"
            defaultValue={site.sitemap ?? ''}
            placeholder={`${site.url.replace(/\/$/, '')}/sitemap.xml`}
            aria-invalid={err.sitemap !== undefined}
          />
          <small className={err.sitemap !== undefined ? 'bad' : undefined}>
            {err.sitemap ??
              (site.sitemap === undefined
                ? 'Ahora se descubre solo; declararlo evita adivinar'
                : 'Vacíalo para volver a descubrirlo solo')}
          </small>
        </label>

        <label>
          <span>Máximo de páginas <em>(opcional)</em></span>
          <input
            name="maxPages"
            type="number"
            min={1}
            max={5000}
            defaultValue={site.maxPages ?? ''}
            placeholder={String(defaultMaxPages ?? 5)}
            aria-invalid={err.maxPages !== undefined}
          />
          <small className={err.maxPages !== undefined ? 'bad' : undefined}>
            {err.maxPages ?? `Vacío hereda el default (${defaultMaxPages ?? 5})`}
          </small>
        </label>

        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={site.enabled} />
          <span>Auditar en las próximas corridas</span>
        </label>
      </div>

      <div className="actions">
        <button type="submit" disabled={enviando}>
          {enviando ? 'Guardando…' : 'Guardar cambios'}
        </button>
        {estado !== null && <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>}
      </div>
    </form>
  );
}
