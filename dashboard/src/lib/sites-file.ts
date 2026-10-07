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
import { parseDocument, isSeq, type Document, type YAMLSeq, type YAMLMap } from 'yaml';
import { z } from 'zod';

export const SITES_FILE = process.env.SITES_FILE ?? '/app/config/sites.yaml';

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

/**
 * Edición de un sitio existente. Mismos campos que el alta menos el
 * identificador, que es inmutable: nombra la carpeta de sus PDFs y es la llave de
 * su historial, así que cambiarlo equivale a crear otro sitio desde cero. La
 * acción lo recibe igual, pero para encontrar el nodo, no para escribirlo.
 */
export const siteEditSchema = siteInputSchema;

/** URL de una página elegida a mano. Mismo contrato que valida el worker. */
const pageUrl = z
  .string()
  .trim()
  .min(1)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Cada página debe ser una URL http:// o https:// completa');

export const pagesInputSchema = z.object({
  id: z.string().trim().min(1),
  /** Vacío borra la selección: el sitio vuelve a descubrimiento automático. */
  pages: z.array(pageUrl).max(50, 'No más de 50 páginas elegidas'),
});

export type PagesInput = z.infer<typeof pagesInputSchema>;

/** Mismas reglas que el worker (config/sites.ts): si pasa aquí, la corrida no falla. */
const GSC_PROPERTY = /^(sc-domain:[a-z0-9.-]+|https?:\/\/[^\s]+\/)$/i;
const GA4_PROPERTY = /^\d{6,12}$/;

const vacioAUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const googleInputSchema = z.object({
  id: z.string().trim().min(1),
  searchConsole: z.preprocess(
    vacioAUndefined,
    z.string().trim().regex(GSC_PROPERTY, 'Escríbela como sc-domain:dominio.com o como URL completa terminada en /').optional(),
  ),
  ga4Property: z.preprocess(
    (v) => {
      const x = vacioAUndefined(v);
      return typeof x === 'string' ? x.trim().replace(/^properties\//, '') : x;
    },
    z.string().regex(GA4_PROPERTY, 'Es el número de la propiedad (Administrar › Detalles de la propiedad), no el G-XXXX').optional(),
  ),
});

export type GoogleInput = z.infer<typeof googleInputSchema>;

export interface SiteEntry {
  id: string;
  name: string;
  url: string;
  sitemap: string | undefined;
  enabled: boolean;
  /** null cuando hereda el valor de `defaults`. */
  maxPages: number | null;
  /** Vacío = las páginas las elige el descubrimiento automático. */
  pages: string[];
  /** null en cada fuente que no está conectada. */
  google: { searchConsole: string | null; ga4Property: string | null };
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
  const pages = map.get('pages');
  const gsc = map.getIn(['google', 'searchConsole']);
  // Sin comillas en el YAML el id de GA4 llega como número.
  const ga4 = map.getIn(['google', 'ga4Property']);
  return {
    id,
    name: String(map.get('name') ?? id),
    url: String(map.get('url') ?? ''),
    sitemap: typeof map.get('sitemap') === 'string' ? String(map.get('sitemap')) : undefined,
    enabled: map.get('enabled') !== false,
    maxPages: typeof maxPages === 'number' ? maxPages : null,
    // toJSON() devuelve strings planos; los nodos crudos de `yaml` no se pueden
    // pasar a un componente de React.
    pages: isSeq(pages) ? (pages.toJSON() as unknown[]).filter((u): u is string => typeof u === 'string') : [],
    google: {
      searchConsole: typeof gsc === 'string' && gsc.trim() !== '' ? gsc.trim() : null,
      ga4Property: typeof ga4 === 'string' || typeof ga4 === 'number' ? String(ga4).trim() || null : null,
    },
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

/**
 * Orden canónico de las llaves de un sitio. Importa porque sites.yaml se lee y se
 * edita a mano: `YAMLMap.set` pega las llaves nuevas al final, así que agregar un
 * sitemap desde el dashboard lo dejaría después de `pages` y el archivo se iría
 * desordenando con cada edición.
 */
const ORDEN_LLAVES = ['id', 'name', 'url', 'sitemap', 'enabled', 'maxPages', 'timeoutMs', 'viewport', 'waitUntil', 'exclude', 'google', 'pages'];

/** Asigna una llave respetando ORDEN_LLAVES cuando hay que crearla. */
function setOrdenado(doc: Document, map: YAMLMap, key: string, value: unknown): void {
  if (map.has(key)) {
    map.set(key, doc.createNode(value));
    return;
  }
  const destino = ORDEN_LLAVES.indexOf(key);
  const par = doc.createPair(key, value);
  // Se inserta antes de la primera llave que deba ir después de esta. Una llave
  // que no esté en la lista (algo que alguien agregó a mano) no mueve nada: se
  // queda donde está y la nueva acaba al final.
  const i = map.items.findIndex((item) => {
    const k = String((item.key as { value?: unknown })?.value ?? '');
    const pos = ORDEN_LLAVES.indexOf(k);
    return pos !== -1 && pos > destino;
  });
  if (i === -1) map.items.push(par);
  else map.items.splice(i, 0, par);
}

function nodoDe(seq: YAMLSeq, id: string): YAMLMap {
  const i = findIndex(seq, id);
  if (i === -1) throw new SitesFileError(`No hay ningún sitio con el identificador "${id}".`);
  return seq.get(i) as YAMLMap;
}

/**
 * Edita un sitio que ya existe. El identificador no se toca: solo sirve para
 * encontrar el nodo.
 *
 * Los campos opcionales que llegan vacíos se BORRAN del YAML en lugar de
 * escribirse como null. Dejar `sitemap: null` haría fallar la validación del
 * worker y tumbaría la corrida completa; borrar la llave es lo que de verdad
 * significa «descúbrelo solo», y un `maxPages` ausente es lo que hace visible que
 * el sitio hereda el default.
 */
export async function editSite(input: SiteInput): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const map = nodoDe(seq, input.id);

  setOrdenado(doc, map, 'name', input.name);
  setOrdenado(doc, map, 'url', input.url);
  setOrdenado(doc, map, 'enabled', input.enabled);

  if (input.sitemap === undefined) map.delete('sitemap');
  else setOrdenado(doc, map, 'sitemap', input.sitemap);

  if (input.maxPages === undefined) map.delete('maxPages');
  else setOrdenado(doc, map, 'maxPages', input.maxPages);

  await saveDocument(doc);
}

/**
 * Guarda las páginas que se auditarán. Una lista vacía borra la llave, que es
 * como se vuelve al descubrimiento automático: el worker lee `pages` ausente y
 * `pages: []` de la misma forma, pero un archivo sin la llave dice lo que pasa.
 */
export async function setSitePages(input: PagesInput): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const map = nodoDe(seq, input.id);

  // Se deduplica conservando el orden: es el que verá el informe.
  const unicas = [...new Set(input.pages)];

  if (unicas.length === 0) map.delete('pages');
  else setOrdenado(doc, map, 'pages', unicas);

  await saveDocument(doc);
}

/**
 * Guarda la conexión con Search Console y GA4. Una fuente vacía se borra del
 * YAML; si las dos quedan vacías se borra el bloque `google` completo, que es
 * como se lee «este sitio no está conectado».
 */
export async function setSiteGoogle(input: GoogleInput): Promise<void> {
  const doc = await loadDocument();
  const seq = sitesSeq(doc);
  const map = nodoDe(seq, input.id);

  const bloque: Record<string, string> = {};
  if (input.searchConsole !== undefined) bloque.searchConsole = input.searchConsole;
  // Como texto: el YAML lo escribe entre comillas y nadie lo confunde con una cantidad.
  if (input.ga4Property !== undefined) bloque.ga4Property = input.ga4Property;

  if (Object.keys(bloque).length === 0) map.delete('google');
  else setOrdenado(doc, map, 'google', bloque);

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
