-- Up Migration

-- Selección manual de páginas: un sitio puede declarar en sites.yaml qué URLs
-- se auditan, en lugar de quedarse con las primeras que devuelva el sitemap.
-- Las primeras del sitemap son un accidente del orden del archivo; las que
-- elige una persona son las representativas del negocio.
ALTER TYPE discovery_method ADD VALUE IF NOT EXISTS 'manual' BEFORE 'sitemap';

-- El descubrimiento sigue corriendo incluso cuando la lista es manual, y aquí
-- queda el catálogo completo de URLs que el sitio ofrece. Sirve para dos cosas:
--   1. que el dashboard pueda presentar las opciones a elegir sin volver a
--      pedir el sitemap por la red;
--   2. que la lista se mantenga fresca: un sitio que publica páginas nuevas las
--      ofrece en la siguiente corrida, aunque su selección esté congelada.
-- Se guarda recortado (CANDIDATE_CAP en el worker), porque el catálogo completo
-- de un sitio de 348 URLs no aporta nada al que va a escoger cinco.
ALTER TABLE site_runs
  ADD COLUMN candidate_urls jsonb NOT NULL DEFAULT '[]';

COMMENT ON COLUMN site_runs.candidate_urls IS
  'Catálogo de URLs descubiertas (recortado), para poblar el selector de páginas del dashboard. No es lo que se auditó: eso es page_results.';

COMMENT ON COLUMN site_runs.discovery IS
  'Cómo se obtuvo la lista auditada. manual = la eligió una persona en sites.yaml; el resto son descubrimiento automático.';

COMMENT ON COLUMN site_runs.truncated IS
  'true si el sitio tiene más URLs que maxPages y la muestra quedó incompleta. Siempre false con discovery = manual: ahí la lista es deliberada, no un recorte.';

-- Down Migration

ALTER TABLE site_runs DROP COLUMN IF EXISTS candidate_urls;

-- Postgres no permite quitar un valor de un enum; 'manual' se queda. Igual que
-- en la migración de site_run_status, recrear el tipo y todas sus columnas no
-- vale la pena para una bajada que nadie va a correr.
