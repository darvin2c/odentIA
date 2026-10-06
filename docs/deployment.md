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

## CI y despliegue automático

`.github/workflows/ci.yml` instala dependencias con el lockfile, ejecuta typecheck,
construye la imagen de PostgreSQL para las pruebas de integración, ejecuta los tests
sin E2E y comprueba el Dockerfile de la app. Solo después de que ambos jobs pasen,
un push a `main` dispara el deploy en OpenShip para el SHA exacto y espera su resultado.
Un fallo o despliegue parcial falla el workflow; no se anuncia como éxito.

Configurar en GitHub:

- Variables `OPENSHIP_URL` (origen HTTPS del panel) y `OPENSHIP_PROJECT_ID`.
- Secreto `OPENSHIP_DEPLOY_TOKEN`: token con grants read/write **solo** sobre el
  proyecto odentIA. Tiene caducidad; renovarlo antes de que expire.

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

## Previews y límites

Estas correcciones estabilizan producción. No habilitan ni acreditan previews:
los puertos fijos de `compose.prod.yaml` no permiten levantar copias simultáneas
sin que el orquestador les asigne otros bindings. Entornos distintos requieren
bases, variables, almacenamiento y ciclos de vida aislados y verificados.

El VPS y sus volúmenes siguen siendo un único punto de fallo. Mantener backups
fuera del host y un procedimiento de recuperación independiente del panel. No
exponer bases ni puertos internos al público. MCP no recibe facultades productivas
irreversibles sin aprobación humana.
