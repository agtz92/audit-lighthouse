/**
 * Entrypoint del servicio analytics: sincroniza Search Console y GA4 a su
 * propia hora, separado de la auditoría.
 *
 * Usa la misma imagen que el worker —comparte el esquema, la configuración y
 * el membrete de los informes— pero corre como otro contenedor, con su propio
 * cron y su propio candado. Que uno falle o se reinicie no toca al otro.
 */

import { installProcessGuards } from '../lib/guards.js';
import cron, { type ScheduledTask } from 'node-cron';
import type { Server } from 'node:http';
import { env } from '../config/env.js';
import { loadSitesConfig } from '../config/sites.js';
import { migrateUp } from '../db/migrate.js';
import { closeDb } from '../db/pool.js';
import { closeOrphanAnalyticsRuns, hasSuccessfulAnalyticsRunToday } from '../db/analytics.js';
import { runAnalyticsSync } from './sync.js';
import { startAnalyticsControl } from './control.js';
import { googleClient, serviceAccountStatus } from './google.js';
import { testConnection, availableProperties } from './connection.js';
import { isoToday } from './periods.js';
import { log } from '../lib/logger.js';
import type { RunTrigger } from '../db/runs.js';

let running = false;
let task: ScheduledTask | undefined;
let control: Server | undefined;

/** Igual que en el worker: un solo camino para arrancar, con un solo candado. */
async function lanzar(trigger: RunTrigger, siteId?: string): Promise<{ runId: number | null; error?: string }> {
  if (running) return { runId: null, error: 'ya hay una sincronización en curso' };
  running = true;

  return new Promise((resolve) => {
    let contestado = false;
    const responder = (r: { runId: number | null; error?: string }): void => {
      if (contestado) return;
      contestado = true;
      resolve(r);
    };
    void runAnalyticsSync({ trigger, siteId, onStart: (runId) => responder({ runId }) })
      .then((s) => {
        // Sin sitios conectados no se registra corrida; se contesta igual.
        if (s.runId === null) responder({ runId: null, error: 'ningún sitio tiene Search Console ni GA4 conectados' });
      })
      .catch((err: unknown) => {
        log.error('la sincronización terminó con excepción', err);
        responder({ runId: null, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = false;
        responder({ runId: null, error: 'la sincronización terminó sin registrarse' });
      });
  });
}

function disparar(trigger: RunTrigger): void {
  void lanzar(trigger).then(({ runId, error }) => {
    if (runId === null) log.info('sincronización no arrancada', { trigger, motivo: error });
  });
}

async function apagar(motivo: string): Promise<void> {
  log.info('apagando analytics', { motivo, sincronizacion_en_curso: running });
  await Promise.resolve(task?.stop()).catch(() => {});
  control?.close();
  await closeDb().catch(() => {});
  process.exit(0);
}

async function main(): Promise<void> {
  installProcessGuards();
  const cfg = env();

  const cuenta = await serviceAccountStatus(cfg.GOOGLE_CREDENTIALS_FILE);
  log.info('analytics arrancando', {
    tz: cfg.TZ,
    schedule: cfg.ANALYTICS_CRON,
    periodo_informes: cfg.REPORT_PERIOD,
    cuenta_servicio: cuenta.email ?? 'sin configurar',
    ...(cuenta.error === null ? {} : { credenciales: cuenta.error }),
  });

  // node-pg-migrate toma un advisory lock: si el worker migra al mismo tiempo,
  // uno espera al otro.
  await migrateUp();
  const huerfanas = await closeOrphanAnalyticsRuns();
  if (huerfanas > 0) log.warn('sincronizaciones interrumpidas cerradas al arrancar', { corridas: huerfanas });

  // Falla temprano si el YAML está mal, igual que el worker.
  await loadSitesConfig(cfg.SITES_FILE);

  if (!cron.validate(cfg.ANALYTICS_CRON)) {
    throw new Error(`ANALYTICS_CRON no es una expresión válida: "${cfg.ANALYTICS_CRON}"`);
  }
  task = cron.schedule(cfg.ANALYTICS_CRON, () => disparar('scheduled'), { timezone: cfg.TZ });
  log.info('scheduler de analytics activo', { cron: cfg.ANALYTICS_CRON, timezone: cfg.TZ });

  control = startAnalyticsControl(cfg.ANALYTICS_CONTROL_PORT, {
    isRunning: () => running,
    start: (siteId) => lanzar('manual', siteId),
    account: () => serviceAccountStatus(cfg.GOOGLE_CREDENTIALS_FILE),
    test: async (input) => {
      const { client } = await googleClient(cfg.GOOGLE_CREDENTIALS_FILE);
      return testConnection(client, input, isoToday(cfg.TZ));
    },
    properties: async () => {
      const { client } = await googleClient(cfg.GOOGLE_CREDENTIALS_FILE);
      return availableProperties(client);
    },
  });

  if (cfg.RECOVERY_RUN_ON_BOOT) {
    if (await hasSuccessfulAnalyticsRunToday(cfg.TZ)) {
      log.info('recuperación de analytics no necesaria: ya hubo una sincronización hoy');
    } else {
      disparar('recovery');
    }
  }

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}

main().catch(async (err) => {
  log.error('analytics no pudo arrancar', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
