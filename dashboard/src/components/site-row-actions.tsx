'use client';

import { useActionState } from 'react';
import { alternarSitio, quitarSitio, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

export function ToggleSite({ id, enabled }: { id: string; enabled: boolean }) {
  const [estado, accion, enviando] = useActionState(alternarSitio, INICIAL);
  return (
    <form action={accion} style={{ display: 'inline' }}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="enabled" value={enabled ? 'false' : 'true'} />
      <button className="ghost" type="submit" disabled={enviando} title={enabled ? 'Dejar de auditarlo, conservando su historial' : 'Volver a auditarlo'}>
        {enviando ? '…' : enabled ? 'Pausar' : 'Reanudar'}
      </button>
      {estado?.ok === false && <span className="msg bad"> {estado.message}</span>}
    </form>
  );
}

/**
 * Quitar es destructivo sobre la configuración, así que pide confirmación.
 * El historial NO se borra: eso se explica en el mensaje, porque «quitar» suena
 * a que se pierde todo y aquí no es el caso.
 */
export function RemoveSite({ id, name }: { id: string; name: string }) {
  const [estado, accion, enviando] = useActionState(quitarSitio, INICIAL);
  return (
    <form
      action={accion}
      style={{ display: 'inline' }}
      onSubmit={(e) => {
        const ok = window.confirm(
          `¿Quitar "${name}" de la lista?\n\nDeja de auditarse, pero su historial de corridas y sus PDFs se conservan. Si lo vuelves a agregar con el identificador "${id}", los recupera.`,
        );
        if (!ok) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="ghost danger" type="submit" disabled={enviando}>
        {enviando ? '…' : 'Quitar'}
      </button>
      {estado?.ok === false && <span className="msg bad"> {estado.message}</span>}
    </form>
  );
}
