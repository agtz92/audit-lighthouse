import { notFound } from 'next/navigation';
import { fetchSite } from '@/lib/queries';
import {
  fetchAdsState, fetchAdsSummary, fetchLatestWeeklyNote, fetchAdsContext, fetchReportNotesInfo, type AdsTotals,
} from '@/lib/ads-queries';
import { parseTrafficRange, type DailyPair } from '@/lib/traffic-queries';
import { readSitesFile } from '@/lib/sites-file';
import { pdfExists } from '@/lib/pdf-files';
import { ComparisonChart, type ComparisonDatum } from '@/components/comparison-chart';
import { RelDelta } from '@/components/sparkline';
import { SiteTabs } from '@/components/site-tabs';
import { TrafficRangePicker, rangeLabel } from '@/components/traffic-range';
import { AdsNow } from '@/components/ads-now';
import { AdsProfileForm } from '@/components/ads-profile-form';
import { fmtDateTime, fmtNum } from '@/lib/format';

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
    key: p.date, label: corta(p.date), full: larga(p.date), fullPrev: larga(restar(p.date, dias)),
    current: p.current, previous: p.previous,
  }));
}

const fmtCuenta = (id: string): string => (/^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

/** Razones de Ads: null si el denominador es cero. */
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
const cpa = (t: AdsTotals | null): number | null => (t === null ? null : div(t.cost, t.conversions));

export default async function SiteAdsPage({
  params, searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { siteId } = await params;
  const range = parseTrafficRange((await searchParams).range);
  const site = await fetchSite(siteId);
  if (site === null) notFound();

  let cuenta: string | null = null;
  try {
    cuenta = (await readSitesFile()).entries.find((e) => e.id === siteId)?.google.adsCustomerId ?? null;
  } catch {
    // Sin YAML legible se muestra lo que haya guardado.
  }

  const [estado, s, semanal, ctx, textos, pdfCliente, pdfAdmin] = await Promise.all([
    fetchAdsState(siteId),
    fetchAdsSummary(siteId, range),
    fetchLatestWeeklyNote(siteId),
    fetchAdsContext(siteId),
    fetchReportNotesInfo(siteId),
    pdfExists(siteId, 'ads-cliente'),
    pdfExists(siteId, 'ads-admin'),
  ]);
  const moneda = estado?.currency ?? 'MXN';
  const $ = (v: number | null, centavos = true): string => (v === null ? '—' : v.toLocaleString('es-MX', {
    style: 'currency', currency: moneda, currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: centavos ? 2 : 0, maximumFractionDigits: centavos ? 2 : 0,
  }));
  const t = s.totals;
  const p = s.previous;

  return (
    <>
      <div className="card">
        <header>
          <h2>{site.name}</h2>
          <span className="sub">
            {cuenta === null ? 'sin cuenta de Google Ads' : <>cuenta <span className="mono">{fmtCuenta(cuenta)}</span></>}
            {estado?.finishedAt != null && <> · sincronizado {fmtDateTime(estado.finishedAt)}</>}
            {textos !== null && <> · informes {fmtDateTime(textos.createdAt)}</>}
          </span>
          <div style={{ flex: 1 }} />
          <span className="dl">
            {pdfCliente ? <a href={`/api/pdf/${siteId}/ads-cliente`} target="_blank" rel="noreferrer noopener">informe cliente</a> : <span className="off">informe cliente</span>}
            {pdfAdmin ? <a href={`/api/pdf/${siteId}/ads-admin`} target="_blank" rel="noreferrer noopener">informe admin</a> : <span className="off">informe admin</span>}
          </span>
          {cuenta !== null && <AdsNow id={siteId} />}
        </header>
        <div style={{ padding: '9px 12px 0' }}>
          <SiteTabs siteId={siteId} current="ads" />
        </div>
        {estado?.status === 'error' && (
          <div className="cross"><span className="status critical"><span className="dot" />{estado.error ?? 'La última sincronización de Google Ads falló.'}</span></div>
        )}
      </div>

      {cuenta === null ? (
        <div className="card">
          <div className="empty">
            Este sitio no tiene cuenta de Google Ads. Se conecta en <code>config/sites.yaml</code>, dentro de <code>google</code>,
            con <code>adsCustomerId: &quot;224-845-1770&quot;</code>; la siguiente sincronización trae su historial.
          </div>
        </div>
      ) : s.latest === null ? (
        <div className="card">
          <div className="empty">Todavía no hay datos de Google Ads. Llegan con la sincronización de las 05:00 o con «Sincronizar ahora» en Búsqueda y tráfico.</div>
        </div>
      ) : (
        <>
          <div className="card">
            <header>
              <h2>Indicadores</h2>
              <span className="sub">{rangeLabel(range)} contra los {range === 365 ? '12 meses' : `${range} días`} previos · datos hasta el {larga(s.latest)}</span>
              <div style={{ flex: 1 }} />
              <TrafficRangePicker basePath={`/sites/${siteId}/ads`} current={range} />
            </header>
            <div className="now">
              <div><div className="k">Inversión</div><div className="v">{$(t?.cost ?? null, false)}<RelDelta current={t?.cost ?? null} previous={p?.cost ?? null} /></div><div className="n">en {moneda}</div></div>
              <div><div className="k">Conversiones</div><div className="v">{fmtNum(t?.conversions ?? null)}<RelDelta current={t?.conversions ?? null} previous={p?.conversions ?? null} /></div><div className="n">columna «Conversiones»</div></div>
              <div><div className="k">Costo por conversión</div><div className="v">{$(cpa(t))}<RelDelta current={cpa(t)} previous={cpa(p)} lowerIsBetter /></div><div className="n">menos es mejor</div></div>
              <div><div className="k">Clics</div><div className="v">{fmtNum(t?.clicks ?? null)}<RelDelta current={t?.clicks ?? null} previous={p?.clicks ?? null} /></div><div className="n">{t === null ? '' : `CTR ${((div(t.clicks, t.impressions) ?? 0) * 100).toFixed(1)}%`}</div></div>
              <div><div className="k">Costo por clic</div><div className="v">{$(t === null ? null : div(t.cost, t.clicks))}<RelDelta current={t === null ? null : div(t.cost, t.clicks)} previous={p === null ? null : div(p.cost, p.clicks)} lowerIsBetter /></div><div className="n">promedio</div></div>
            </div>
          </div>

          <div className="charts">
            <ComparisonChart title="Inversión" unit={`${moneda} · por día`} total={$(t?.cost ?? null, false)} data={serie(s.series.cost, range)} format="money" />
            <ComparisonChart title="Conversiones" unit="por día del clic" total={fmtNum(t?.conversions ?? null)} data={serie(s.series.conversions, range)} />
          </div>

          <div className="card">
            <header>
              <h2>Campañas</h2>
              <span className="sub">{rangeLabel(range)}</span>
            </header>
            <div className="scroll-x"><table>
              <thead><tr><th>Campaña</th><th className="num">Inversión</th><th className="num">Clics</th><th className="num">Conversiones</th><th className="num">Costo/conv.</th></tr></thead>
              <tbody>
                {s.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td className="num">{$(c.cost, false)}<RelDelta current={c.cost} previous={p === null ? null : c.previousCost} /></td>
                    <td className="num">{fmtNum(c.clicks)}</td>
                    <td className="num">{fmtNum(c.conversions)}<RelDelta current={c.conversions} previous={p === null ? null : c.previousConversions} /></td>
                    <td className="num">{$(div(c.cost, c.conversions))}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div className="cross">
              Google Ads atribuye cada conversión al día del clic, así que los últimos días todavía suben. El detalle —keywords,
              términos de búsqueda, anuncios, segmentación— está en el informe admin.
            </div>
          </div>
        </>
      )}

      {cuenta !== null && (
        <div className="two-col">
          <div className="card">
            <header>
              <h2>Análisis semanal</h2>
              <span className="sub">{semanal === null ? 'todavía no hay' : `${larga(semanal.periodStart)} – ${larga(semanal.periodEnd)} · ${semanal.model}`}</span>
            </header>
            {semanal === null ? (
              <div className="empty">
                Se escribe una vez por semana, después de sincronizar, si hay ANTHROPIC_API_KEY. También sale con «Generar informes» si no hay uno de los últimos seis días.
              </div>
            ) : (
              <div className="ads-note">
                {semanal.resumen.split(/\n\s*\n/).map((x, i) => <p key={i}>{x}</p>)}
                {semanal.mejoro.length > 0 && <><h3>Mejoró</h3><ul>{semanal.mejoro.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
                {semanal.empeoro.length > 0 && <><h3>Empeoró</h3><ul>{semanal.empeoro.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
                {semanal.alertas.length > 0 && <><h3>Alertas</h3><ul>{semanal.alertas.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
                {semanal.acciones.length > 0 && <><h3>Acciones</h3><ul>{semanal.acciones.map((x, i) => <li key={i}>{x}</li>)}</ul></>}
              </div>
            )}
          </div>

          <div className="card">
            <header>
              <h2>Perfil de la cuenta</h2>
              <span className="sub">lo que Claude lee antes de escribir</span>
            </header>
            <AdsProfileForm id={siteId} profile={ctx.profile} />
            {ctx.baseline !== null && (
              <details style={{ padding: '0 12px 12px' }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                  Baseline{ctx.baselineUpdatedAt !== null && <> · actualizado {fmtDateTime(ctx.baselineUpdatedAt)}</>}
                </summary>
                <div className="ads-note ads-baseline">{ctx.baseline}</div>
              </details>
            )}
          </div>
        </div>
      )}
    </>
  );
}
