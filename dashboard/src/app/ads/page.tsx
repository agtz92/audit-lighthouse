import Link from 'next/link';
import { fetchAdsOverview, type AdsOverviewRow, type AdsTotals } from '@/lib/ads-queries';
import { parseTrafficRange } from '@/lib/traffic-queries';
import { readSitesFile, type SiteEntry } from '@/lib/sites-file';
import { analyticsHealth } from '@/lib/analytics-control';
import { adsPdfs } from '@/lib/pdf-files';
import { Sparkline, RelDelta } from '@/components/sparkline';
import { AdsNow } from '@/components/ads-now';
import { AutoRefresh } from '@/components/auto-refresh';
import { TrafficRangePicker, rangeLabel } from '@/components/traffic-range';
import { fmtDateTime, fmtNum } from '@/lib/format';

export const dynamic = 'force-dynamic';

const fmtCuenta = (id: string): string => (/^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const cpa = (t: AdsTotals | null): number | null => (t === null ? null : div(t.cost, t.conversions));

function dinero(v: number | null, moneda: string, centavos = false): string {
  if (v === null) return '—';
  return v.toLocaleString('es-MX', {
    style: 'currency', currency: moneda, currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: centavos ? 2 : 0, maximumFractionDigits: centavos ? 2 : 0,
  });
}

/** Estado de la cuenta: sincronizada, con error (el motivo en el título) o pendiente. */
function Estado({ r }: { r: AdsOverviewRow | undefined }) {
  const s = r?.state;
  if (s === null || s === undefined) return <span className="status none" title="todavía no se sincroniza"><span className="dot" />pendiente</span>;
  if (s.status === 'error') return <span className="status critical" title={s.error ?? 'error'}><span className="dot" />error</span>;
  return <span className="status good" title={s.finishedAt === null ? '' : `sincronizada ${fmtDateTime(s.finishedAt)}`}><span className="dot" />ok</span>;
}

export default async function AdsPage({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const range = parseTrafficRange((await searchParams).range);

  let entries: SiteEntry[] = [];
  try {
    entries = (await readSitesFile()).entries;
  } catch {
    // Sin YAML legible se muestra lo que haya en la base.
  }

  const [filas, salud] = await Promise.all([fetchAdsOverview(range), analyticsHealth()]);
  const porId = new Map(filas.map((r) => [r.siteId, r]));
  // La lista manda: los sitios con adsCustomerId en sites.yaml, tengan datos o no.
  const conAds = entries.filter((e) => e.google.adsCustomerId !== null);
  const cuentas = (conAds.length > 0 ? conAds.map((e) => ({ id: e.id, name: e.name, customerId: e.google.adsCustomerId }))
    : filas.map((r) => ({ id: r.siteId, name: r.siteId, customerId: r.state?.customerId ?? null })))
    .sort((a, b) => (porId.get(b.id)?.totals?.cost ?? -1) - (porId.get(a.id)?.totals?.cost ?? -1));
  const pdfs = await adsPdfs(cuentas.map((c) => c.id));

  const monedas = [...new Set(cuentas.map((c) => porId.get(c.id)?.state?.currency).filter((m): m is string => m !== undefined))];
  const moneda = monedas[0] ?? 'MXN';
  const unaMoneda = monedas.length <= 1;
  const con = cuentas.map((c) => porId.get(c.id)).filter((r): r is AdsOverviewRow => r?.totals !== null && r?.totals !== undefined);
  const suma = (f: (t: AdsTotals) => number, prev = false): number | null => {
    const lista = prev ? con.filter((r) => r.previous !== null).map((r) => r.previous as AdsTotals) : con.map((r) => r.totals as AdsTotals);
    return lista.length === 0 ? null : lista.reduce((a, t) => a + f(t), 0);
  };
  // El periodo anterior solo compara cuentas que tienen los dos.
  const par = (f: (t: AdsTotals) => number): [number | null, number | null] => {
    const ambos = con.filter((r) => r.previous !== null);
    if (ambos.length === 0) return [null, null];
    return [ambos.reduce((a, r) => a + f(r.totals as AdsTotals), 0), ambos.reduce((a, r) => a + f(r.previous as AdsTotals), 0)];
  };
  const [costoPar, costoPrev] = par((t) => t.cost);
  const [convPar, convPrev] = par((t) => t.conversions);
  const costo = suma((t) => t.cost);
  const conv = suma((t) => t.conversions);
  const conError = cuentas.filter((c) => porId.get(c.id)?.state?.status === 'error');

  return (
    <>
      {!salud.alcanzable ? (
        <div className="banner failed">
          <strong>El servicio analytics no responde.</strong>
          <span className="muted">Las cifras de abajo son de la última sincronización. Revisa el contenedor con <code>docker compose ps analytics</code>.</span>
        </div>
      ) : (
        <div className={`banner ${conError.length > 0 ? 'stale' : 'today'}`}>
          <strong>
            {cuentas.length === 0 ? 'Ningún sitio tiene Google Ads conectado'
              : conError.length > 0 ? `${conError.length} de ${cuentas.length} cuentas con problemas` : `${cuentas.length} cuentas sincronizadas`}
          </strong>
          <span className="muted">
            {conError.length > 0 && conError[0] !== undefined
              ? (porId.get(conError[0].id)?.state?.error ?? '')
              : 'Los informes se generan solos una vez por semana, después de sincronizar.'}
          </span>
          <div className="spacer" style={{ flex: 1 }} />
          {salud.corriendo ? <span className="pill">trabajando…</span> : cuentas.length > 0 && <AdsNow />}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="k">Inversión</div>
          <div className="v">{unaMoneda ? dinero(costo, moneda) : '—'}</div>
          <div className="n">{unaMoneda ? <><RelDelta current={costoPar} previous={costoPrev} /> vs periodo anterior</> : 'cuentas en monedas distintas'}</div>
        </div>
        <div className="tile">
          <div className="k">Conversiones</div>
          <div className="v">{conv === null ? '—' : fmtNum(conv)}</div>
          <div className="n"><RelDelta current={convPar} previous={convPrev} /></div>
        </div>
        <div className="tile">
          <div className="k">Costo por conversión</div>
          <div className="v">{unaMoneda && costo !== null && conv !== null ? dinero(div(costo, conv), moneda, true) : '—'}</div>
          <div className="n">
            <RelDelta current={costoPar === null || convPar === null ? null : div(costoPar, convPar)} previous={costoPrev === null || convPrev === null ? null : div(costoPrev, convPrev)} lowerIsBetter />
          </div>
        </div>
        <div className="tile">
          <div className="k">Cuentas con error</div>
          <div className="v" style={{ color: conError.length > 0 ? 'var(--critical)' : undefined }}>{conError.length}</div>
          <div className="n">de {cuentas.length} conectadas</div>
        </div>
      </div>

      <div className="card">
        <header>
          <h2>Cuentas</h2>
          <span className="sub">{rangeLabel(range)} contra el periodo anterior · cada cuenta se ancla en su último día sincronizado</span>
          <div style={{ flex: 1 }} />
          <TrafficRangePicker basePath="/ads" current={range} />
          <AutoRefresh />
        </header>
        {cuentas.length === 0 ? (
          <div className="empty">
            Se conecta una cuenta en <code>config/sites.yaml</code>, dentro de <code>google</code> del sitio, con{' '}
            <code>adsCustomerId: &quot;224-845-1770&quot;</code>.
          </div>
        ) : (
          <div className="scroll-x">
            <table className="traffic">
              <thead>
                <tr>
                  <th>Sitio</th>
                  <th>Cuenta</th>
                  <th>Estado</th>
                  <th className="num">Inversión</th>
                  <th>Tendencia</th>
                  <th className="num">Clics</th>
                  <th className="num">Conversiones</th>
                  <th className="num">Costo/conv.</th>
                  <th>Análisis semanal</th>
                  <th>Informes</th>
                </tr>
              </thead>
              <tbody>
                {cuentas.map((c) => {
                  const r = porId.get(c.id);
                  const t = r?.totals ?? null;
                  const p = r?.previous ?? null;
                  const m = r?.state?.currency ?? moneda;
                  const pdf = pdfs.get(c.id);
                  return (
                    <tr key={c.id} className={r?.state?.status === 'error' ? 'row-warn' : undefined}>
                      <td><Link href={`/sites/${c.id}/ads?range=${range}`}>{c.name}</Link></td>
                      <td className="mono">{c.customerId === null ? '—' : fmtCuenta(c.customerId)}</td>
                      <td><Estado r={r} /></td>
                      <td className="num">{dinero(t?.cost ?? null, m)}<RelDelta current={t?.cost ?? null} previous={p?.cost ?? null} /></td>
                      <td>{r === undefined || r.spark.length === 0 ? <span className="score none">—</span> : <Sparkline values={r.spark} />}</td>
                      <td className="num">{t === null ? '—' : fmtNum(t.clicks)}</td>
                      <td className="num">{t === null ? '—' : fmtNum(t.conversions)}<RelDelta current={t?.conversions ?? null} previous={p?.conversions ?? null} /></td>
                      <td className="num">{dinero(cpa(t), m, true)}<RelDelta current={cpa(t)} previous={cpa(p)} lowerIsBetter /></td>
                      <td>
                        {r?.weeklyAt == null ? <span className="muted">—</span> : (
                          <Link href={`/sites/${c.id}/ads`}>
                            {fmtDateTime(r.weeklyAt)}{r.weeklyAlerts > 0 && <> · {r.weeklyAlerts} {r.weeklyAlerts === 1 ? 'alerta' : 'alertas'}</>}
                          </Link>
                        )}
                      </td>
                      <td>
                        <span className="dl">
                          {pdf?.cliente === true
                            ? <a href={`/api/pdf/${c.id}/ads-cliente`} target="_blank" rel="noreferrer noopener">cliente</a>
                            : <span className="off">cliente</span>}
                          {pdf?.admin === true
                            ? <a href={`/api/pdf/${c.id}/ads-admin`} target="_blank" rel="noreferrer noopener">admin</a>
                            : <span className="off">admin</span>}
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
    </>
  );
}
