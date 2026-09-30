'use client';

import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { fmtBytes, fmtMs, fmtNum } from '@/lib/format';

/**
 * Gráfica de tendencia de una métrica, con escritorio y móvil como las dos series.
 *
 * Decisiones que vienen de la guía de visualización:
 *  - Una gráfica por métrica (small multiples) en lugar de meter los cuatro
 *    scores juntos. Con dos series basta el par azul/naranja, que pasa los seis
 *    checks de contraste y daltonismo en claro y oscuro sin advertencias; con
 *    cuatro, dos de los colores caían por debajo de 3:1 en modo claro.
 *  - Un solo eje Y. Nunca dos escalas en la misma gráfica.
 *  - El color sigue a la entidad: escritorio siempre azul, móvil siempre naranja,
 *    en todas las gráficas de toda la app. No se reasigna según quién sobreviva
 *    a un filtro.
 *  - Leyenda siempre presente con dos series, para que la identidad no dependa
 *    solo del color.
 *  - Marcas delgadas: línea de 2px, punto de 8px solo al pasar el cursor, malla
 *    discreta.
 */

export interface TrendDatum {
  /**
   * Identidad del punto en el eje X. Tiene que ser ÚNICA, y por eso no es la
   * fecha formateada: varias corridas del mismo día comparten etiqueta —la de
   * las 06:00, una manual, una de recuperación— y Recharts trata el valor del
   * eje como categoría. Con categorías repetidas dibuja la retícula donde está
   * el cursor pero resuelve el contenido al PRIMER punto que comparte etiqueta,
   * así que el tooltip mostraba los números de otra corrida.
   *
   * Sirve cualquier cosa estable y distinta por punto: el id de la corrida o su
   * marca de tiempo.
   */
  key: string;
  /** Etiqueta del eje X, ya formateada. Puede repetirse: es solo texto. */
  label: string;
  /** Fecha completa para el tooltip. */
  full: string;
  desktop: number | null;
  mobile: number | null;
}

/**
 * El formato viaja como nombre, no como función: las funciones no cruzan la
 * frontera entre un componente de servidor y uno de cliente. Se resuelve aquí.
 */
export type ValueFormat = 'plain' | 'ms' | 'bytes' | 'cls';

const FORMATTERS: Record<ValueFormat, (v: number) => string> = {
  plain: (v) => fmtNum(v),
  ms: (v) => fmtMs(v),
  bytes: (v) => fmtBytes(v),
  cls: (v) => v.toFixed(3),
};

export interface TrendChartProps {
  title: string;
  unit: string;
  data: TrendDatum[];
  format?: ValueFormat;
  /** Rango fijo del eje Y, p. ej. [0, 100] para los scores. */
  domain?: [number, number];
  /** Solo se grafica escritorio (para métricas que no dependen de la estrategia). */
  singleSeries?: boolean;
}

const SERIES = [
  { key: 'desktop' as const, label: 'Escritorio', color: 'var(--series-desktop)' },
  { key: 'mobile' as const, label: 'Móvil', color: 'var(--series-mobile)' },
];

interface TooltipPayloadItem {
  dataKey?: string | number;
  value?: number | string;
  payload?: TrendDatum;
}

function ChartTooltip({
  active, payload, format,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  format: (v: number) => string;
}) {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const punto = payload[0]?.payload;
  return (
    <div className="tooltip">
      <div className="t-date">{punto?.full ?? ''}</div>
      {payload.map((item) => {
        const serie = SERIES.find((s) => s.key === item.dataKey);
        if (serie === undefined || typeof item.value !== 'number') return null;
        return (
          <div className="t-row" key={serie.key}>
            <i style={{ background: serie.color }} />
            <span>{serie.label}</span>
            <b>{format(item.value)}</b>
          </div>
        );
      })}
    </div>
  );
}

export function TrendChart({
  title, unit, data, format = 'plain', domain, singleSeries = false,
}: TrendChartProps) {
  const formatear = FORMATTERS[format];
  const series = singleSeries ? SERIES.slice(0, 1) : SERIES;
  // Una línea necesita dos puntos para dibujarse. Con pocas corridas —los
  // primeros días del sistema, o un sitio recién agregado— la gráfica se vería
  // vacía aunque haya datos, así que ahí sí se marcan los puntos.
  const pocosPuntos = data.length <= 10;
  const hayDatos = data.some((d) => d.desktop !== null || d.mobile !== null);
  // El eje se mueve sobre la clave única; la fecha se pinta al formatear la marca.
  const etiquetas = new Map(data.map((d) => [d.key, d.label]));

  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <p className="unit">{unit}</p>
      {!hayDatos ? (
        <div className="chart-empty">Sin datos en este rango</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={158}>
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
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
                domain={domain ?? ['auto', 'auto']}
                tickFormatter={(v: number) => formatear(v)}
              />
              <Tooltip
                content={<ChartTooltip format={formatear} />}
                // La retícula hace de crosshair; el área de impacto es toda la
                // columna, mucho más grande que el punto.
                cursor={{ stroke: 'var(--axis)', strokeWidth: 1, strokeDasharray: '3 3' }}
              />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={pocosPuntos ? { r: 2.5, strokeWidth: 0 } : false}
                  activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <ul className="chart-legend">
            {series.map((s) => (
              <li key={s.key}>
                <i style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
