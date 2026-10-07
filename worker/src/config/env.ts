/**
 * Variables de entorno validadas. Si algo está mal el proceso muere al arrancar
 * con un mensaje claro, en vez de fallar a media corrida por un NaN.
 */

import { z } from 'zod';
import { PDF_QUALITIES } from '../pdf/compress.js';

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

  // Puerto del endpoint de control, por donde el dashboard pide auditorías a
  // mano. NO se publica al host en docker-compose: solo existe dentro de la red
  // de Compose, así que lo alcanza el dashboard y nada más.
  CONTROL_PORT: int(8099, 1, 65_535),

  CONCURRENCY: int(2, 1, 16),
  PAGE_CONCURRENCY: int(3, 1, 16),
  LIGHTHOUSE_CONCURRENCY: int(1, 1, 8),

  // 90 min, no 45. Medido en una corrida real: Lighthouse cuesta 1.59 min por
  // sitio y va de uno en uno, así que 20 sitios sanos son ~39 min. Con 45 el
  // margen era de 6 minutos y cualquier sitio lento empezaba a dejar sitios sin
  // auditar. El objetivo es que la corrida termine completa; a las 6am no hay
  // nada más compitiendo por la máquina y acabar a las 7:30 no le estorba a nadie.
  RUN_BUDGET_MINUTES: int(90, 1, 1440),
  // Tope por sitio, además del global. Sin él un solo sitio lento se come la
  // corrida entera: medido aquí, un sitio con 21 páginas que se van a timeout
  // consumió 29 de los 45 minutos él solo.
  SITE_BUDGET_MINUTES: int(8, 1, 120),
  // page.pdf() no tiene timeout propio en Playwright.
  PDF_RENDER_TIMEOUT_MS: int(45_000, 5000, 300_000),
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

  // ── Marca del informe ──────────────────────────────────────────────────
  // Encabezan la portada y cada hoja. Van en configuración y no en el código
  // para que cambiar un título no exija reconstruir la imagen.
  REPORT_AUTHOR_NAME: str('José Alfredo Gutiérrez Guerra'),
  REPORT_AUTHOR_ROLE: str('Consultor en soluciones de software e inteligencia artificial'),
  REPORT_AUTHOR_CREDENTIALS: str('ITE 2016 · MNA 2027'),

  // ── Search Console y GA4 (servicio analytics) ──────────────────────────
  // A las 05:00 y no a las 06:00: el informe integral se arma al terminar
  // Lighthouse y tiene que encontrar el tráfico ya sincronizado.
  ANALYTICS_CRON: str('0 5 * * *'),
  ANALYTICS_CONTROL_PORT: int(8098, 1, 65_535),
  // La llave JSON de la cuenta de servicio. Solo se monta en el contenedor de
  // analytics: el worker y el dashboard nunca la ven.
  GOOGLE_CREDENTIALS_FILE: str('/app/secrets/google-sa.json'),
  // Días que se vuelven a pedir en cada sincronización. Search Console sigue
  // ajustando los últimos días después de publicarlos.
  ANALYTICS_REFRESH_DAYS: int(5, 1, 60),
  // Lo que se carga la primera vez que un sitio se conecta. 16 meses es lo más
  // que guarda Search Console, y alcanza para comparar contra el año anterior.
  ANALYTICS_BACKFILL_DAYS: int(486, 30, 1000),
  // Las series diarias son diminutas: se conservan más que las auditorías.
  ANALYTICS_RETENTION_DAYS: int(500, 60, 3650),
  ANALYTICS_CONCURRENCY: int(3, 1, 10),
  // Periodo que cubren los informes en PDF. month = el último mes calendario
  // completo contra el anterior; 28d = los últimos 28 días contra los 28 previos.
  REPORT_PERIOD: str('month').pipe(z.enum(['month', '28d'])),
  // Caída de clics, en %, que dispara la bandera del webhook de tráfico.
  TRAFFIC_DROP_THRESHOLD: int(20, 1, 100),
  // Por aquí el servicio analytics pregunta si el worker está auditando, para
  // no imprimir PDFs mientras Lighthouse mide.
  WORKER_URL: str('http://worker:8099'),

  SITES_FILE: str('/app/config/sites.yaml'),
  PDF_DIR: str('/data/pdfs'),
  // Perfil de compresión de Ghostscript: screen (72 dpi) | ebook (150) |
  // printer (300) | none. El texto nunca se rasteriza; solo bajan las imágenes.
  PDF_QUALITY: str('ebook').pipe(z.enum(PDF_QUALITIES)),
  // Base del tope de Ghostscript; el tope real crece con el tamaño del documento.
  PDF_COMPRESS_TIMEOUT_MS: int(60_000, 5000, 900_000),
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
