# Despliegue a producción

El VPS es compartido y OpenShip administra sus aplicaciones y el borde HTTPS.
odentIA es un proyecto, no el propietario del servidor. PostgreSQL de odentIA
no se comparte con OpenShip ni con las demás aplicaciones.

## Contrato de ejecución

- `compose.prod.yaml`, en la raíz del repositorio, usa rutas estándar de Docker
  Compose. Los servicios con `build` no declaran `image`: OpenShip construye sus
  artefactos y un refresh reutiliza los del despliegue anterior. No requiere GHCR.
- `Dockerfile` es la receta compartida de las aplicaciones. OpenShip construye un
  artefacto por servicio, secuencialmente, con caché de capas. No implica una única
  invocación de build ni que cada contenedor ocupe el tamaño completo de la imagen.
- PostgreSQL 18 lleva PGMQ y pg_cron mediante `infra/dev/postgres/Dockerfile`.
  Cambiarlo por una imagen stock sin esas extensiones no es una sustitución válida.
- `migrate` termina después de aplicar las migraciones; detenido con código cero
  es su estado normal. API y worker dependen de su finalización.
- API, panel y platform publican únicamente en loopback. Los dominios se asignan
  al servicio correspondiente en OpenShip; el dominio raíz queda reservado para
  marketing y platform atiende los hosts de las organizaciones.
- `pgdata` es persistente. Un redeploy puede reiniciar PostgreSQL; no debe borrar
  ni sustituir su volumen. No ejecutar `down -v` en producción.

### Ejecución sin OpenShip

Docker Compose 2.24 o posterior permite el archivo de entorno opcional del stack:

```bash
cp infra/prod/.env.example infra/prod/.env
# Rellenar infra/prod/.env antes de continuar.
docker compose --env-file infra/prod/.env -f compose.prod.yaml config --quiet
docker compose --env-file infra/prod/.env -f compose.prod.yaml up -d --build
```

Las rutas se resuelven desde la raíz, donde vive `compose.prod.yaml`. No copiar el
archivo a otro directorio sin conservar el árbol del repositorio. El borde no
forma parte del stack: fuera de OpenShip es necesario un proxy HTTPS propio.

## Variables: una sola fuente

En OpenShip, las variables comunes viven en el entorno **production del proyecto**.
No copiar `.env.example` a los entornos de cada servicio ni mantener copias de los
secretos. Los overrides por servicio tienen precedencia y pueden eclipsar cambios
del proyecto. Panel y platform solo necesitan el override declarado `PORT=3000`;
la API usa `PORT=3001`.

Para Compose manual, la misma fuente es `infra/prod/.env`, excluido de Git y del
contexto Docker. Los secretos se generan una vez, se conservan y se rotan mediante
un procedimiento explícito; no regenerarlos para corregir un deploy.

`VITE_API_URL` y `VITE_BASE_DOMAIN` son argumentos de build: cambiar sus valores
requiere reconstruir las webs. Las variables de runtime requieren **Apply/refresh**,
que recrea los contenedores. Un restart solo reinicia con la configuración antigua.

### Modelo del agente

La clínica elige «ChatGPT 6» o «Claude 5.5» y odentIA pone la cuenta
(`docs/decisions/0022-la-clinica-elige-entre-dos-modelos-de-odentia.md`). API y
worker leen `LLM_OPENAI_API_KEY` y `LLM_ANTHROPIC_API_KEY`; sin la del proveedor
del modelo elegido, el agente deriva cada caso y avisa a quien lo administra
nombrando la variable que falta. `LLM_OPENAI_BASE_URL` y `LLM_ANTHROPIC_BASE_URL`
solo hacen falta con una pasarela propia. `LLM_MODEL=fake` es solo para previews
y pruebas.

### SMTP

`SMTP_PORT=465` usa TLS implícito; `587` usa STARTTLS cuando el servidor lo
ofrece. El mailer deja esa selección a Nodemailer y respeta un `secure` explícito
del caller. SMTP local de desarrollo, como Mailpit en 1025, sigue sin TLS.
No desactivar la validación de certificados para corregir la conexión. Autenticar
contra SMTP no demuestra que el proveedor acepte el remitente ni entregue el correo.

## CI y despliegue automático

`.github/workflows/ci.yml` instala dependencias con el lockfile, ejecuta typecheck,
construye la imagen de PostgreSQL para las pruebas de integración, ejecuta los tests
sin E2E y comprueba el Dockerfile de la app. Solo después de que ambos jobs pasen,
un push a `main` ejecuta el CLI oficial `openship deploy --commit "$GITHUB_SHA"
--watch`. El CLI envía el despliegue y espera su resultado; no hay controlador
propio ni bucle HTTP de espera.

Configurar en GitHub:

- Variables `OPENSHIP_URL` (origen HTTPS del panel) y `OPENSHIP_PROJECT_ID`.
- Secreto `OPENSHIP_DEPLOY_TOKEN`: grants `project:<id>:read,write` y
  `github_repository:darvin2c/odentIA:read`. El permiso del proyecto no concede
  acceso al origen Git. Tiene caducidad; renovarlo antes de que expire.

En OpenShip, mantener **Auto-deploy por push desactivado en producción**: el job
anterior es el único disparador automático. La GitHub App sigue dando acceso al
repo. El deploy manual queda disponible para operación y recuperación, pero no
sustituye las comprobaciones del CI.

Configurar `composePath=compose.prod.yaml` y dejar el directorio raíz vacío en el
proyecto. No importar una copia temporal de Compose con placeholders interpolados.
Si se necesita corregir configuración mediante CLI, `openship api` usa el contexto
local; no imprimir ni copiar sus tokens en logs.

El Dockerfile no usa extensiones exclusivas de BuildKit ni declara un frontend
externo. Esto evita que OpenShip fuerce la ruta de transporte del contexto asociada
a esa directiva. CI sigue utilizando BuildKit mediante buildx.

## Backups y recuperación

El servicio `backup` usa `pg_dump` de PostgreSQL 18 y rclone oficial fijado por
versión. El bucket R2 debe existir y ser privado. El token necesita acceso de
lectura/escritura a sus objetos; `no_check_bucket=true` evita solicitar permisos
de administración de buckets.

- `BACKUP_S3_ENDPOINT` es el endpoint S3 de la cuenta, sin nombre de bucket.
- `BACKUP_BUCKET` selecciona el bucket de backups; no usar el bucket público de
  avatares. `BACKUP_RETAIN` conserva los últimos dumps y `BACKUP_INTERVAL` determina
  el intervalo entre ejecuciones.
- Un bucket vacío desactiva el servicio solo para entornos efímeros. En producción
  deben configurarse bucket y credenciales.
- Supervisar los logs: un contenedor en ejecución no demuestra que el backup se
  haya subido. Verificar descarga y restauración periódicamente.

Restaurar el dump descargado primero en una instancia aislada con la misma major
 y extensiones, nunca directamente sobre la base activa:

```bash
pg_restore --exit-on-error --clean --if-exists --no-owner --no-acl \
  --dbname="$DATABASE_URL" archivo.dump
```

La restauración debe conservar esquema, historial de migraciones y datos, y no
activar proveedores externos. El healthcheck `/health` de la API comprueba la base,
no R2, SMTP ni el modelo: esas integraciones requieren comprobaciones separadas.

## Previews automáticos por PR

Cada PR del mismo repositorio tiene su propio entorno de OpenShip. El job
`preview` de `.github/workflows/preview.yml` corre en paralelo con `check` y
ejecuta `scripts/preview-environment.mjs up`. Es un workflow aparte de CI: si el
preview falla (servidor, DNS, OpenShip), CI sigue reflejando solo el código. La
protección de `main` debe exigir únicamente `check`. Pasos de `up`:

1. Reutiliza el entorno `pr-<número>` o lo crea con
   `openship project environment create` a partir del proyecto productivo, en la
   rama del PR. Cada entorno es un proyecto con su propio ID, red y volúmenes.
2. Fija `compose.preview.yaml` (el entorno copia `compose.prod.yaml`) y desactiva
   Auto Deploy: Actions es el único disparador y solo despliega commits verificados.
3. Aplica las variables de `infra/prod/.env.preview.example` derivadas de
   `pr-<número>.<OPENSHIP_PREVIEW_DOMAIN>`. Los secretos (PostgreSQL, Better Auth,
   `SECRETS_KEY`, MinIO) se generan una vez por entorno y no se rotan después.
4. Despliega el commit del PR con `openship deploy --watch`.
5. Expone `app.` (panel, 3000, primario), `api.` (3001), `storage.` (MinIO, 9000)
   y `*.` (platform, 3000). El dominio se crea al exponer el servicio. Publica
   los registros con el proveedor DNS de OpenShip y espera al DNS autoritativo
   antes de verificar: el comodín usa DNS-01 y el resto HTTP-01.
6. Comenta la URL en el PR, actualizando el mismo comentario en cada push.

Al cerrar o fusionar el PR, `preview-teardown` ejecuta
`scripts/preview-environment.mjs down`, que borra el entorno con
`--wipe-volumes`. Los registros DNS de Cloudflare no se eliminan con el proyecto;
apuntan al mismo servidor y se reutilizan si el número de PR reaparece.

OpenShip publica además un check `build:<servicio>` por servicio desplegado y
marca como fallidos los que no llegaron a desplegarse porque otro falló antes;
esos checks no los crea el repositorio y no indican un fallo de código.

Los PR desde forks no reciben secretos y no generan preview. Cada preview es un
stack completo (PostgreSQL, MinIO, Mailpit, API, worker, panel, platform, unos
4 GB de límite de memoria): los PR abiertos compiten con producción en el VPS.

Configuración en GitHub:

- Variable `OPENSHIP_PREVIEW_DOMAIN` (p. ej. `preview.example.com`). Su zona debe
  estar en el proveedor DNS conectado a OpenShip (token Cloudflare con
  Zone:Read y DNS:Edit). OpenShip 0.8.1 corrige la validación de hooks de
  Certbot que falla en 0.8.0.
- Secreto `OPENSHIP_PREVIEW_TOKEN`: grants `project:*:create` (solo los entornos
  que crea el propio token), `project:<id-produccion>:read,write` (origen de los
  entornos) y `github_repository:darvin2c/odentIA:read`. Un entorno creado con otra
  credencial no es administrable por este token: retirarlo y dejar que el job lo
  recree. Es distinto de `OPENSHIP_DEPLOY_TOKEN`, que sigue limitado a producción.
- Reutiliza `OPENSHIP_URL` y `OPENSHIP_PROJECT_ID`.

PostgreSQL, SMTP y las consolas administrativas permanecen internos. S3 necesita
el endpoint `storage.` para las URLs firmadas del navegador.

El servicio one-shot `seed` inicializa cada preview después de `migrate` y
`minio-init`: ejecuta `seed:cie10`, `seed:procedures` y `db:seed`, en ese orden.
API y worker esperan su salida correcta. Si falla, no escribe el marcador de
finalización ni permite arrancar sus dependientes.

`seedstate` conserva ese marcador entre despliegues: no se recrean usuarios ni
datos demo y se respetan las modificaciones hechas durante las pruebas. Un
preview nuevo tiene sus propios volúmenes e inicializa la demo automáticamente.
`pgdata`, `miniodata` y `seedstate` forman una unidad: al reiniciar desde cero o
restaurar un preview deben gestionarse juntos, nunca conservar el marcador con
una base vacía. No eliminar `seedstate` para actualizar código: volvería a
ejecutar la semilla, que restablece sus organizaciones demo.

Credenciales demo: `ana@odentia.dev`, `luis@odentia.dev` y `cora@odentia.dev`,
contraseña `Demo1234`. Solo datos ficticios. La inicialización pertenece al
runtime del preview, no a producción, tests ni CI; el comando manual
`pnpm db:seed` conserva su comportamiento de reinicio explícito.

### Operar un preview manualmente

Instalar el CLI oficial y ejecutar `openship login`. Para esta instalación,
el API público se alcanza bajo `https://ops.darvincotrina.com/api/proxy`.
El token queda en el contexto privado del CLI; no guardarlo en el repositorio.
El mismo script reproduce el job, también para recuperar un preview fallido:

```bash
export OPENSHIP_PROJECT_ID=<id-de-produccion> OPENSHIP_PREVIEW_DOMAIN=<dominio>
node scripts/preview-environment.mjs up --pr 29 --branch <rama> --commit <sha>
node scripts/preview-environment.mjs down --pr 29
```

**Proyecto/entorno y conjunto de variables no son lo mismo.** En OpenShip 0.8,
el panel y los pushes usan el conjunto predeterminado `production` **dentro del
proyecto seleccionado**, incluso si ese proyecto es de tipo preview. Ese nombre
no le da acceso al runtime ni a los secretos del proyecto productivo. Por eso el
script escribe y despliega con `--env production` sobre el ID del entorno.
Ver la [referencia del CLI](https://openship.io/docs/cli/deploy).

Nunca ejecutar `project delete` sobre el ID de Production: `down` solo actúa
sobre entornos `preview` cuyo slug es `pr-<número>`.

El correo de prueba queda en Mailpit. Una entrega allí no acredita entrega por
Resend; `LLM_MODEL=fake` y canales mock tampoco acreditan proveedores reales.
MinIO se construye desde su release oficial de fuente porque esa release no
publica una imagen comunitaria oficial utilizable; no se introduce otro proveedor.
El callback del registro devuelve al panel del mismo entorno tras verificar el correo.

## Límites operativos

El VPS y sus volúmenes siguen siendo un único punto de fallo. Mantener backups
fuera del host y un procedimiento de recuperación independiente del panel. No
exponer bases ni puertos internos al público. MCP no recibe facultades productivas
irreversibles sin aprobación humana.
