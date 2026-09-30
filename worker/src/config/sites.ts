/**
 * Lectura y validación de sites.yaml.
 *
 * Se lee en cada corrida, no al arrancar el contenedor: editar el YAML basta
 * para agregar o quitar un sitio. Si el archivo está mal formado la corrida
 * falla completa y con un mensaje que dice exactamente qué campo y en qué sitio,
 * en lugar de auditar medio archivo y dejar el resto en silencio.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/** Valores que Playwright acepta en waitUntil. */
const WAIT_UNTIL = ['load', 'domcontentloaded', 'networkidle', 'commit'] as const;
export type WaitUntil = (typeof WAIT_UNTIL)[number];

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'debe ser una URL http:// o https:// completa' },
  );

const viewportSchema = z.strictObject({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(320).max(2160),
});

/** Ajustes que pueden vivir en `defaults` o sobrescribirse por sitio. */
const tunablesSchema = z.strictObject({
  maxPages: z.number().int().min(1).max(5000).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  viewport: viewportSchema.optional(),
  waitUntil: z.enum(WAIT_UNTIL).optional(),
  exclude: z.array(z.string().min(1)).optional(),
});

const siteSchema = tunablesSchema.extend({
  // El id acaba como nombre de carpeta en data/pdfs y como llave de historial en
  // la BD: solo minúsculas, dígitos y guiones, para que sea seguro en rutas.
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'solo minúsculas, dígitos y guiones, empezando con letra o dígito')
    .max(64),
  name: z.string().trim().min(1),
  url: httpUrl,
  sitemap: httpUrl.optional(),
  enabled: z.boolean().default(true),
  // Selección manual de páginas. No vive en `tunables` a propósito: una lista de
  // URLs concretas no puede heredarse desde `defaults`, solo pertenece a un sitio.
  //
  // Cuando trae elementos, esas son las páginas que se auditan y el
  // descubrimiento automático deja de decidir (aunque sigue corriendo, para
  // mantener fresco el catálogo de opciones). Vacía o ausente equivale a
  // automático. No se exige que sean del mismo host: un sitio puede querer medir
  // su blog en un subdominio.
  pages: z.array(httpUrl).max(50).optional(),
});

const fileSchema = z.strictObject({
  defaults: tunablesSchema.default({}),
  sites: z.array(siteSchema).min(1, 'sites.yaml no declara ningún sitio'),
});

/** Un sitio con los defaults ya aplicados: no quedan campos opcionales de tuning. */
export interface ResolvedSite {
  id: string;
  name: string;
  url: string;
  sitemap: string | undefined;
  enabled: boolean;
  maxPages: number;
  timeoutMs: number;
  viewport: { width: number; height: number };
  waitUntil: WaitUntil;
  exclude: string[];
  /** Vacío = las páginas las elige el descubrimiento automático. */
  pages: string[];
}

/** Defaults de los defaults, cuando el YAML no dice nada. */
const FALLBACK = {
  maxPages: 50,
  timeoutMs: 30_000,
  viewport: { width: 1440, height: 900 },
  waitUntil: 'networkidle' as WaitUntil,
  exclude: [] as string[],
};

export class SitesConfigError extends Error {
  override readonly name = 'SitesConfigError';
}

/**
 * Valida el contenido de un sites.yaml ya leído.
 * Separado de la lectura de disco para poder probarlo sin tocar el filesystem.
 */
export function parseSitesConfig(raw: string, source = 'sites.yaml'): ResolvedSite[] {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new SitesConfigError(
      `${source} no es YAML válido: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (doc === null || doc === undefined) {
    throw new SitesConfigError(`${source} está vacío`);
  }

  const parsed = fileSchema.safeParse(doc);
  if (!parsed.success) {
    throw new SitesConfigError(`${source} tiene errores:\n${z.prettifyError(parsed.error)}`);
  }

  const { defaults, sites } = parsed.data;

  // Un id repetido haría que dos sitios compartan carpeta de PDFs y se pisen.
  const seen = new Map<string, number>();
  const dupes: string[] = [];
  sites.forEach((site, index) => {
    const first = seen.get(site.id);
    if (first !== undefined) {
      dupes.push(`  id "${site.id}" repetido en sites[${first}] y sites[${index}]`);
    } else {
      seen.set(site.id, index);
    }
  });
  if (dupes.length > 0) {
    throw new SitesConfigError(`${source} tiene ids duplicados:\n${dupes.join('\n')}`);
  }

  return sites.map((site) => ({
    id: site.id,
    name: site.name,
    url: site.url,
    sitemap: site.sitemap,
    enabled: site.enabled,
    maxPages: site.maxPages ?? defaults.maxPages ?? FALLBACK.maxPages,
    timeoutMs: site.timeoutMs ?? defaults.timeoutMs ?? FALLBACK.timeoutMs,
    viewport: site.viewport ?? defaults.viewport ?? FALLBACK.viewport,
    waitUntil: site.waitUntil ?? defaults.waitUntil ?? FALLBACK.waitUntil,
    exclude: site.exclude ?? defaults.exclude ?? FALLBACK.exclude,
    // Una lista vacía se lee como ausente: es lo que queda en el YAML al
    // deseleccionar todo desde el dashboard, y significa «vuelve a automático».
    pages: site.pages ?? [],
  }));
}

/** Lee y valida el sites.yaml del disco. */
export async function loadSitesConfig(path: string): Promise<ResolvedSite[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new SitesConfigError(
      `no se pudo leer ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseSitesConfig(raw, path);
}
