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

import { parseArgs } from 'node:util';
import { runAudit } from './run/orchestrator.js';
import { closeDb } from './db/pool.js';
import { log } from './lib/logger.js';

export interface CliOptions {
  site: string | undefined;
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      site: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  return { site: values.site, dryRun: values['dry-run'] === true };
}

async function main(): Promise<void> {
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
