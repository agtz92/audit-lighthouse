import Link from 'next/link';
import { notFound } from 'next/navigation';
import { readSitesFile, SitesFileError, SITES_FILE } from '@/lib/sites-file';
import { fetchSitePageOptions } from '@/lib/queries';
import { EditSiteForm } from '@/components/edit-site-form';
import { PagePicker } from '@/components/page-picker';
import { AuditNow } from '@/components/audit-now';
import { fmtDateTime, DISCOVERY_LABELS } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Deja la URL principal como la deja el worker, para que la selección guardada
 * coincida con lo que se audita. Es la misma normalización mínima: el navegador
 * agrega la diagonal de la raíz.
 */
function homeDe(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

export default async function SiteConfigPage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;

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

  const site = archivo.entries.find((e) => e.id === siteId);
  if (site === undefined) notFound();

  const opciones = await fetchSitePageOptions(siteId);

  const topeEfectivo = site.maxPages ?? archivo.defaults.maxPages ?? 5;
  const home = homeDe(site.url);
  const yaGuardada = site.pages.length > 0;

  // La precarga es la selección guardada si existe; si no, lo que el sistema
  // venía auditando por su cuenta. Así la pantalla arranca en el estado actual.
  const precarga = yaGuardada ? site.pages : opciones.audited;

  return (
    <>
      <div className="card">
        <header>
          <h2>{site.name}</h2>
          <span className="sub">
            <code>{site.id}</code> · <Link href="/config">todos los sitios</Link> ·{' '}
            <Link href={`/sites/${site.id}`}>su panel</Link>
          </span>
        </header>
        <div style={{ padding: '14px 12px' }}>
          <EditSiteForm site={site} defaultMaxPages={archivo.defaults.maxPages} />
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
            <AuditNow id={site.id} name={site.name} />
          </div>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>Páginas que se auditan</h2>
          <span className="sub">
            hasta {topeEfectivo} por corrida
            {opciones.catalogAt !== null && (
              <> · catálogo del {fmtDateTime(opciones.catalogAt)}</>
            )}
            {opciones.discovery !== null && (
              <> · última vez: {DISCOVERY_LABELS[opciones.discovery] ?? opciones.discovery}</>
            )}
          </span>
        </header>
        <div style={{ padding: '14px 12px' }}>
          <PagePicker
            siteId={site.id}
            homeUrl={home}
            catalog={opciones.catalog}
            selected={precarga}
            maxPages={topeEfectivo}
            yaGuardada={yaGuardada}
          />
        </div>
      </div>

      <div className="card">
        <header><h2>Qué hace esta pantalla</h2></header>
        <div style={{ padding: '12px', fontSize: '12.5px', color: 'var(--ink-2)', lineHeight: 1.6, maxWidth: '72ch' }}>
          <p style={{ marginTop: 0 }}>
            Sin selección guardada, el sitio audita las primeras {topeEfectivo} páginas que
            encuentra en su sitemap. Ese orden es un accidente del archivo, no una decisión:
            por eso puedes fijar aquí cuáles quieres medir.
          </p>
          <p>
            El catálogo se rearma en cada corrida aunque la selección esté fija, así que una
            página nueva del sitio aparece al día siguiente como opción. Si una página que
            elegiste deja de existir, se sigue mostrando marcada —nadie la borra por ti— y su
            error se verá en el panel del sitio.
          </p>
          <p style={{ marginBottom: 0 }}>
            Todo se guarda en <code>{SITES_FILE}</code>, el mismo archivo que puedes editar a
            mano. Los cambios entran en la siguiente corrida; no hace falta reiniciar nada.
          </p>
        </div>
      </div>
    </>
  );
}
