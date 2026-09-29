import type { SiteRunStatus } from '@/lib/queries';
import { rateScore, type StatusKey } from '@/lib/palette';

/**
 * Los colores de estado nunca cargan el significado solos: siempre van con un
 * ícono y una etiqueta de texto. En modo claro, `warning` y `serious` quedan por
 * debajo de 3:1 de contraste a propósito, y hay gente que no distingue el verde
 * del rojo.
 */
const STATUS_META: Record<SiteRunStatus | 'sin-datos', { key: StatusKey | 'none'; label: string; icon: string }> = {
  ok: { key: 'good', label: 'En línea', icon: '●' },
  partial: { key: 'warning', label: 'Parcial', icon: '◐' },
  failed: { key: 'critical', label: 'Caído', icon: '▲' },
  skipped_timeout: { key: 'serious', label: 'Sin medir', icon: '◌' },
  running: { key: 'none', label: 'En curso', icon: '◌' },
  'sin-datos': { key: 'none', label: 'Sin datos', icon: '—' },
};

export function StatusBadge({ status }: { status: SiteRunStatus | null }) {
  const meta = STATUS_META[status ?? 'sin-datos'];
  return (
    <span className={`status ${meta.key}`} title={meta.label}>
      <span className="dot" aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** Score de Lighthouse con su color por umbral (>=90 bien, >=50 medio, resto mal). */
export function Score({ value }: { value: number | null }) {
  const rating = rateScore(value);
  return <span className={`score ${rating ?? 'none'}`}>{value ?? '—'}</span>;
}

/**
 * Delta contra la corrida anterior. El signo y la flecha llevan el significado;
 * el color solo lo refuerza.
 */
export function Delta({ value, invert = false }: { value: number | null; invert?: boolean }) {
  if (value === null || value === 0) {
    return <span className="delta flat" title="sin cambio respecto a la corrida anterior">·</span>;
  }
  // En LCP o CLS, subir es empeorar: invert voltea qué color es "bueno".
  const mejora = invert ? value < 0 : value > 0;
  const signo = value > 0 ? '+' : '−';
  const magnitud = Math.abs(value);
  const texto = Number.isInteger(magnitud) ? magnitud.toString() : magnitud.toFixed(2);
  return (
    <span className={`delta ${mejora ? 'up' : 'down'}`} title="cambio contra la corrida anterior">
      {mejora ? '▲' : '▼'}
      {signo}
      {texto}
    </span>
  );
}

/** Días restantes del certificado, con umbral de aviso a 21 días. */
export function CertCell({ days, valid }: { days: number | null; valid: boolean | null }) {
  if (days === null) return <span className="score none">—</span>;
  const key: StatusKey = days < 0 ? 'critical' : days < 21 ? 'warning' : 'good';
  const label = days < 0 ? `vencido hace ${Math.abs(days)} d` : `${days} d`;
  return (
    <span className={`status ${key}`} title={valid === false ? 'la cadena del certificado no valida' : `vence en ${days} días`}>
      <span className="dot" aria-hidden="true" />
      {label}
      {valid === false ? ' ⚠' : ''}
    </span>
  );
}
