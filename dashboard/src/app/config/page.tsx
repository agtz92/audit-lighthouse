import Link from 'next/link';
import { readSitesFile, SitesFileError, SITES_FILE } from '@/lib/sites-file';
import { fetchOverview } from '@/lib/queries';
import { SiteForm } from '@/components/site-form';
import { ToggleSite, RemoveSite } from '@/components/site-row-actions';
import { StatusBadge } from '@/components/indicators';
import { fmtDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ConfigPage() {
  let archivo;
  try {
    archivo = await readSitesFile();
  } catch (err) {
    return (
      <div className="card">
        <div className="empty">
          No se pudo leer la lista de sitios.
          <div className="err-msg" style={{ marginTop: 8 }}>
            {err instanceof SitesFileError ? err.message : String(err)}
          </div>
        </div>
      </div>
    );
  }

  // Se cruza con la base para mostrar el estado de la última corrida de cada uno:
  // saber que un sitio está en la lista importa menos que saber cómo le fue.
  const overview = await fetchOverview();
  const porId = new Map(overview.map((o) => [o.siteId, o]));

  const habilitados = archivo.entries.filter((e) => e.enabled).length;

  return (
    <>
      <div className="card">
        <header>
          <h2>Sitios auditados</h2>
          <span className="sub">
            {archivo.entries.length} en la lista · {habilitados} activos · se leen de{' '}
            <code>{SITES_FILE}</code> en cada corrida
          </span>
        </header>

        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Sitio</th>
                <th>URL</th>
                <th>Sitemap</th>
                <th>Páginas</th>
                <th>Última corrida</th>
                <th>Estado en la lista</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {archivo.entries.map((e) => {
                const datos = porId.get(e.id);
                return (
                  <tr key={e.id} className={e.enabled ? undefined : 'row-warn'}>
                    <td>
                      <Link href={`/config/${e.id}`} style={{ fontWeight: 560 }}>{e.name}</Link>
                      <div style={{ fontSize: '10.5px', color: 'var(--ink-muted)' }}>{e.id}</div>
                    </td>
                    <td className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <a href={e.url} target="_blank" rel="noreferrer noopener">{e.url}</a>
                    </td>
                    <td style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                      {e.sitemap === undefined
                        ? <span style={{ color: 'var(--ink-muted)' }}>se descubre</span>
                        : <span className="pill">declarado</span>}
                    </td>
                    <td style={{ fontSize: '11px', whiteSpace: 'nowrap' }}>
                      {e.pages.length > 0
                        ? <span className="pill" title={e.pages.join('\n')}>{e.pages.length} elegidas</span>
                        : <span style={{ color: 'var(--ink-muted)' }}>
                            automáticas · hasta {e.maxPages ?? archivo.defaults.maxPages ?? 5}
                          </span>}
                    </td>
                    <td>
                      {datos?.status == null
                        ? <span style={{ color: 'var(--ink-muted)' }}>sin auditar</span>
                        : <>
                            <StatusBadge status={datos.status} />
                            <div style={{ fontSize: '10.5px', color: 'var(--ink-muted)' }}>
                              {fmtDateTime(datos.startedAt)}
                            </div>
                          </>}
                    </td>
                    <td>
                      {e.enabled
                        ? <span className="status good"><span className="dot" aria-hidden="true" />Activo</span>
                        : <span className="status warning"><span className="dot" aria-hidden="true" />En pausa</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <Link href={`/config/${e.id}`} className="ghost-link">Editar</Link>{' '}
                      <ToggleSite id={e.id} enabled={e.enabled} />{' '}
                      <RemoveSite id={e.id} name={e.name} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>Agregar un sitio</h2>
          <span className="sub">entra en la siguiente corrida; no hace falta reiniciar nada</span>
        </header>
        <div style={{ padding: '14px 12px' }}>
          <SiteForm defaultMaxPages={archivo.defaults.maxPages} />
        </div>
      </div>

      <div className="card">
        <header><h2>Cómo funciona esta pantalla</h2></header>
        <div style={{ padding: '12px', fontSize: '12.5px', color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: '72ch' }}>
          <p style={{ marginTop: 0 }}>
            Todo lo que edites aquí se escribe en <code>sites.yaml</code>, el mismo archivo que puedes
            editar a mano. Los comentarios del archivo se conservan.
          </p>
          <p>
            <strong>Editar</strong> abre el sitio para cambiar su nombre, su URL, su sitemap y,
            sobre todo, para elegir cuáles de sus páginas se auditan.
          </p>
          <p>
            <strong>Pausar</strong> deja de auditar un sitio pero conserva su historial y sus PDFs.
            <strong> Quitar</strong> lo saca de la lista; el historial tampoco se borra, y si lo vuelves
            a agregar con el mismo identificador lo recupera.
          </p>
          <p style={{ marginBottom: 0 }}>
            El identificador es permanente: nombra la carpeta de sus PDFs y es la llave de su historial.
            Cambiarlo equivale a crear un sitio nuevo desde cero.
          </p>
        </div>
      </div>
    </>
  );
}
