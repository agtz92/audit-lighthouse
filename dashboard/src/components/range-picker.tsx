import Link from 'next/link';

const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];

export function parseRange(raw: string | undefined): Range {
  const n = Number(raw);
  return (RANGES as readonly number[]).includes(n) ? (n as Range) : 30;
}

/** Selector de 7/30/90 días. Va como enlaces para que el rango viva en la URL. */
export function RangePicker({ basePath, current }: { basePath: string; current: Range }) {
  return (
    <span className="ranges">
      {RANGES.map((r) => (
        <Link key={r} href={`${basePath}?range=${r}`} className={r === current ? 'on' : undefined}>
          {r} d
        </Link>
      ))}
    </span>
  );
}
