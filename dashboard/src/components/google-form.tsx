'use client';

import { useActionState, useState } from 'react';
import { conexionGoogle, type GoogleActionResult } from '@/app/config/actions';
import type { AvailableProperties } from '@/lib/analytics-control';

const INICIAL: GoogleActionResult | null = null;

/**
 * Conexión de un sitio con Search Console y GA4.
 *
 * Las propiedades se ofrecen en una lista con lo que la cuenta de servicio ya
 * puede ver, pero el campo sigue siendo de texto: si el servicio analytics no
 * responde, o la propiedad todavía no comparte acceso, se puede escribir igual.
 * «Probar conexión» prueba lo que está escrito, sin guardarlo.
 */
export function GoogleForm({
  siteId, siteUrl, current, account, accountError, properties,
}: {
  siteId: string;
  siteUrl: string;
  current: { searchConsole: string | null; ga4Property: string | null };
  account: string | null;
  accountError: string | null;
  properties: AvailableProperties;
}) {
  const [estado, accion, enviando] = useActionState(conexionGoogle, INICIAL);
  const [copiado, setCopiado] = useState<string | null>(null);
  // Controlados a propósito. React 19 reinicia un formulario después de cada
  // acción, y con campos no controlados lo que se escribió para «Probar
  // conexión» desaparecía antes de poder «Guardar».
  const [gsc, setGsc] = useState(current.searchConsole ?? '');
  const [ga4, setGa4] = useState(current.ga4Property ?? '');
  const err = estado?.fieldErrors ?? {};
  const check = estado?.check;

  let dominio = '';
  try {
    dominio = new URL(siteUrl).hostname.replace(/^www\./, '');
  } catch {
    // sin sugerencia
  }

  const copiar = (): void => {
    if (account === null) return;
    navigator.clipboard.writeText(account).then(
      () => setCopiado('Copiado'),
      () => setCopiado('Selecciónalo a mano'),
    );
  };

  return (
    <form action={accion} className="site-form google-form">
      <input type="hidden" name="id" value={siteId} />

      <div className="sa-box">
        {account !== null ? (
          <>
            <span>
              Agrega esta cuenta como usuario <b>de solo lectura</b> en la propiedad de Search Console
              (Configuración › Usuarios y permisos) y en la de GA4 (Administrar › Acceso a la propiedad):
            </span>
            <code>{account}</code>
            <button type="button" className="ghost" onClick={copiar}>{copiado ?? 'Copiar'}</button>
          </>
        ) : (
          <span className="bad">
            {accountError ?? 'El servicio analytics no responde, así que no se puede leer la cuenta de servicio.'}
          </span>
        )}
      </div>

      <div className="grid">
        <label>
          <span>Propiedad de Search Console <em>(opcional)</em></span>
          <input
            name="searchConsole"
            list={`gsc-${siteId}`}
            value={gsc}
            onChange={(e) => setGsc(e.target.value)}
            placeholder={dominio === '' ? 'sc-domain:ejemplo.com' : `sc-domain:${dominio}`}
            aria-invalid={err.searchConsole !== undefined}
            autoComplete="off"
          />
          <datalist id={`gsc-${siteId}`}>
            {properties.searchConsole.map((p) => <option key={p.siteUrl} value={p.siteUrl} />)}
          </datalist>
          <small className={err.searchConsole !== undefined ? 'bad' : undefined}>
            {err.searchConsole
              ?? (properties.searchConsole.length > 0
                ? `${properties.searchConsole.length} propiedades disponibles para elegir. Prefiere la de dominio.`
                : 'De dominio (sc-domain:…) o de prefijo de URL, con la diagonal final.')}
          </small>
        </label>

        <label>
          <span>Propiedad de GA4 <em>(opcional)</em></span>
          <input
            name="ga4Property"
            list={`ga4-${siteId}`}
            inputMode="numeric"
            value={ga4}
            onChange={(e) => setGa4(e.target.value)}
            placeholder="345678901"
            aria-invalid={err.ga4Property !== undefined}
            autoComplete="off"
          />
          <datalist id={`ga4-${siteId}`}>
            {properties.ga4.map((p) => <option key={p.id} value={p.id}>{`${p.name} · ${p.account}`}</option>)}
          </datalist>
          <small className={err.ga4Property !== undefined ? 'bad' : undefined}>
            {err.ga4Property ?? 'El número en Administrar › Detalles de la propiedad. No es el ID de medición G-XXXX.'}
          </small>
        </label>
      </div>

      {check !== undefined && (
        <div className="checks">
          {check.searchConsole !== null && (
            <div className="line">
              <span className={`status ${check.searchConsole.ok ? 'good' : 'critical'}`}>
                <span className="dot" aria-hidden="true" />Search Console
              </span>
              <span>{check.searchConsole.message}</span>
            </div>
          )}
          {check.ga4 !== null && (
            <>
              <div className="line">
                <span className={`status ${check.ga4.ok ? 'good' : 'critical'}`}>
                  <span className="dot" aria-hidden="true" />GA4
                </span>
                <span>{check.ga4.message}</span>
              </div>
              {check.ga4.ok && (
                <div className="line sub-line">
                  <span className="k">Eventos clave</span>
                  {check.ga4.keyEventsError !== null ? (
                    <span className="muted">No se pudieron leer: {check.ga4.keyEventsError}</span>
                  ) : check.ga4.keyEvents.length === 0 ? (
                    <span className="muted">
                      La propiedad no tiene eventos clave definidos. Sin ellos no se pueden contar contactos ni ventas:
                      conviene marcar como clave el envío de formularios, los clics a WhatsApp y las llamadas.
                    </span>
                  ) : (
                    <span className="chips">{check.ga4.keyEvents.map((k) => <code key={k}>{k}</code>)}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="actions">
        <button type="submit" name="intent" value="probar" className="ghost" disabled={enviando}>
          {enviando ? 'Probando…' : 'Probar conexión'}
        </button>
        <button type="submit" name="intent" value="guardar" disabled={enviando}>
          Guardar
        </button>
        {estado !== null && estado.message !== '' && (
          <span className={estado.ok ? 'msg ok' : 'msg bad'}>{estado.message}</span>
        )}
      </div>
    </form>
  );
}
