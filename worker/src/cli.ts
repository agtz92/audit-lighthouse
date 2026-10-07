/**
 * CLI del worker.
 *
 *   npm run check                       todos los sitios habilitados
 *   npm run check -- --site=matmarkt    solo ese sitio, aunque esté deshabilitado
 *   npm run check -- --dry-run          sin escribir en BD ni reemplazar PDFs
 *
 * Código de salida: 0 si la corrida terminó ok, 1 si quedó parcial o falló, para
 * que sirva en un script.
 */

import { installProcessGuards } from './lib/guards.js';
import { parseCliArgs } from './cli-args.js';
import { runAudit } from './run/orchestrator.js';
import { closeDb } from './db/pool.js';
import { log } from './lib/logger.js';

async function main(): Promise<void> {
  installProcessGuards();
  const opts = parseCliArgs(process.argv.slice(2));

  const summary = await runAudit({
    trigger: 'manual',
    siteId: opts.site,
    dryRun: opts.dryRun,
  });

  await closeDb();
  process.exit(summary.status === 'ok' ? 0 : 1);
}

main().catch(async (err) => {
  log.error('la corrida falló', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
