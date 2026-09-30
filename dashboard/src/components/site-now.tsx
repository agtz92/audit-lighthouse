import type { OverviewRow } from '@/lib/queries';
import { StatusBadge, Score, Delta, CertCell } from './indicators';
import { fmtBytes, fmtMs, fmtTime, ERROR_LABELS } from '@/lib/format';
import { rateLowerIsBetter, THRESHOLDS } from '@/lib/palette';

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return Number((a - b).toFixed(2));
}

/**
 * Estado actual del sitio, de un vistazo.
 *
 * Va arriba de las gráficas a propósito: quien entra a la página de un sitio
 * casi siempre quiere saber cómo está HOY, y solo después cómo ha venido
 * cambiando. Las tendencias responden la segunda pregunta, no la primera.
 */
export function SiteNow({ row }: { row: OverviewRow }) {
  const d = row.current.desktop;
  const m = row.current.mobile;
  const dPrev = row.previous.desktop;
  const mPrev = row.previous.mobile;

  const lcp = m?.lcpMs ?? d?.lcpMs ?? null;
  const lcpPrev = mPrev?.lcpMs ?? dPrev?.lcpMs ?? null;
  const cls = m?.cls ?? d?.cls ?? null;

  return (
    <div className="now">
      <div>
        <div className="k">Estado</div>
        <div className="v" style={{ fontSize: 14 }}><StatusBadge status={row.status} /></div>
        <div className="n">
          {row.errorCategory !== null
            ? (ERROR_LABELS[row.errorCategory] ?? row.errorCategory)
            : `HTTP ${row.homeHttpStatus ?? '—'}`}
        </div>
      </div>

      <div>
        <div className="k">Perf. escritorio</div>
        <div className="v"><Score value={d?.performance ?? null} /><Delta value={diff(d?.performance, dPrev?.performance)} /></div>
        <div className="n">a11y {d?.accessibility ?? '—'} · SEO {d?.seo ?? '—'}</div>
      </div>

      <div>
        <div className="k">Perf. móvil</div>
        <div className="v"><Score value={m?.performance ?? null} /><Delta value={diff(m?.performance, mPrev?.performance)} /></div>
        <div className="n">a11y {m?.accessibility ?? '—'} · SEO {m?.seo ?? '—'}</div>
      </div>

      <div>
        <div className="k">LCP</div>
        <div className="v">
          <span className={`score ${rateLowerIsBetter(lcp, THRESHOLDS.lcpMs) ?? 'none'}`}>{fmtMs(lcp)}</span>
          <Delta value={diff(lcp, lcpPrev)} invert />
        </div>
        <div className="n">umbral 2.5 s</div>
      </div>

      <div>
        <div className="k">CLS</div>
        <div className="v">
          <span className={`score ${rateLowerIsBetter(cls, THRESHOLDS.cls) ?? 'none'}`}>
            {cls === null ? '—' : cls.toFixed(3)}
          </span>
        </div>
        <div className="n">umbral 0.10</div>
      </div>

      <div>
        <div className="k">Certificado</div>
        <div className="v" style={{ fontSize: 14 }}><CertCell days={row.certDaysRemaining} valid={row.certValid} /></div>
        <div className="n">aviso a los 21 días</div>
      </div>

      <div>
        <div className="k">Páginas</div>
        <div className="v">{row.pagesAudited}</div>
        <div className="n">
          de {row.pagesDiscovered} descubiertas
          {row.pagesFailed > 0 ? ` · ${row.pagesFailed} con error` : ''}
        </div>
      </div>

      <div>
        <div className="k">Informes</div>
        <div className="v" style={{ fontSize: 13, gap: 6 }}>
          <span className="dl">
            {row.desktopPdfBytes !== null
              ? <a href={`/api/pdf/${row.siteId}/desktop`} target="_blank" rel="noreferrer noopener" title={fmtBytes(row.desktopPdfBytes)}>escritorio</a>
              : <span className="off">escritorio</span>}
            {row.mobilePdfBytes !== null
              ? <a href={`/api/pdf/${row.siteId}/mobile`} target="_blank" rel="noreferrer noopener" title={fmtBytes(row.mobilePdfBytes)}>móvil</a>
              : <span className="off">móvil</span>}
          </span>
        </div>
        <div className="n">corrida de las {fmtTime(row.startedAt)}</div>
      </div>
    </div>
  );
}
