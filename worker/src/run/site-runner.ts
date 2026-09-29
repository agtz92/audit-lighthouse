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
import { discoverPages, finalizeUrlList, type DiscoveryMethod } from '../discovery/index.js';
import { harvestRenderedLinks } from '../discovery/rendered.js';
import { startSiteRun, finishSiteRun, recordPdfMeta, type SiteRunStatus } from '../db/runs.js';
import { insertPageResults, type PageRow } from '../db/results.js';
import { SitePdfCollector, sitePdfPaths, cleanStaleTmpDirs } from '../pdf/site-pdfs.js';
import type { PdfQuality } from '../pdf/compress.js';

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
  pdfQuality: PdfQuality;
  pdfCompressTimeoutMs: number;
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
}

export async function runSite(site: ResolvedSite, deps: RunSiteDeps): Promise<SiteRunResult> {
  const startedAt = Date.now();
  const log = deps.log.child({ site_id: site.id });
  const persist = deps.runId !== null;

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
    if (discovery.method === 'crawl' || discovery.method === 'home_only') {
      const harvest = await harvestRenderedLinks(context, site, { signal: deps.deadline.signal });
      if (harvest.urls.length > urls.length) {
        const merged = finalizeUrlList(site.url, [...urls.slice(1), ...harvest.urls], site);
        log.info('links cosechados del DOM renderizado', {
          antes: urls.length,
          despues: merged.urls.length,
          cargas: harvest.fetches,
        });
        urls = merged.urls;
        base.discovery = 'crawl';
        base.pagesDiscovered = merged.discovered;
        base.truncated = merged.truncated;
      }
    }

    const homeUrl = urls[0];
    base.homeUrl = homeUrl ?? null;
    const orderIndex = new Map(urls.map((u, i) => [u, i]));

    await cleanStaleTmpDirs(deps.pdfDir, site.id);
    const paths = sitePdfPaths(deps.pdfDir, site.id, deps.runId ?? 'dry-run');
    const pdfs = new SitePdfCollector({
      paths,
      dryRun: deps.dryRun,
      log,
      quality: deps.pdfQuality,
      compressTimeoutMs: deps.pdfCompressTimeoutMs,
    });
    await pdfs.init();

    const limit = pLimit(deps.pageConcurrency);
    const results = new Map<string, PageMetrics>();

    await Promise.all(
      urls.map((url) =>
        limit(async () => {
          // Al agotarse el presupuesto dejamos de empezar páginas nuevas; las que
          // ya estaban en vuelo terminan, para no guardar mediciones a medias.
          if (deps.deadline.expired) {
            base.abortedByDeadline = true;
            return;
          }
          const metrics = await auditPage(context as BrowserContext, url, site, {
            // El PDF se imprime en esta misma visita: volver a cargar cada página
            // solo para imprimirla duplicaría el costo de la corrida completa.
            capture: (page, capturedUrl) => pdfs.capture(page, capturedUrl, orderIndex.get(url) ?? 0),
          });
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

    // Los dos PDFs se arman al final, en orden de descubrimiento y no de término.
    const pdfMeta = await pdfs.finalize(urls, homeUrl, {
      siteName: site.name,
      siteUrl: site.url,
      generatedAt: new Date(),
      discovered: base.pagesDiscovered,
      truncated: base.truncated,
      maxPages: site.maxPages,
      failed: base.pagesAudited - pdfs.capturedCount,
    });
    if (persist && (pdfMeta.home !== null || pdfMeta.full !== null)) {
      await recordPdfMeta(siteRunId as number, pdfMeta.home, pdfMeta.full);
    }
    log.info('PDFs actualizados', {
      home_bytes: pdfMeta.home?.bytes ?? null,
      full_bytes: pdfMeta.full?.bytes ?? null,
      full_paginas: pdfMeta.full?.pages ?? null,
      full_urls: pdfMeta.full?.urls ?? null,
    });

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
