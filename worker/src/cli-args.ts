/**
 * Argumentos de las dos CLIs (auditoría y tráfico). Aparte de cli.ts porque
 * ese módulo arranca una corrida al importarse.
 */

import { parseArgs } from 'node:util';

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
