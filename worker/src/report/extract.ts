/**
 * Lectura del JSON de Lighthouse para el informe.
 *
 * Se trabaja sobre el `lhr` completo y no sobre las columnas que guardamos en la
 * base porque el informe necesita el detalle —oportunidades con su ahorro
 * estimado, auditorías no aprobadas con su descripción— que en la base vive
 * comprimido. Como ese JSON se conserva 90 días, cualquier informe se puede
 * regenerar hacia atrás sin volver a auditar el sitio.
 */

/** Forma mínima del reporte de Lighthouse que nos interesa. */
export interface Lhr {
  lighthouseVersion?: string;
  categories?: Record<string, { id?: string; title?: string; score?: number | null; auditRefs?: Array<{ id: string; group?: string }> }>;
  audits?: Record<string, LhAudit | undefined>;
}

export interface LhAudit {
  id?: string;
  title?: string;
  description?: string;
  score?: number | null;
  scoreDisplayMode?: string;
  numericValue?: number;
  displayValue?: string;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number };
}

export interface Opportunity {
  title: string;
  savingsMs: number;
  savingsBytes: number;
}

export interface Finding {
  title: string;
  description: string;
  category: 'accessibility' | 'best-practices' | 'seo' | 'performance';
}

/**
 * Las descripciones de Lighthouse traen markdown con enlaces:
 * "Aprende más sobre [X](https://...)". En un PDF el enlace no sirve de nada y
 * la sintaxis estorba, así que se deja solo el texto.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Recorta una descripción a una o dos oraciones, sin cortar a media palabra. */
export function firstSentences(text: string, max = 240): string {
  const limpio = stripMarkdown(text);
  if (limpio.length <= max) return limpio;
  const corte = limpio.lastIndexOf('. ', max);
  if (corte > 60) return limpio.slice(0, corte + 1);
  const espacio = limpio.lastIndexOf(' ', max);
  return `${limpio.slice(0, espacio > 0 ? espacio : max)}…`;
}

/**
 * Oportunidades con ahorro real, de mayor a menor.
 *
 * Se descartan las auditorías que Lighthouse marca como tipo "oportunidad" pero
 * que el sitio YA aprueba: `server-response-time` reporta un ahorro estimado
 * incluso cuando el servidor respondió rápido, y sin este filtro el informe le
 * pedía al cliente corregir algo que estaba bien. Un informe que hace eso pierde
 * la confianza de quien lo lee.
 *
 * El piso de 150 ms es de relevancia, no de espacio: un ahorro de 60 ms no se
 * percibe y no se defiende en una presentación. Llenar la lista con esos
 * entierra los dos o tres cambios que sí mueven la aguja.
 */
export function opportunities(lhr: Lhr, min = 150): Opportunity[] {
  const out: Opportunity[] = [];
  for (const audit of Object.values(lhr.audits ?? {})) {
    if (audit?.details?.type !== 'opportunity') continue;
    if (audit.score !== null && audit.score !== undefined && audit.score >= 1) continue;
    const savingsMs = Math.round(audit.details.overallSavingsMs ?? 0);
    if (savingsMs < min) continue;
    out.push({
      title: stripMarkdown(audit.title ?? ''),
      savingsMs,
      savingsBytes: Math.round(audit.details.overallSavingsBytes ?? 0),
    });
  }
  return out.sort((a, b) => b.savingsMs - a.savingsMs);
}

const CATEGORIAS: Array<Finding['category']> = ['accessibility', 'best-practices', 'seo', 'performance'];

/** Auditorías no aprobadas, agrupadas por la categoría a la que pertenecen. */
export function findings(lhr: Lhr): Finding[] {
  const out: Finding[] = [];
  const vistos = new Set<string>();

  for (const categoria of CATEGORIAS) {
    const refs = lhr.categories?.[categoria]?.auditRefs ?? [];
    for (const ref of refs) {
      if (vistos.has(ref.id)) continue;
      const audit = lhr.audits?.[ref.id];
      if (audit === undefined) continue;
      // Solo las de aprobado/reprobado: las informativas y las que no aplican
      // no son hallazgos, son contexto.
      if (audit.scoreDisplayMode !== 'binary') continue;
      if (audit.score === null || audit.score === undefined || audit.score >= 1) continue;
      vistos.add(ref.id);
      out.push({
        title: stripMarkdown(audit.title ?? ref.id),
        description: firstSentences(audit.description ?? ''),
        category: categoria,
      });
    }
  }
  return out;
}

/** Valor numérico de una auditoría, o null si no la produjo. */
export function metric(lhr: Lhr, id: string): number | null {
  const v = lhr.audits?.[id]?.numericValue;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
