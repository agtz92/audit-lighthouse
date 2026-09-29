import { fetchOverview, fetchLastRun } from '@/lib/queries';
import { OverviewTable } from '@/components/overview-table';
import { RunBanner } from '@/components/run-banner';
import { AutoRefresh } from '@/components/auto-refresh';
import Link from 'next/link';

// Monitoreo: cada carga consulta la base. Los datos cambian una vez al día, pero
// "¿ya corrió hoy?" tiene que ser verdad ahora, no hace cinco minutos.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const [rows, lastRun] = await Promise.all([fetchOverview(), fetchLastRun()]);

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

      <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/runs">Ver el histórico de corridas →</Link>
      </p>
    </>
  );
}
