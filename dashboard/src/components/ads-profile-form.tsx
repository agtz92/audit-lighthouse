'use client';

import { useActionState, useState } from 'react';
import { guardarPerfilAds, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

/** Lo que el negocio dice de sí mismo: Claude lo lee antes de cada análisis e informe. */
export function AdsProfileForm({ id, profile }: { id: string; profile: string }) {
  const [estado, accion, enviando] = useActionState(guardarPerfilAds, INICIAL);
  const [texto, setTexto] = useState(profile);
  return (
    <form action={accion} className="ads-profile">
      <input type="hidden" name="id" value={id} />
      <textarea
        name="profile"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        maxLength={4000}
        rows={5}
        placeholder="Qué vende el negocio, qué cuenta como una buena conversión (¿un WhatsApp vale lo mismo que una llamada?), temporadas, márgenes, qué no se debe tocar…"
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="ghost" type="submit" disabled={enviando || texto === profile}>
          {enviando ? 'Guardando…' : 'Guardar perfil'}
        </button>
        <span className="muted" style={{ fontSize: 11 }}>{texto.length.toLocaleString('es-MX')} / 4,000</span>
        {estado !== null && estado.message !== '' && (
          <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>
        )}
      </div>
    </form>
  );
}
