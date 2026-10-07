import Link from 'next/link';
import { TRAFFIC_RANGES, type TrafficRange } from '@/lib/traffic-queries';

const ETIQUETA: Record<TrafficRange, string> = { 28: '28 días', 90: '90 días', 365: '12 meses' };

/** Selector de periodo del tráfico. Enlaces, para que el rango viva en la URL. */
export function TrafficRangePicker({ basePath, current }: { basePath: string; current: TrafficRange }) {
  return (
    <span className="ranges">
      {TRAFFIC_RANGES.map((r) => (
        <Link key={r} href={`${basePath}?range=${r}`} className={r === current ? 'on' : undefined}>
          {ETIQUETA[r]}
        </Link>
      ))}
    </span>
  );
}

export function rangeLabel(r: TrafficRange): string {
  return r === 365 ? 'los últimos 12 meses' : `los últimos ${r} días`;
}
