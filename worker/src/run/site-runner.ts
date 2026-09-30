/**
 * Auditoría de un sitio dentro de una corrida.
 *
 * Orden: descubrimiento de URLs y chequeo del certificado en paralelo (los dos
 * son red y no dependen entre sí), luego el navegador para medir cada página.
 * El navegador se abre después del descubrimiento a propósito: si un sitio no
 * responde, no gastamos 1.5 s en levantar un Chromium para nada.
 */

import pLimit from 'p-limit';
import type { Browser, BrowserContext } from 'playwright';
import type { ResolvedSite } from '../config/sites.js';
import type { Logger } from '../lib/logger.js';
import type { Deadline } from '../lib/deadline.js';
import { launchBrowser, newSiteContext, cdpPortForSlot } from '../audit/browser.js';
import { auditPage, type ErrorCategory, type PageMetrics } from '../audit/page-metrics.js';
import { checkCertificate, type CertInfo } from '../audit/tls.js';
import {
  discoverPages,
  finalizeUrlList,
  chooseAuditList,
  CANDIDATE_CAP,
  type DiscoveryMethod,
} from '../discovery/index.js';
import { harvestRenderedLinks } from '../discovery/rendered.js';
import { startSiteRun, finishSiteRun, type SiteRunStatus } from '../db/runs.js';
import { insertPageResults, type PageRow } from '../db/results.js';
import { withTimeout, withTimeoutOr, TimeoutError } from '../lib/timeout.js';

export interface RunSiteDeps {
  /** null en dry-run: nada se escribe en la base. */
  runId: number | null;
  slot: number;
  userAgent: string;
  pageConcurrency: number;
  deadline: Deadline;
  log: Logger;
  /** Raíz de los PDFs; dentro se crea un directorio por sitio. */
  pdfDir: string;
  /** En dry-run no se escribe en la base ni se reemplazan los PDFs. */
  dryRun: boolean;
  /** Tope propio del sitio, además del presupuesto global de la corrida. */
  siteBudgetMs: number;
}

export interface SiteRunResult {
  siteId: string;
  siteRunId: number | null;
  status: SiteRunStatus;
  discovery: DiscoveryMethod | null;
  pagesDiscovered: number;
  pagesAudited: number;
  pagesFailed: number;
  truncated: boolean;
  abortedByDeadline: boolean;
  homeHttpStatus: number | null;
  cert: CertInfo | null;
  errorCategory: ErrorCategory | null;
  errorMessage: string | null;
  durationMs: number;
  /** Las páginas medidas, en el orden de descubrimiento. */
  pages: PageRow[];
  /** URL principal, que es la única que recibe Lighthouse en la segunda fase. */
  homeUrl: string | null;
  /** Catálogo de URLs que el sitio ofrece, para el selector de páginas del dashboard. */
  candidateUrls: string[];
}

export async function runSite(site: ResolvedSite, deps: RunSiteDeps): Promise<SiteRunResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ site_id: site.id });
  const persist = deps.runId !== null;

  // Reloj del sitio: lo que quede del presupuesto global, o su tope propio, lo
  // que se agote primero. Esto es lo que impide que un sitio lento se lleve la
  // corrida completa: el presupuesto global solo evita EMPEZAR sitios nuevos,
  // no puede cortar lo que ya está en vuelo.
  const siteDeadlineAt = Math.min(
    Date.now() + deps.siteBudgetMs,
    deps.deadline.endsAt,
  );
  const siteExpired = (): boolean => Date.now() >= siteDeadlineAt;
  const siteRemainingMs = (): number => Math.max(0, siteDeadlineAt - Date.now());

  const siteRunId = persist ? await startSiteRun(deps.runId as number, site.id) : null;

  const base = {
    siteId: site.id,
    siteRunId,
    discovery: null as DiscoveryMethod | null,
    pagesDiscovered: 0,
    pagesAudited: 0,
    pagesFailed: 0,
    truncated: false,
    abortedByDeadline: false,
    homeHttpStatus: null as number | null,
    cert: null as CertInfo | null,
    pages: [] as PageRow[],
    homeUrl: null as string | null,
    candidateUrls: [] as string[],
  };

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
    // Descubrimiento y certificado en paralelo: ninguno depende del otro.
    const [discovery, cert] = await Promise.all([
      discoverPages(site, { userAgent: deps.userAgent, signal: deps.deadline.signal, log }),
      checkCertificate(new URL(site.url).hostname, site.timeoutMs).catch((err: unknown) => {
        log.warn('no se pudo revisar el certificado', {
          motivo: err instanceof Error ? err.message : String(err),
        });
        return null;
      }),
    ]);

    base.discovery = discovery.method;
    base.pagesDiscovered = discovery.discovered;
    base.truncated = discovery.truncated;
    base.cert = cert;

    log.info('páginas descubiertas', {
      metodo: discovery.method,
      fuente: discovery.source,
      descubiertas: discovery.discovered,
      a_auditar: discovery.urls.length,
      truncado: discovery.truncated,
      cert_dias: cert?.daysRemaining ?? null,
    });

    browser = await launchBrowser(cdpPortForSlot(deps.slot));
    context = await newSiteContext(browser, site, deps.userAgent);

    // Sitios que pintan su navegación con JavaScript sueltan muy pocos links en
    // el HTML crudo. Cuando el descubrimiento barato se quedó sin sitemap, se
    // complementa leyendo el DOM ya renderizado en el navegador que de todas
    // formas acabamos de abrir.
    let urls = discovery.urls;
    let candidatas = discovery.candidates;
    if ((discovery.method === 'crawl' || discovery.method === 'home_only') && !siteExpired()) {
      // La cosecha es opcional: si tarda, se sigue con lo que ya se descubrió.
      const harvest = await withTimeoutOr(
        harvestRenderedLinks(context, site, { collect: CANDIDATE_CAP, signal: deps.deadline.signal }),
        Math.min(60_000, siteRemainingMs()),
        'cosecha de links renderizados',
        { urls: [] as string[], fetches: 0 },
        (err) => log.warn('cosecha de links cortada por tiempo', { motivo: err.message }),
      );
      // La unión se hace sobre el catálogo completo, no sobre las urls ya
      // recortadas a maxPages: lo cosechado sirve tanto para auditar como para
      // ofrecerlo a elegir, y recortar antes de unir tiraba el resto del catálogo.
      // Como el catálogo va primero, esto solo puede agregar: el orden de las
      // primeras páginas no cambia si el crawl ya había encontrado suficientes.
      if (harvest.urls.length > 1) {
        const merged = finalizeUrlList(site.url, [...candidatas.slice(1), ...harvest.urls], site);
        log.info('links cosechados del DOM renderizado', {
          antes: candidatas.length,
          despues: merged.candidates.length,
          cargas: harvest.fetches,
        });
        urls = merged.urls;
        candidatas = merged.candidates;
        base.discovery = 'crawl';
        base.pagesDiscovered = merged.discovered;
        base.truncated = merged.truncated;
      }
    }

    // El catálogo se guarda aunque la selección sea manual: es lo que el
    // dashboard ofrece a elegir, y así un sitio que publica páginas nuevas las
    // ofrece mañana aun con su selección congelada hoy.
    base.candidateUrls = candidatas;

    // El descubrimiento ya corrió —hace falta para el catálogo— pero si el sitio
    // trae una selección manual, deja de decidir qué se audita.
    const elegidas = chooseAuditList(site, {
      urls,
      method: base.discovery ?? 'none',
      truncated: base.truncated,
    });
    if (elegidas.method === 'manual') {
      log.info('páginas elegidas a mano', {
        pedidas: site.pages.length,
        a_auditar: elegidas.urls.length,
        catalogo: candidatas.length,
      });
    }
    urls = elegidas.urls;
    base.discovery = elegidas.method;
    base.truncated = elegidas.truncated;

    const homeUrl = urls[0];
    base.homeUrl = homeUrl ?? null;

    const limit = pLimit(deps.pageConcurrency);
    const results = new Map<string, PageMetrics>();

    await Promise.all(
      urls.map((url) =>
        limit(async () => {
          // Al agotarse el presupuesto dejamos de empezar páginas nuevas; las que
          // ya estaban en vuelo terminan, para no guardar mediciones a medias.
          if (siteExpired()) {
            base.abortedByDeadline = true;
            return;
          }
          // Tope duro por página. Consultar el reloj SOLO entre páginas no basta:
          // si una sola página no termina nunca, la corrida se queda abierta
          // indefinidamente. Medido aquí: un sitio pasó 29 minutos sin escribir
          // una línea de log mientras el resto de la corrida ya estaba abortado.
          const presupuestoPagina = Math.min(site.timeoutMs * 2 + 15_000, siteRemainingMs());
          let metrics: PageMetrics;
          try {
            metrics = await withTimeout(
              auditPage(context as BrowserContext, url, site),
              Math.max(5000, presupuestoPagina),
              `auditoría de ${url}`,
            );
          } catch (err) {
            if (!(err instanceof TimeoutError)) throw err;
            base.abortedByDeadline = true;
            log.warn('página cortada por tiempo', { url, motivo: err.message });
            return;
          }
          results.set(url, metrics);
          if (!metrics.ok) {
            log.warn('página con error', {
              url,
              status: metrics.httpStatus,
              categoria: metrics.errorCategory,
              intentos: metrics.attemptCount,
            });
          }
        }),
      ),
    );

    // Se reordena según el descubrimiento: el Map preserva orden de inserción,
    // que es orden de terminación, y el PDF necesita el orden del sitemap.
    base.pages = urls
      .map((url) => {
        const metrics = results.get(url);
        return metrics === undefined ? null : { ...metrics, isHome: url === homeUrl };
      })
      .filter((row): row is PageRow => row !== null);

    base.pagesAudited = base.pages.length;
    base.pagesFailed = base.pages.filter((p) => !p.ok).length;
    base.homeHttpStatus = base.pages.find((p) => p.isHome)?.httpStatus ?? null;

    if (persist && base.pages.length > 0) {
      await insertPageResults(siteRunId as number, site.id, base.pages);
    }

    const home = base.pages.find((p) => p.isHome);

    const status: SiteRunStatus =
      home === undefined || !home.ok
        ? 'failed'
        : base.pagesFailed > 0 || base.abortedByDeadline
          ? 'partial'
          : 'ok';

    const errorCategory = home !== undefined && !home.ok ? home.errorCategory : null;
    const errorMessage =
      home === undefined
        ? 'la URL principal no llegó a medirse'
        : !home.ok
          ? home.errorMessage
          : base.abortedByDeadline
            ? 'se agotó el presupuesto de tiempo de la corrida'
            : null;

    if (persist) {
      await finishSiteRun(siteRunId as number, {
        status,
        discovery: base.discovery,
        pagesDiscovered: base.pagesDiscovered,
        pagesAudited: base.pagesAudited,
        pagesFailed: base.pagesFailed,
        maxPages: site.maxPages,
        truncated: base.truncated,
        candidateUrls: base.candidateUrls,
        homeHttpStatus: base.homeHttpStatus,
        cert: base.cert,
        errorCategory,
        errorMessage,
      });
    }

    const durationMs = Date.now() - startedAt;
    log.info('sitio terminado', {
      estado: status,
      auditadas: base.pagesAudited,
      fallidas: base.pagesFailed,
      duracion_ms: durationMs,
    });

    return { ...base, status, errorCategory, errorMessage, durationMs };
  } catch (err) {
    // Cualquier cosa no prevista (Chromium que no arranca, la base caída a mitad)
    // deja el sitio como fallido con su causa, sin tumbar la corrida completa.
    const message = err instanceof Error ? err.message : String(err);
    log.error('el sitio falló', err);

    if (persist && siteRunId !== null) {
      await finishSiteRun(siteRunId, {
        status: 'failed',
        discovery: base.discovery,
        pagesDiscovered: base.pagesDiscovered,
        pagesAudited: base.pagesAudited,
        pagesFailed: base.pagesFailed,
        maxPages: site.maxPages,
        truncated: base.truncated,
        candidateUrls: base.candidateUrls,
        homeHttpStatus: base.homeHttpStatus,
        cert: base.cert,
        errorCategory: 'unknown',
        errorMessage: message,
      }).catch(() => {});
    }

    return {
      ...base,
      status: 'failed',
      errorCategory: 'unknown',
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
