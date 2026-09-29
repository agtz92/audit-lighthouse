/**
 * Entrypoint del worker: migra el esquema, sincroniza sites.yaml y se queda
 * vivo esperando la corrida diaria.
 *
 * FASE 1: el scheduler (node-cron a las 06:00) y la corrida de recuperación
 * llegan en la fase 5. Por ahora el proceso solo prepara la base y se mantiene
 * en pie para que `docker compose up -d` deje algo estable corriendo.
 */

import { env } from './config/env.js';
import { loadSitesConfig } from './config/sites.js';
import { migrateUp } from './db/migrate.js';
import { syncSites } from './db/sites.js';
import { closeDb } from './db/pool.js';
import { log } from './lib/logger.js';

async function main(): Promise<void> {
  const cfg = env();

  log.info('worker arrancando', {
    tz: cfg.TZ,
    now_local: new Date().toLocaleString('es-MX', { timeZone: cfg.TZ }),
    schedule: cfg.SCHEDULE_CRON,
    concurrency: cfg.CONCURRENCY,
    page_concurrency: cfg.PAGE_CONCURRENCY,
    lighthouse_concurrency: cfg.LIGHTHOUSE_CONCURRENCY,
    budget_minutes: cfg.RUN_BUDGET_MINUTES,
    retention_days: cfg.RETENTION_DAYS,
    webhook: cfg.WEBHOOK_URL === undefined ? 'desactivado' : 'activo',
  });

  await migrateUp();

  const sites = await loadSitesConfig(cfg.SITES_FILE);
  const sync = await syncSites(sites);
  const enabled = sites.filter((s) => s.enabled);

  log.info('sites.yaml sincronizado', {
    total: sites.length,
    habilitados: enabled.length,
    ...sync,
  });

  log.info('worker listo', { pendiente: 'scheduler y corridas (fases 2-5)' });

  // Mantener el proceso vivo sin quemar CPU. En la fase 5 esto lo reemplaza
  // el cron de node-cron, que ya sostiene el event loop por sí mismo.
  const keepAlive = setInterval(() => {}, 1 << 30);

  const shutdown = async (signal: string): Promise<void> => {
    log.info('apagando', { signal });
    clearInterval(keepAlive);
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (err) => {
  log.error('el worker no pudo arrancar', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
