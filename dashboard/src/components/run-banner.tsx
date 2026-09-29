import type { LastRunInfo } from '@/lib/queries';
import { fmtDateTime, fmtDuration, fmtTime } from '@/lib/format';

/**
 * Distingue "estos son los datos de la corrida de hoy" de "hoy todavía no ha
 * corrido". Sin esta línea, una tabla con datos de ayer se lee idéntica a una con
 * datos de hoy, y eso es exactamente el error que un monitoreo no puede permitir.
 */
export function RunBanner({ run }: { run: LastRunInfo | null }) {
  if (run === null) {
    return (
      <div className="banner stale">
        <strong>Todavía no hay ninguna corrida.</strong>
        <span className="muted">
          La primera ocurre a las 06:00 (hora de Ciudad de México), o ejecuta una manual con{' '}
          <code>docker compose exec worker npm run check</code>.
        </span>
      </div>
    );
  }

  if (run.status === 'running') {
    return (
      <div className="banner running">
        <strong>Corrida en curso</strong>
        <span className="muted">
          #{run.id} · {run.trigger} · empezó a las {fmtTime(run.startedAt)}
        </span>
      </div>
    );
  }

  const clase = !run.isToday ? 'stale' : run.status === 'failed' ? 'failed' : 'today';
  const encabezado = !run.isToday
    ? 'Hoy todavía no ha corrido'
    : run.status === 'ok'
      ? 'Datos de la corrida de hoy'
      : run.status === 'partial'
        ? 'Datos de hoy, con incidencias'
        : 'La corrida de hoy falló';

  return (
    <div className={`banner ${clase}`}>
      <strong>{encabezado}</strong>
      <span className="muted">
        #{run.id} · {run.trigger} · {fmtDateTime(run.startedAt)} · duró {fmtDuration(run.durationMs)} ·{' '}
        {run.sitesOk}/{run.sitesTotal} en línea
        {run.sitesFailed > 0 ? `, ${run.sitesFailed} caídos` : ''}
        {run.sitesSkipped > 0 ? `, ${run.sitesSkipped} sin medir` : ''}
        {run.budgetExceeded ? ' · se agotó el presupuesto de tiempo' : ''}
      </span>
      {!run.isToday && (
        <span className="muted">
          Lo que ves abajo es de la última corrida disponible, no de hoy.
        </span>
      )}
    </div>
  );
}
