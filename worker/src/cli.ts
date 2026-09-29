/**
 * CLI del worker.
 *
 *   npm run check                      todos los sitios habilitados
 *   npm run check -- --site=matmarkt    solo ese sitio
 *   npm run check -- --dry-run          sin escribir en BD ni reemplazar PDFs
 *
 * FASE 1: por ahora solo resuelve y muestra la configuración; la auditoría
 * llega en la fase 2.
 */

import { parseArgs } from 'node:util';
import { env } from './config/env.js';
import { loadSitesConfig } from './config/sites.js';
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
  const cfg = env();
  const all = await loadSitesConfig(cfg.SITES_FILE);

  const selected = opts.site === undefined ? all.filter((s) => s.enabled) : all.filter((s) => s.id === opts.site);

  if (opts.site !== undefined && selected.length === 0) {
    const ids = all.map((s) => s.id).join(', ');
    throw new Error(`no existe el sitio "${opts.site}" en ${cfg.SITES_FILE}. Disponibles: ${ids}`);
  }

  log.info('configuración resuelta', {
    dry_run: opts.dryRun,
    seleccionados: selected.length,
    de_un_total_de: all.length,
  });

  for (const site of selected) {
    log.info('sitio', {
      site_id: site.id,
      url: site.url,
      sitemap: site.sitemap ?? '(por descubrir)',
      max_pages: site.maxPages,
      wait_until: site.waitUntil,
      timeout_ms: site.timeoutMs,
      exclude: site.exclude,
    });
  }

  await closeDb();
}

main().catch(async (err) => {
  log.error('la corrida falló', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
