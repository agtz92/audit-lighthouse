-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- Search Console y Google Analytics 4.
--
-- Es un proceso aparte de la auditoría: lo corre el servicio `analytics` a su
-- propia hora, con su propio candado y su propio historial de corridas. Por eso
-- no reutiliza runs/site_runs: mezclar las dos tareas en una tabla haría que
-- «la última corrida» significara cosas distintas según quién preguntara, y la
-- recuperación al arrancar del worker tomaría una sincronización de tráfico como
-- si fuera una auditoría.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE analytics_runs (
  id            bigserial   PRIMARY KEY,
  trigger       run_trigger NOT NULL,
  status        run_status  NOT NULL DEFAULT 'running',
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  sites_total   integer     NOT NULL DEFAULT 0,
  sites_ok      integer     NOT NULL DEFAULT 0,
  sites_failed  integer     NOT NULL DEFAULT 0,
  notes         text
);

CREATE INDEX analytics_runs_started_idx ON analytics_runs (started_at DESC);

COMMENT ON COLUMN analytics_runs.status IS
  'partial = algún sitio sincronizó solo una de las dos fuentes, o alguno falló.';

-- Estado de una fuente dentro de una sincronización. 'off' = el sitio no tiene
-- esa fuente configurada en sites.yaml, que no es un error.
CREATE TYPE source_status AS ENUM ('ok', 'error', 'off');

CREATE TABLE analytics_site_runs (
  id                  bigserial     PRIMARY KEY,
  run_id              bigint        NOT NULL REFERENCES analytics_runs (id) ON DELETE CASCADE,
  site_id             text          NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  status              run_status    NOT NULL DEFAULT 'running',
  started_at          timestamptz   NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  duration_ms         integer,

  gsc_property        text,
  gsc_status          source_status NOT NULL DEFAULT 'off',
  gsc_error           text,
  gsc_rows            integer       NOT NULL DEFAULT 0,
  -- Último día que Search Console ya publicó. Va 2 a 3 días detrás de hoy.
  gsc_latest_date     date,

  ga_property         text,
  ga_status           source_status NOT NULL DEFAULT 'off',
  ga_error            text,
  ga_rows             integer       NOT NULL DEFAULT 0,
  ga_latest_date      date,
  -- Nombres de los eventos clave que la propiedad tiene definidos.
  ga_key_events       text[]        NOT NULL DEFAULT '{}',

  analytics_pdf_bytes        bigint,
  analytics_pdf_pages        integer,
  analytics_pdf_generated_at timestamptz,

  UNIQUE (run_id, site_id)
);

CREATE INDEX analytics_site_runs_site_idx ON analytics_site_runs (site_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- Series diarias. Una fila por sitio y día: la sincronización vuelve a pedir
-- los últimos días y los reemplaza, porque Google sigue ajustándolos después
-- de publicarlos. La llave natural hace que repetir una sincronización no
-- duplique nada.
--
-- No cuelgan de una corrida a propósito: son la serie del sitio, no la foto de
-- un día. Si colgaran de analytics_runs, la retención de 90 días se llevaría el
-- histórico de 16 meses que se cargó la primera vez.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE gsc_daily (
  site_id     text    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date        date    NOT NULL,
  clicks      integer NOT NULL,
  impressions integer NOT NULL,
  -- Posición media ponderada por impresiones, tal como la entrega Google.
  position    numeric(7,2),
  PRIMARY KEY (site_id, date)
);

COMMENT ON TABLE gsc_daily IS
  'El CTR no se guarda: es clicks / impressions, y guardarlo invita a promediar porcentajes.';

CREATE TABLE ga_daily (
  site_id          text    NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date             date    NOT NULL,
  sessions         integer NOT NULL,
  engaged_sessions integer NOT NULL,
  total_users      integer NOT NULL,
  new_users        integer NOT NULL,
  page_views       integer NOT NULL,
  key_events       numeric(12,2) NOT NULL,
  PRIMARY KEY (site_id, date)
);

COMMENT ON COLUMN ga_daily.total_users IS
  'Usuarios de ESE día. No se suman entre días: un mismo usuario cuenta una vez por día. Los totales de un periodo están en analytics_breakdowns (kind = ga_totals).';
COMMENT ON COLUMN ga_daily.key_events IS
  'numeric porque GA4 permite eventos clave con valor fraccionario.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Desgloses por periodo: consultas y páginas de Search Console; canales,
-- dispositivos, páginas de entrada, eventos clave y totales de GA4.
--
-- Solo se guarda el vigente de cada combinación: son la foto que alimenta la
-- tabla del dashboard y el informe, no una serie. Cada sincronización los
-- sobrescribe.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE analytics_breakdowns (
  site_id     text        NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  -- last28 | prev28 | month | prev_month
  period      text        NOT NULL,
  -- gsc_queries | gsc_pages | ga_totals | ga_channels | ga_devices | ga_landing | ga_key_events
  kind        text        NOT NULL,
  start_date  date        NOT NULL,
  end_date    date        NOT NULL,
  rows        jsonb       NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, period, kind)
);

-- ─────────────────────────────────────────────────────────────────────────────
-- El informe integral lo arma el worker al terminar Lighthouse, así que su
-- metadato vive junto a los de escritorio y móvil.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE site_runs ADD COLUMN integral_pdf_bytes        bigint;
ALTER TABLE site_runs ADD COLUMN integral_pdf_pages        integer;
ALTER TABLE site_runs ADD COLUMN integral_pdf_generated_at timestamptz;

-- Down Migration

ALTER TABLE site_runs DROP COLUMN IF EXISTS integral_pdf_generated_at;
ALTER TABLE site_runs DROP COLUMN IF EXISTS integral_pdf_pages;
ALTER TABLE site_runs DROP COLUMN IF EXISTS integral_pdf_bytes;
DROP TABLE IF EXISTS analytics_breakdowns;
DROP TABLE IF EXISTS ga_daily;
DROP TABLE IF EXISTS gsc_daily;
DROP TABLE IF EXISTS analytics_site_runs;
DROP TABLE IF EXISTS analytics_runs;
DROP TYPE IF EXISTS source_status;
