'use client';

import { useActionState } from 'react';
import { auditarSitio, type ActionResult } from '@/app/config/actions';

const INICIAL: ActionResult | null = null;

/**
 * Dispara una auditoría del sitio sin esperar a las 06:00.
 *
 * Pide confirmación porque no es gratis: ocupa el worker varios minutos —que
 * corre una auditoría a la vez— y reemplaza los dos PDFs del sitio. No es
 * destructivo, pero tampoco es algo que quieras haber disparado sin querer al
 * pasar por la fila.
 *
 * El mensaje de respuesta se muestra en la fila misma: el resultado tarda
 * minutos y no hay nada que esperar en pantalla, así que lo que importa es
 * confirmar que arrancó y decir dónde seguirla.
 */
export function AuditNow({ id, name, compacto = false }: { id: string; name: string; compacto?: boolean }) {
  const [estado, accion, enviando] = useActionState(auditarSitio, INICIAL);

  return (
    <form
      action={accion}
      style={{ display: compacto ? 'inline' : 'flex', alignItems: 'center', gap: 10 }}
      onSubmit={(e) => {
        const ok = window.confirm(
          `¿Auditar "${name}" ahora?\n\nToma unos minutos y ocupa el worker, que corre una auditoría a la vez. Reemplaza los dos informes del sitio con los nuevos.`,
        );
        if (!ok) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button className="ghost" type="submit" disabled={enviando} title="Correr la auditoría de este sitio ahora">
        {enviando ? 'Pidiendo…' : 'Auditar ahora'}
      </button>
      {estado !== null && estado.message !== '' && (
        <span className={estado.ok ? 'msg ok' : 'msg bad'}> {estado.message}</span>
      )}
    </form>
  );
}
