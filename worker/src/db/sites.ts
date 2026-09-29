/**
 * Sincronización de la tabla sites con sites.yaml.
 *
 * Un sitio que desaparece del YAML NO se borra: se le marca removed_from_yaml_at
 * para conservar su historial de corridas. Si vuelve al YAML, la marca se limpia.
 */

import type { PoolClient } from 'pg';
import { db } from './pool.js';
import type { ResolvedSite } from '../config/sites.js';

export interface SitesSyncResult {
  inserted: number;
  updated: number;
  removed: number;
}

export async function syncSites(sites: ResolvedSite[]): Promise<SitesSyncResult> {
  const client: PoolClient = await db().connect();
  try {
    await client.query('BEGIN');

    const ids = sites.map((s) => s.id);
    const names = sites.map((s) => s.name);
    const urls = sites.map((s) => s.url);
    const enabled = sites.map((s) => s.enabled);

    // unnest + ON CONFLICT: un solo viaje a la BD para los 20 sitios.
    const upsert = await client.query<{ inserted: boolean }>(
      `
      INSERT INTO sites (id, name, url, enabled, last_seen_in_yaml_at, removed_from_yaml_at)
      SELECT id, name, url, enabled, now(), NULL
        FROM unnest($1::text[], $2::text[], $3::text[], $4::boolean[])
             AS t(id, name, url, enabled)
      ON CONFLICT (id) DO UPDATE SET
        name                 = EXCLUDED.name,
        url                  = EXCLUDED.url,
        enabled              = EXCLUDED.enabled,
        last_seen_in_yaml_at = now(),
        removed_from_yaml_at = NULL
      -- xmax = 0 solo en filas realmente insertadas: en un UPDATE por conflicto
      -- Postgres deja ahi el id de la transaccion que la toco. Es el idioma
      -- estandar para distinguir insert de update dentro de un upsert.
      RETURNING (xmax = 0) AS inserted
      `,
      [ids, names, urls, enabled],
    );

    // Los que ya no están en el YAML quedan marcados, no borrados.
    const removed = await client.query(
      `UPDATE sites
          SET removed_from_yaml_at = now(), enabled = false
        WHERE id <> ALL($1::text[])
          AND removed_from_yaml_at IS NULL`,
      [ids],
    );

    await client.query('COMMIT');

    let inserted = 0;
    for (const row of upsert.rows) if (row.inserted) inserted += 1;

    return {
      inserted,
      updated: upsert.rows.length - inserted,
      removed: removed.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
