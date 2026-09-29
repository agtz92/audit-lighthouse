/**
 * Pool de Postgres del worker.
 *
 * max=5 a propósito: el contenedor de db corre con max_connections=30 y el
 * dashboard también necesita su parte. Las escrituras del worker son cortas.
 */

import { Pool } from 'pg';
import { env } from '../config/env.js';
import { log } from '../lib/logger.js';

let pool: Pool | undefined;

export function db(): Pool {
  if (pool === undefined) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'site-monitor-worker',
    });
    // Sin este handler un error de red en un cliente idle tumba el proceso.
    pool.on('error', (err) => log.error('error en cliente idle de Postgres', err));
  }
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
  }
}
