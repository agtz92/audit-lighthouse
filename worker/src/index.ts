/**
 * Entrypoint del worker: migra el esquema, programa la corrida diaria y se queda
 * vivo. Todo el sistema vive dentro de Compose: no hay cron de macOS ni un
 * contenedor de cron aparte.
 */

import { installProcessGuards } from './lib/guards.js';
import cron from 'node-cron';
import { env } from './config/env.js';
import { loadSitesConfig } from './config/sites.js';
import { migrateUp } from './db/migrate.js';
import { syncSites } from './db/sites.js';
import { closeDb } from './db/pool.js';
import { hasSuccessfulRunToday } from './db/snapshots.js';
import { runAudit } from './run/orchestrator.js';
import { log } from './lib/logger.js';
import type { RunTrigger } from './db/runs.js';

/** Una corrida a la vez: dos Chromium por sitio no caben en la memoria asignada. */
let running = false;

async function runOnce(trigger: RunTrigger): Promise<void> {
  if (running) {
    log.warn('corrida omitida: ya hay una en curso', { trigger });
    return;
  }
  running = true;
  try {
    await runAudit({ trigger });
  } catch (err) {
    // runAudit ya marca la corrida en la base; aquí solo evitamos que una
    // excepción mate el proceso y con él el scheduler de mañana.
    log.error('la corrida terminó con excepción', err);
  } finally {
    running = false;
  }
}

/**
 * Hora local legible, para que el log diga "06:00" y no un UTC que hay que
 * traducir mentalmente.
 */
function localNow(tz: string): string {
  return new Date().toLocaleString('es-MX', { timeZone: tz, dateStyle: 'short', timeStyle: 'medium' });
}

async function main(): Promise<void> {
  installProcessGuards();
  const cfg = env();

  log.info('worker arrancando', {
    tz: cfg.TZ,
    ahora_local: localNow(cfg.TZ),
    schedule: cfg.SCHEDULE_CRON,
    concurrencia: cfg.CONCURRENCY,
    paginas_en_paralelo: cfg.PAGE_CONCURRENCY,
    lighthouse_en_paralelo: cfg.LIGHTHOUSE_CONCURRENCY,
    presupuesto_min: cfg.RUN_BUDGET_MINUTES,
    retencion_dias: cfg.RETENTION_DAYS,
    pdf_quality: cfg.PDF_QUALITY,
    webhook: cfg.WEBHOOK_URL === undefined ? 'desactivado' : 'activo',
  });

  await migrateUp();

  // Se valida el YAML al arrancar para fallar temprano y ruidosamente si está
  // mal, en lugar de descubrirlo a las 6am.
  const sites = await loadSitesConfig(cfg.SITES_FILE);
  const sync = await syncSites(sites);
  log.info('sites.yaml validado y sincronizado', {
    total: sites.length,
    habilitados: sites.filter((s) => s.enabled).length,
    ...sync,
  });

  if (!cron.validate(cfg.SCHEDULE_CRON)) {
    throw new Error(`SCHEDULE_CRON no es una expresión válida: "${cfg.SCHEDULE_CRON}"`);
  }

  // El timezone lo aplica node-cron, así que la corrida sigue siendo a las 6am
  // locales pase lo que pase con el horario de verano. (México lo eliminó en
  // 2022, pero esto no depende de esa decisión.)
  const task = cron.schedule(
    cfg.SCHEDULE_CRON,
    () => {
      log.info('disparo programado', { ahora_local: localNow(cfg.TZ) });
      void runOnce('scheduled');
    },
    { timezone: cfg.TZ },
  );

  log.info('scheduler activo', { cron: cfg.SCHEDULE_CRON, timezone: cfg.TZ });

  // Corrida de recuperación: si el servidor estuvo apagado a las 6am, no hay que
  // esperar a mañana para tener datos de hoy.
  if (cfg.RECOVERY_RUN_ON_BOOT) {
    const yaCorrio = await hasSuccessfulRunToday(cfg.TZ);
    if (yaCorrio) {
      log.info('recuperación no necesaria: ya hubo una corrida exitosa hoy');
    } else {
      log.info('recuperación: hoy no hay corrida exitosa, lanzando una ahora');
      void runOnce('recovery');
    }
  }

  const shutdown = async (signal: string): Promise<void> => {
    log.info('apagando', { signal, corrida_en_curso: running });
    task.stop();
    await closeDb().catch(() => {});
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
