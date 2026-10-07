'use client';

import { useActionState } from 'react';
import { sincronizarTrafico, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

/**
 * Pide al servicio analytics traer el tráfico ahora, sin esperar a las 05:00.
 *
 * Sin confirmación, a diferencia de «Auditar ahora»: sincronizar son llamadas
 * a las APIs de Google que tardan uno o dos minutos y no ocupan Chromium ni
 * reemplazan nada que no fuera a reemplazarse mañana.
 */
export function SyncNow({ id }: { id?: string }) {
  const [estado, accion, enviando] = useActionState(sincronizarTrafico, INICIAL);
  return (
    <form action={accion} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <input type="hidden" name="id" value={id ?? ''} />
      <button className="ghost" type="submit" disabled={enviando}>
        {enviando ? 'Pidiendo…' : 'Sincronizar ahora'}
      </button>
      {estado !== null && estado.message !== '' && (
        <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>
      )}
    </form>
  );
}
