/**
 * Tendencia en miniatura para la tabla de tráfico. SVG del servidor, sin
 * Recharts: son quince en una tabla y ninguna necesita tooltip.
 *
 * Área tenue, línea delgada y el último punto marcado, que es el que importa.
 * Si la serie cae fuerte se pinta en rojo, para que la fila se lea de un
 * vistazo aunque nadie mire los números.
 */
export function Sparkline({ values, alert = false, width = 96, height = 22 }: {
  values: number[];
  alert?: boolean;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) return <span className="score none">—</span>;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    2 + (i / (values.length - 1)) * (width - 4),
    height - 3 - ((v - min) / span) * (height - 6),
  ] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1] ?? [0, 0];
  const color = alert ? 'var(--critical)' : 'var(--series-current)';

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="spark">
      <polygon points={`2,${height - 2} ${line} ${last[0].toFixed(1)},${height - 2}`} fill={color} fillOpacity={0.12} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.3} />
      <circle cx={last[0]} cy={last[1]} r={2} fill={color} />
    </svg>
  );
}

/**
 * Cambio relativo contra el periodo anterior, con la misma convención que el
 * Delta de Lighthouse: la flecha dice si mejoró (▲) o empeoró (▼), el signo
 * dice hacia dónde se movió el número, y el color lo refuerza. Así una posición
 * que pasa de 3.9 a 3.1 se lee «▲ −0.8»: bajó, y eso es bueno.
 */
export function RelDelta({ current, previous, lowerIsBetter = false, absolute = false }: {
  current: number | null;
  previous: number | null;
  lowerIsBetter?: boolean;
  /** Diferencia en unidades (posición media) en vez de porcentaje. */
  absolute?: boolean;
}) {
  if (current === null || previous === null || (!absolute && previous === 0)) {
    return <span className="delta flat" title="sin periodo anterior completo con qué comparar">·</span>;
  }
  const d = absolute ? current - previous : (current - previous) / previous;
  if (Math.abs(d) < (absolute ? 0.05 : 0.005)) return <span className="delta flat" title="sin cambio">·</span>;
  const mejora = lowerIsBetter ? d < 0 : d > 0;
  const texto = absolute ? Math.abs(d).toFixed(1) : `${(Math.abs(d) * 100).toFixed(1)}%`;
  return (
    <span className={`delta ${mejora ? 'up' : 'down'}`} title="contra el periodo anterior de la misma duración">
      {mejora ? '▲' : '▼'} {d > 0 ? '+' : '−'}{texto}
    </span>
  );
}
