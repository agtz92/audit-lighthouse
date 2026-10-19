-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- Lo que Claude escribe sobre cada cuenta de Google Ads.
--
-- Los números de los informes salen del modelo con reglas (report/ads-model.ts)
-- y no se guardan aquí: esto es solo el texto —la interpretación, las acciones,
-- el baseline— para mostrarlo en el dashboard sin volver a pagar por él.
-- ─────────────────────────────────────────────────────────────────────────────

-- Contexto vivo de cada cuenta. `profile` lo escribe una persona (qué vende el
-- negocio, qué cuenta como conversión buena, qué no tocar); `baseline` lo
-- reescribe Claude con cada análisis semanal, a partir del anterior.
CREATE TABLE ads_context (
  site_id             text        PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
  profile             text        NOT NULL DEFAULT '',
  baseline            text,
  baseline_updated_at timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- weekly  = análisis semanal (qué mejoró, qué empeoró, alertas, acciones)
-- cliente = texto del informe para el dueño del negocio
-- admin   = texto del informe para quien administra la cuenta
CREATE TYPE ads_note_kind AS ENUM ('weekly', 'cliente', 'admin');

CREATE TABLE ads_notes (
  id            bigserial     PRIMARY KEY,
  site_id       text          NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  kind          ads_note_kind NOT NULL,
  period_start  date          NOT NULL,
  period_end    date          NOT NULL,
  created_at    timestamptz   NOT NULL DEFAULT now(),
  -- El modelo que respondió: con un fallback puede no ser el que se pidió.
  model         text          NOT NULL,
  content       jsonb         NOT NULL,
  input_tokens  integer,
  output_tokens integer
);

CREATE INDEX ads_notes_site_idx ON ads_notes (site_id, kind, created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS ads_notes;
DROP TYPE IF EXISTS ads_note_kind;
DROP TABLE IF EXISTS ads_context;
