import Link from 'next/link';
import { fetchRunHistory } from '@/lib/queries';
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

export default async function RunsPage() {
  const runs = await fetchRunHistory();

  return (
    <>
      <div className="card">
        <header>
          <h2>Histórico de corridas</h2>
          <span className="sub">
            {runs.length} corridas · la retención borra todo lo anterior a 90 días
          </span>
          <div style={{ flex: 1 }} />
          <AutoRefresh />
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

      <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/">← Volver a todos los sitios</Link>
      </p>
    </>
  );
}
