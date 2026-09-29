/**
 * Escritura atómica de archivos.
 *
 * El requisito es que una corrida fallida NUNCA deje al usuario sin PDF: el del
 * día anterior tiene que quedar intacto. Por eso se escribe a un .tmp y solo se
 * renombra cuando el archivo está completo y cerrado. rename(2) es atómico dentro
 * del mismo sistema de archivos, así que el .tmp vive en el mismo directorio que
 * el destino, no en /tmp.
 */

import { mkdir, rename, writeFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Escribe `data` en `target` de forma atómica. Devuelve el tamaño en bytes. */
export async function writeFileAtomic(target: string, data: Uint8Array): Promise<number> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
    return data.byteLength;
  } catch (err) {
    // Un .tmp huérfano confundiría la siguiente corrida; se limpia siempre.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Bytes del archivo, o null si no existe. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}
