# Build en varias etapas para que la imagen final no cargue con node_modules de
# desarrollo ni con el código fuente: Next produce un bundle "standalone" que
# trae solo lo que el servidor necesita.

FROM node:22-alpine AS deps
WORKDIR /app
COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY dashboard/ ./
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

# tzdata para que las fechas se rendericen en hora de Ciudad de México dentro del
# contenedor; sin él, Alpine solo conoce UTC.
RUN apk add --no-cache tzdata

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    TZ=America/Mexico_City \
    PORT=3000 \
    # Next escucha en localhost por default: sin esto el puerto publicado no
    # responde desde la LAN, solo desde dentro del contenedor.
    HOSTNAME=0.0.0.0

COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
