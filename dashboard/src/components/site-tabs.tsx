import Link from 'next/link';

/** Las dos vistas de un sitio: lo que mide la auditoría y lo que dice Google. */
export function SiteTabs({ siteId, current }: { siteId: string; current: 'rendimiento' | 'trafico' }) {
  return (
    <nav className="subtabs no-print" aria-label="Vistas del sitio">
      <Link href={`/sites/${siteId}`} className={current === 'rendimiento' ? 'on' : undefined}>Rendimiento</Link>
      <Link href={`/sites/${siteId}/trafico`} className={current === 'trafico' ? 'on' : undefined}>Búsqueda y tráfico</Link>
    </nav>
  );
}
