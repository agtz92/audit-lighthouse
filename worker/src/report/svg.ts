/**
 * Gráficas para los informes impresos, como SVG en línea.
 *
 * No hay librería de gráficas en el worker y no hace falta: un informe impreso
 * no tiene tooltip ni zoom, y una línea con su periodo de comparación se dibuja
 * en treinta líneas. A cambio, el PDF lleva vectores nítidos y no depende de
 * que un script termine de pintar antes de imprimir.
 */

import { esc } from './format.js';

export interface LineChartInput {
  /** Valores del periodo actual, uno por día. */
  current: Array<number | null>;
  /** Periodo anterior, alineado por posición con el actual. */
  previous: Array<number | null>;
  /** Etiquetas del primer y último día del eje X. */
  first: string;
  last: string;
  /** Formato de las marcas del eje Y. */
  tick?: (v: number) => string;
  /** Posición media: menos es mejor, así que el eje va al revés. */
  invert?: boolean;
  color?: string;
}

/** Marcas «bonitas» del eje: 0, 50, 100… y no 0, 47, 94. */
export function niceTicks(max: number, count = 3): number[] {
  if (max <= 0) return [0, 1];
  const crudo = max / count;
  const potencia = 10 ** Math.floor(Math.log10(crudo));
  const paso = [1, 2, 2.5, 5, 10].map((m) => m * potencia).find((p) => p >= crudo) ?? crudo;
  const out: number[] = [];
  for (let v = 0; v <= max + paso * 0.001; v += paso) out.push(Number(v.toFixed(6)));
  if ((out[out.length - 1] ?? 0) < max) out.push(Number((out.length * paso).toFixed(6)));
  return out;
}

export function lineChartSvg(c: LineChartInput): string {
  const W = 520;
  const H = 150;
  const L = 40;
  const R = 8;
  const T = 8;
  const B = 18;
  const n = Math.max(c.current.length, c.previous.length, 2);
  const valores = [...c.current, ...c.previous].filter((v): v is number => v !== null);
  const tick = c.tick ?? ((v: number) => v.toLocaleString('es-MX'));
  const color = c.color ?? '#16355e';

  if (valores.length === 0) {
    return `<svg viewBox="0 0 ${W} ${H}" width="100%"><text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="9" fill="#98a1ad">Sin datos en el periodo</text></svg>`;
  }

  const ticks = niceTicks(Math.max(...valores));
  const tope = ticks[ticks.length - 1] ?? 1;
  const x = (i: number): number => L + (i / (n - 1)) * (W - L - R);
  const y = (v: number): number => {
    const f = v / tope;
    return c.invert === true ? T + f * (H - T - B) : H - B - f * (H - T - B);
  };
  const path = (serie: Array<number | null>): string => {
    let d = '';
    let pluma = false;
    serie.forEach((v, i) => {
      if (v === null) {
        pluma = false;
        return;
      }
      d += `${pluma ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pluma = true;
    });
    return d;
  };

  const malla = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="#ebeef2" stroke-width="1"/>
    <text x="${L - 6}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end" font-size="8" fill="#98a1ad" font-family="Roboto Mono">${esc(tick(t))}</text>`).join('');

  const ultimo = [...c.current].reverse().findIndex((v) => v !== null);
  const iUltimo = ultimo === -1 ? -1 : c.current.length - 1 - ultimo;
  const punto = iUltimo === -1 ? '' : `<circle cx="${x(iUltimo).toFixed(1)}" cy="${y(c.current[iUltimo] ?? 0).toFixed(1)}" r="2.6" fill="${color}"/>`;

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">
    ${malla}
    <path d="${path(c.previous)}" fill="none" stroke="#98a1ad" stroke-width="1.2" stroke-dasharray="3 3"/>
    <path d="${path(c.current)}" fill="none" stroke="${color}" stroke-width="1.8"/>
    ${punto}
    <text x="${L}" y="${H - 4}" font-size="8" fill="#98a1ad" font-family="Roboto Mono">${esc(c.first)}</text>
    <text x="${W - R}" y="${H - 4}" text-anchor="end" font-size="8" fill="#98a1ad" font-family="Roboto Mono">${esc(c.last)}</text>
  </svg>`;
}

/** Barra horizontal proporcional, para canales y dispositivos. */
export function barCell(value: number, max: number, color = '#16355e'): string {
  const ancho = max <= 0 ? 0 : Math.max(1, Math.round((value / max) * 100));
  return `<span class="hbar"><i style="width:${ancho}%;background:${color}"></i></span>`;
}
