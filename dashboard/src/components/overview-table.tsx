'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import type { OverviewRow, SiteRunStatus, Strategy } from '@/lib/queries';
import { StatusBadge, Score, Delta, CertCell } from './indicators';
import { fmtBytes, fmtMs, fmtNum, fmtTime, ERROR_LABELS } from '@/lib/format';
import { rateLowerIsBetter, THRESHOLDS } from '@/lib/palette';

function diff(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return Number((a - b).toFixed(2));
}

const SCORE_KEYS = ['performance', 'accessibility', 'bestPractices', 'seo'] as const;
const SCORE_LABELS = { performance: 'Perf', accessibility: 'A11y', bestPractices: 'BP', seo: 'SEO' } as const;

/** Clases de la banda de color de cada estrategia; la primera columna lleva la línea divisoria. */
function bandClass(strategy: Strategy, i: number): string {
  return `${strategy === 'desktop' ? 'band-d' : 'band-m'}${i === 0 ? ' band-start' : ''}`;
}

/** Los cuatro scores de una estrategia, con su delta contra la corrida anterior. */
function ScoreGroup({ row, strategy }: { row: OverviewRow; strategy: Strategy }) {
  const now = row.current[strategy];
  const before = row.previous[strategy];
  return (
    <>
      {SCORE_KEYS.map((k, i) => (
        <td className={`num ${bandClass(strategy, i)}`} key={k}>
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

/**
 * Enlace al reporte de Lighthouse de una estrategia.
 *
 * target="_blank" a propósito: el PDF se abre en una pestaña nueva y el
 * dashboard se queda donde estaba. Sin eso, el navegador reemplaza la tabla por
 * el visor de PDF y hay que volver atrás para seguir revisando sitios.
 * rel="noreferrer noopener" acompaña siempre a target="_blank".
 */
function ReportLink({
  siteId, strategy, bytes, pages,
}: {
  siteId: string;
  strategy: 'desktop' | 'mobile';
  bytes: number | null;
  pages: number | null;
}) {
  const etiqueta = strategy === 'desktop' ? 'escritorio' : 'móvil';
  if (bytes === null) return <span className="off">{etiqueta}</span>;
  return (
    <a
      href={`/api/pdf/${siteId}/${strategy}`}
      target="_blank"
      rel="noreferrer noopener"
      title={`Reporte de Lighthouse ${etiqueta} · ${fmtBytes(bytes)}${pages !== null ? ` · ${pages} hojas` : ''} · abre en otra pestaña`}
    >
      {etiqueta}
    </a>
  );
}

type SortDir = 'asc' | 'desc';
type Sort = { key: string; dir: SortDir } | null;
type SortValue = string | number | null;

/** De peor a mejor, para que ordenar por estado ponga arriba lo que hay que atender. */
const STATUS_RANK: Record<SiteRunStatus, number> = {
  failed: 0, partial: 1, skipped_timeout: 2, running: 3, ok: 4,
};

/**
 * Qué valor usa cada columna ordenable. Las de score se generan para las dos
 * estrategias: `desktop.performance`, `mobile.seo`, etc.
 */
const SORT_VALUES: Record<string, (r: OverviewRow) => SortValue> = {
  name: (r) => r.name.toLowerCase(),
  status: (r) => (r.status === null ? null : STATUS_RANK[r.status]),
  http: (r) => r.homeHttpStatus,
  lcp: (r) => r.current.mobile?.lcpMs ?? null,
  cls: (r) => r.current.mobile?.cls ?? null,
  cert: (r) => r.certDaysRemaining,
  pages: (r) => r.pagesAudited,
  startedAt: (r) => (r.startedAt === null ? null : new Date(r.startedAt).getTime()),
};
for (const strategy of ['desktop', 'mobile'] as const) {
  for (const k of SCORE_KEYS) SORT_VALUES[`${strategy}.${k}`] = (r) => r.current[strategy]?.[k] ?? null;
}

/** Los vacíos van siempre al final, sin importar la dirección. */
function compare(a: SortValue, b: SortValue, dir: SortDir): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const c = typeof a === 'string' ? a.localeCompare(String(b), 'es') : a - (b as number);
  return dir === 'asc' ? c : -c;
}

/**
 * Encabezado que ordena con cada clic: ascendente, descendente y de vuelta al
 * orden original. La flecha tenue avisa que la columna se puede ordenar.
 */
function SortTh({
  label, sortKey, sort, onSort, className, title,
}: {
  label: string;
  sortKey: string;
  sort: Sort;
  onSort: (key: string) => void;
  className?: string;
  title?: string;
}) {
  const active = sort?.key === sortKey ? sort.dir : null;
  return (
    <th
      className={className}
      aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none'}
    >
      <button type="button" className={`sort-btn${active ? ' active' : ''}`} onClick={() => onSort(sortKey)} title={title}>
        {label}
        <span className="sort-arrow" aria-hidden="true">
          {active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}
        </span>
      </button>
    </th>
  );
}

export function OverviewTable({ rows }: { rows: OverviewRow[] }) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q === ''
      ? rows
      : rows.filter((r) => `${r.name} ${r.siteId} ${r.url}`.toLowerCase().includes(q));
    const value = sort === null ? undefined : SORT_VALUES[sort.key];
    if (sort === null || value === undefined) return filtered;
    return [...filtered].sort((a, b) => compare(value(a), value(b), sort.dir));
  }, [rows, query, sort]);

  if (rows.length === 0) {
    return <div className="empty">No hay sitios registrados. Agrega alguno a sites.yaml.</div>;
  }

  const onSort = (key: string) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null));
  const th = (label: string, sortKey: string, className?: string, title?: string) => (
    <SortTh key={sortKey} label={label} sortKey={sortKey} sort={sort} onSort={onSort} className={className} title={title} />
  );
  const scoreHeaders = (strategy: Strategy) =>
    SCORE_KEYS.map((k, i) => th(SCORE_LABELS[k], `${strategy}.${k}`, `num ${bandClass(strategy, i)}`));

  return (
    <>
      <div className="table-tools no-print">
        <input
          type="search"
          className="table-search"
          placeholder="Buscar sitio…"
          aria-label="Filtrar sitios por nombre, id o URL"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        />
        {query.trim() !== '' && <span className="sub">{visible.length} de {rows.length}</span>}
      </div>
      <div className="scroll-x">
        <table>
          <thead>
            <tr className="group-row">
              <th colSpan={3} />
              <th colSpan={4} className="band-d band-start">Escritorio</th>
              <th colSpan={4} className="band-m band-start">Móvil</th>
              <th colSpan={6} />
            </tr>
            <tr>
              {th('Sitio', 'name')}
              {th('Estado', 'status', undefined, 'De peor a mejor: fallido, parcial, sin tiempo, en curso, en línea')}
              {th('HTTP', 'http', 'num')}
              {scoreHeaders('desktop')}
              {scoreHeaders('mobile')}
              {th('LCP móvil', 'lcp', 'num')}
              {th('CLS móvil', 'cls', 'num')}
              {th('Certificado', 'cert')}
              {th('Págs.', 'pages', 'num')}
              {th('Corrida', 'startedAt', 'num')}
              <th>Reporte</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={17} className="empty">Ningún sitio coincide con «{query.trim()}».</td>
              </tr>
            )}
            {visible.map((row) => {
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
                  {/* La hora se formatea igual en servidor y navegador, pero el ICU de
                      cada uno puede espaciar distinto «a.m.»; no vale un error de hidratación. */}
                  <td className="num" suppressHydrationWarning>{fmtTime(row.startedAt)}</td>
                  <td>
                    <span className="dl">
                      <ReportLink
                        siteId={row.siteId}
                        strategy="desktop"
                        bytes={row.desktopPdfBytes}
                        pages={row.desktopPdfPages}
                      />
                      <ReportLink
                        siteId={row.siteId}
                        strategy="mobile"
                        bytes={row.mobilePdfBytes}
                        pages={row.mobilePdfPages}
                      />
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
