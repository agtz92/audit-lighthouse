/**
 * Purga de retención.
 *
 * Una sola sentencia: runs tiene ON DELETE CASCADE hacia site_runs, y site_runs
 * hacia page_results y lighthouse_results, así que borrar las corridas viejas
 * arrastra todo lo dependiente. Va en transacción para que no quede a medias si
 * el proceso muere, y se registra en el log porque es la única operación del
 * sistema que destruye datos.
 */

import { db } from './pool.js';
import type { Logger } from '../lib/logger.js';

export interface PurgeResult {
  runsDeleted: number;
  cutoff: Date;
  durationMs: number;
}

export async function purgeOldRuns(retentionDays: number, log: Logger): Promise<PurgeResult> {
  const startedAt = Date.now();
  const client = await db().connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ cutoff: Date }>(
      `SELECT (now() - ($1 || ' days')::interval) AS cutoff`,
      [retentionDays],
    );
    const cutoff = rows[0]?.cutoff ?? new Date();

    // Solo corridas ya terminadas: una corrida 'running' con started_at viejo
    // sería un proceso vivo, y borrarla le arrancaría las filas bajo los pies.
    const deleted = await client.query(
      `DELETE FROM runs
        WHERE started_at < now() - ($1 || ' days')::interval
          AND status <> 'running'`,
      [retentionDays],
    );

    await client.query('COMMIT');

    const result: PurgeResult = {
      runsDeleted: deleted.rowCount ?? 0,
      cutoff,
      durationMs: Date.now() - startedAt,
    };

    if (result.runsDeleted > 0) {
      log.info('retención: corridas purgadas', {
        corridas_borradas: result.runsDeleted,
        retencion_dias: retentionDays,
        anteriores_a: cutoff.toISOString(),
        duracion_ms: result.durationMs,
      });
    } else {
      log.debug('retención: nada que purgar', { retencion_dias: retentionDays });
    }

    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
