-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- Visibilidad en asistentes de IA.
--
-- Ningún asistente publica impresiones. Lo que sí se puede medir es si pueden
-- leer el sitio (la auditoría) y cuántas visitas mandan (GA4).
-- ─────────────────────────────────────────────────────────────────────────────

-- Diagnóstico de la auditoría: robots.txt por bot, la prueba contra el firewall,
-- el HTML sin JavaScript y llms.txt. Es un documento y no columnas porque la
-- lista de bots cambia más rápido que el esquema.
ALTER TABLE site_runs ADD COLUMN ai_readiness jsonb;

COMMENT ON COLUMN site_runs.ai_readiness IS
  'Preparación para asistentes de IA (worker/src/audit/ai-readiness.ts). NULL si la corrida no llegó a revisarlo.';

-- Sesiones que llegan desde un asistente, por día. Se guarda también el día
-- sin visitas: así el último día guardado dice hasta dónde se sincronizó, y la
-- carga inicial no se repite en cada corrida para los sitios que no reciben nada.
CREATE TABLE ga_ai_daily (
  site_id          text          NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date             date          NOT NULL,
  sessions         integer       NOT NULL,
  engaged_sessions integer       NOT NULL,
  key_events       numeric(12,2) NOT NULL,
  -- Sesiones por asistente: {"ChatGPT": 12, "Perplexity": 3}.
  by_assistant     jsonb         NOT NULL DEFAULT '{}',
  PRIMARY KEY (site_id, date)
);

COMMENT ON TABLE ga_ai_daily IS
  'Solo cuenta las visitas que llegan con referrer o utm del asistente. Las apps móviles suelen no mandarlo y caen en Directo.';

-- Down Migration

DROP TABLE IF EXISTS ga_ai_daily;
ALTER TABLE site_runs DROP COLUMN IF EXISTS ai_readiness;
