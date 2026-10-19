-- Up Migration

-- ─────────────────────────────────────────────────────────────────────────────
-- Google Ads, como tercera fuente del servicio analytics.
--
-- Vive junto a Search Console y GA4 y no en tablas de corrida propias: se
-- sincroniza a la misma hora, con el mismo candado y la misma cuenta de
-- servicio, y un sitio puede tener cualquier combinación de las tres fuentes.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE analytics_site_runs ADD COLUMN ads_customer_id text;
ALTER TABLE analytics_site_runs ADD COLUMN ads_status      source_status NOT NULL DEFAULT 'off';
ALTER TABLE analytics_site_runs ADD COLUMN ads_error       text;
ALTER TABLE analytics_site_runs ADD COLUMN ads_rows        integer       NOT NULL DEFAULT 0;
ALTER TABLE analytics_site_runs ADD COLUMN ads_latest_date date;
-- Moneda de la cuenta: los importes de Ads vienen en ella y no se convierten.
ALTER TABLE analytics_site_runs ADD COLUMN ads_currency    text;

-- Serie diaria por campaña. Por campaña y no por cuenta: así una campaña que
-- se pausa o una nueva se ven en la serie sin recalcular nada.
--
-- Igual que gsc_daily, no cuelga de una corrida. Se vuelven a pedir los últimos
-- ADS_REFRESH_DAYS en cada sincronización: Google Ads atribuye una conversión
-- al día del clic, y llega días o semanas después.
CREATE TABLE ads_daily (
  site_id           text          NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  date              date          NOT NULL,
  campaign_id       bigint        NOT NULL,
  campaign_name     text          NOT NULL,
  impressions       bigint        NOT NULL,
  clicks            bigint        NOT NULL,
  -- Millonésimas de la moneda de la cuenta, tal como las entrega Google: un
  -- entero exacto, sin redondeos acumulados al sumar meses.
  cost_micros       bigint        NOT NULL,
  conversions       numeric(14,2) NOT NULL,
  conversions_value numeric(16,2) NOT NULL,
  all_conversions   numeric(14,2) NOT NULL,
  PRIMARY KEY (site_id, date, campaign_id)
);

COMMENT ON TABLE ads_daily IS
  'Solo trae los días con actividad: una campaña sin impresiones ese día no tiene fila. CTR, CPC y CPA no se guardan; se calculan al sumar.';

-- Los desgloses (campañas, keywords, términos de búsqueda, anuncios...) van en
-- analytics_breakdowns con kind = ads_*, igual que los de GSC y GA4.

-- Down Migration

DROP TABLE IF EXISTS ads_daily;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_currency;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_latest_date;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_rows;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_error;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_status;
ALTER TABLE analytics_site_runs DROP COLUMN IF EXISTS ads_customer_id;
