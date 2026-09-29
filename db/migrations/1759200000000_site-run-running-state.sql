-- Up Migration

-- Un site_run se inserta en cuanto arranca, porque page_results apunta a él por
-- llave foránea y las páginas se escriben conforme se miden. Necesita entonces
-- un estado inicial honesto: 'running', igual que ya tiene runs.status.
ALTER TYPE site_run_status ADD VALUE IF NOT EXISTS 'running' BEFORE 'ok';

-- Un sitio 'partial' respondió y dejó datos, pero algo salió mal (páginas
-- sueltas con error, o se agotó el presupuesto de tiempo). Cuenta en sites_ok
-- porque su URL principal sí respondió; lo que distingue a sites_failed es que
-- el sitio esté realmente caído. Así sites_total = ok + failed + skipped.
COMMENT ON COLUMN runs.sites_ok IS
  'Sitios cuya URL principal respondió, incluyendo los que quedaron en partial.';
COMMENT ON COLUMN runs.sites_failed IS
  'Sitios cuya URL principal no respondió o no llegó a medirse.';
COMMENT ON COLUMN runs.sites_skipped IS
  'Sitios que nunca arrancaron porque se agotó RUN_BUDGET_MINUTES.';

-- Down Migration

-- Postgres no permite quitar un valor de un enum. Revertir esto exigiría
-- recrear el tipo y todas las columnas que lo usan; para una migración que solo
-- agrega un estado no vale la pena. La bajada se deja como no-op deliberado.
SELECT 1;
