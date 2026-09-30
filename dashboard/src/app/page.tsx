import { fetchOverview, fetchLastRun, type OverviewRow } from '@/lib/queries';
import { readSitesFile } from '@/lib/sites-file';
import { OverviewTable } from '@/components/overview-table';
import { RunBanner } from '@/components/run-banner';
import { AutoRefresh } from '@/components/auto-refresh';
import Link from 'next/link';

// Monitoreo: cada carga consulta la base. Los datos cambian una vez al día, pero
// "¿ya corrió hoy?" tiene que ser verdad ahora, no hace cinco minutos.
export const dynamic = 'force-dynamic';

/**
 * Separa lo que se está auditando de lo que ya salió de la lista.
 *
 * La tabla `sites` no sirve sola para esto: el worker la sincroniza al empezar
 * cada corrida, así que un sitio quitado hoy sigue marcado como vigente hasta
 * mañana a las 06:00 y aparecía en Panorama como si nada. La lista real es
 * sites.yaml, y es la que manda aquí.
 *
 * Si el archivo no se puede leer se muestra todo: que Panorama deje de reportar
 * el estado de los sitios sería mucho peor que mostrar uno de más, y el error de
 * lectura ya se ve en la pantalla de configuración.
 */
async function separarPorLista(rows: OverviewRow[]): Promise<{
  enLista: OverviewRow[];
  fueraDeLista: OverviewRow[];
}> {
  let ids: Set<string>;
  try {
    ids = new Set((await readSitesFile()).entries.map((e) => e.id));
  } catch {
    return { enLista: rows, fueraDeLista: [] };
  }
  return {
    enLista: rows.filter((r) => ids.has(r.siteId)),
    fueraDeLista: rows.filter((r) => !ids.has(r.siteId)),
  };
}

export default async function Page() {
  const [todas, lastRun] = await Promise.all([fetchOverview(), fetchLastRun()]);
  const { enLista: rows, fueraDeLista } = await separarPorLista(todas);

  const caidos = rows.filter(
    (r) => r.status === 'failed' || (r.homeHttpStatus !== null && r.homeHttpStatus >= 400),
  ).length;
  const porVencer = rows.filter(
    (r) => r.certDaysRemaining !== null && r.certDaysRemaining < 21,
  ).length;

  return (
    <>
      <RunBanner run={lastRun} />

      <div className="tiles">
        <div className="tile">
          <div className="k">Sitios</div>
          <div className="v">{rows.length}</div>
          <div className="n">{rows.filter((r) => r.enabled).length} habilitados</div>
        </div>
        <div className="tile">
          <div className="k">Caídos</div>
          <div className="v" style={{ color: caidos > 0 ? 'var(--critical)' : undefined }}>
            {caidos}
          </div>
          <div className="n">{caidos === 0 ? 'todo responde' : 'requieren atención'}</div>
        </div>
        <div className="tile">
          <div className="k">Certificados por vencer</div>
          <div className="v" style={{ color: porVencer > 0 ? 'var(--warning)' : undefined }}>
            {porVencer}
          </div>
          <div className="n">menos de 21 días</div>
        </div>
        <div className="tile">
          <div className="k">Páginas auditadas</div>
          <div className="v">{rows.reduce((a, r) => a + r.pagesAudited, 0)}</div>
          <div className="n">en la última corrida de cada sitio</div>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>Sitios</h2>
          <span className="sub">
            los deltas comparan contra la corrida anterior de cada sitio · clic en un nombre para su historial
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          <AutoRefresh />
        </header>
        <OverviewTable rows={rows} />
      </div>

      {fueraDeLista.length > 0 && (
        // No desaparecen sin dejar rastro: dejaron de auditarse, pero su
        // historial sigue completo y tiene que poder alcanzarse desde algún lado.
        <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
          Fuera de la lista, con su historial conservado:{' '}
          {fueraDeLista.map((r, i) => (
            <span key={r.siteId}>
              {i > 0 && ', '}
              <Link href={`/sites/${r.siteId}`}>{r.name}</Link>
            </span>
          ))}
          .
        </p>
      )}

      <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/runs">Ver el histórico de corridas →</Link>
      </p>
    </>
  );
}
