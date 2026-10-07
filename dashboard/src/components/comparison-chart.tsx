'use client';

import {
  Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmtNum } from '@/lib/format';

/**
 * Una métrica de tráfico: el periodo actual contra el anterior de la misma
 * duración, alineados día a día.
 *
 * Mismas reglas que TrendChart —una gráfica por métrica, un solo eje, leyenda
 * siempre presente— con una diferencia de color a propósito: el azul y el
 * naranja de la app significan escritorio y móvil, y aquí no hay estrategias.
 * El periodo actual va en el color de serie propio del tráfico, y el anterior
 * en gris punteado, que se lee como «referencia» sin competir.
 */

export interface ComparisonDatum {
  key: string;
  label: string;
  full: string;
  fullPrev: string;
  current: number | null;
  previous: number | null;
}

export type ComparisonFormat = 'int' | 'dec';

const FORMAT: Record<ComparisonFormat, (v: number) => string> = {
  int: (v) => fmtNum(v),
  dec: (v) => fmtNum(v, 1),
};

interface TooltipItem {
  dataKey?: string | number;
  value?: number | string;
  payload?: ComparisonDatum;
}

function ChartTooltip({ active, payload, format }: { active?: boolean; payload?: TooltipItem[]; format: (v: number) => string }) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const p = payload[0]?.payload;
  if (p === undefined) return null;
  return (
    <div className="tooltip">
      <div className="t-row">
        <i style={{ background: 'var(--series-current)' }} />
        <span>{p.full}</span>
        <b>{p.current === null ? '—' : format(p.current)}</b>
      </div>
      <div className="t-row">
        <i style={{ background: 'var(--series-prev)' }} />
        <span>{p.fullPrev}</span>
        <b>{p.previous === null ? '—' : format(p.previous)}</b>
      </div>
    </div>
  );
}

export function ComparisonChart({
  title, unit, total, data, format = 'int', invert = false,
}: {
  title: string;
  unit: string;
  /** Cifra del periodo, al lado del título. */
  total: string;
  data: ComparisonDatum[];
  format?: ComparisonFormat;
  /** Posición media: menos es mejor, así que el eje va al revés. */
  invert?: boolean;
}) {
  const f = FORMAT[format];
  const hayDatos = data.some((d) => d.current !== null && d.current !== 0);
  const etiquetas = new Map(data.map((d) => [d.key, d.label]));

  return (
    <div className="chart-card">
      <h3 className="chart-title">
        {title}
        <span className="big">{total}</span>
      </h3>
      <p className="unit">{unit}</p>
      {!hayDatos ? (
        <div className="chart-empty">Sin datos en este rango</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={158}>
            <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="var(--grid)" strokeWidth={1} vertical={false} />
              <XAxis
                dataKey="key"
                tickFormatter={(k: string) => etiquetas.get(k) ?? ''}
                tick={{ fill: 'var(--ink-muted)', fontSize: 10 }}
                stroke="var(--axis)"
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={28}
              />
              <YAxis
                tick={{ fill: 'var(--ink-muted)', fontSize: 10 }}
                stroke="var(--axis)"
                tickLine={false}
                width={46}
                reversed={invert}
                domain={invert ? ['dataMin', 'dataMax'] : [0, 'auto']}
                tickFormatter={(v: number) => f(v)}
              />
              <Tooltip
                content={<ChartTooltip format={f} />}
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1, strokeDasharray: '3 3' }}
              />
              {!invert && (
                <Area type="monotone" dataKey="current" stroke="none" fill="var(--series-current)" fillOpacity={0.08} isAnimationActive={false} />
              )}
              <Line type="monotone" dataKey="previous" stroke="var(--series-prev)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} activeDot={false} connectNulls={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="current" stroke="var(--series-current)" strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} connectNulls={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <ul className="chart-legend">
            <li><i style={{ background: 'var(--series-current)' }} />periodo actual</li>
            <li><i className="dashed" />periodo anterior</li>
          </ul>
        </>
      )}
    </div>
  );
}
