/**
 * Entrypoint del worker: migra el esquema, programa la corrida diaria y se queda
 * vivo. Todo el sistema vive dentro de Compose: no hay cron de macOS ni un
 * contenedor de cron aparte.
 */

import { installProcessGuards } from './lib/guards.js';
import cron, { type ScheduledTask } from 'node-cron';
import type { Server } from 'node:http';
import { getHeapStatistics } from 'node:v8';
import { env } from './config/env.js';
import { loadSitesConfig } from './config/sites.js';
import { migrateUp } from './db/migrate.js';
import { syncSites } from './db/sites.js';
import { closeDb } from './db/pool.js';
import { hasSuccessfulRunToday } from './db/snapshots.js';
import { closeOrphanRuns } from './db/runs.js';
import { runAudit } from './run/orchestrator.js';
import { startControlServer } from './control/server.js';
import { log } from './lib/logger.js';
import type { RunTrigger } from './db/runs.js';

/** Una corrida a la vez: dos Chromium por sitio no caben en la memoria asignada. */
let running = false;

/**
 * Lo que hay que cerrar antes de irse. A nivel de módulo porque el apagado se
 * dispara desde tres lados —una señal, un reciclaje, un error— y ninguno
 * debería tener que recibir estos handles por parámetro.
 */
let task: ScheduledTask | undefined;
let control: Server | undefined;

interface OpcionesCorrida {
  /** Solo este sitio. Lo usa el botón del dashboard. */
  siteId?: string | undefined;
  /**
   * Se llama cuando la auditoría terminó de verdad —no cuando quedó
   * registrada—, y solo si terminó sin lanzar.
   */
  alTerminar?: () => void;
}

/**
 * Lanza una auditoría y espera solo a que quede registrada, no a que termine.
 *
 * Es el único camino para arrancar una corrida —el cron, la recuperación y el
 * dashboard pasan por aquí—, porque el candado `running` tiene que ser uno solo:
 * con dos funciones manejándolo, un disparo manual podría encimarse con el de
 * las 06:00 y dejar dos Chromium por sitio peleando por la memoria.
 *
 * Devuelve el id en cuanto la corrida existe en la base. La auditoría sigue
 * corriendo después de que esto resuelve, que es justo lo que se quiere: quien
 * la pidió desde el dashboard recibe respuesta en milisegundos y sigue el avance
 * por la base, en vez de dejar una petición HTTP colgada quince minutos.
 *
 * runId null significa que no arrancó, y `error` dice por qué: ya había una en
 * curso, o falló antes de registrarse (un sitio que no está en el YAML).
 */
async function lanzarCorrida(
  trigger: RunTrigger,
  opts: OpcionesCorrida = {},
): Promise<{ runId: number | null; error?: string }> {
  if (running) return { runId: null, error: 'ya hay una corrida en curso' };
  running = true;

  return new Promise((resolve) => {
    let contestado = false;
    const responder = (r: { runId: number | null; error?: string }): void => {
      if (contestado) return;
      contestado = true;
      resolve(r);
    };

    let completada = false;

    void runAudit({ trigger, siteId: opts.siteId, onStart: (runId) => responder({ runId }) })
      .then(() => {
        completada = true;
      })
      .catch((err: unknown) => {
        // runAudit ya marca la corrida en la base si alcanzó a crearla; aquí
        // solo evitamos que una excepción mate el proceso y con él el scheduler.
        log.error('la corrida terminó con excepción', err);
        responder({ runId: null, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        running = false;
        // Red de seguridad: si terminó sin registrarse y sin lanzar, se contesta
        // igual en vez de dejar esperando a quien la pidió.
        responder({ runId: null, error: 'la corrida terminó sin registrarse' });
        // Solo si la auditoría llegó a su fin por las buenas. Reciclar después
        // de una excepción de arranque —un sites.yaml roto, digamos— metería al
        // proceso en un ciclo de reinicios en vez de dejar el error quieto y
        // visible en el log.
        if (completada) opts.alTerminar?.();
      });
  });
}

/** Dispara una corrida en segundo plano, dejando constancia si no arrancó. */
function dispararCorrida(trigger: RunTrigger, opts: OpcionesCorrida = {}): void {
  void lanzarCorrida(trigger, opts).then(({ runId, error }) => {
    if (runId === null) log.warn('corrida no arrancada', { trigger, motivo: error });
  });
}

/**
 * Cierra todo y termina con código 0.
 *
 * Código 0 a propósito, incluso cuando se va por una señal: no hay nada que
 * reportar como falla y `restart: unless-stopped` de Compose vuelve a levantar
 * el contenedor pase lo que pase con el código, salvo que alguien lo haya
 * detenido a mano.
 */
async function apagar(motivo: string, extra: Record<string, unknown> = {}): Promise<void> {
  log.info('apagando', { motivo, corrida_en_curso: running, ...extra });
  // node-cron solo rechaza esto cuando la tarea corre en un fork, que no es el
  // caso aquí; el catch está para que un apagado nunca se tuerza por el cierre.
  await Promise.resolve(task?.stop()).catch(() => {});
  control?.close();
  await closeDb().catch(() => {});
  process.exit(0);
}

/**
 * Termina el proceso al cerrar la corrida programada, para que Compose lo
 * levante con el heap limpio.
 *
 * Por qué hace falta: una corrida completa deja el heap de V8 crecido —medido,
 * ~1 GB de RSS con el proceso inactivo—, y el techo por default de Node ronda
 * 1.4 GB. La *segunda* corrida completa de un mismo proceso arranca entonces
 * casi sin margen, se pasa la vida recolectando basura (páginas que vencen a los
 * 75 s, el pool de Postgres agotando su timeout) y acaba muriendo con "Reached
 * heap limit". Eso rompió la corrida de las 06:00 cuatro días seguidos: moría a
 * los ~19 minutos, Compose reiniciaba y la recuperación del arranque —proceso
 * nuevo, heap vacío— sí terminaba. Era el reinicio, no la recuperación, lo que
 * la arreglaba. Así que mejor reiniciar a propósito y en frío que por un crash a
 * media auditoría.
 *
 * Al arrancar de nuevo, `hasSuccessfulRunToday` ve la corrida que acaba de
 * terminar y no lanza recuperación: el proceso se queda fresco e inactivo hasta
 * las 06:00 de mañana. Que `docker compose ps` muestre el worker con pocas horas
 * de vida y un RestartCount que sube a diario es lo esperado, no un síntoma.
 *
 * Solo tras la corrida programada, y por motivos distintos en cada caso:
 *
 * - Tras una *recuperación*, no. Si esa corrida terminó con todos los sitios
 *   fallando, `hasSuccessfulRunToday` sigue en false y el siguiente arranque
 *   lanzaría otra recuperación, que fallaría igual, y así para siempre. Que el
 *   proceso se quede vivo es justo el freno de ese ciclo.
 * - Tras una corrida *manual*, tampoco. Alguien está mirando el dashboard, y
 *   tumbarle el endpoint de control al terminar sería grosero; además casi
 *   siempre es de un solo sitio y no mueve la aguja del heap.
 */
function reciclar(): void {
  void apagar('reciclaje tras la corrida programada: el proceso vuelve con el heap limpio');
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
    // Queda en el log porque es el número que explicó la caída de las 06:00 y
    // no se puede adivinar: Node lo deduce de la RAM de la VM de Docker, no del
    // límite que Compose le pone al contenedor.
    heap_limite_mb: Math.round(getHeapStatistics().heap_size_limit / 1048576),
    webhook: cfg.WEBHOOK_URL === undefined ? 'desactivado' : 'activo',
  });

  await migrateUp();

  // Antes que nada: si el proceso anterior murió a media corrida, su fila sigue
  // diciendo que está en curso. Al arrancar no puede haber ninguna viva.
  const huerfanas = await closeOrphanRuns();
  if (huerfanas.runs > 0 || huerfanas.siteRuns > 0) {
    log.warn('corridas interrumpidas cerradas al arrancar', huerfanas);
  }

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
  task = cron.schedule(
    cfg.SCHEDULE_CRON,
    () => {
      log.info('disparo programado', { ahora_local: localNow(cfg.TZ) });
      dispararCorrida('scheduled', { alTerminar: reciclar });
    },
    { timezone: cfg.TZ },
  );

  log.info('scheduler activo', { cron: cfg.SCHEDULE_CRON, timezone: cfg.TZ });

  // El dashboard pide auditorías por aquí. Comparte el candado `running` con el
  // scheduler, así que un botón no puede encimarse con la corrida de las 06:00.
  control = startControlServer(cfg.CONTROL_PORT, {
    isRunning: () => running,
    start: (siteId) => lanzarCorrida('manual', { siteId }),
  });

  // Corrida de recuperación: si el servidor estuvo apagado a las 6am, no hay que
  // esperar a mañana para tener datos de hoy.
  if (cfg.RECOVERY_RUN_ON_BOOT) {
    const yaCorrio = await hasSuccessfulRunToday(cfg.TZ);
    if (yaCorrio) {
      log.info('recuperación no necesaria: ya hubo una corrida exitosa hoy');
    } else {
      log.info('recuperación: hoy no hay corrida exitosa, lanzando una ahora');
      dispararCorrida('recovery');
    }
  }

  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));
}

main().catch(async (err) => {
  log.error('el worker no pudo arrancar', err);
  await closeDb().catch(() => {});
  process.exit(1);
});
