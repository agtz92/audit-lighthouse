-- Up Migration

-- Los dos PDFs por sitio dejan de ser capturas del sitio (portada y páginas
-- concatenadas) y pasan a ser los reportes de Lighthouse, uno por estrategia.
-- Se renombran las columnas en vez de reutilizarlas con otro significado: una
-- columna llamada home_pdf_bytes que guarda el peso de un reporte de escritorio
-- es una trampa para quien lea el esquema dentro de seis meses.
ALTER TABLE site_runs RENAME COLUMN home_pdf_bytes        TO desktop_pdf_bytes;
ALTER TABLE site_runs RENAME COLUMN home_pdf_pages        TO desktop_pdf_pages;
ALTER TABLE site_runs RENAME COLUMN home_pdf_generated_at TO desktop_pdf_generated_at;
ALTER TABLE site_runs RENAME COLUMN full_pdf_bytes        TO mobile_pdf_bytes;
ALTER TABLE site_runs RENAME COLUMN full_pdf_pages        TO mobile_pdf_pages;
ALTER TABLE site_runs RENAME COLUMN full_pdf_generated_at TO mobile_pdf_generated_at;

-- full_pdf_urls contaba cuántas páginas del sitio entraron al PDF concatenado.
-- Ya no existe ese documento, y el dato equivalente vive en pages_audited.
ALTER TABLE site_runs DROP COLUMN full_pdf_urls;

COMMENT ON COLUMN site_runs.desktop_pdf_pages IS
  'Hojas del reporte de Lighthouse de escritorio impreso a PDF.';
COMMENT ON COLUMN site_runs.mobile_pdf_pages IS
  'Hojas del reporte de Lighthouse móvil impreso a PDF.';

-- Los archivos viejos (home.pdf y full.pdf) quedan huérfanos en el volumen.
-- No se borran desde aquí: una migración no debe tocar el sistema de archivos.
-- Se limpian con:  rm -f data/pdfs/*/home.pdf data/pdfs/*/full.pdf

-- Down Migration

ALTER TABLE site_runs ADD COLUMN full_pdf_urls integer;
ALTER TABLE site_runs RENAME COLUMN desktop_pdf_bytes        TO home_pdf_bytes;
ALTER TABLE site_runs RENAME COLUMN desktop_pdf_pages        TO home_pdf_pages;
ALTER TABLE site_runs RENAME COLUMN desktop_pdf_generated_at TO home_pdf_generated_at;
ALTER TABLE site_runs RENAME COLUMN mobile_pdf_bytes         TO full_pdf_bytes;
ALTER TABLE site_runs RENAME COLUMN mobile_pdf_pages         TO full_pdf_pages;
ALTER TABLE site_runs RENAME COLUMN mobile_pdf_generated_at  TO full_pdf_generated_at;
