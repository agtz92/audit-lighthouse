/**
 * Tipografías del informe, incrustadas como data URI.
 *
 * Los archivos vienen de los paquetes @fontsource, así que viajan dentro de la
 * imagen: imprimir no depende de que haya red ni de que Google Fonts responda.
 * Y al ir embebidas en el HTML, Chromium las mete en el PDF, que es lo que hace
 * que el documento se vea igual en cualquier computadora que lo abra.
 *
 * Se leen una sola vez por proceso: son ~150 kB que no tiene sentido releer en
 * cada uno de los cuarenta informes de una corrida.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface FaceSpec {
  family: string;
  weight: number;
  /** Ruta dentro del paquete de @fontsource. */
  file: string;
}

const FACES: FaceSpec[] = [
  { family: 'Archivo', weight: 500, file: '@fontsource/archivo/files/archivo-latin-500-normal.woff2' },
  { family: 'Archivo', weight: 600, file: '@fontsource/archivo/files/archivo-latin-600-normal.woff2' },
  { family: 'Archivo', weight: 700, file: '@fontsource/archivo/files/archivo-latin-700-normal.woff2' },
  { family: 'Source Sans 3', weight: 400, file: '@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2' },
  { family: 'Source Sans 3', weight: 600, file: '@fontsource/source-sans-3/files/source-sans-3-latin-600-normal.woff2' },
  { family: 'Roboto Mono', weight: 400, file: '@fontsource/roboto-mono/files/roboto-mono-latin-400-normal.woff2' },
  { family: 'Roboto Mono', weight: 500, file: '@fontsource/roboto-mono/files/roboto-mono-latin-500-normal.woff2' },
];

let cached: string | undefined;

/** Bloque @font-face con las siete variantes embebidas en base64. */
export async function fontFaceCss(): Promise<string> {
  if (cached !== undefined) return cached;

  const bloques = await Promise.all(
    FACES.map(async (face) => {
      const path = require.resolve(face.file);
      const base64 = (await readFile(path)).toString('base64');
      return `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${face.weight};font-display:block;src:url(data:font/woff2;base64,${base64}) format('woff2');}`;
    }),
  );

  cached = bloques.join('\n');
  return cached;
}
