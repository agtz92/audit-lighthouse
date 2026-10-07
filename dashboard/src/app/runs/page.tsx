import Link from 'next/link';
import { fetchRunHistory } from '@/lib/queries';
import { fetchAnalyticsRuns } from '@/lib/traffic-queries';
import { AutoRefresh } from '@/components/auto-refresh';
import { fmtDateTime, fmtDuration, ERROR_LABELS } from '@/lib/format';

export const dynamic = 'force-dynamic';

const RUN_STATUS: Record<string, { key: string; label: string }> = {
  ok: { key: 'good', label: 'Completa' },
  partial: { key: 'warning', label: 'Parcial' },
  failed: { key: 'critical', label: 'Fallida' },
  running: { key: 'none', label: 'En curso' },
};

const TRIGGER_LABELS: Record<string, string> = {
  scheduled: 'programada 06:00',
  manual: 'manual',
  recovery: 'recuperación',
};

const TIPOS = [
  { key: 'todas', label: 'Todas' },
  { key: 'lighthouse', label: 'Auditorías' },
  { key: 'trafico', label: 'Tráfico' },
] as const;
type Tipo = (typeof TIPOS)[number]['key'];

const TRIGGER_TRAFICO: Record<string, string> = {
  scheduled: 'programada 05:00',
  manual: 'manual',
  recovery: 'recuperación',
};

export default async function RunsPage({ searchParams }: { searchParams: Promise<{ tipo?: string }> }) {
  const crudo = (await searchParams).tipo;
  const tipo: Tipo = TIPOS.some((t) => t.key === crudo) ? (crudo as Tipo) : 'todas';
  const [runs, sincronizaciones] = await Promise.all([
    tipo === 'trafico' ? Promise.resolve([]) : fetchRunHistory(),
    tipo === 'lighthouse' ? Promise.resolve([]) : fetchAnalyticsRuns(60),
  ]);

  return (
    <>
      <div className="card">
        <header>
          <h2>Tipo de corrida</h2>
          <span className="sub">
            las auditorías de Lighthouse y las sincronizaciones de Search Console y GA4 corren por separado, cada una a su hora
          </span>
          <div style={{ flex: 1 }} />
          <span className="ranges">
            {TIPOS.map((t) => (
              <Link key={t.key} href={`/runs?tipo=${t.key}`} className={t.key === tipo ? 'on' : undefined}>{t.label}</Link>
            ))}
          </span>
          <AutoRefresh />
        </header>
      </div>

      {tipo !== 'lighthouse' && (
        <div className="card">
          <header>
            <h2>Sincronizaciones de tráfico</h2>
            <span className="sub">{sincronizaciones.length} sincronizaciones · Search Console y GA4</span>
          </header>
          {sincronizaciones.length === 0 ? (
            <div className="empty">Todavía no hay sincronizaciones. Corren a las 05:00 para los sitios con Google conectado.</div>
          ) : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Inicio</th>
                    <th>Disparo</th>
                    <th>Resultado</th>
                    <th className="num">Duración</th>
                    <th className="num">Sitios</th>
                    <th className="num">Bien</th>
                    <th className="num">Fallidos</th>
                    <th>Problemas</th>
                  </tr>
                </thead>
                <tbody>
                  {sincronizaciones.map((run) => {
                    const meta = RUN_STATUS[run.status] ?? { key: 'none', label: run.status };
                    return (
                      <tr key={run.id} id={`sync-${run.id}`} className={run.status === 'failed' ? 'row-down' : run.status === 'partial' ? 'row-warn' : undefined}>
                        <td className="num mono">{run.id}</td>
                        <td>{fmtDateTime(run.startedAt)}</td>
                        <td><span className="pill">{TRIGGER_TRAFICO[run.trigger] ?? run.trigger}</span></td>
                        <td>
                          <span className={`status ${meta.key}`}>
                            <span className="dot" aria-hidden="true" />
                            {meta.label}
                          </span>
                        </td>
                        <td className="num">{fmtDuration(run.durationMs)}</td>
                        <td className="num">{run.sitesTotal}</td>
                        <td className="num">{run.sitesOk}</td>
                        <td className="num" style={{ color: run.sitesFailed > 0 ? 'var(--critical)' : undefined }}>{run.sitesFailed}</td>
                        <td>
                          {run.problems.length === 0 ? (
                            run.notes !== null && run.status === 'failed'
                              ? <span className="err-msg">{run.notes}</span>
                              : <span style={{ color: 'var(--ink-muted)' }}>·</span>
                          ) : (
                            <details className="errors">
                              <summary>{run.problems.length} {run.problems.length === 1 ? 'sitio' : 'sitios'}</summary>
                              <ul>
                                {run.problems.map((p) => (
                                  <li key={p.siteId}>
                                    <Link href={`/sites/${p.siteId}/trafico`}>{p.siteId}</Link>
                                    {p.gscError !== null && <div className="err-msg">Search Console: {p.gscError}</div>}
                                    {p.gaError !== null && <div className="err-msg">GA4: {p.gaError}</div>}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tipo !== 'trafico' && (
      <div className="card">
        <header>
          <h2>Auditorías de Lighthouse</h2>
          <span className="sub">
            {runs.length} corridas · la retención borra todo lo anterior a 90 días
          </span>
        </header>
        {runs.length === 0 ? (
          <div className="empty">
            Todavía no hay corridas. La primera ocurre a las 06:00 hora de Ciudad de México.
          </div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th>Inicio</th>
                  <th>Disparo</th>
                  <th>Resultado</th>
                  <th className="num">Duración</th>
                  <th className="num">Sitios</th>
                  <th className="num">En línea</th>
                  <th className="num">Caídos</th>
                  <th className="num">Sin medir</th>
                  <th>Errores</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const meta = RUN_STATUS[run.status] ?? { key: 'none', label: run.status };
                  return (
                    <tr
                      key={run.id}
                      id={`run-${run.id}`}
                      className={run.status === 'failed' ? 'row-down' : run.status === 'partial' ? 'row-warn' : undefined}
                    >
                      <td className="num mono">{run.id}</td>
                      <td>{fmtDateTime(run.startedAt)}</td>
                      <td>
                        <span className="pill">{TRIGGER_LABELS[run.trigger] ?? run.trigger}</span>
                      </td>
                      <td>
                        <span className={`status ${meta.key}`}>
                          <span className="dot" aria-hidden="true" />
                          {meta.label}
                        </span>
                        {run.budgetExceeded && (
                          <div style={{ fontSize: '10.5px', color: 'var(--ink-2)' }}>
                            presupuesto de tiempo agotado
                          </div>
                        )}
                      </td>
                      <td className="num">{fmtDuration(run.durationMs)}</td>
                      <td className="num">{run.sitesTotal}</td>
                      <td className="num">{run.sitesOk}</td>
                      <td className="num" style={{ color: run.sitesFailed > 0 ? 'var(--critical)' : undefined }}>
                        {run.sitesFailed}
                      </td>
                      <td className="num">{run.sitesSkipped}</td>
                      <td>
                        {run.errors.length === 0 ? (
                          <span style={{ color: 'var(--ink-muted)' }}>·</span>
                        ) : (
                          <details className="errors">
                            <summary>
                              {run.errors.length} {run.errors.length === 1 ? 'sitio' : 'sitios'}
                            </summary>
                            <ul>
                              {run.errors.map((e) => (
                                <li key={e.siteId}>
                                  <Link href={`/sites/${e.siteId}`}>{e.siteId}</Link>
                                  {' — '}
                                  {e.category !== null ? (ERROR_LABELS[e.category] ?? e.category) : 'sin categoría'}
                                  {e.message !== null && (
                                    <div className="err-msg">{e.message.slice(0, 200)}</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      )}

      <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/">← Volver a todos los sitios</Link>
      </p>
    </>
  );
}
