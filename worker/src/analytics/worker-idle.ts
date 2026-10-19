import type { Logger } from '../lib/logger.js';

/**
 * Espera a que el worker termine de auditar antes de abrir Chromium. Lo usan
 * los PDFs de tráfico y los de Google Ads.
 *
 * Los dos procesos juntos no caben en la memoria de Docker: el worker usa
 * hasta 2.4 GB durante Lighthouse. A las 05:00 nunca coinciden, pero un
 * «Sincronizar ahora» a media auditoría sí. Los datos se guardan sin esperar;
 * lo que se pospone son solo los PDFs.
 */
export async function waitForWorkerIdle(workerUrl: string, maxMs: number, log: Logger): Promise<boolean> {
  const limite = Date.now() + maxMs;
  let avisado = false;
  while (Date.now() < limite) {
    try {
      const res = await fetch(`${workerUrl}/health`, { signal: AbortSignal.timeout(3000) });
      const body = (await res.json()) as { corriendo?: boolean };
      if (body.corriendo !== true) return true;
    } catch {
      // Sin worker no hay con quién competir por memoria.
      return true;
    }
    if (!avisado) {
      log.info('el worker está auditando; los PDFs esperan a que termine');
      avisado = true;
    }
    await new Promise((r) => setTimeout(r, 30_000).unref());
  }
  return false;
}

