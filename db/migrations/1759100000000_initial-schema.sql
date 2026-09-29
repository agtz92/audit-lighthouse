-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- sites: espejo de sites.yaml. Se sincroniza al inicio de cada corrida.
-- Un sitio que desaparece del YAML NO se borra: se le pone removed_from_yaml_at
-- para no perder su historial.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE sites (
  id                   text        PRIMARY KEY,
  name                 text        NOT NULL,
  url                  text        NOT NULL,
  enabled              boolean     NOT NULL DEFAULT true,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_in_yaml_at timestamptz NOT NULL DEFAULT now(),
  removed_from_yaml_at timestamptz
);

COMMENT ON COLUMN sites.id IS
  'Slug estable del YAML. Se usa como nombre de carpeta en data/pdfs y como llave de historial.';

-- ─────────────────────────────────────────────────────────────────────────────
-- runs: una fila por ejecución.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE run_trigger AS ENUM ('scheduled', 'manual', 'recovery');
CREATE TYPE run_status  AS ENUM ('running', 'ok', 'partial', 'failed');

CREATE TABLE runs (
  id              bigserial   PRIMARY KEY,
  trigger         run_trigger NOT NULL,
  status          run_status  NOT NULL DEFAULT 'running',
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  duration_ms     integer,
  sites_total     integer     NOT NULL DEFAULT 0,
  sites_ok        integer     NOT NULL DEFAULT 0,
  sites_failed    integer     NOT NULL DEFAULT 0,
  sites_skipped   integer     NOT NULL DEFAULT 0,
  budget_exceeded boolean     NOT NULL DEFAULT false,
  notes           text
);

CREATE INDEX runs_started_at_idx ON runs (started_at DESC);

COMMENT ON COLUMN runs.status IS
  'partial = la corrida terminó pero algún sitio falló o se quedó sin presupuesto de tiempo.';
COMMENT ON COLUMN runs.budget_exceeded IS
  'true si se agotó RUN_BUDGET_MINUTES y se abortó lo pendiente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- site_runs: resumen por sitio por corrida.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE site_run_status AS ENUM ('ok', 'partial', 'failed', 'skipped_timeout');

CREATE TYPE error_category AS ENUM (
  'timeout', 'dns', 'tls', 'http_4xx', 'http_5xx',
  'navigation', 'render', 'pdf', 'lighthouse', 'unknown'
);

CREATE TYPE discovery_method AS ENUM ('sitemap', 'robots', 'crawl', 'home_only', 'none');

CREATE TABLE site_runs (
  id                     bigserial       PRIMARY KEY,
  run_id                 bigint          NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  site_id                text            NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  status                 site_run_status NOT NULL,
  started_at             timestamptz     NOT NULL DEFAULT now(),
  finished_at            timestamptz,
  duration_ms            integer,

  discovery              discovery_method,
  pages_discovered       integer         NOT NULL DEFAULT 0,
  pages_audited          integer         NOT NULL DEFAULT 0,
  pages_failed           integer         NOT NULL DEFAULT 0,
  max_pages              integer,
  truncated              boolean         NOT NULL DEFAULT false,

  home_http_status       integer,

  home_pdf_bytes         bigint,
  home_pdf_pages         integer,
  home_pdf_generated_at  timestamptz,
  full_pdf_bytes         bigint,
  full_pdf_pages         integer,
  full_pdf_urls          integer,
  full_pdf_generated_at  timestamptz,

  cert_valid             boolean,
  cert_issuer            text,
  cert_valid_from        timestamptz,
  cert_valid_to          timestamptz,
  cert_days_remaining    integer,
  cert_error             text,

  error_category         error_category,
  error_message          text,

  -- Gancho de extensibilidad: auditores nuevos (SEO on-page, diffs de contenido)
  -- pueden dejar aquí su resumen sin migrar el esquema.
  extra                  jsonb           NOT NULL DEFAULT '{}',

  UNIQUE (run_id, site_id)
);

CREATE INDEX site_runs_site_started_idx ON site_runs (site_id, started_at DESC);
CREATE INDEX site_runs_run_idx          ON site_runs (run_id);

COMMENT ON COLUMN site_runs.truncated IS
  'true si el sitio tiene más URLs que maxPages y full.pdf quedó incompleto.';
COMMENT ON COLUMN site_runs.full_pdf_urls IS
  'URLs realmente incluidas en full.pdf (sin contar la página de índice).';

-- ─────────────────────────────────────────────────────────────────────────────
-- page_results: una fila por URL auditada. site_id va denormalizado a propósito:
-- las consultas del dashboard son todas "por sitio ordenado por fecha" y así se
-- evita el join con site_runs en el camino caliente.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE page_results (
  id             bigserial   PRIMARY KEY,
  site_run_id    bigint      NOT NULL REFERENCES site_runs (id) ON DELETE CASCADE,
  site_id        text        NOT NULL,
  url            text        NOT NULL,
  final_url      text,
  is_home        boolean     NOT NULL DEFAULT false,

  http_status    integer,
  redirect_chain jsonb       NOT NULL DEFAULT '[]',

  ttfb_ms        integer,
  load_ms        integer,
  dcl_ms         integer,
  transfer_bytes bigint,
  request_count  integer,

  ok             boolean     NOT NULL,
  error_category error_category,
  error_message  text,
  attempt_count  smallint    NOT NULL DEFAULT 1,
  degraded_wait  boolean     NOT NULL DEFAULT false,

  audited_at     timestamptz NOT NULL DEFAULT now(),

  -- Gancho para SEO on-page / hashes de contenido más adelante.
  extra          jsonb       NOT NULL DEFAULT '{}',

  UNIQUE (site_run_id, url)
);

CREATE INDEX page_results_site_audited_idx ON page_results (site_id, audited_at DESC);
CREATE INDEX page_results_site_run_idx     ON page_results (site_run_id);
CREATE INDEX page_results_failures_idx     ON page_results (site_id, audited_at DESC) WHERE NOT ok;

COMMENT ON COLUMN page_results.redirect_chain IS
  'Arreglo de {url, status} desde la URL pedida hasta la final.';
COMMENT ON COLUMN page_results.degraded_wait IS
  'true si waitUntil=networkidle no se alcanzó y se reintentó esperando solo load.';

-- ─────────────────────────────────────────────────────────────────────────────
-- lighthouse_results: solo la URL principal, una fila por estrategia.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE lh_strategy AS ENUM ('desktop', 'mobile');

CREATE TABLE lighthouse_results (
  id                 bigserial   PRIMARY KEY,
  site_run_id        bigint      NOT NULL REFERENCES site_runs (id) ON DELETE CASCADE,
  site_id            text        NOT NULL,
  url                text        NOT NULL,
  strategy           lh_strategy NOT NULL,

  performance        smallint,
  accessibility      smallint,
  best_practices     smallint,
  seo                smallint,

  lcp_ms             integer,
  cls                numeric(7,4),
  tbt_ms             integer,
  inp_ms             integer,
  fcp_ms             integer,
  speed_index_ms     integer,
  tti_ms             integer,

  lighthouse_version text,
  raw_report         bytea,
  raw_report_bytes   integer,

  ok                 boolean     NOT NULL,
  error_message      text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (site_run_id, strategy)
);

CREATE INDEX lighthouse_site_strategy_idx ON lighthouse_results (site_id, strategy, created_at DESC);

COMMENT ON COLUMN lighthouse_results.inp_ms IS
  'Siempre NULL: INP es métrica de campo (CrUX), no la produce una corrida de laboratorio. TBT hace de proxy.';
COMMENT ON COLUMN lighthouse_results.raw_report IS
  'Reporte JSON completo de Lighthouse comprimido con gzip (~50 KB en vez de ~600 KB).';
COMMENT ON COLUMN lighthouse_results.cls IS
  'Cumulative Layout Shift: adimensional, no milisegundos.';

-- Down Migration

DROP TABLE IF EXISTS lighthouse_results;
DROP TABLE IF EXISTS page_results;
DROP TABLE IF EXISTS site_runs;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS sites;
DROP TYPE IF EXISTS lh_strategy;
DROP TYPE IF EXISTS discovery_method;
DROP TYPE IF EXISTS error_category;
DROP TYPE IF EXISTS site_run_status;
DROP TYPE IF EXISTS run_status;
DROP TYPE IF EXISTS run_trigger;
