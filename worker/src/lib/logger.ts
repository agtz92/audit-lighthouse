/**
 * Logs estructurados en JSON a stdout, una línea por evento.
 *
 * Todo lo que ocurre dentro de una corrida lleva run_id, y lo que ocurre dentro
 * de un sitio lleva además site_id: así `docker compose logs worker | jq 'select(.run_id==7)'`
 * reconstruye una corrida completa.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function levelFromEnv(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw in SEVERITY ? (raw as LogLevel) : 'info';
}

/** Campos fijos que se repiten en cada línea del logger (run_id, site_id, ...). */
export type Bindings = Record<string, unknown>;

/** Convierte un Error en algo serializable sin perder la causa ni el stack. */
function serializeError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  return {
    name: err.name,
    message: err.message,
    stack: err.stack,
    ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
  };
}

export class Logger {
  #threshold: number;

  constructor(
    private readonly bindings: Bindings = {},
    level: LogLevel = levelFromEnv(),
  ) {
    this.#threshold = SEVERITY[level];
  }

  /** Nuevo logger que arrastra los campos de este más los que le pases. */
  child(bindings: Bindings): Logger {
    const next = new Logger({ ...this.bindings, ...bindings });
    next.#threshold = this.#threshold;
    return next;
  }

  debug(msg: string, fields?: Bindings): void { this.#write('debug', msg, fields); }
  info(msg: string, fields?: Bindings): void { this.#write('info', msg, fields); }
  warn(msg: string, fields?: Bindings): void { this.#write('warn', msg, fields); }

  error(msg: string, errOrFields?: unknown, fields?: Bindings): void {
    const extra = errOrFields instanceof Error
      ? { err: serializeError(errOrFields), ...fields }
      : { ...(errOrFields as Bindings | undefined), ...fields };
    this.#write('error', msg, extra);
  }

  #write(level: LogLevel, msg: string, fields?: Bindings): void {
    if (SEVERITY[level] < this.#threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...fields,
    };
    // Una sola escritura por línea: stdout de Docker no entrelaza escrituras atómicas.
    process.stdout.write(`${JSON.stringify(line)}\n`);
  }
}

export const log = new Logger();
