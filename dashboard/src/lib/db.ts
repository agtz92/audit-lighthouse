import { Pool, types as pgTypes } from 'pg';

// Igual que en el worker: el driver devuelve int8 y numeric como string, y una
// suma silenciosa se convertiría en concatenación. Nuestros ids y conteos no se
// acercan a 2^53.
pgTypes.setTypeParser(20, (v) => Number(v));
pgTypes.setTypeParser(1700, (v) => Number(v));

declare global {
  // Next recarga los módulos en desarrollo; sin esto se abriría un pool nuevo
  // por recarga hasta agotar max_connections de Postgres.
  var __sitemonPool: Pool | undefined;
}

function create(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL no está definida en el dashboard');
  }
  const pool = new Pool({
    connectionString,
    // El dashboard es de solo lectura y comparte los 30 max_connections del
    // contenedor de Postgres con el worker.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5000,
    application_name: 'site-monitor-dashboard',
  });
  pool.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pool de Postgres', err: err.message }));
  });
  return pool;
}

export function db(): Pool {
  globalThis.__sitemonPool ??= create();
  return globalThis.__sitemonPool;
}

export async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const { rows } = await db().query<T>(sql, params);
  return rows;
}
