'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Recarga los datos del servidor cada cierto tiempo.
 *
 * 60 segundos, no 5: los datos cambian una vez al día a las 6am. Lo que justifica
 * cualquier refresco es detectar que la corrida de hoy acaba de terminar, y para
 * eso un minuto sobra. Se pausa cuando la pestaña no está visible, para no
 * consultar la base toda la noche contra un monitor apagado.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const [lastAt, setLastAt] = useState<Date | null>(null);

  useEffect(() => {
    const tick = (): void => {
      if (document.visibilityState !== 'visible') return;
      router.refresh();
      setLastAt(new Date());
    };
    const id = setInterval(tick, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return (
    <span className="sub" title={`se actualiza cada ${seconds} s mientras la pestaña esté visible`}>
      {lastAt === null
        ? `auto-refresco cada ${seconds} s`
        : `actualizado ${lastAt.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`}
    </span>
  );
}
