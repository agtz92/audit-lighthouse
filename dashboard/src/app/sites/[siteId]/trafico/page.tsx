import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchSite } from '@/lib/queries';
import { fetchSiteTraffic, parseTrafficRange, pathKey, type DailyPair, type SiteTraffic } from '@/lib/traffic-queries';
import { readSitesFile } from '@/lib/sites-file';
import { pdfExists } from '@/lib/pdf-files';
import { ComparisonChart, type ComparisonDatum } from '@/components/comparison-chart';
import { RelDelta } from '@/components/sparkline';
import { SiteTabs } from '@/components/site-tabs';
import { SyncNow } from '@/components/sync-now';
import { TrafficRangePicker, rangeLabel } from '@/components/traffic-range';
import { fmtDateTime, fmtMs, fmtNum } from '@/lib/format';

export const dynamic = 'force-dynamic';

const TZ_FMT = { timeZone: 'UTC' } as const;

function corta(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-MX', { ...TZ_FMT, day: '2-digit', month: 'short' });
}
function larga(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-MX', { ...TZ_FMT, day: 'numeric', month: 'short', year: 'numeric' });
}
function restar(iso: string, dias: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - dias);
  return d.toISOString().slice(0, 10);
}

function serie(pares: DailyPair[], dias: number): ComparisonDatum[] {
  return pares.map((p) => ({
    key: p.date,
    label: corta(p.date),
    full: larga(p.date),
    fullPrev: larga(restar(p.date, dias)),
    current: p.current,
    previous: p.previous,
  }));
}

const CANALES: Record<string, string> = {
  'Organic Search': 'Búsqueda orgánica', Direct: 'Directo', Referral: 'Referido', 'Organic Social': 'Social orgánico',
  'Paid Search': 'Búsqueda pagada', 'Paid Social': 'Social pagado', Email: 'Correo', Display: 'Display',
  'Cross-network': 'Varias redes', 'Organic Video': 'Video orgánico', Unassigned: 'Sin asignar', Affiliates: 'Afiliados',
};
const DISPOSITIVOS: Record<string, string> = { mobile: 'Móvil', desktop: 'Escritorio', tablet: 'Tableta' };

function Barras({ rows, label }: { rows: Array<{ key: string; sessions: number }>; label: (k: string) => string }) {
  if (rows.length === 0) return <div className="empty">Sin datos en el periodo.</div>;
  const max = Math.max(...rows.map((r) => r.sessions));
  const total = rows.reduce((a, r) => a + r.sessions, 0);
  return (
    <div className="bars">
      {rows.slice(0, 8).map((r) => (
        <div className="row" key={r.key}>
          <span>{label(r.key)}</span>
          <span className="track"><i style={{ width: `${max === 0 ? 0 : (r.sessions / max) * 100}%` }} /></span>
          <b>{fmtNum(r.sessions)} <span className="muted">{total === 0 ? '' : `${Math.round((r.sessions / total) * 100)}%`}</span></b>
        </div>
      ))}
    </div>
  );
}

/** Estado de una página en la última auditoría, para ponerlo junto a su tráfico. */
function Salud({ h }: { h: SiteTraffic['health'][string] | undefined }) {
  if (h === undefined) {
    return <span className="score none" style={{ whiteSpace: 'nowrap' }} title="La página no está entre las que mide la auditoría diaria">no auditada</span>;
  }
  if (!h.ok || (h.httpStatus !== null && h.httpStatus >= 400)) {
    return <span className="status critical"><span className="dot" />{h.httpStatus ?? 'error'}</span>;
  }
  if (h.loadMs !== null && h.loadMs > 4000) return <span className="status warning"><span className="dot" />lenta</span>;
  return <span className="status good"><span className="dot" />{h.httpStatus ?? 'ok'}</span>;
}

export default async function SiteTrafficPage({
  params, searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { siteId } = await params;
  const range = parseTrafficRange((await searchParams).range);
  const site = await fetchSite(siteId);
  if (site === null) notFound();

  let google = { searchConsole: null as string | null, ga4Property: null as string | null };
  try {
    google = (await readSitesFile()).entries.find((e) => e.id === siteId)?.google ?? google;
  } catch {
    // Sin YAML legible se muestra lo que haya guardado.
  }
  const conectado = google.searchConsole !== null || google.ga4Property !== null;

  const [t, pdfTrafico, pdfIntegral] = await Promise.all([
    fetchSiteTraffic(siteId, range),
    pdfExists(siteId, 'analitica'),
    pdfExists(siteId, 'integral'),
  ]);
  const hayDatos = t.gscLatest !== null || t.gaLatest !== null;

  // Páginas: las de Search Console y las de entrada de GA4, juntas por ruta.
  const paginas = new Map<string, { path: string; clicks: number | null; sessions: number | null; engagement: number | null }>();
  for (const p of t.breakdowns.pages) {
    const k = pathKey(p.key);
    paginas.set(k, { path: k, clicks: p.clicks, sessions: null, engagement: null });
  }
  for (const l of t.breakdowns.landing) {
    const k = pathKey(l.key);
    if (k === '/(not set)' || l.key === '(not set)') continue;
    const previo = paginas.get(k);
    paginas.set(k, {
      path: k,
      clicks: previo?.clicks ?? null,
      sessions: l.sessions,
      engagement: l.sessions > 0 ? l.engagedSessions / l.sessions : null,
    });
  }
  const listaPaginas = [...paginas.values()]
    .sort((a, b) => (b.clicks ?? 0) + (b.sessions ?? 0) - ((a.clicks ?? 0) + (a.sessions ?? 0)))
    .slice(0, 15);
  const sinOcurrir = t.keyEventsDefined.filter((n) => !t.breakdowns.keyEvents.some((k) => k.name === n));

  return (
    <>
      <div className="card">
        <header>
          <h2>{site.name}</h2>
          <span className="sub">
            <a href={site.url} target="_blank" rel="noreferrer noopener">{site.url}</a>
            {' · '}
            <Link href={`/config/${siteId}`}>configurar conexión</Link>
            {t.lastSyncAt !== null && <> · sincronizado {fmtDateTime(t.lastSyncAt)}</>}
          </span>
          <div style={{ flex: 1 }} />
          <span className="dl">
            {pdfTrafico ? <a href={`/api/pdf/${siteId}/analitica`} target="_blank" rel="noreferrer noopener">informe de tráfico</a> : <span className="off">informe de tráfico</span>}
            {pdfIntegral ? <a href={`/api/pdf/${siteId}/integral`} target="_blank" rel="noreferrer noopener">informe integral</a> : <span className="off">informe integral</span>}
          </span>
          {conectado && <SyncNow id={siteId} />}
        </header>
        <div style={{ padding: '9px 12px 0' }}>
          <SiteTabs siteId={siteId} current="trafico" />
        </div>
        {conectado && (
          <div className="conn-line">
            {google.searchConsole !== null && (
              <span>
                <span className={`status ${t.gscStatus === 'ok' ? 'good' : t.gscStatus === 'error' ? 'critical' : 'none'}`}>
                  <span className="dot" />Search Console
                </span>{' '}
                <code>{google.searchConsole}</code>
                {t.gscStatus === 'error' && <span className="err-msg"> {t.gscError}</span>}
                {t.gscLatest !== null && <span className="muted"> · datos hasta el {larga(t.gscLatest)}</span>}
              </span>
            )}
            {google.ga4Property !== null && (
              <span>
                <span className={`status ${t.gaStatus === 'ok' ? 'good' : t.gaStatus === 'error' ? 'critical' : 'none'}`}>
                  <span className="dot" />GA4
                </span>{' '}
                <code>{google.ga4Property}</code>
                {t.gaStatus === 'error' && <span className="err-msg"> {t.gaError}</span>}
              </span>
            )}
          </div>
        )}
      </div>

      {!conectado ? (
        <div className="card">
          <div className="empty">
            Este sitio no tiene Search Console ni Google Analytics conectados.{' '}
            <Link href={`/config/${siteId}`}>Conectarlo</Link>
          </div>
        </div>
      ) : !hayDatos ? (
        <div className="card">
          <div className="empty">
            Todavía no hay datos sincronizados. La próxima sincronización es a las 05:00, o pídela ahora con «Sincronizar ahora».
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <header>
              <h2>Tendencias</h2>
              <span className="sub">{rangeLabel(range)} contra los {range === 365 ? '12 meses' : `${range} días`} anteriores, día por día</span>
              <div style={{ flex: 1 }} />
              <TrafficRangePicker basePath={`/sites/${siteId}/trafico`} current={range} />
            </header>
            <div className="now">
              <div><div className="k">Clics</div><div className="v">{t.gsc === null ? '—' : fmtNum(t.gsc.clicks)}<RelDelta current={t.gsc?.clicks ?? null} previous={t.gscPrev?.clicks ?? null} /></div><div className="n">desde Google</div></div>
              <div><div className="k">Impresiones</div><div className="v">{t.gsc === null ? '—' : fmtNum(t.gsc.impressions)}<RelDelta current={t.gsc?.impressions ?? null} previous={t.gscPrev?.impressions ?? null} /></div><div className="n">veces que apareció</div></div>
              <div><div className="k">CTR</div><div className="v">{t.gsc?.ctr == null ? '—' : `${(t.gsc.ctr * 100).toFixed(1)}%`}</div><div className="n">clics / impresiones</div></div>
              <div><div className="k">Posición media</div><div className="v">{t.gsc?.position?.toFixed(1) ?? '—'}<RelDelta current={t.gsc?.position ?? null} previous={t.gscPrev?.position ?? null} lowerIsBetter absolute /></div><div className="n">menos es mejor</div></div>
              <div><div className="k">Sesiones</div><div className="v">{t.ga === null ? '—' : fmtNum(t.ga.sessions)}<RelDelta current={t.ga?.sessions ?? null} previous={t.gaPrev?.sessions ?? null} /></div><div className="n">de todos los canales</div></div>
              <div><div className="k">Interacción</div><div className="v">{t.ga?.engagementRate == null ? '—' : `${Math.round(t.ga.engagementRate * 100)}%`}</div><div className="n">sesiones con interacción</div></div>
              <div><div className="k">Eventos clave</div><div className="v">{t.ga === null ? '—' : fmtNum(t.ga.keyEvents)}<RelDelta current={t.ga?.keyEvents ?? null} previous={t.gaPrev?.keyEvents ?? null} /></div><div className="n">{t.keyEventsDefined.length === 0 ? 'ninguno definido' : `${t.keyEventsDefined.length} definidos`}</div></div>
            </div>
          </div>

          <div className="charts">
            {t.series.clicks.length > 0 && <ComparisonChart title="Clics" unit="Search Console · por día" total={fmtNum(t.gsc?.clicks ?? null)} data={serie(t.series.clicks, range)} />}
            {t.series.impressions.length > 0 && <ComparisonChart title="Impresiones" unit="Search Console · por día" total={fmtNum(t.gsc?.impressions ?? null)} data={serie(t.series.impressions, range)} />}
            {t.series.position.length > 0 && <ComparisonChart title="Posición media" unit="Search Console · menos es mejor" total={t.gsc?.position?.toFixed(1) ?? '—'} data={serie(t.series.position, range)} format="dec" invert />}
            {t.series.sessions.length > 0 && <ComparisonChart title="Sesiones" unit="GA4 · por día" total={fmtNum(t.ga?.sessions ?? null)} data={serie(t.series.sessions, range)} />}
            {t.series.users.length > 0 && <ComparisonChart title="Usuarios" unit="GA4 · usuarios de cada día" total="" data={serie(t.series.users, range)} />}
            {t.series.keyEvents.length > 0 && <ComparisonChart title="Eventos clave" unit="GA4 · por día" total={fmtNum(t.ga?.keyEvents ?? null)} data={serie(t.series.keyEvents, range)} />}
          </div>

          <div className="two-col">
            {google.searchConsole !== null && (
              <div className="card">
                <header>
                  <h2>Consultas principales</h2>
                  <span className="sub">
                    Search Console · {t.breakdowns.range === null ? 'últimos 28 días' : `${corta(t.breakdowns.range.start)} – ${corta(t.breakdowns.range.end)}`}
                  </span>
                </header>
                {t.breakdowns.queries.length === 0 ? <div className="empty">Sin consultas en el periodo.</div> : (
                  <div className="scroll-x"><table>
                    <thead><tr><th>Consulta</th><th className="num">Clics</th><th className="num">Impr.</th><th className="num">CTR</th><th className="num">Posición</th></tr></thead>
                    <tbody>
                      {t.breakdowns.queries.slice(0, 15).map((q) => (
                        <tr key={q.key}>
                          <td className="clip" title={q.key}>{q.key}</td>
                          <td className="num">{fmtNum(q.clicks)}</td>
                          <td className="num">{fmtNum(q.impressions)}</td>
                          <td className="num">{q.impressions > 0 ? `${((q.clicks / q.impressions) * 100).toFixed(1)}%` : '—'}</td>
                          <td className="num">
                            {q.position?.toFixed(1) ?? '—'}
                            <RelDelta current={q.position} previous={q.prevPosition} lowerIsBetter absolute />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </div>
            )}

            <div className="card">
              <header>
                <h2>Páginas con tráfico</h2>
                <span className="sub">últimos 28 días, cruzadas con la auditoría de hoy</span>
              </header>
              {listaPaginas.length === 0 ? <div className="empty">Sin páginas con tráfico en el periodo.</div> : (
                <div className="scroll-x"><table>
                  <thead><tr><th>Página</th><th className="num">Clics</th><th className="num">Sesiones</th><th className="num">Interacción</th><th className="num">Carga</th><th>Estado</th></tr></thead>
                  <tbody>
                    {listaPaginas.map((p) => {
                      const h = t.health[p.path];
                      const mal = h !== undefined && (!h.ok || (h.httpStatus !== null && h.httpStatus >= 400));
                      const lenta = h !== undefined && !mal && h.loadMs !== null && h.loadMs > 4000;
                      return (
                        <tr key={p.path} className={mal ? 'row-down' : lenta ? 'row-warn' : undefined}>
                          <td className="mono clip" title={p.path}>{p.path}</td>
                          <td className="num">{fmtNum(p.clicks)}</td>
                          <td className="num">{fmtNum(p.sessions)}</td>
                          <td className="num">{p.engagement === null ? '—' : `${Math.round(p.engagement * 100)}%`}</td>
                          <td className="num">{fmtMs(h?.loadMs ?? null)}</td>
                          <td><Salud h={h} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table></div>
              )}
            </div>

            {google.ga4Property !== null && (
              <>
                <div className="card">
                  <header><h2>Canales</h2><span className="sub">GA4 · sesiones, últimos 28 días</span></header>
                  <Barras rows={t.breakdowns.channels} label={(k) => CANALES[k] ?? k} />
                </div>
                <div className="card">
                  <header><h2>Dispositivos</h2><span className="sub">GA4 · sesiones, últimos 28 días</span></header>
                  <Barras rows={t.breakdowns.devices} label={(k) => DISPOSITIVOS[k.toLowerCase()] ?? k} />
                </div>
                <div className="card">
                  <header>
                    <h2>Eventos clave</h2>
                    <span className="sub">{t.keyEventsDefined.length === 0 ? 'ninguno definido en la propiedad' : `${t.keyEventsDefined.length} definidos en la propiedad`}</span>
                  </header>
                  {t.breakdowns.keyEvents.length === 0 ? (
                    <div className="empty">
                      {t.keyEventsDefined.length === 0
                        ? 'La propiedad no tiene eventos clave. Sin ellos GA4 no puede contar contactos ni ventas: conviene marcar como clave el envío de formularios, los clics a WhatsApp y las llamadas.'
                        : 'Ningún evento clave ocurrió en los últimos 28 días.'}
                    </div>
                  ) : (
                    <table>
                      <thead><tr><th>Evento</th><th className="num">Veces</th></tr></thead>
                      <tbody>
                        {t.breakdowns.keyEvents.map((k) => (
                          <tr key={k.name}><td className="mono">{k.name}</td><td className="num">{fmtNum(k.count)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {sinOcurrir.length > 0 && (
                    <div className="cross">
                      Definidos sin ocurrencias: {sinOcurrir.map((n) => <code key={n} style={{ marginRight: 6 }}>{n}</code>)}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}

      <p className="no-print" style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href="/trafico">← Tráfico de todos los sitios</Link>
      </p>
    </>
  );
}
