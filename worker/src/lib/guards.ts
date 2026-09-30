/**
 * Red de seguridad del proceso.
 *
 * Node mata el proceso ante una promesa rechazada que nadie maneja. Eso está
 * bien en un script, pero aquí significa perder una corrida entera de 30 minutos
 * por un error asíncrono de una dependencia, de madrugada y sin nadie mirando.
 *
 * Pasó de verdad: Lighthouse lanzó "Protocol error (Target.getTargetInfo):
 * Session with given id not found" desde un callback interno, después de haber
 * auditado los 20 sitios, y la corrida quedó abierta para siempre sin escribir
 * su resultado.
 *
 * Registrar y seguir NO es esconder el error: queda en el log con su stack, y
 * el trabajo que ya se hizo alcanza a guardarse. Lo contrario —morir— pierde
 * todo y además deja la corrida marcada como 'running' eternamente.
 */

import { log } from './logger.js';

let instalado = false;

export function installProcessGuards(): void {
  if (instalado) return;
  instalado = true;

  process.on('unhandledRejection', (reason: unknown) => {
    log.error('promesa rechazada sin manejar; la corrida continúa', reason);
  });

  process.on('uncaughtException', (err: Error) => {
    // Una excepción síncrona sin capturar sí deja el proceso en estado dudoso,
    // pero queremos que quede registrada antes de que Node se vaya.
    log.error('excepción no capturada', err);
  });
}
