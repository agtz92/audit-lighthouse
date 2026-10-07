/**
 * ¿Ya existe tal PDF de un sitio? Se pregunta al disco y no a la base: el
 * archivo vigente es el de la última corrida que ALCANZÓ a generarlo, y el
 * disco es el único que lo sabe sin juntar dos tablas de dos procesos.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const PDF_DIR = process.env.PDF_DIR ?? '/data/pdfs';
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export type PdfKind = 'desktop' | 'mobile' | 'analitica' | 'integral';

export async function pdfExists(siteId: string, kind: PdfKind): Promise<boolean> {
  if (!SLUG.test(siteId)) return false;
  try {
    return (await stat(join(PDF_DIR, siteId, `${kind}.pdf`))).isFile();
  } catch {
    return false;
  }
}

/** Los dos documentos de tráfico de varios sitios, en paralelo. */
export async function trafficPdfs(siteIds: string[]): Promise<Map<string, { analitica: boolean; integral: boolean }>> {
  const pares = await Promise.all(siteIds.map(async (id) => {
    const [analitica, integral] = await Promise.all([pdfExists(id, 'analitica'), pdfExists(id, 'integral')]);
    return [id, { analitica, integral }] as const;
  }));
  return new Map(pares);
}
