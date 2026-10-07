/**
 * Sirve el PDF vigente de un sitio desde el volumen compartido.
 *
 * El dashboard no tiene autenticación, así que el id del sitio se valida contra
 * la base antes de tocar el disco: sin eso, un id como "../../etc" sería una fuga
 * de archivos arbitrarios. Se valida además con la misma expresión que usa el
 * validador del YAML, para que ni un id raro en la base abra la puerta.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { query } from '@/lib/db';

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/**
 * Los documentos de cada sitio: los dos de Lighthouse, el de tráfico y el
 * integral. Lista cerrada: el valor termina en una ruta de archivo.
 */
const KINDS = new Set(['desktop', 'mobile', 'analitica', 'integral']);

const NOMBRE: Record<string, string> = {
  desktop: 'el reporte de Lighthouse de escritorio',
  mobile: 'el reporte de Lighthouse móvil',
  analitica: 'el informe de búsqueda y tráfico',
  integral: 'el informe integral',
};

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteId: string; kind: string }> },
) {
  const { siteId, kind } = await params;

  if (!SLUG.test(siteId) || !KINDS.has(kind)) {
    return new Response('petición inválida', { status: 400 });
  }

  // El sitio debe existir: es la segunda barrera contra rutas inventadas.
  const rows = await query<{ id: string; name: string }>('SELECT id, name FROM sites WHERE id = $1', [siteId]);
  const site = rows[0];
  if (site === undefined) {
    return new Response('sitio desconocido', { status: 404 });
  }

  const pdfDir = process.env.PDF_DIR ?? '/data/pdfs';
  const file = join(pdfDir, siteId, `${kind}.pdf`);

  let size: number;
  let mtime: Date;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('no es un archivo');
    size = info.size;
    mtime = info.mtime;
  } catch {
    return new Response(
      kind === 'analitica' || kind === 'integral'
        ? `Todavía no hay ${NOMBRE[kind]} de ${site.name}. Se genera cuando el sitio tiene Search Console o GA4 conectados: el de tráfico después de sincronizar, y el integral al terminar la siguiente auditoría.`
        : `Todavía no hay ${NOMBRE[kind]} de ${site.name}. Se genera en la siguiente corrida.`,
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  }

  const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;

  return new Response(stream, {
    headers: {
      'content-type': 'application/pdf',
      'content-length': String(size),
      'last-modified': mtime.toUTCString(),
      // inline para poder verlo en el navegador; el nombre lleva el sitio para
      // que al guardarlo no queden veinte archivos llamados full.pdf.
      'content-disposition': `inline; filename="${siteId}-${kind}.pdf"`,
      // Los PDFs se reemplazan una vez al día; que el navegador revalide siempre.
      'cache-control': 'no-cache, must-revalidate',
    },
  });
}
