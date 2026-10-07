import Link from 'next/link';
import {
  fetchTrafficOverview, fetchAnalyticsRuns, parseTrafficRange, type TrafficOverviewRow, type SourceStatus,
} from '@/lib/traffic-queries';
import { readSitesFile, type SiteEntry } from '@/lib/sites-file';
import { analyticsHealth } from '@/lib/analytics-control';
import { trafficPdfs } from '@/lib/pdf-files';
import { Sparkline, RelDelta } from '@/components/sparkline';
import { Score } from '@/components/indicators';
import { SyncNow } from '@/components/sync-now';
import { AutoRefresh } from '@/components/auto-refresh';
import { TrafficRangePicker, rangeLabel } from '@/components/traffic-range';
import { fmtDateTime, fmtDuration, fmtNum } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Una caída de clics así o peor pinta la fila de rojo. Igual que el webhook. */
const CAIDA = -0.2;

function cambio(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur === null || cur === undefined || prev === null || prev === undefined || prev === 0) return null;
  return (cur - prev) / prev;
}

function compacto(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 10_000) return `${Math.round(n / 1000)} k`;
  return fmtNum(n);
}

function pct(v: number | null): string {
  return v === null ? '—' : `${(v * 100).toFixed(1)}%`;
}

/** Punto de estado de una fuente: conectada y bien, con error, o pendiente. */
function Fuente({ label, configured, status, error }: { label: string; configured: boolean; status: SourceStatus | null; error: string | null }) {
  if (!configured) return null;
  const key = status === 'ok' ? 'good' : status === 'error' ? 'critical' : 'none';
  const titulo = status === 'error' ? error ?? 'error' : status === 'ok' ? 'sincronizada' : 'todavía no se sincroniza';
  return (
    <span className={`status ${key}`} title={titulo}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

const RUN_LABEL: Record<string, { key: string; label: string }> = {
  ok: { key: 'today', label: 'Sincronizado' },
  partial: { key: 'stale', label: 'Sincronizado con problemas' },
  failed: { key: 'failed', label: 'La sincronización falló' },
  running: { key: 'running', label: 'Sincronizando' },
};

export default async function TraficoPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const range = parseTrafficRange((await searchParams).range);

  let entries: SiteEntry[] = [];
  try {
    entries = (await readSitesFile()).entries;
  } catch {
    // Sin YAML legible se muestra lo que haya en la base; la pantalla de
    // Sitios ya avisa del error de lectura.
  }

  const [todas, [ultima], salud] = await Promise.all([
    fetchTrafficOverview(range),
    fetchAnalyticsRuns(1),
    analyticsHealth(),
  ]);

  const porId = new Map(entries.map((e) => [e.id, e]));
  const filas = todas.filter((r) => entries.length === 0 || porId.has(r.siteId));
  const conectado = (r: TrafficOverviewRow): boolean => {
    const g = porId.get(r.siteId)?.google;
    return g !== undefined && (g.searchConsole !== null || g.ga4Property !== null);
  };
  const conectados = filas.filter(conectado)
    .sort((a, b) => (b.gsc?.clicks ?? -1) - (a.gsc?.clicks ?? -1) || (b.ga?.sessions ?? -1) - (a.ga?.sessions ?? -1));
  const sinConectar = filas.filter((r) => !conectado(r));
  const pdfs = await trafficPdfs(conectados.map((r) => r.siteId));

  const suma = (f: (r: TrafficOverviewRow) => number | null | undefined): number | null => {
    const vals = conectados.map(f).filter((v): v is number => typeof v === 'number');
    return vals.length === 0 ? null : vals.reduce((a, v) => a + v, 0);
  };
  // Las sumas del periodo anterior solo comparan sitios que tienen los dos.
  const sumaPar = (cur: (r: TrafficOverviewRow) => number | undefined, prev: (r: TrafficOverviewRow) => number | undefined): [number | null, number | null] => {
    const con = conectados.filter((r) => cur(r) !== undefined && prev(r) !== undefined);
    if (con.length === 0) return [null, null];
    return [con.reduce((a, r) => a + (cur(r) ?? 0), 0), con.reduce((a, r) => a + (prev(r) ?? 0), 0)];
  };
  const [clicsPar, clicsPrev] = sumaPar((r) => r.gsc?.clicks, (r) => r.gscPrev?.clicks);
  const [imprPar, imprPrev] = sumaPar((r) => r.gsc?.impressions, (r) => r.gscPrev?.impressions);
  const [sesPar, sesPrev] = sumaPar((r) => r.ga?.sessions, (r) => r.gaPrev?.sessions);
  const caidas = conectados.filter((r) => (cambio(r.gsc?.clicks, r.gscPrev?.clicks) ?? 0) <= CAIDA).length;
  const ultimoGsc = conectados.map((r) => r.gscLatest).filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const meta = ultima === undefined ? null : RUN_LABEL[ultima.status] ?? RUN_LABEL.failed;

  return (
    <>
      {!salud.alcanzable ? (
        <div className="banner failed">
          <strong>El servicio analytics no responde.</strong>
          <span className="muted">Las cifras de abajo son de la última sincronización. Revisa el contenedor con <code>docker compose ps analytics</code>.</span>
        </div>
      ) : salud.credencialesError !== null ? (
        <div className="banner failed">
          <strong>Falta la llave de Google.</strong>
          <span className="muted">{salud.credencialesError}</span>
        </div>
      ) : (
        <div className={`banner ${meta?.key ?? 'stale'}`}>
          <strong>
            {ultima === undefined ? 'Todavía no hay sincronizaciones' : `${meta?.label} · ${fmtDateTime(ultima.finishedAt ?? ultima.startedAt)}`}
          </strong>
          <span className="muted">
            {ultima === undefined
              ? 'Conecta un sitio en Sitios › su nombre › Search Console y Google Analytics.'
              : `${ultima.sitesOk} de ${ultima.sitesTotal} sitios bien · tardó ${fmtDuration(ultima.durationMs)}`}
            {ultimoGsc !== null && ` · Search Console tiene datos hasta el ${ultimoGsc} (publica con 2 a 3 días de retraso)`}
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          {salud.corriendo ? <span className="pill">sincronizando…</span> : <SyncNow />}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="k">Clics desde Google</div>
          <div className="v">{suma((r) => r.gsc?.clicks) === null ? '—' : fmtNum(suma((r) => r.gsc?.clicks))}</div>
          <div className="n"><RelDelta current={clicsPar} previous={clicsPrev} /> vs periodo anterior</div>
        </div>
        <div className="tile">
          <div className="k">Impresiones</div>
          <div className="v">{suma((r) => r.gsc?.impressions) === null ? '—' : compacto(suma((r) => r.gsc?.impressions) ?? 0)}</div>
          <div className="n"><RelDelta current={imprPar} previous={imprPrev} /></div>
        </div>
        <div className="tile">
          <div className="k">Sesiones (GA4)</div>
          <div className="v">{suma((r) => r.ga?.sessions) === null ? '—' : fmtNum(suma((r) => r.ga?.sessions))}</div>
          <div className="n"><RelDelta current={sesPar} previous={sesPrev} /></div>
        </div>
        <div className="tile">
          <div className="k">Eventos clave</div>
          <div className="v">{suma((r) => r.ga?.keyEvents) === null ? '—' : fmtNum(suma((r) => r.ga?.keyEvents))}</div>
          <div className="n">formularios, WhatsApp, llamadas…</div>
        </div>
        <div className="tile">
          <div className="k">Caídas fuertes</div>
          <div className="v" style={{ color: caidas > 0 ? 'var(--critical)' : undefined }}>{caidas}</div>
          <div className="n">clics −20% o más</div>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>Sitios conectados</h2>
          <span className="sub">{rangeLabel(range)} contra el periodo anterior · cada fuente se ancla en su último día publicado</span>
          <div style={{ flex: 1 }} />
          <TrafficRangePicker basePath="/trafico" current={range} />
          <AutoRefresh />
        </header>
        {conectados.length === 0 ? (
          <div className="empty">
            Ningún sitio tiene Search Console ni GA4 conectados todavía. Se conectan en{' '}
            <Link href="/config">Sitios</Link> › el nombre del sitio.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="traffic">
              <thead>
                <tr>
                  <th>Sitio</th>
                  <th>Conexión</th>
                  <th className="num">Clics</th>
                  <th>Tendencia</th>
                  <th className="num">Impresiones</th>
                  <th className="num">CTR</th>
                  <th className="num">Posición</th>
                  <th className="num">Sesiones</th>
                  <th className="num">Interacción</th>
                  <th className="num">Ev. clave</th>
                  <th className="num" title="Rendimiento móvil de Lighthouse en la última medición">Perf. móvil</th>
                  <th>Informes</th>
                </tr>
              </thead>
              <tbody>
                {conectados.map((r) => {
                  const g = porId.get(r.siteId)?.google ?? { searchConsole: null, ga4Property: null };
                  const caida = (cambio(r.gsc?.clicks, r.gscPrev?.clicks) ?? 0) <= CAIDA;
                  const conError = r.gscStatus === 'error' || r.gaStatus === 'error';
                  const pdf = pdfs.get(r.siteId);
                  return (
                    <tr key={r.siteId} className={caida ? 'row-down' : conError ? 'row-warn' : undefined}>
                      <td><Link href={`/sites/${r.siteId}/trafico?range=${range}`}>{r.name}</Link></td>
                      <td>
                        <span className="conn">
                          <Fuente label="GSC" configured={g.searchConsole !== null} status={r.gscStatus} error={r.gscError} />
                          <Fuente label="GA4" configured={g.ga4Property !== null} status={r.gaStatus} error={r.gaError} />
                        </span>
                      </td>
                      <td className="num">
                        {r.gsc === null ? '—' : fmtNum(r.gsc.clicks)}
                        <RelDelta current={r.gsc?.clicks ?? null} previous={r.gscPrev?.clicks ?? null} />
                      </td>
                      <td>{r.gsc === null ? <span className="score none">—</span> : <Sparkline values={r.spark} alert={caida} />}</td>
                      <td className="num">{r.gsc === null ? '—' : compacto(r.gsc.impressions)}</td>
                      <td className="num">{pct(r.gsc?.ctr ?? null)}</td>
                      <td className="num">
                        {r.gsc?.position?.toFixed(1) ?? '—'}
                        <RelDelta current={r.gsc?.position ?? null} previous={r.gscPrev?.position ?? null} lowerIsBetter absolute />
                      </td>
                      <td className="num">
                        {r.gaStatus === 'error' && r.ga === null
                          ? <span className="status critical" title={r.gaError ?? ''}><span className="dot" />sin acceso</span>
                          : r.ga === null ? '—' : fmtNum(r.ga.sessions)}
                        {r.ga !== null && <RelDelta current={r.ga.sessions} previous={r.gaPrev?.sessions ?? null} />}
                      </td>
                      <td className="num">{r.ga?.engagementRate === null || r.ga === null ? '—' : `${Math.round(r.ga.engagementRate * 100)}%`}</td>
                      <td className="num">
                        {r.ga === null ? '—' : r.keyEventsDefined === 0 && r.ga.keyEvents === 0
                          ? <span className="score none" title="La propiedad no tiene eventos clave definidos">sin definir</span>
                          : fmtNum(r.ga.keyEvents)}
                      </td>
                      <td className="num"><Score value={r.mobilePerformance} /></td>
                      <td>
                        <span className="dl">
                          {pdf?.analitica === true
                            ? <a href={`/api/pdf/${r.siteId}/analitica`} target="_blank" rel="noreferrer noopener">tráfico</a>
                            : <span className="off">tráfico</span>}
                          {pdf?.integral === true
                            ? <a href={`/api/pdf/${r.siteId}/integral`} target="_blank" rel="noreferrer noopener">integral</a>
                            : <span className="off" title="Se genera al terminar la siguiente auditoría">integral</span>}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sinConectar.length > 0 && (
        <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
          Sin conectar:{' '}
          {sinConectar.map((r, i) => (
            <span key={r.siteId}>
              {i > 0 && ', '}
              <Link href={`/config/${r.siteId}`}>{r.name}</Link>
            </span>
          ))}
          .
        </p>
      )}

      <p style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/runs?tipo=trafico">Ver el histórico de sincronizaciones →</Link>
      </p>
    </>
  );
}
