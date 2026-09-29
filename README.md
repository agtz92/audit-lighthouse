# site-monitor

Audita todos los días una lista de sitios web, guarda dos PDFs por sitio y
registra métricas históricas en Postgres, con un dashboard para verlas. Todo
corre en Docker Compose en una Mac usada como servidor local.

Cada corrida, por sitio:

1. **Descubre las páginas** — sitemap declarado → `/sitemap.xml` → directiva
   `Sitemap:` de `robots.txt` → crawl de links internos → cosecha del DOM
   renderizado.
2. **Mide disponibilidad y velocidad** de cada página: status HTTP, cadena de
   redirecciones, TTFB, tiempo de carga, peso transferido y número de requests.
3. **Revisa el certificado TLS** del dominio.
4. **Genera dos PDFs**: `home.pdf` (solo la portada) y `full.pdf` (todas las
   páginas concatenadas con índice), comprimidos con Ghostscript.
5. **Mide rendimiento con Lighthouse** (escritorio y móvil) sobre la URL
   principal, en una segunda fase con la máquina en silencio.
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
| `worker` | Scheduler, auditorías y generación de PDFs | 2048 MB |
| `dashboard` | Next.js de solo lectura, publicado en la LAN | 640 MB |

El puerto de Postgres **no se publica**: el worker y el dashboard se hablan por
la red interna de Compose. Para conectarte con `psql` desde la Mac, descomenta el
bloque `ports` del servicio `db` en `docker-compose.yml` (usa 5434, porque 5432 y
5433 suelen estar ocupados).

---

## Agregar o quitar un sitio

Edita `sites.yaml`. **No hace falta reiniciar nada**: el archivo se lee completo
en cada corrida.

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
```

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

### Los dos PDFs

- **`home.pdf`** — solo la URL principal.
- **`full.pdf`** — todas las páginas auditadas, concatenadas, con un índice al
  inicio que lista cada URL y su número de página. Cada página lleva su URL de
  origen en el pie.

Ambos se generan en A4 con `printBackground` y CSS de pantalla (no de impresión),
para que el PDF se parezca al sitio y no a su versión imprimible.

Si el sitio tiene más URLs que `maxPages`, el índice lo dice explícitamente:
*"Documento truncado: el sitio declara 1257 URLs y el límite configurado es 50"*.
En el dashboard aparece la etiqueta `trunc` en la columna de páginas.

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
No hay histórico de PDFs más allá de los dos vigentes por sitio.

El esquema y el pipeline quedaron abiertos para agregar SEO on-page y detección
de cambios de contenido —hay columnas `extra jsonb` en `site_runs` y
`page_results`, y el orquestador itera sobre una lista de auditores— pero eso no
está construido.
