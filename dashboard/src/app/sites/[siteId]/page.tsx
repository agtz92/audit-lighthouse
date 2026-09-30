import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  fetchSite, fetchLighthouseTrend, fetchAvailabilityTrend, fetchLastRunPages, fetchSiteRunHistory,
  fetchSiteOverview, type TrendPoint,
} from '@/lib/queries';
import { SiteNow } from '@/components/site-now';
import { PrintButton } from '@/components/print-button';
import type { TrendDatum } from '@/components/trend-chart';
import { TrendChart } from '@/components/trend-chart';
import { RangePicker, parseRange } from '@/components/range-picker';
import { StatusBadge } from '@/components/indicators';
import {
  fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtMs, fmtNum, pathOf,
  ERROR_LABELS, DISCOVERY_LABELS,
} from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Las métricas graficables de una serie de Lighthouse, derivadas del tipo real. */
type Metric = Exclude<keyof TrendPoint, 'at' | 'strategy' | 'siteRunId'>;

/**
 * Convierte la serie de Lighthouse (una fila por fecha y estrategia) en puntos
 * con las dos estrategias juntas, que es lo que la gráfica necesita.
 */
function toTrend(points: TrendPoint[], metric: Metric): TrendDatum[] {
  // Se agrupa por site_run_id: es lo único exacto. Agrupar por fecha fusionaría
  // dos corridas del mismo día en un punto, y la segunda borraría a la primera.
  const porCorrida = new Map<number, TrendDatum>();
  for (const p of points) {
    const clave = p.siteRunId;
    const existente = porCorrida.get(clave) ?? {
      label: fmtDate(p.at),
      full: fmtDateTime(p.at),
      desktop: null,
      mobile: null,
    };
    existente[p.strategy] = p[metric];
    porCorrida.set(clave, existente);
  }
  return [...porCorrida.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
}

export default async function SitePage({
  params, searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { siteId } = await params;
  const { range: rawRange } = await searchParams;
  const range = parseRange(rawRange);

  const site = await fetchSite(siteId);
  if (site === null) notFound();

  const [lighthouse, availability, pages, history, ahora] = await Promise.all([
    fetchLighthouseTrend(siteId, range),
    fetchAvailabilityTrend(siteId, range),
    fetchLastRunPages(siteId),
    fetchSiteRunHistory(siteId, range),
    fetchSiteOverview(siteId),
  ]);

  const disponibilidad: TrendDatum[] = availability.map((p) => ({
    label: fmtDate(p.at),
    full: fmtDateTime(p.at),
    desktop: p.ttfbMs,
    mobile: null,
  }));
  const carga: TrendDatum[] = availability.map((p) => ({
    label: fmtDate(p.at),
    full: fmtDateTime(p.at),
    desktop: p.loadMs,
    mobile: null,
  }));
  const peso: TrendDatum[] = availability.map((p) => ({
    label: fmtDate(p.at),
    full: fmtDateTime(p.at),
    desktop: p.transferBytes,
    mobile: null,
  }));

  const ultima = history[0];

  return (
    <>
      <div className="print-only print-header">
        <h1>{site.name}</h1>
        <div className="meta">
          <span>{site.url}</span>
          <span>
            Corrida del {ultima === undefined ? '—' : fmtDateTime(ultima.startedAt)}
          </span>
          <span>Tendencias de los últimos {range} días</span>
          <span>site-monitor</span>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>{site.name}</h2>
          <span className="sub">
            <a href={site.url} target="_blank" rel="noreferrer noopener">
              {site.url}
            </a>
            {' · '}
            {site.removedFromYaml ? 'fuera del sites.yaml' : site.enabled ? 'habilitado' : 'deshabilitado'}
          </span>
          <div style={{ flex: 1 }} />
          <span className="dl">
            {/* En pestaña nueva: abrir un PDF no debe sacarte del dashboard. */}
            <a href={`/api/pdf/${siteId}/desktop`} target="_blank" rel="noreferrer noopener">
              reporte escritorio
            </a>
            <a href={`/api/pdf/${siteId}/mobile`} target="_blank" rel="noreferrer noopener">
              reporte móvil
            </a>
          </span>
          <RangePicker basePath={`/sites/${siteId}`} current={range} />
          <PrintButton />
        </header>
        {ultima !== undefined && (
          <div style={{ padding: '9px 12px', display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: '12px' }}>
            <StatusBadge status={ultima.status} />
            <span>
              <span style={{ color: 'var(--ink-muted)' }}>última corrida </span>
              {fmtDateTime(ultima.startedAt)}
            </span>
            <span>
              <span style={{ color: 'var(--ink-muted)' }}>duró </span>
              {fmtDuration(ultima.durationMs)}
            </span>
            <span>
              <span style={{ color: 'var(--ink-muted)' }}>descubrimiento </span>
              {DISCOVERY_LABELS[ultima.discovery ?? 'none'] ?? ultima.discovery}
            </span>
            <span>
              <span style={{ color: 'var(--ink-muted)' }}>páginas </span>
              {fmtNum(ultima.pagesAudited)}
              {ultima.pagesFailed > 0 ? ` (${ultima.pagesFailed} con error)` : ''}
              {ultima.truncated ? ' · truncado' : ''}
            </span>
            <span>
              <span style={{ color: 'var(--ink-muted)' }}>certificado </span>
              {ultima.certDaysRemaining === null ? '—' : `${ultima.certDaysRemaining} d`}
            </span>
          </div>
        )}
      </div>

      {ahora !== null && <SiteNow row={ahora} />}

      <div className="card">
        <header>
          <h2>Tendencias</h2>
          <span className="sub">últimos {range} días · una gráfica por métrica</span>
        </header>
      </div>

      <div className="charts">
        <TrendChart title="Performance" unit="score de Lighthouse, 0 a 100" data={toTrend(lighthouse, 'performance')} domain={[0, 100]} />
        <TrendChart title="Accesibilidad" unit="score de Lighthouse, 0 a 100" data={toTrend(lighthouse, 'accessibility')} domain={[0, 100]} />
        <TrendChart title="Buenas prácticas" unit="score de Lighthouse, 0 a 100" data={toTrend(lighthouse, 'bestPractices')} domain={[0, 100]} />
        <TrendChart title="SEO" unit="score de Lighthouse, 0 a 100" data={toTrend(lighthouse, 'seo')} domain={[0, 100]} />
        <TrendChart title="LCP" unit="Largest Contentful Paint · menos es mejor" data={toTrend(lighthouse, 'lcpMs')} format="ms" />
        <TrendChart title="CLS" unit="Cumulative Layout Shift · menos es mejor" data={toTrend(lighthouse, 'cls')} format="cls" />
        <TrendChart title="TBT" unit="Total Blocking Time · menos es mejor" data={toTrend(lighthouse, 'tbtMs')} format="ms" />
        <TrendChart title="TTFB" unit="promedio de las páginas auditadas" data={disponibilidad} format="ms" singleSeries />
        <TrendChart title="Tiempo de carga" unit="promedio de las páginas auditadas" data={carga} format="ms" singleSeries />
        <TrendChart title="Peso transferido" unit="promedio por página" data={peso} format="bytes" singleSeries />
      </div>

      <div className="card">
        <header>
          <h2>Páginas de la última corrida</h2>
          <span className="sub">{pages.length} URLs · ordenadas por errores y luego por tiempo de carga</span>
        </header>
        {pages.length === 0 ? (
          <div className="empty">Este sitio todavía no tiene páginas auditadas.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Ruta</th>
                  <th className="num">HTTP</th>
                  <th className="num">Redir.</th>
                  <th className="num">TTFB</th>
                  <th className="num">Carga</th>
                  <th className="num">Peso</th>
                  <th className="num">Reqs</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {pages.map((p) => (
                  <tr key={p.url} className={p.ok ? undefined : 'row-down'}>
                    <td className="mono" title={p.url}>
                      {p.isHome && <span className="pill" style={{ marginRight: 5 }}>home</span>}
                      {pathOf(p.url)}
                    </td>
                    <td className="num mono">{p.httpStatus ?? '—'}</td>
                    <td className="num">{p.redirects > 0 ? p.redirects : '·'}</td>
                    <td className="num">{fmtMs(p.ttfbMs)}</td>
                    <td className="num">{fmtMs(p.loadMs)}</td>
                    <td className="num">{fmtBytes(p.transferBytes)}</td>
                    <td className="num">{fmtNum(p.requestCount)}</td>
                    <td style={{ fontSize: '11px', color: 'var(--ink-2)' }}>
                      {p.errorCategory !== null && (ERROR_LABELS[p.errorCategory] ?? p.errorCategory)}
                      {p.errorCategory !== null && p.errorMessage !== null ? ': ' : ''}
                      {p.errorMessage !== null && <span className="err-msg">{p.errorMessage.slice(0, 120)}</span>}
                      {p.attemptCount > 1 && <span className="pill" style={{ marginLeft: 4 }}>2 intentos</span>}
                      {p.degradedWait && (
                        <span className="pill" style={{ marginLeft: 4 }} title="networkidle no se alcanzó; se midió esperando solo load">
                          espera degradada
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card page-break">
        <header>
          <h2>Historial de corridas de este sitio</h2>
          <span className="sub">últimos {range} días</span>
        </header>
        {history.length === 0 ? (
          <div className="empty">Sin corridas en este rango.</div>
        ) : (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Cuándo</th>
                  <th>Estado</th>
                  <th className="num">HTTP</th>
                  <th className="num">Duración</th>
                  <th>Descubrimiento</th>
                  <th className="num">Páginas</th>
                  <th className="num">Cert.</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className={h.status === 'failed' ? 'row-down' : undefined}>
                    <td>
                      <Link href={`/runs#run-${h.runId}`}>{fmtDateTime(h.startedAt)}</Link>
                    </td>
                    <td><StatusBadge status={h.status} /></td>
                    <td className="num mono">{h.homeHttpStatus ?? '—'}</td>
                    <td className="num">{fmtDuration(h.durationMs)}</td>
                    <td>{DISCOVERY_LABELS[h.discovery ?? 'none'] ?? '—'}</td>
                    <td className="num">
                      {fmtNum(h.pagesAudited)}
                      {h.pagesFailed > 0 ? ` (${h.pagesFailed}✗)` : ''}
                    </td>
                    <td className="num">{h.certDaysRemaining ?? '—'}</td>
                    <td style={{ fontSize: '11px' }}>
                      {h.errorCategory !== null && (ERROR_LABELS[h.errorCategory] ?? h.errorCategory)}
                      {h.errorMessage !== null && (
                        <div className="err-msg">{h.errorMessage.slice(0, 140)}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="no-print" style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/">← Volver a todos los sitios</Link>
      </p>
    </>
  );
}
