import Link from 'next/link';
import type { OverviewRow, Strategy } from '@/lib/queries';
import { StatusBadge, Score, Delta, CertCell } from './indicators';
import { fmtBytes, fmtMs, fmtNum, fmtTime, ERROR_LABELS } from '@/lib/format';
import { rateLowerIsBetter, THRESHOLDS } from '@/lib/palette';

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return Number((a - b).toFixed(2));
}

/** Los cuatro scores de una estrategia, con su delta contra la corrida anterior. */
function ScoreGroup({ row, strategy }: { row: OverviewRow; strategy: Strategy }) {
  const now = row.current[strategy];
  const before = row.previous[strategy];
  const keys = ['performance', 'accessibility', 'bestPractices', 'seo'] as const;
  return (
    <>
      {keys.map((k) => (
        <td className="num" key={k}>
          <Score value={now?.[k] ?? null} />
          <Delta value={diff(now?.[k], before?.[k])} />
        </td>
      ))}
    </>
  );
}

function Vital({ value, delta, kind }: { value: number | null; delta: number | null; kind: 'lcp' | 'cls' }) {
  const rating =
    kind === 'lcp'
      ? rateLowerIsBetter(value, THRESHOLDS.lcpMs)
      : rateLowerIsBetter(value, THRESHOLDS.cls);
  return (
    <td className="num">
      <span className={`score ${rating ?? 'none'}`}>
        {value === null ? '—' : kind === 'lcp' ? fmtMs(value) : value.toFixed(3)}
      </span>
      <Delta value={delta} invert />
    </td>
  );
}

export function OverviewTable({ rows }: { rows: OverviewRow[] }) {
  if (rows.length === 0) {
    return <div className="empty">No hay sitios registrados. Agrega alguno a sites.yaml.</div>;
  }

  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Sitio</th>
            <th>Estado</th>
            <th className="num">HTTP</th>
            <th className="num">Perf</th>
            <th className="num">A11y</th>
            <th className="num">BP</th>
            <th className="num">SEO</th>
            <th className="num">Perf</th>
            <th className="num">A11y</th>
            <th className="num">BP</th>
            <th className="num">SEO</th>
            <th className="num">LCP móvil</th>
            <th className="num">CLS móvil</th>
            <th>Certificado</th>
            <th className="num">Págs.</th>
            <th className="num">Corrida</th>
            <th>PDFs</th>
          </tr>
          <tr>
            <th colSpan={3} />
            <th colSpan={4} style={{ color: 'var(--series-desktop)', textTransform: 'none', fontSize: '10.5px' }}>
              ▬ Escritorio
            </th>
            <th colSpan={4} style={{ color: 'var(--series-mobile)', textTransform: 'none', fontSize: '10.5px' }}>
              ▬ Móvil
            </th>
            <th colSpan={6} />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const caido = row.status === 'failed' || (row.homeHttpStatus !== null && row.homeHttpStatus >= 400);
            const advertencia = !caido && (row.status === 'partial' || row.status === 'skipped_timeout');
            const mobile = row.current.mobile;
            const mobileBefore = row.previous.mobile;
            return (
              <tr key={row.siteId} className={caido ? 'row-down' : advertencia ? 'row-warn' : undefined}>
                <td>
                  <Link href={`/sites/${row.siteId}`} style={{ fontWeight: 560 }}>
                    {row.name}
                  </Link>
                  <div style={{ fontSize: '10.5px', color: 'var(--ink-muted)' }}>
                    {row.siteId}
                    {row.removedFromYaml ? ' · fuera del YAML' : ''}
                    {!row.enabled && !row.removedFromYaml ? ' · deshabilitado' : ''}
                  </div>
                </td>
                <td>
                  <StatusBadge status={row.status} />
                  {row.errorCategory !== null && (
                    <div style={{ fontSize: '10.5px', color: 'var(--ink-2)' }}>
                      {ERROR_LABELS[row.errorCategory] ?? row.errorCategory}
                    </div>
                  )}
                </td>
                <td className="num mono">{row.homeHttpStatus ?? '—'}</td>
                <ScoreGroup row={row} strategy="desktop" />
                <ScoreGroup row={row} strategy="mobile" />
                <Vital value={mobile?.lcpMs ?? null} delta={diff(mobile?.lcpMs, mobileBefore?.lcpMs)} kind="lcp" />
                <Vital value={mobile?.cls ?? null} delta={diff(mobile?.cls, mobileBefore?.cls)} kind="cls" />
                <td>
                  <CertCell days={row.certDaysRemaining} valid={row.certValid} />
                </td>
                <td className="num" title={`${row.pagesDiscovered} descubiertas`}>
                  {fmtNum(row.pagesAudited)}
                  {row.pagesFailed > 0 && (
                    <span className="delta down" title={`${row.pagesFailed} con error`}>
                      ▼{row.pagesFailed}
                    </span>
                  )}
                  {row.truncated && (
                    <span className="pill" style={{ marginLeft: 4 }} title={`el sitio declara ${row.pagesDiscovered} URLs`}>
                      trunc
                    </span>
                  )}
                </td>
                <td className="num">{fmtTime(row.startedAt)}</td>
                <td>
                  <span className="dl">
                    {row.homePdfBytes !== null ? (
                      <a href={`/api/pdf/${row.siteId}/home`} title={`home.pdf · ${fmtBytes(row.homePdfBytes)}`}>
                        home
                      </a>
                    ) : (
                      <span className="off">home</span>
                    )}
                    {row.fullPdfBytes !== null ? (
                      <a
                        href={`/api/pdf/${row.siteId}/full`}
                        title={`full.pdf · ${fmtBytes(row.fullPdfBytes)} · ${row.fullPdfPages ?? '?'} páginas`}
                      >
                        full
                      </a>
                    ) : (
                      <span className="off">full</span>
                    )}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
