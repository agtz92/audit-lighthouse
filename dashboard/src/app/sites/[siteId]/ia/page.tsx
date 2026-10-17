import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fetchSite } from '@/lib/queries';
import { fetchAiReadiness, fetchAiTraffic, type AiReadiness, type BotRole, type FindingLevel } from '@/lib/ai-queries';
import { parseTrafficRange, type DailyPair } from '@/lib/traffic-queries';
import { readSitesFile } from '@/lib/sites-file';
import { ComparisonChart, type ComparisonDatum } from '@/components/comparison-chart';
import { RelDelta } from '@/components/sparkline';
import { SiteTabs } from '@/components/site-tabs';
import { TrafficRangePicker, rangeLabel } from '@/components/traffic-range';
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

const ROLES: Record<BotRole, string> = { search: 'índice de citas', user: 'consulta en vivo', training: 'entrenamiento' };
const NIVEL: Record<FindingLevel, { cls: string; label: string }> = {
  critical: { cls: 'critical', label: 'crítico' },
  warning: { cls: 'warning', label: 'aviso' },
  info: { cls: 'none', label: 'nota' },
};

function Robots({ v }: { v: 'allowed' | 'partial' | 'blocked' }) {
  if (v === 'blocked') return <span className="status critical"><span className="dot" />bloqueado</span>;
  if (v === 'partial') return <span className="status good" title="Puede entrar a la home; algunas rutas están prohibidas"><span className="dot" />permitido, con rutas excluidas</span>;
  return <span className="status good"><span className="dot" />permitido</span>;
}

function Firewall({ p, base }: { p: AiReadiness['probes'][number] | undefined; base: AiReadiness['baseline'] }) {
  if (p === undefined) return <span className="muted">—</span>;
  const baseOk = base.status !== null && base.status < 400 && !base.challenge;
  if (!p.blocked) return <span className="status good"><span className="dot" />{p.status}</span>;
  if (!baseOk) return <span className="status none" title="Al navegador tampoco lo dejaron pasar: no hay con qué comparar"><span className="dot" />sin comparación</span>;
  return <span className="status critical"><span className="dot" />{p.reason}</span>;
}

export default async function SiteAiPage({
  params, searchParams,
}: {
  params: Promise<{ siteId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { siteId } = await params;
  const range = parseTrafficRange((await searchParams).range);
  const site = await fetchSite(siteId);
  if (site === null) notFound();

  let ga4: string | null = null;
  try {
    ga4 = (await readSitesFile()).entries.find((e) => e.id === siteId)?.google?.ga4Property ?? null;
  } catch {
    // Sin YAML legible se muestra lo que haya guardado.
  }

  const [r, t] = await Promise.all([fetchAiReadiness(siteId), fetchAiTraffic(siteId, range)]);
  const probe = (token: string) => r?.probes.find((p) => p.token === token);
  const criticos = r?.findings.filter((f) => f.level === 'critical').length ?? 0;
  const maxAsist = Math.max(1, ...t.assistants.map((a) => a.sessions));

  return (
    <>
      <div className="card">
        <header>
          <h2>{site.name}</h2>
          <span className="sub">
            <a href={site.url} target="_blank" rel="noreferrer noopener">{site.url}</a>
            {r !== null && <> · revisado {fmtDateTime(new Date(r.checkedAt))}</>}
          </span>
        </header>
        <div style={{ padding: '9px 12px 0' }}>
          <SiteTabs siteId={siteId} current="ia" />
        </div>
        <div className="cross">
          Ningún asistente publica cuántas veces mostró un sitio. Aquí está lo que sí se puede medir: si sus bots pueden leerlo
          y cuántas visitas mandan.
        </div>
      </div>

      {r === null ? (
        <div className="card">
          <div className="empty">Todavía no hay revisión. Se hace en cada auditoría; corre «Auditar ahora» o espera a la de las 06:00.</div>
        </div>
      ) : (
        <>
          <div className="card">
            <header>
              <h2>Lo que hay que atender</h2>
              <span className="sub">{criticos === 0 ? 'nada bloquea a los asistentes' : `${criticos} ${criticos === 1 ? 'problema impide' : 'problemas impiden'} salir citado`}</span>
            </header>
            {r.findings.length === 0 ? <div className="empty">Todo en orden.</div> : (
              <table>
                <tbody>
                  {r.findings.map((f, i) => (
                    <tr key={i} className={f.level === 'critical' ? 'row-down' : undefined}>
                      <td style={{ width: 80 }}><span className={`status ${NIVEL[f.level].cls}`}><span className="dot" />{NIVEL[f.level].label}</span></td>
                      <td>{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="two-col">
            <div className="card">
              <header>
                <h2>Acceso de cada bot</h2>
                <span className="sub">robots.txt ({r.robots.status ?? r.robots.error ?? '—'}) y respuesta real del servidor a la home</span>
              </header>
              <div className="scroll-x"><table>
                <thead><tr><th>Bot</th><th>De</th><th>Para qué</th><th>robots.txt</th><th>Servidor</th></tr></thead>
                <tbody>
                  {r.robots.bots.map((b) => (
                    <tr key={b.token}>
                      <td className="mono">{b.token}{b.explicit && <span className="pill" style={{ marginLeft: 4 }} title="robots.txt lo nombra">nombrado</span>}</td>
                      <td>{b.vendor}</td>
                      <td>{ROLES[b.role]}</td>
                      <td><Robots v={b.verdict} /></td>
                      <td><Firewall p={probe(b.token)} base={r.baseline} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <div className="cross">
                «Servidor» pide la home con el user-agent del bot, desde este servidor y no desde las IPs del bot. Un firewall que
                verifica IPs puede rechazar la prueba y dejar pasar al bot real.
              </div>
            </div>

            <div className="card">
              <header>
                <h2>Lo que lee un asistente</h2>
                <span className="sub">el HTML de la home tal como llega, sin ejecutar JavaScript</span>
              </header>
              {r.html === null ? (
                <div className="empty">La home no respondió HTML al navegador ({r.baseline.status ?? r.baseline.error}).</div>
              ) : (
                <table>
                  <tbody>
                    <tr><td>Palabras de texto</td><td className="num">{fmtNum(r.html.words)}</td></tr>
                    <tr><td>Título</td><td className="clip" title={r.html.title ?? ''}>{r.html.title ?? <span className="muted">sin título</span>}</td></tr>
                    <tr><td>Meta description</td><td className="clip" title={r.html.description ?? ''}>{r.html.description ?? <span className="muted">no tiene</span>}</td></tr>
                    <tr><td>Datos estructurados</td><td>{r.html.jsonLdTypes.length === 0 ? <span className="muted">ninguno</span> : r.html.jsonLdTypes.map((x) => <code key={x} style={{ marginRight: 6 }}>{x}</code>)}</td></tr>
                    <tr><td>Encabezados H1</td><td className="num">{r.html.h1}</td></tr>
                    <tr><td>Idioma</td><td>{r.html.lang ?? <span className="muted">sin declarar</span>}</td></tr>
                    <tr><td>Canonical</td><td className="mono clip" title={r.html.canonical ?? ''}>{r.html.canonical ?? <span className="muted">no tiene</span>}</td></tr>
                    <tr><td>Meta robots</td><td className="mono">{r.html.metaRobots ?? r.xRobotsTag ?? <span className="muted">—</span>}</td></tr>
                    <tr>
                      <td>/llms.txt</td>
                      <td>
                        {!r.llmsTxt.present ? <span className="muted">no existe</span> : (
                          <span className={`status ${r.llmsTxt.valid ? 'good' : 'warning'}`}>
                            <span className="dot" />{r.llmsTxt.valid ? 'válido' : 'sin encabezado'} · {fmtNum(r.llmsTxt.links)} enlaces
                          </span>
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      <div className="card">
        <header>
          <h2>Visitas desde asistentes</h2>
          <span className="sub">
            GA4 · {rangeLabel(range)}{t.latest !== null && <> · datos hasta el {larga(t.latest)}</>}
          </span>
          <div style={{ flex: 1 }} />
          <TrafficRangePicker basePath={`/sites/${siteId}/ia`} current={range} />
        </header>
        {ga4 === null && t.latest === null ? (
          <div className="empty">
            El sitio no tiene GA4 conectado. <Link href={`/config/${siteId}`}>Conectarlo</Link>
          </div>
        ) : t.latest === null ? (
          <div className="empty">Todavía no hay datos. Llegan con la próxima sincronización de las 05:00, o con «Sincronizar ahora» en Búsqueda y tráfico.</div>
        ) : (
          <div className="now">
            <div><div className="k">Sesiones</div><div className="v">{fmtNum(t.sessions)}<RelDelta current={t.sessions} previous={t.prevSessions} /></div><div className="n">desde un asistente</div></div>
            <div><div className="k">Del total</div><div className="v">{t.share === null ? '—' : `${(t.share * 100).toFixed(1)}%`}</div><div className="n">de todas las sesiones</div></div>
            <div><div className="k">Interacción</div><div className="v">{t.sessions === null || t.sessions === 0 ? '—' : `${Math.round(((t.engagedSessions ?? 0) / t.sessions) * 100)}%`}</div><div className="n">sesiones con interacción</div></div>
            <div><div className="k">Eventos clave</div><div className="v">{fmtNum(t.keyEvents)}</div><div className="n">de esas visitas</div></div>
          </div>
        )}
      </div>

      {t.latest !== null && (
        <>
          <div className="charts">
            <ComparisonChart title="Sesiones desde asistentes" unit="GA4 · por día" total={fmtNum(t.sessions)} data={serie(t.series, range)} />
          </div>
          <div className="two-col">
            <div className="card">
              <header><h2>Por asistente</h2><span className="sub">sesiones, {rangeLabel(range)}</span></header>
              {t.assistants.length === 0 ? <div className="empty">Ningún asistente mandó visitas en el periodo.</div> : (
                <div className="bars">
                  {t.assistants.map((a) => (
                    <div className="row" key={a.key}>
                      <span>{a.key}</span>
                      <span className="track"><i style={{ width: `${(a.sessions / maxAsist) * 100}%` }} /></span>
                      <b>{fmtNum(a.sessions)} <RelDelta current={a.sessions} previous={a.prev} /></b>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <header>
                <h2>Páginas a las que llegan</h2>
                <span className="sub">{t.landingRange === null ? 'últimos 28 días' : `${corta(t.landingRange.start)} – ${corta(t.landingRange.end)}`}</span>
              </header>
              {t.landing.length === 0 ? <div className="empty">Sin visitas desde asistentes en el periodo.</div> : (
                <div className="scroll-x"><table>
                  <thead><tr><th>Página</th><th className="num">Sesiones</th><th className="num">Interacción</th><th className="num">Eventos clave</th></tr></thead>
                  <tbody>
                    {t.landing.slice(0, 15).map((l) => (
                      <tr key={l.key}>
                        <td className="mono clip" title={l.key}>{l.key}</td>
                        <td className="num">{fmtNum(l.sessions)}</td>
                        <td className="num">{l.sessions > 0 ? `${Math.round((l.engagedSessions / l.sessions) * 100)}%` : '—'}</td>
                        <td className="num">{fmtNum(l.keyEvents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          </div>
          <div className="card">
            <div className="cross">
              Solo cuenta las visitas que llegan con referrer o con utm del asistente (ChatGPT agrega utm_source=chatgpt.com). Las
              apps de escritorio y de teléfono a menudo no lo mandan y esas visitas caen en «Directo», así que el número real es mayor.
            </div>
          </div>
        </>
      )}

      <p className="no-print" style={{ fontSize: '11.5px', color: 'var(--ink-muted)' }}>
        <Link href={`/sites/${siteId}`}>← Rendimiento del sitio</Link>
      </p>
    </>
  );
}
