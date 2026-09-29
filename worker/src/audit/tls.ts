/**
 * Estado del certificado TLS del dominio.
 *
 * Se conecta con rejectUnauthorized: false a propósito. Con la validación
 * estricta, un certificado ya vencido tira la conexión y nos quedaríamos sin
 * saber cuándo venció ni de quién era; justo la información que se necesita para
 * arreglarlo. Así obtenemos las fechas igual y reportamos la validez aparte.
 */

import { connect as tlsConnect, type PeerCertificate } from 'node:tls';

export interface CertInfo {
  valid: boolean;
  issuer: string | null;
  validFrom: Date | null;
  validTo: Date | null;
  daysRemaining: number | null;
  error: string | null;
}

const NO_CERT: CertInfo = {
  valid: false,
  issuer: null,
  validFrom: null,
  validTo: null,
  daysRemaining: null,
  error: null,
};

/** Días completos entre ahora y la fecha dada; negativo si ya pasó. */
export function daysUntil(date: Date, now: Date = new Date()): number {
  return Math.floor((date.getTime() - now.getTime()) / 86_400_000);
}

function issuerName(cert: PeerCertificate): string | null {
  const issuer = cert.issuer as Record<string, string> | undefined;
  if (issuer === undefined) return null;
  // O = organización (Let's Encrypt, DigiCert...), CN = nombre común.
  return issuer.O ?? issuer.CN ?? null;
}

export async function checkCertificate(
  hostname: string,
  timeoutMs: number,
  now: Date = new Date(),
): Promise<CertInfo> {
  return new Promise<CertInfo>((resolve) => {
    let settled = false;
    const finish = (info: CertInfo): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(info);
    };

    const socket = tlsConnect(
      {
        host: hostname,
        port: 443,
        servername: hostname, // SNI: sin esto un host compartido devuelve otro cert.
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      () => {
        const cert = socket.getPeerCertificate();
        if (cert === null || Object.keys(cert).length === 0) {
          finish({ ...NO_CERT, error: 'el servidor no presentó certificado' });
          return;
        }
        const validFrom = new Date(cert.valid_from);
        const validTo = new Date(cert.valid_to);
        const parsedTo = Number.isNaN(validTo.getTime()) ? null : validTo;
        finish({
          // authorized es false si la cadena no valida (vencido, autofirmado,
          // nombre que no coincide); authorizationError dice cuál de esos es.
          valid: socket.authorized,
          issuer: issuerName(cert),
          validFrom: Number.isNaN(validFrom.getTime()) ? null : validFrom,
          validTo: parsedTo,
          daysRemaining: parsedTo === null ? null : daysUntil(parsedTo, now),
          error: socket.authorized ? null : (socket.authorizationError?.toString() ?? 'cadena no válida'),
        });
      },
    );

    socket.on('timeout', () => finish({ ...NO_CERT, error: `timeout de ${timeoutMs} ms en el handshake TLS` }));
    socket.on('error', (err: Error) => finish({ ...NO_CERT, error: err.message }));
  });
}
