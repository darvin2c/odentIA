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

## Previews nativos de OpenShip

Seguir la [guía de entornos](https://openship.io/docs/guides/preview-environments):
en el proyecto, pulsar **+** junto al selector de entorno, elegir la rama y
seleccionar el nuevo entorno antes de configurar o desplegar. Reutilizar el
entorno existente para esa rama; no crear otra aplicación ni copiar producción.

Configuración inicial del preview:

1. Usar `compose.preview.yaml`, directorio raíz vacío. Es Docker Compose estándar,
   no un gestor de despliegue: API, worker y webs usan el mismo Dockerfile de
   producción. PostgreSQL conserva PGMQ/pg_cron. MinIO y Mailpit pertenecen solo
   al preview; no incluye backup productivo.
2. Cargar valores propios siguiendo `infra/prod/.env.preview.example`. Generar
   secretos independientes y no importar datos de producción.
3. En **Services**, asignar `api.<base-preview>` a API (3001),
   `app.<base-preview>` al panel (3000) y `*.<base-preview>` a platform (3000).
   El panel es la entrada principal. No enumerar clínicas: el wildcard sirve
   todos los slugs, con prioridad de las rutas exactas de API y panel.
   Usar DNS-01 mediante Cloudflare para el certificado wildcard; el token de
   usuario requiere Zone:Read y DNS:Edit. OpenShip 0.8.1 corrige la validación
   de hooks de Certbot que falla en 0.8.0.
   PostgreSQL, SMTP y las consolas administrativas permanecen internos.
   S3 necesita un endpoint accesible para las URLs firmadas; no retirarlo antes
   de migrar a almacenamiento aislado equivalente.
4. Desplegar desde OpenShip y activar **Source → Auto Deploy** en ese preview
   para que sus siguientes pushes se desplieguen por la GitHub App. No requiere
   un job de preview en Actions, Python ni acceso SSH desde GitHub.

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

### CLI: vincular una vez, desplegar con un comando

Instalar el CLI oficial y ejecutar `openship login`. Para esta instalación,
el API público se alcanza bajo `https://ops.darvincotrina.com/api/proxy`.
El token queda en el contexto privado del CLI; no guardarlo en el repositorio.

```bash
# Seleccionar el ID del entorno, no el ID de producción.
openship init --project <id-del-entorno-preview>
openship deploy --watch
```

`.openship/project.json` es un enlace local excluido de Git. En otra copia de
trabajo puede vincularse producción con su ID y usar el mismo `openship deploy`.
`--watch` observa el resultado; sin él solo se solicita el despliegue.

**Proyecto/entorno y conjunto de variables no son lo mismo.** En OpenShip 0.8,
el panel y los pushes usan el conjunto predeterminado `production` **dentro del
proyecto seleccionado**, incluso si ese proyecto es de tipo preview. Ese nombre
no le da acceso al runtime ni a los secretos del proyecto productivo.
`openship deploy --env preview` selecciona un conjunto alternativo de variables;
no crea ni selecciona otro entorno. Usarlo solo si ese conjunto está configurado.
Ver la [referencia del CLI](https://openship.io/docs/cli/deploy).

Los previews se actualizan por su rama. La creación del entorno y su retirada
son operaciones nativas explícitas: no asumir que abrir o cerrar un PR las realiza.
Al retirar un preview, usar **Advanced → Delete Project** sobre su ID y revisar
los volúmenes efímeros que se eliminarán; nunca hacerlo sobre Production.

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
