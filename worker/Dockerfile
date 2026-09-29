# La imagen oficial de Playwright ya trae Chromium compilado para arm64 con
# todas sus librerías de sistema. La etiqueta debe coincidir exactamente con la
# versión del paquete playwright en package.json, o el navegador no se encuentra.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    TZ=America/Mexico_City \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

WORKDIR /app

# Ghostscript comprime los PDFs finales: deduplica las fuentes e imágenes que
# Chromium repite en cada página concatenada y submuestrea las imágenes. Sin esto
# un full.pdf de 26 páginas web pesa 64 MB.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ghostscript \
 && rm -rf /var/lib/apt/lists/*

# Deja constancia en el log de build de con qué Node y Ghostscript se construye.
RUN node --version && npm --version && gs --version

# Las dependencias en su propia capa: cambiar código fuente no reinstala nada.
COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker \
 && npm ci --include=dev \
 && npm cache clean --force

# Las migraciones viven en la raíz del repo, fuera de worker/.
COPY db ./db
COPY worker ./worker

WORKDIR /app/worker

# PDF_DIR se monta como volumen; lo creamos para que exista aunque no haya bind.
RUN mkdir -p /data/pdfs

CMD ["npm", "run", "start"]
