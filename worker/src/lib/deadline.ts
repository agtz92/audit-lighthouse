/**
 * Presupuesto de tiempo de la corrida.
 *
 * La corrida de las 6am no puede extenderse sin límite: si un sitio se cuelga,
 * lo que importa es que los demás alcancen a medirse y que quede registrado qué
 * quedó fuera. El signal se pasa a los fetch y a los descubrimientos para que
 * corten solos.
 */

export class Deadline {
  readonly startedAt: number;
  readonly endsAt: number;
  readonly signal: AbortSignal;

  constructor(budgetMs: number) {
    // AbortSignal.timeout rechaza valores negativos. Un presupuesto negativo no
    // significa nada: se trata como cero, o sea vencido desde el arranque.
    const budget = Math.max(0, budgetMs);
    this.startedAt = Date.now();
    this.endsAt = this.startedAt + budget;
    this.signal = AbortSignal.timeout(budget);
  }

  get expired(): boolean {
    return Date.now() >= this.endsAt;
  }

  get remainingMs(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}

/**
 * Reparte índices de slot entre tareas concurrentes.
 *
 * p-limit garantiza cuántas tareas corren a la vez, pero no les da identidad, y
 * cada Chromium concurrente necesita un puerto CDP distinto. Esto asigna el
 * índice libre más bajo y lo devuelve al terminar.
 */
export class SlotPool {
  #free: number[];

  constructor(size: number) {
    this.#free = Array.from({ length: size }, (_, i) => i);
  }

  acquire(): number {
    const slot = this.#free.shift();
    if (slot === undefined) {
      throw new Error('SlotPool agotado: hay más tareas concurrentes que slots');
    }
    return slot;
  }

  release(slot: number): void {
    this.#free.push(slot);
    this.#free.sort((a, b) => a - b);
  }
}
