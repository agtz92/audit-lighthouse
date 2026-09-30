/**
 * Lectura y edición de sites.yaml desde el dashboard.
 *
 * Se usa la API de documento de `yaml`, no parse + stringify: eso último
 * devolvería el archivo sin los comentarios, y sites.yaml está lleno de notas
 * que explican por qué cada sitio está configurado como está —cuál responde 503,
 * cuál sirve su sitemap en el apex—. Perderlas al agregar un sitio desde la web
 * sería destruir la documentación del sistema sin avisar.
 *
 * La escritura es atómica (tmp + rename) por la misma razón que los PDFs: el
 * worker lee este archivo en cada corrida, y un archivo a medio escribir a las
 * 06:00 rompería la auditoría completa.
 */

import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { parseDocument, type Document, type YAMLSeq, type YAMLMap } from 'yaml';
import { z } from 'zod';

export const SITES_FILE = process.env.SITES_FILE ?? '/app/sites.yaml';

/** Mismo contrato que valida el worker: si no pasa aquí, la corrida fallaría. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

export const siteInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1, 'El identificador es obligatorio')
    .max(64, 'El identificador no puede pasar de 64 caracteres')
    .regex(SLUG, 'Solo minúsculas, dígitos y guiones, empezando con letra o dígito'),
  name: z.string().trim().min(1, 'El nombre es obligatorio').max(120),
  url: z
    .string()
    .trim()
    .min(1, 'La URL es obligatoria')
    .refine((v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'Debe ser una URL http:// o https:// completa'),
  sitemap: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v === undefined || v === '' ? undefined : v))
    .refine((v) => {
      if (v === undefined) return true;
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'El sitemap debe ser una URL completa, o déjalo vacío para descubrirlo'),
  maxPages: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : Number.NaN;
    })
    .refine((v) => v === undefined || (Number.isInteger(v) && v >= 1 && v <= 5000), 'Entre 1 y 5000 páginas'),
  enabled: z.boolean().default(true),
});

export type SiteInput = z.infer<typeof siteInputSchema>;

export interface SiteEntry {
  id: string;
  name: string;
  url: string;
  sitemap: string | undefined;
  enabled: boolean;
  /** null cuando hereda el valor de `defaults`. */
  maxPages: number | null;
}

export interface SitesFile {
  entries: SiteEntry[];
  defaults: { maxPages: number | null };
}

export class SitesFileError extends Error {
  override readonly name = 'SitesFileError';
}

async function loadDocument(): Promise<Document> {
  let raw: string;
  try {
    raw = await readFile(SITES_FILE, 'utf8');
  } catch (err) {
    throw new SitesFileError(
      `No se pudo leer ${SITES_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new SitesFileError(`${SITES_FILE} no es YAML válido: ${doc.errors[0]?.message ?? ''}`);
  }
  return doc;
}

function sitesSeq(doc: Document): YAMLSeq {
  const seq = doc.get('sites');
  if (seq === undefined || seq === null || typeof (seq as YAMLSeq).items === 'undefined') {
    throw new SitesFileError(`${SITES_FILE} no tiene una lista "sites"`);
  }
  return seq as YAMLSeq;
}

function entryOf(node: unknown): SiteEntry | null {
  const map = node as YAMLMap | undefined;
  if (map === undefined || typeof map.get !== 'function') return null;
  const id = map.get('id');
  if (typeof id !== 'string') return null;
  const maxPages = map.get('maxPages');
  return {
    id,
    name: String(map.get('name') ?? id),
    url: String(map.get('url') ?? ''),
    sitemap: typeof map.get('sitemap') === 'string' ? String(map.get('sitemap')) : undefined,
    enabled: map.get('enabled') !== false,
    maxPages: typeof maxPages === 'number' ? maxPages : null,
  };
}

export async function readSitesFile(): Promise<SitesFile> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const entries = seq.items.map(entryOf).filter((e): e is SiteEntry => e !== null);
  const defaults = doc.getIn(['defaults', 'maxPages']);
  return { entries, defaults: { maxPages: typeof defaults === 'number' ? defaults : null } };
}

/** Escribe el documento de vuelta, sin dejar el archivo a medias si algo falla. */
async function saveDocument(doc: Document): Promise<void> {
  const tmp = `${SITES_FILE}.tmp`;
  const texto = doc.toString({ lineWidth: 0 });
  try {
    await writeFile(tmp, texto, 'utf8');
    await rename(tmp, SITES_FILE);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw new SitesFileError(
      `No se pudo escribir ${SITES_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function findIndex(seq: YAMLSeq, id: string): number {
  return seq.items.findIndex((item) => entryOf(item)?.id === id);
}

export async function addSite(input: SiteInput): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);

  if (findIndex(seq, input.id) !== -1) {
    throw new SitesFileError(
      `Ya existe un sitio con el identificador "${input.id}". Los identificadores no se repiten porque nombran la carpeta de sus PDFs y su historial.`,
    );
  }

  // Solo se escriben los campos con valor: un `sitemap: null` en el YAML haría
  // fallar la validación del worker, y un maxPages redundante esconde que el
  // sitio en realidad hereda el default.
  const nodo: Record<string, unknown> = {
    id: input.id,
    name: input.name,
    url: input.url,
  };
  if (input.sitemap !== undefined) nodo.sitemap = input.sitemap;
  nodo.enabled = input.enabled;
  if (input.maxPages !== undefined) nodo.maxPages = input.maxPages;

  seq.add(doc.createNode(nodo));
  await saveDocument(doc);
}

export async function removeSite(id: string): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const i = findIndex(seq, id);
  if (i === -1) throw new SitesFileError(`No hay ningún sitio con el identificador "${id}".`);
  if (seq.items.length === 1) {
    throw new SitesFileError('No se puede quitar el último sitio: el worker necesita al menos uno.');
  }
  seq.delete(i);
  await saveDocument(doc);
}

export async function setSiteEnabled(id: string, enabled: boolean): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const i = findIndex(seq, id);
  if (i === -1) throw new SitesFileError(`No hay ningún sitio con el identificador "${id}".`);
  (seq.get(i) as YAMLMap).set('enabled', enabled);
  await saveDocument(doc);
}
