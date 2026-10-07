# site-monitor

Audita todos los días una lista de sitios web, guarda sus informes en PDF y
registra métricas históricas en Postgres, con un dashboard para verlas. Si un
sitio tiene Search Console o Google Analytics 4 conectados, además sincroniza su
tráfico en un proceso aparte y genera un informe de tráfico y uno integral. Todo
corre en Docker Compose en una Mac usada como servidor local.

Cada corrida, por sitio:

1. **Descubre las páginas** — sitemap declarado → `/sitemap.xml` → directiva
   `Sitemap:` de `robots.txt` → crawl de links internos → cosecha del DOM
   renderizado.
2. **Mide disponibilidad y velocidad** de cada página: status HTTP, cadena de
   redirecciones, TTFB, tiempo de carga, peso transferido y número de requests.
3. **Revisa el certificado TLS** del dominio.
4. **Mide rendimiento con Lighthouse** (escritorio y móvil) sobre la URL
   principal, en una segunda fase con la máquina en silencio.
5. **Genera los informes**: `desktop.pdf` y `mobile.pdf`, y `integral.pdf` si el
   sitio tiene Search Console o GA4 conectados. Se comprimen con Ghostscript.
6. **Purga** lo que tenga más de 90 días y manda un webhook si está configurado.

---

## Levantarlo

```bash
cp .env.example .env
# Edita .env y cambia POSTGRES_PASSWORD
docker compose up -d
```

Eso deja los tres servicios corriendo y la corrida diaria programada a las
**06:00 hora de Ciudad de México**. El dashboard queda en
`http://<ip-de-tu-mac>:8480`.

| Servicio | Qué hace | Memoria |
|---|---|---|
| `db` | Postgres 17 con volumen persistente | 384 MB |
| `worker` | Scheduler, auditorías y generación de PDFs | 2432 MB |
| `analytics` | Sincroniza Search Console y GA4 a las 05:00 e imprime `analitica.pdf` | 768 MB |
| `dashboard` | Next.js, publicado en la LAN | 320 MB |

El puerto de Postgres **no se publica**: el worker y el dashboard se hablan por
la red interna de Compose. Para conectarte con `psql` desde la Mac, descomenta el
bloque `ports` del servicio `db` en `docker-compose.yml` (usa 5434, porque 5432 y
5433 suelen estar ocupados).

---

## Administrar los sitios

Desde el dashboard, en **Sitios**: agregar, quitar, pausar, y entrando a cada uno
editar sus datos y elegir qué páginas se auditan. Todo se escribe en
`config/sites.yaml`, que también puedes editar a mano. **No hace falta reiniciar
nada**: el archivo se lee completo en cada corrida.

```yaml
sites:
  - id: mi-sitio            # slug estable: nombre de carpeta de PDFs y llave de historial
    name: Mi Sitio
    url: https://www.misitio.com
    sitemap: https://www.misitio.com/sitemap.xml   # opcional; si falta, se descubre
    enabled: true
    maxPages: 50            # opcional, sobrescribe defaults
    exclude:                # opcional: subcadenas de URL a ignorar
      - "/blog/tag/"
    pages:                  # opcional: las páginas a auditar, elegidas a mano
      - https://www.misitio.com/productos
```

Vive en su propio directorio, y no suelto en la raíz, porque el dashboard lo
reescribe de forma atómica (temporal + `rename`) y `rename` sobre un bind mount
de archivo devuelve `EBUSY`: hay que montar el directorio. `config/` es además lo
único que el dashboard puede escribir.

### Auditar un sitio ahora

El botón **Auditar ahora**, en la lista de sitios y en la pantalla de cada uno,
corre ese sitio en el momento sin esperar a las 06:00. El worker hace una
auditoría a la vez: si ya hay una en curso lo dice y no la encima.

El dashboard no audita —no tiene Chromium ni escribe en la base—; se lo pide al
worker por un endpoint de control en la red interna de Compose. Ese puerto se
declara con `expose` y **no** se publica al host, así que solo lo alcanza el
dashboard. Equivale a `npm run check -- --site=mi-sitio`, pero desde la pantalla.

### Elegir las páginas que se auditan

Sin `pages`, cada sitio audita las primeras `maxPages` URLs de su sitemap, que es
el orden del archivo y no una decisión. Con `pages`, se auditan esas —con la URL
principal siempre incluida, porque es la única que recibe Lighthouse—. El
descubrimiento sigue corriendo para mantener al día el catálogo de opciones que
ofrece el dashboard, así que una página nueva del sitio aparece como opción al
día siguiente aunque la selección esté fija.

El `id` es permanente: cambiarlo equivale a crear un sitio nuevo y perder su
historial. El YAML se valida con Zod y es estricto con las llaves desconocidas —
si escribes `sitmap:` en lugar de `sitemap:`, la corrida falla diciéndote
exactamente dónde, en vez de ignorarlo en silencio.

Un sitio que borres del YAML **no se borra de la base**: se marca con
`removed_from_yaml_at` y conserva su historial. Si lo devuelves, la marca se
limpia sola.

Valida un cambio sin correr una auditoría completa:

```bash
docker compose exec worker npm run check -- --site=mi-sitio --dry-run
```

---

## Search Console y GA4

Cada sitio puede conectarse a su propiedad de **Google Search Console** (clics,
impresiones, CTR, posición, consultas y páginas) y a la de **Google Analytics 4**
(sesiones, usuarios, interacción, canales, dispositivos, páginas de entrada y
eventos clave). Las dos son opcionales e independientes: un sitio sin conexión
se sigue auditando con Lighthouse como siempre.

Es un **proceso aparte** de la auditoría: el servicio `analytics`, con su propio
cron (`ANALYTICS_CRON`, por default **05:00**), su propio candado y su propio
historial de corridas. Corre una hora antes que Lighthouse a propósito: el
informe integral se arma al terminar la auditoría y tiene que encontrar el
tráfico ya sincronizado.

### Configurar la cuenta de servicio (una sola vez)

1. En [Google Cloud](https://console.cloud.google.com/) crea un proyecto (o usa
   uno) y en **APIs y servicios › Biblioteca** habilita:
   - Google Search Console API
   - Google Analytics Data API
   - Google Analytics Admin API (para listar propiedades y eventos clave)
2. En **IAM › Cuentas de servicio** crea una cuenta, sin roles. En su pestaña
   **Claves**, agrega una clave JSON y descárgala.
3. Guárdala como `secrets/google-sa.json` y reinicia el servicio:

   ```bash
   docker compose up -d analytics
   ```

La llave solo se monta en el contenedor `analytics`: ni el worker ni el
dashboard la ven. `secrets/` está en `.gitignore` y en `.dockerignore`.

Cuenta de servicio y no OAuth: el dashboard vive en la LAN sin HTTPS, y Google
no acepta una IP privada como destino de regreso de OAuth. Con una cuenta de
servicio no hay consentimientos que caduquen.

### Conectar un sitio

En **Sitios › nombre del sitio › Search Console y Google Analytics**:

1. Copia el correo de la cuenta de servicio que muestra la pantalla y agrégalo
   como usuario **de lectura**:
   - Search Console: Configuración › Usuarios y permisos › Agregar usuario, permiso *Restringido*.
   - GA4: Administrar › Acceso a la propiedad › Agregar usuario, rol *Lector*.
2. Escribe (o elige de la lista) la propiedad de Search Console —de dominio,
   `sc-domain:ejemplo.com`, o de prefijo de URL con su diagonal final— y el id
   numérico de la propiedad de GA4 (Administrar › Detalles de la propiedad; **no**
   es el `G-XXXX`).
3. **Probar conexión** prueba lo escrito sin guardarlo: dice si hay acceso, hasta
   qué día hay datos y qué **eventos clave** tiene definidos la propiedad.
4. **Guardar** lo escribe en `sites.yaml`:

   ```yaml
   google:
     searchConsole: sc-domain:matmarkt.mx
     ga4Property: "345678901"
   ```

5. **Sincronizar ahora** trae su historia sin esperar a las 05:00.

### Qué sincroniza

- **Series diarias** de cada fuente. La primera vez carga 16 meses hacia atrás
  (`ANALYTICS_BACKFILL_DAYS`, lo más que guarda Search Console); después pide
  desde el último día guardado, pero nunca menos de los últimos
  `ANALYTICS_REFRESH_DAYS` (5), porque Google sigue ajustando esos días.
- **Desgloses** de cuatro periodos —últimos 28 días, los 28 anteriores, el último
  mes calendario y el anterior—: consultas, páginas, canales, dispositivos,
  páginas de entrada, eventos clave y totales.

Search Console publica con **2 a 3 días de retraso**. Por eso los periodos de 28
días se anclan en el último día publicado y no en ayer: con ayer, los últimos
días saldrían en cero y toda comparación caería.

Si una fuente falla —permisos, una API sin habilitar— la otra se guarda igual,
el sitio queda `partial` y el motivo, ya traducido a qué hacer, aparece en el
dashboard.

### Monitorear

- **Tráfico** (pestaña nueva): todos los sitios conectados con clics, tendencia,
  impresiones, CTR, posición, sesiones, interacción, eventos clave y el
  rendimiento móvil de Lighthouse, contra el periodo anterior. 28 días, 90 días
  o 12 meses. Una fila en rojo es una caída de clics de `TRAFFIC_DROP_THRESHOLD`
  (20%) o más.
- **Sitio › Búsqueda y tráfico**: una gráfica por métrica con el periodo actual
  contra el anterior día a día, consultas principales, y las **páginas con
  tráfico cruzadas con la auditoría de hoy**: una página que recibe visitas y
  responde 404 o tarda más de 4 s sale marcada.
- **Corridas** muestra las sincronizaciones junto a las auditorías, filtrables.

Correrla a mano:

```bash
docker compose exec analytics npm run analytics:sync                    # todos
docker compose exec analytics npm run analytics:sync -- --site=matmarkt # uno
docker compose exec analytics npm run analytics:sync -- --dry-run       # sin escribir
```

### Informes

- **`analitica.pdf`**: búsqueda y tráfico. Lo imprime el servicio `analytics` al
  terminar de sincronizar.
- **`integral.pdf`**: rendimiento y tráfico juntos. Abre con un resumen ejecutivo
  que cruza las dos miradas, sigue con el diagnóstico de móvil y escritorio, las
  hojas de tráfico y la disponibilidad por página. Lo imprime el worker al
  terminar Lighthouse, con el tráfico que ya está en la base.

Los dos llevan el mismo membrete que los informes de Lighthouse (sale de
`worker/src/report/brand.ts`, compartido por los cuatro). Cubren el periodo de
`REPORT_PERIOD`: `month` (default) es el último mes calendario completo contra el
anterior, que es lo que se entrega a un cliente; `28d` son los últimos 28 días.
Durante los primeros días de cada mes Search Console todavía no publica el final
del mes anterior, y el informe lo dice.

Si el worker está auditando cuando el servicio `analytics` termina de
sincronizar, los PDFs de tráfico esperan a que acabe: los dos Chromium juntos no
caben en la memoria de Docker. Los datos se guardan sin esperar.

---

## Correr una auditoría manual

```bash
docker compose exec worker npm run check                    # todos los habilitados
docker compose exec worker npm run check -- --site=matmarkt # uno solo
docker compose exec worker npm run check -- --dry-run       # sin tocar BD ni PDFs
```

El código de salida es 0 si la corrida terminó completa y 1 si quedó parcial o
falló, por si lo quieres encadenar en un script.

Ver los logs en vivo (salen en JSON, una línea por evento):

```bash
docker compose logs -f worker
```

Cada línea lleva `run_id`, así que puedes reconstruir una corrida completa:

```bash
docker compose logs worker | grep '"run_id":42'
```

---

## Respaldar

**Base de datos** — un volcado comprimido:

```bash
docker compose exec -T db pg_dump -U sitemon -Fc sitemon > sitemon-$(date +%F).dump
```

Restaurarlo:

```bash
docker compose exec -T db pg_restore -U sitemon -d sitemon --clean < sitemon-2026-09-29.dump
```

**PDFs** — viven en `./data/pdfs/<site-id>/`, son solo dos archivos por sitio:

```bash
tar czf pdfs-$(date +%F).tar.gz data/pdfs
```

No hay histórico de PDFs por diseño: cada corrida reemplaza los del día anterior.
Si quieres conservar una foto de un día, respáldalos ese día.

---

## Cómo leer cada métrica

### Disponibilidad

| Métrica | Qué significa | Cuándo preocuparte |
|---|---|---|
| **HTTP** | Status de la URL principal tras seguir redirecciones | Cualquier 4xx o 5xx. La fila se pinta de rojo |
| **Redirecciones** | Saltos antes de llegar al destino | Más de 1 en la home: cada salto suma latencia |
| **TTFB** | Time To First Byte: cuánto tarda el servidor en responder | Arriba de 600 ms el servidor está lento, no la página |
| **Tiempo de carga** | Hasta el evento `load` del navegador | Es contexto; los umbrales reales son LCP y CLS |
| **Peso transferido** | Bytes que viajaron por el cable, medido por CDP | Arriba de 2-3 MB en móvil duele |
| **Certificado** | Días hasta que vence | Menos de 21 días dispara la bandera del webhook |

### Lighthouse

Los cuatro scores van de 0 a 100. El dashboard los colorea: **≥90 verde**,
**50-89 neutro**, **<50 rojo**.

| Métrica | Qué mide | Bien | Mal |
|---|---|---|---|
| **Performance** | Qué tan rápido se siente cargar | ≥90 | <50 |
| **Accesibilidad** | Contraste, etiquetas, navegación por teclado | ≥90 | <90 ya es deuda |
| **Buenas prácticas** | HTTPS, errores de consola, APIs obsoletas | 100 | <90 |
| **SEO** | Metadatos, enlaces rastreables, responsive | ≥90 | <90 |
| **LCP** | Cuándo aparece el elemento más grande | <2.5 s | >4 s |
| **CLS** | Cuánto se mueve el contenido al cargar. **Adimensional, no son milisegundos** | <0.1 | >0.25 |
| **TBT** | Tiempo que el hilo principal estuvo bloqueado | <200 ms | >600 ms |
| **INP** | **Siempre vacío.** Ver abajo | — | — |

**Por qué INP está siempre en NULL.** INP (Interaction to Next Paint) es una
métrica de *campo*: se calcula con interacciones de usuarios reales y solo existe
en datos de CrUX. Una corrida de laboratorio como esta no la puede producir. La
columna está en el esquema para no migrar después, pero nunca se llena. **TBT
hace de proxy**: mide lo mismo —el hilo principal bloqueado— desde el lado del
laboratorio.

**Sobre la comparabilidad de los scores.** Lighthouse corre en una segunda fase,
de uno en uno y cuando ningún otro sitio está siendo auditado. No es un detalle
de implementación: medido en este proyecto, el mismo sitio dio **performance 96**
aislado y **49** mientras otro sitio crawleaba y Ghostscript comprimía en
paralelo. Si subes `CONCURRENCY` o `LIGHTHOUSE_CONCURRENCY`, los scores dejan de
ser comparables entre días.

Aun así, esperar variación de 1-3 puntos entre corridas idénticas es normal. Por
eso la bandera `performanceDropped` del webhook exige una caída **mayor** a 10
puntos: con un umbral más apretado avisaría por ruido.

### Los PDFs

Viven en `data/pdfs/<site-id>/`, uno vigente de cada tipo:

- **`desktop.pdf`** y **`mobile.pdf`**: el informe de rendimiento de cada
  estrategia, con conclusión, calificaciones, Core Web Vitals, prioridades,
  oportunidades, hallazgos y disponibilidad por página.
- **`analitica.pdf`**: búsqueda y tráfico, solo para sitios con Search Console o
  GA4 conectados. Ver [Search Console y GA4](#search-console-y-ga4).
- **`integral.pdf`**: los dos anteriores juntos, con un resumen ejecutivo propio.

Se generan en A4 desde plantillas propias, con las fuentes embebidas, y la
numeración de hojas la pone Chromium en el pie.

**La escritura es atómica.** Se escribe a `.tmp` y se renombra solo al terminar
bien, así que si una corrida falla **los PDFs del día anterior quedan intactos**.
Nunca te quedas sin PDF por un error de red.

Los PDFs se comprimen con Ghostscript (`PDF_QUALITY`, default `ebook`). El texto
sigue siendo texto seleccionable; solo bajan de resolución las imágenes. En la
práctica un `full.pdf` pasa de ~60 MB a ~6 MB, porque Chromium repite las fuentes
y las imágenes en cada página y Ghostscript las deduplica.

### Estados

| Estado | Qué pasó |
|---|---|
| **En línea** (`ok`) | Todo respondió |
| **Parcial** (`partial`) | La home respondió pero algunas páginas fallaron, o se agotó el tiempo |
| **Caído** (`failed`) | La URL principal no respondió |
| **Sin medir** (`skipped_timeout`) | La corrida agotó su presupuesto antes de llegar a este sitio |

Un sitio `partial` cuenta como "en línea" en los totales: respondió y dejó datos.
Lo que distingue a `failed` es que el sitio esté realmente caído.

---

## Webhook

Opcional. Define `WEBHOOK_URL` en `.env` y al final de cada corrida se manda un
`POST` con JSON: resumen de la corrida y, por sitio, su estado, status HTTP,
scores de Lighthouse de escritorio y móvil, deltas contra la corrida anterior y
tres banderas:

- `isDown` — la home no respondió o devolvió 4xx/5xx
- `performanceDropped` — el performance cayó más de `PERF_DROP_THRESHOLD` puntos
- `certExpiringSoon` — al certificado le quedan menos de `CERT_EXPIRY_WARN_DAYS` días

Tres intentos con backoff exponencial (1 s, 2 s, 4 s) y timeout de 10 s. Un 4xx
no se reintenta: el payload o la URL están mal y repetir no ayuda. **Una falla del
webhook nunca marca la corrida como fallida.**

Probarlo con la última corrida real:

```bash
docker compose exec worker npm run webhook:test
```

Al terminar cada sincronización de tráfico llega otro `POST` al mismo destino,
con `event: "analytics.finished"` (también en el encabezado
`x-site-monitor-event`). Por sitio trae el estado de cada fuente, clics y
sesiones de los últimos 28 días contra los 28 anteriores y dos banderas:

- `trafficDropped`: los clics cayeron `TRAFFIC_DROP_THRESHOLD`% o más
- `accessLost`: una fuente falló por algo que no se arregla solo, como un
  permiso perdido, una propiedad que no existe o una API deshabilitada

---

## Operación

**Recuperación al arrancar.** Si el worker arranca y hoy ya pasaron las 6am sin
una corrida exitosa, lanza una de inmediato. Desactívalo con
`RECOVERY_RUN_ON_BOOT=false`.

**Presupuesto de tiempo.** `RUN_BUDGET_MINUTES` (default 45). Al agotarse no se
empiezan sitios nuevos; los que quedaron fuera se registran como
`skipped_timeout` y la corrida queda `partial`. Los que estaban a medias terminan
la página en curso para no guardar mediciones truncadas.

**Retención.** 90 días por default. Al final de cada corrida se borran las
corridas más viejas en una transacción; el `ON DELETE CASCADE` arrastra sus
páginas y resultados de Lighthouse. Queda registrado en el log.

**Concurrencia.** `CONCURRENCY=2` sitios en paralelo y `PAGE_CONCURRENCY=3`
páginas por sitio. Con 3.8 GB asignados a Docker eso deja ~2.3 GB de uso pico.
Si le das más memoria a Docker Desktop puedes subirlo — pero **no subas
`LIGHTHOUSE_CONCURRENCY`** sin leer la nota de comparabilidad de arriba.

---

## Desarrollo

```bash
cd worker && npm install && npm test && npm run typecheck
cd dashboard && npm install && npm run typecheck
```

Los tests del worker usan el runner integrado de Node (`node:test`), sin
dependencias extra. Cubren el parser de sitemaps, el validador del YAML, la
concatenación de PDFs y el cálculo de deltas.

Las migraciones son SQL plano en `db/migrations/`, aplicadas con `node-pg-migrate`
al arrancar el worker (toma un advisory lock, así que dos procesos no se pisan).

### Notas de implementación que no son obvias

- **Chromium completo, no headless-shell.** `browser.ts` fuerza
  `channel: 'chromium'`. Playwright 1.49+ usa por default el binario
  `chromium-headless-shell`, que **no emite Largest Contentful Paint**: Lighthouse
  devuelve `NO_LCP` y se caen en silencio performance, TBT y TTI, mientras
  accessibility, best-practices y SEO siguen saliendo bien. Es un fallo parcial
  que parece funcionar.
- **El peso se mide por CDP, no por la Performance API.** `transferSize` del
  navegador devuelve 0 para recursos cross-origin sin `Timing-Allow-Origin`, que
  con CDN y fuentes externas son la mayoría.
- **El PDF se imprime en la misma visita que la medición**, vía un hook del
  auditor. Cargar cada página dos veces duplicaría el costo de la corrida.
- **`networkidle` tiene reintento degradado.** Si un sitio con analítica que hace
  polling nunca queda idle, el segundo intento espera solo `load` y la página se
  marca con `degraded_wait`, para distinguir "lento" de "nunca se calla".

---

## Fuera de alcance

No hay autenticación, usuarios ni HTTPS: el dashboard asume una red local de
confianza. No hay notificaciones por email ni Slack, solo el webhook genérico.
No hay histórico de PDFs más allá de los vigentes por sitio.

El esquema y el pipeline quedaron abiertos para agregar SEO on-page y detección
de cambios de contenido —hay columnas `extra jsonb` en `site_runs` y
`page_results`, y el orquestador itera sobre una lista de auditores— pero eso no
está construido.
