'use client';

import { useActionState } from 'react';
import { generarInformesAds, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

/**
 * Genera los informes de Ads del sitio ahora, sin esperar al día semanal.
 * Lee de la base —no pide datos a Google Ads—; lo que cuesta es el texto de
 * Claude, así que el análisis semanal no se repite si ya hay uno reciente.
 */
export function AdsNow({ id }: { id: string }) {
  const [estado, accion, enviando] = useActionState(generarInformesAds, INICIAL);
  return (
    <form action={accion} style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <input type="hidden" name="id" value={id} />
      <button className="ghost" type="submit" disabled={enviando}>
        {enviando ? 'Pidiendo…' : 'Generar informes'}
      </button>
      {estado !== null && estado.message !== '' && (
        <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>
      )}
    </form>
  );
}
