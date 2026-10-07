/**
 * CLI de la sincronización de tráfico.
 *
 *   npm run analytics:sync                       todos los sitios conectados
 *   npm run analytics:sync -- --site=matmarkt    solo ese
 *   npm run analytics:sync -- --dry-run          consulta Google sin escribir nada
 *
 * Se corre dentro del contenedor `analytics`, que es el que tiene la llave:
 *   docker compose exec analytics npm run analytics:sync -- --site=matmarkt
 */

import { installProcessGuards } from '../lib/guards.js';
import { parseCliArgs } from '../cli-args.js';
import { runAnalyticsSync } from './sync.js';
import { closeDb } from '../db/pool.js';
import { log } from '../lib/logger.js';

async function main(): Promise<void> {
  installProcessGuards();
  const opts = parseCliArgs(process.argv.slice(2));
  const summary = await runAnalyticsSync({ trigger: 'manual', siteId: opts.site, dryRun: opts.dryRun });
  await closeDb();
  process.exit(summary.status === 'ok' ? 0 : 1);
}

main().catch(async (err) => {
  log.error('la sincronización falló', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
