import Link from 'next/link';

/** Las vistas de un sitio: lo que mide la auditoría, lo que dice Google, lo que pueden ver los asistentes de IA y sus anuncios. */
export function SiteTabs({ siteId, current }: { siteId: string; current: 'rendimiento' | 'trafico' | 'ia' | 'ads' }) {
  return (
    <nav className="subtabs no-print" aria-label="Vistas del sitio">
      <Link href={`/sites/${siteId}`} className={current === 'rendimiento' ? 'on' : undefined}>Rendimiento</Link>
      <Link href={`/sites/${siteId}/trafico`} className={current === 'trafico' ? 'on' : undefined}>Búsqueda y tráfico</Link>
      <Link href={`/sites/${siteId}/ia`} className={current === 'ia' ? 'on' : undefined}>Asistentes de IA</Link>
      <Link href={`/sites/${siteId}/ads`} className={current === 'ads' ? 'on' : undefined}>Google Ads</Link>
    </nav>
  );
}
