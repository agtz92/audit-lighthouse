'use client';

/**
 * Selector de las páginas que se auditan de un sitio.
 *
 * Dos decisiones que se ven en la pantalla y conviene dejar escritas:
 *
 * 1. La página principal está fija, marcada y no se puede quitar. Es la única URL
 *    que recibe Lighthouse y la que encabeza el informe, así que el worker la
 *    mete de todas formas. Si aquí se pudiera desmarcar, el worker la agregaría
 *    igual y empujaría fuera del tope a la última página elegida: una selección
 *    ignorada en silencio. Mostrarla fija dice la verdad —ocupa un lugar de los
 *    cinco— en lugar de esconderla.
 *
 * 2. Las opciones vienen precargadas con lo que el sistema ya venía auditando.
 *    Así la pantalla arranca en el estado actual y el trabajo es ajustar, no
 *    armar la lista desde cero.
 */

import { useActionState, useMemo, useState } from 'react';
import { guardarPaginas, type ActionResult } from '@/app/config/actions';
import { pathOf } from '@/lib/format';

const INICIAL: ActionResult | null = null;

export interface PagePickerProps {
  siteId: string;
  /** URL principal, tal como la audita el worker. Siempre entra. */
  homeUrl: string;
  /** Catálogo de URLs que el sitio ofrece, de la última corrida que descubrió algo. */
  catalog: string[];
  /** Precarga: lo elegido en el YAML si lo hay, o lo que auditó el sistema. */
  selected: string[];
  /** Tope de páginas del sitio, incluyendo la principal. */
  maxPages: number;
  /** true si la precarga viene de una selección ya guardada y no del automático. */
  yaGuardada: boolean;
}

export function PagePicker({
  siteId,
  homeUrl,
  catalog,
  selected,
  maxPages,
  yaGuardada,
}: PagePickerProps) {
  const [estado, accion, enviando] = useActionState(guardarPaginas, INICIAL);

  const esHome = (u: string): boolean => u === homeUrl;

  // Las opciones son el catálogo más cualquier cosa ya elegida que no esté en él:
  // una página que el sitemap dejó de listar sigue siendo una elección válida y
  // desaparecer de la pantalla sin avisar la borraría de hecho.
  const [opciones, setOpciones] = useState<string[]>(() => [
    ...new Set([...catalog.filter((u) => !esHome(u)), ...selected.filter((u) => !esHome(u))]),
  ]);
  const [elegidas, setElegidas] = useState<Set<string>>(
    () => new Set(selected.filter((u) => !esHome(u))),
  );
  const [filtro, setFiltro] = useState('');
  const [extra, setExtra] = useState('');
  const [errorExtra, setErrorExtra] = useState<string | null>(null);

  // La principal ocupa un lugar del tope.
  const cupo = Math.max(0, maxPages - 1);
  const lleno = elegidas.size >= cupo;

  const visibles = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    if (q === '') return opciones;
    return opciones.filter((u) => u.toLowerCase().includes(q));
  }, [opciones, filtro]);

  function alternar(url: string): void {
    setElegidas((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else if (next.size < cupo) next.add(url);
      return next;
    });
  }

  function agregar(): void {
    const valor = extra.trim();
    if (valor === '') return;
    let normalizada: string;
    try {
      const u = new URL(valor);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocolo');
      normalizada = u.toString();
    } catch {
      setErrorExtra('Escribe la URL completa, con https://');
      return;
    }
    if (esHome(normalizada) || opciones.includes(normalizada)) {
      setErrorExtra('Esa página ya está en la lista.');
      return;
    }
    if (lleno) {
      setErrorExtra(`Ya tienes ${maxPages} páginas. Quita una antes de agregar otra.`);
      return;
    }
    setOpciones((prev) => [...prev, normalizada]);
    setElegidas((prev) => new Set(prev).add(normalizada));
    setExtra('');
    setErrorExtra(null);
  }

  const total = elegidas.size + 1;

  return (
    <div className="picker">
      <form action={accion}>
        <input type="hidden" name="id" value={siteId} />

        <div className="picker-head">
          <div>
            <strong>
              {total} de {maxPages}
            </strong>{' '}
            <span className="sub">
              {yaGuardada
                ? 'páginas elegidas, guardadas en sites.yaml'
                : 'páginas: las que el sistema viene auditando'}
            </span>
          </div>
          {opciones.length > 12 && (
            <input
              type="search"
              className="picker-filtro"
              placeholder={`Filtrar ${opciones.length} páginas…`}
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
              aria-label="Filtrar el catálogo de páginas"
            />
          )}
        </div>

        <ul className="picker-list">
          {/* La principal: fija, marcada y enviada siempre. */}
          <li className="fija">
            <label>
              <input type="checkbox" checked disabled aria-label="Página principal, siempre incluida" />
              <span className="ruta">
                {pathOf(homeUrl)}
                <em>principal</em>
              </span>
            </label>
            <a href={homeUrl} target="_blank" rel="noreferrer noopener" className="mono">
              {homeUrl}
            </a>
            <input type="hidden" name="pages" value={homeUrl} />
          </li>

          {visibles.map((url) => {
            const marcada = elegidas.has(url);
            return (
              <li key={url} className={marcada ? 'marcada' : undefined}>
                <label>
                  <input
                    type="checkbox"
                    checked={marcada}
                    disabled={!marcada && lleno}
                    onChange={() => alternar(url)}
                  />
                  <span className="ruta">{pathOf(url)}</span>
                </label>
                <a href={url} target="_blank" rel="noreferrer noopener" className="mono">
                  {url}
                </a>
                {/* Solo las marcadas viajan al servidor. */}
                {marcada && <input type="hidden" name="pages" value={url} />}
              </li>
            );
          })}

          {visibles.length === 0 && (
            <li className="vacio">
              {opciones.length === 0
                ? 'Todavía no hay catálogo: se llena en la próxima corrida, cuando el sitio se descubra.'
                : 'Ninguna página coincide con el filtro.'}
            </li>
          )}
        </ul>

        <div className="picker-extra">
          <label>
            <span>Agregar una página que no esté en la lista</span>
            <div className="row">
              <input
                type="url"
                value={extra}
                placeholder="https://www.misitio.com/una-pagina"
                onChange={(e) => {
                  setExtra(e.target.value);
                  setErrorExtra(null);
                }}
                onKeyDown={(e) => {
                  // Enter aquí agregaría la página Y enviaría el formulario.
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    agregar();
                  }
                }}
              />
              <button type="button" className="ghost" onClick={agregar} disabled={extra.trim() === ''}>
                Agregar
              </button>
            </div>
            <small className={errorExtra === null ? undefined : 'bad'}>
              {errorExtra ??
                'Útil para páginas que el sitemap no lista: una campaña, una landing nueva.'}
            </small>
          </label>
        </div>

        <div className="picker-actions">
          <button type="submit" disabled={enviando}>
            {enviando ? 'Guardando…' : 'Guardar selección'}
          </button>
          {lleno && <span className="sub">Tope alcanzado: quita una para elegir otra.</span>}
          {estado !== null && <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>}
        </div>
      </form>

      {/*
        Volver a automático va en su propio formulario, sin campos "pages": la
        principal siempre viaja en el de arriba, así que desde ahí la selección
        nunca puede quedar vacía.
      */}
      {yaGuardada && <VolverAutomatico siteId={siteId} />}
    </div>
  );
}

function VolverAutomatico({ siteId }: { siteId: string }): React.JSX.Element {
  const [estado, accion, enviando] = useActionState(guardarPaginas, INICIAL);
  return (
    <form
      action={accion}
      className="picker-auto"
      onSubmit={(e) => {
        const ok = window.confirm(
          '¿Volver al descubrimiento automático?\n\nSe borra la selección guardada y el sitio vuelve a auditar las primeras páginas que encuentre en su sitemap.',
        );
        if (!ok) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={siteId} />
      <button type="submit" className="ghost" disabled={enviando}>
        {enviando ? '…' : 'Volver al descubrimiento automático'}
      </button>
      {estado?.ok === false && <span className="msg bad"> {estado.message}</span>}
    </form>
  );
}
