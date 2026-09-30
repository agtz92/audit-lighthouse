/**
 * Topes de tiempo duros.
 *
 * Existe porque el presupuesto de la corrida solo se consultaba ENTRE páginas:
 * bastaba con que una operación no terminara nunca para que la corrida se
 * quedara abierta indefinidamente. Medido en este proyecto: un sitio se llevó
 * 29 minutos sin escribir una línea de log mientras el resto de la corrida ya
 * había sido abortado.
 *
 * Nota sobre lo que esto puede y no puede hacer: una promesa de JavaScript no se
 * cancela. withTimeout deja de ESPERARLA, y quien llama debe liberar el recurso
 * subyacente —cerrar la página, matar el proceso— para que el trabajo huérfano
 * no siga consumiendo memoria.
 */

export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} excedió ${ms} ms`);
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Igual que withTimeout, pero en vez de lanzar devuelve `fallback`.
 * Para pasos opcionales —comprimir, cosechar links— donde quedarse sin ese paso
 * es mucho mejor que perder la corrida.
 */
export async function withTimeoutOr<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  fallback: T,
  onTimeout?: (err: TimeoutError) => void,
): Promise<T> {
  try {
    return await withTimeout(promise, ms, label);
  } catch (err) {
    if (err instanceof TimeoutError) {
      onTimeout?.(err);
      return fallback;
    }
    throw err;
  }
}
