/**
 * Aplica las migraciones pendientes al arrancar el worker.
 *
 * node-pg-migrate toma un advisory lock de Postgres, así que si el worker y un
 * `npm run check` manual arrancan a la vez no se pisan: uno espera al otro.
 */

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';

/** db/migrations vive fuera de worker/, en la raíz del repo. */
export function migrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
}

export async function migrateUp(): Promise<void> {
  const dir = migrationsDir();
  const applied = await runner({
    databaseUrl: env().DATABASE_URL,
    dir,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    singleTransaction: true,
    // node-pg-migrate escribe a stdout con console.log; lo redirigimos al logger
    // JSON para que no rompa el formato de una línea por evento.
    log: (msg: string) => log.debug('migracion', { detail: msg.trim() }),
  });

  if (applied.length === 0) {
    log.info('esquema al día, sin migraciones pendientes');
  } else {
    log.info('migraciones aplicadas', { count: applied.length, names: applied.map((m) => m.name) });
  }
}
