'use client';

/**
 * Manda la página a imprimir. El formato lo define la hoja de estilos de
 * impresión, no una vista aparte: mantener dos plantillas del mismo panel
 * garantiza que tarde o temprano digan cosas distintas.
 */
export function PrintButton() {
  return (
    <button className="ghost no-print" onClick={() => window.print()} title="Imprimir o guardar como PDF">
      Imprimir
    </button>
  );
}
