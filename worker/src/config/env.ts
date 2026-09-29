/**
 * Variables de entorno validadas. Si algo está mal el proceso muere al arrancar
 * con un mensaje claro, en vez de fallar a media corrida por un NaN.
 */

import { z } from 'zod';

/** Entero desde string de entorno, con default. */
const int = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));

/** Booleano tolerante: true/1/yes/on cuentan como verdadero. */
const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
    );

/** String con default, tratando "" como ausente. */
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? def : v.trim()));

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),

  TZ: str('America/Mexico_City'),
  SCHEDULE_CRON: str('0 6 * * *'),
  RECOVERY_RUN_ON_BOOT: bool(true),

  CONCURRENCY: int(2, 1, 16),
  PAGE_CONCURRENCY: int(3, 1, 16),
  LIGHTHOUSE_CONCURRENCY: int(1, 1, 8),

  RUN_BUDGET_MINUTES: int(45, 1, 1440),
  NAV_TIMEOUT_MS: int(30_000, 1000, 300_000),
  LIGHTHOUSE_TIMEOUT_MS: int(120_000, 10_000, 600_000),

  RETENTION_DAYS: int(90, 1, 3650),

  // Vacío = webhook desactivado.
  WEBHOOK_URL: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()))
    .refine(
      (v) => {
        if (v === undefined) return true;
        try {
          const u = new URL(v);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'WEBHOOK_URL debe ser una URL http:// o https://' },
    ),
  PERF_DROP_THRESHOLD: int(10, 1, 100),
  CERT_EXPIRY_WARN_DAYS: int(21, 1, 365),

  SITES_FILE: str('/app/sites.yaml'),
  PDF_DIR: str('/data/pdfs'),
  LOG_LEVEL: str('info').pipe(z.enum(['debug', 'info', 'warn', 'error'])),
  USER_AGENT: str('site-monitor/1.0 (+auditoria interna)'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`variables de entorno inválidas:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/** Entorno del proceso, parseado una sola vez. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}
