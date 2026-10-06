# Despliegue a producción

Topología: un único VPS (x86, DC en UE) con Docker y **OpenShip** como plataforma
de despliegue (build, push-to-deploy, dominios, TLS, variables por entorno,
previews, métricas). Los archivos van a Cloudflare R2 (contrato S3) y los backups
de la base de datos también (off-box, servicio propio del stack).

```
internet ── edge OpenResty de OpenShip (80/443, TLS automático)
              ├─ portal   (platform, TanStack Start SSR)
              ├─ panel    (panel, TanStack Start SSR)
              └─ api      (Hono + SSE)
             worker (proceso aparte, misma imagen; consume PGMQ)
             postgres 18 + PGMQ + pg_cron (volumen local; NO el Postgres one-click)
             backup (pg_dump diario → R2, retención configurable)
```

## Artefactos

- `Dockerfile` (raíz): imagen única multi-etapa; los cuatro servicios comparten
  build y difieren en el comando. OpenShip la construye en el servidor.
- `infra/prod/compose.yaml`: stack desplegado "as-is" por OpenShip. Los servicios
  web/api publican en `127.0.0.1` para que el edge les enrute dominios; no hay
  borde propio (Caddy eliminado: el edge de OpenShip ocupa 80/443).
- `infra/prod/.env.example`: contrato de variables (se cargan por entorno en la
  UI de OpenShip).
- `infra/prod/backup/`: volcado diario a R2 con retención.
- `.github/workflows/ci.yml`: typecheck + tests + verificación de que el
  Dockerfile construye (sin push; el build real lo hace OpenShip).

## Puesta en marcha del VPS (una vez)

1. VPS con Ubuntu 24.04 y Docker. DNS: registros A del dominio del panel de
   OpenShip y de los dominios de la app al VPS.
2. Instalar OpenShip (modo compose, Linux + Docker):

   ```bash
   curl -fsSL https://get.openship.io | sh
   openship up --public-url https://ops.example.com
   ```


3. En el dashboard: conectar el repo de GitHub y crear el proyecto con el
   compose `infra/prod/compose.yaml`. Asignar dominios: portal → `platform`,
   `app.<dominio>` → `panel`, `api.<dominio>` → `api`.
4. Cargar las variables del entorno *production* desde `.env.example`
   (secretos con `openssl rand -hex 32`; credenciales R2; SMTP real).
   `VITE_API_URL` y `VITE_BASE_DOMAIN` son build-args del Dockerfile: deben
   estar definidas en el entorno para que el build las incruste.
5. Activar push-to-deploy (webhook de GitHub que configura OpenShip) sobre
   `main`.

## Entornos y previews

- **Staging**: segundo entorno del proyecto en OpenShip apuntando a la rama
  `staging`, con sus propias variables (dominios `*-staging`, buckets R2
  `*-staging`). Solo datos de semilla (`seed-dev.ts`), nunca copia de
  producción (RGPD).
- **Previews por PR/rama**: nativos en OpenShip; activarlos en el proyecto.
  Mismas reglas: datos de semilla, variables de preview aisladas.

## Operación

- Deploy: push a `main` (o rama del entorno). Rollback: un clic en el dashboard
  (re-ejecuta el snapshot exacto del build).
- Logs y métricas de contenedores: dashboard de OpenShip.
- Backup de la app: diario, conserva `BACKUP_RETAIN` dumps en el bucket.
  Restaurar: `pg_restore --clean --no-owner -d "$DATABASE_URL" pg-<ts>.dump`.
- Migraciones: el servicio `migrate` corre en cada `compose up`, antes de api
  y worker.

## Riesgos aceptados y mitigaciones

- **OpenShip es joven (jul 2026) y sus docs están en construcción.** Mitigación:
  los dumps a R2 son la salida de emergencia; el stack es Docker Compose
  estándar y portable a otro orquestador (Komodo/Coolify/manual) sin cambios.
  Aspectos no verificados por documentación incompleta — confirmar en la UI al
  montar: sintaxis exacta de asignación de dominios a servicios compose, y
  cómo se inyectan variables de entorno en builds.
- **MCP/agentes**: el endpoint MCP permite a agentes IA desplegar y operar.
  Política: solo lectura o staging; nunca deploy/rollback/secretos de
  producción sin aprobación humana (invariante del repo).
- **Correo**: se usa SMTP transaccional externo; el servidor de correo
  integrado de OpenShip queda desactivado (reputación de IP de VPS = spam).
- La imagen incluye devDeps de api/worker (tsx ejecuta TS en runtime; las
  dependencias workspace exportan fuente TS). Deliberado.
- Un solo nodo: si el VPS cae, cae todo. E2E no corre en CI (supervisor
  Windows); ejecutarlo local.
## Particularidades de OpenShip (verificadas en 0.8.0)

- Los `build.context` del compose se resuelven desde la **raíz del repo**,
  no desde el directorio del compose. `../..` falla con *path escapes the
  linked repository*: usar rutas como `infra/dev/postgres` o `.` (raíz).
- El `composePath` del proyecto (`infra/prod/compose.yaml`) no se fija desde
  el CLI `project create`; se establece con
  `openship api /projects/<id> -X PATCH -d '{"composePath":"..."}'`.
- `service sync` materializa el `.env` local como variables por servicio que
  **eclipsan** las del proyecto: tras sincronizar, cargar los valores reales
  en cada servicio (`service env set -p <slug> -e production <svc> ...`).
- Los builds de la imagen comparten caché de capas entre servicios y deploys.
