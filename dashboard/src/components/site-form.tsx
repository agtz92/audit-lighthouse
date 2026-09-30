'use client';

import { useActionState } from 'react';
import { crearSitio, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

/** Alta de un sitio. Los errores se muestran junto al campo que los provoca. */
export function SiteForm({ defaultMaxPages }: { defaultMaxPages: number | null }) {
  const [estado, accion, enviando] = useActionState(crearSitio, INICIAL);
  const err = estado?.fieldErrors ?? {};

  return (
    <form action={accion} className="site-form">
      <div className="grid">
        <label>
          <span>Identificador</span>
          <input name="id" required placeholder="mi-sitio" aria-invalid={err.id !== undefined} />
          <small className={err.id !== undefined ? 'bad' : undefined}>
            {err.id ?? 'Permanente: nombra su carpeta de PDFs y su historial'}
          </small>
        </label>

        <label>
          <span>Nombre</span>
          <input name="name" required placeholder="Mi Sitio" aria-invalid={err.name !== undefined} />
          <small className={err.name !== undefined ? 'bad' : undefined}>
            {err.name ?? 'Como aparecerá en la tabla y en el informe'}
          </small>
        </label>

        <label>
          <span>URL principal</span>
          <input name="url" required type="url" placeholder="https://www.misitio.com" aria-invalid={err.url !== undefined} />
          <small className={err.url !== undefined ? 'bad' : undefined}>
            {err.url ?? 'La que recibe Lighthouse y encabeza el informe'}
          </small>
        </label>

        <label>
          <span>Sitemap <em>(opcional)</em></span>
          <input name="sitemap" type="url" placeholder="https://www.misitio.com/sitemap.xml" aria-invalid={err.sitemap !== undefined} />
          <small className={err.sitemap !== undefined ? 'bad' : undefined}>
            {err.sitemap ?? 'Si lo dejas vacío se descubre solo'}
          </small>
        </label>

        <label>
          <span>Máximo de páginas <em>(opcional)</em></span>
          <input name="maxPages" type="number" min={1} max={5000} placeholder={String(defaultMaxPages ?? 5)} aria-invalid={err.maxPages !== undefined} />
          <small className={err.maxPages !== undefined ? 'bad' : undefined}>
            {err.maxPages ?? `Vacío hereda el default (${defaultMaxPages ?? 5})`}
          </small>
        </label>

        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked />
          <span>Auditar desde la próxima corrida</span>
        </label>
      </div>

      <div className="actions">
        <button type="submit" disabled={enviando}>
          {enviando ? 'Agregando…' : 'Agregar sitio'}
        </button>
        {estado !== null && (
          <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>
        )}
      </div>
    </form>
  );
}
