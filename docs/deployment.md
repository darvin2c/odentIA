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
- La historia de migraciones empieza en la base del 2026-10-16 (ADR 0045). Una
  base creada antes no se migra a ella, tampoco la de producción: se recrea su
  volumen antes de desplegar. Antes de esa fecha no hubo datos reales.
- El rol `dentalagent_app` y sus permisos por defecto los crea el init de la
  imagen (`infra/dev/postgres/init`), no las migraciones. Un PostgreSQL
  gestionado necesita crearlos aparte antes de migrar.
- La entrada pública es Cloudflare Tunnel (servicio `tunnel`, ver «Entrada por
  Cloudflare Tunnel»). API, admin, panel, platform y web además publican en loopback
  (API en el host 3101, panel 3010, platform 3011, admin 3012 y web 3013) solo como
  vuelta atrás por el borde de OpenShip. La web redirige `www.` a la raíz.
- La web (`apps/web`, ADR 0046) es HTML generado al compilar la imagen y servido por
  `apps/web/server.mjs`, sin variables de runtime. Su dirección canónica, su mapa del
  sitio y sus enlaces a `app.` y `api.` salen de `VITE_BASE_DOMAIN`: la canónica es
  `https://<dominio>`, no `WEB_URL`, que es el panel. El Libro de Reclamaciones envía
  desde el navegador a `api.`: el origen raíz `https://<dominio>` va en `TRUSTED_ORIGINS`
  y `COMPLAINTS_EMAIL` es el correo de odentIA que recibe el aviso de cada hoja.
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
archivo a otro directorio sin conservar el árbol del repositorio. El túnel forma
parte del stack: fuera de OpenShip basta su clave, sin proxy HTTPS propio ni
puertos abiertos.

## Entrada por Cloudflare Tunnel

Toda visita a odentIA entra por Cloudflare. El servicio `tunnel` (cloudflared) solo
abre conexiones de salida hacia Cloudflare y entrega cada visita por la red interna
del stack, así que nadie llega a odentIA yendo directo a la IP del servidor. El
servidor es compartido: sus puertos 80 y 443 siguen abiertos para las demás
aplicaciones de OpenShip, pero ya no llevan a odentIA. Se cierran solo cuando todas
entren por su propio túnel.

Un túnel y una clave por proyecto. Se crea en Cloudflare (Networking → Tunnels,
tipo Cloudflared); de su comando de instalación solo se usa la clave, que va en
`CLOUDFLARE_TUNNEL_TOKEN` del entorno production del proyecto. Sin ella Compose
rechaza el archivo. Quien tiene la clave puede recibir las visitas de odentIA: no
copiarla fuera de OpenShip y, si se filtra, renovarla en Cloudflare.

Rutas del túnel («Published application routes»), con el comodín al final:

| Dirección | Servicio |
| --- | --- |
| `api.<dominio>` | `http://api:3001` |
| `app.<dominio>` | `http://panel:3000` |
| `admin.<dominio>` | `http://admin:3000` |
| `<dominio>` y `www.<dominio>` | `http://web:3000` |
| `*.<dominio>` | `http://platform:3000` |

Cloudflare crea el registro DNS de cada ruta salvo el del comodín: el CNAME `*` a
`<id del túnel>.cfargotunnel.com`, con proxy, se crea a mano. El certificado
universal de Cloudflare cubre `<dominio>` y `*.<dominio>`. Todas las direcciones
quedan sujetas a los límites de Cloudflare (en el plan gratuito, 100 MB por
petición y 100 s hasta la respuesta).

Cambio desde el borde de OpenShip, una vez y con unos minutos sin servicio:

1. Clave en `CLOUDFLARE_TUNNEL_TOKEN` y despliegue: el túnel queda «Healthy», sin rutas.
2. Quitar en OpenShip los dominios de odentIA. OpenShip borra los registros DNS que
   creó; borrar a mano los que queden con esos nombres.
3. Añadir las rutas y el CNAME `*`.
4. `CLIENT_IP_HEADER=cf-connecting-ip` y Apply/refresh de la API.

Comprobar que cada dirección responde y que la IP del servidor ya no lleva a
odentIA: `curl --resolve api.<dominio>:443:<IP del servidor> https://api.<dominio>/health`
debe recibir la página «Service not found» de OpenShip. Vuelta atrás: quitar las
rutas y el CNAME `*`, volver a exponer los dominios en OpenShip y
`CLIENT_IP_HEADER=x-real-ip`.

## Variables: una sola fuente

En OpenShip, las variables comunes viven en el entorno **production del proyecto**.
No copiar `.env.example` a los entornos de cada servicio ni mantener copias de los
secretos. Los overrides por servicio tienen precedencia y pueden eclipsar cambios
del proyecto. Admin, panel, platform y web necesitan el override declarado `PORT=3000`;
la API usa `PORT=3001`.

Para Compose manual, la misma fuente es `infra/prod/.env`, excluido de Git y del
contexto Docker. Los secretos se generan una vez, se conservan y se rotan mediante
un procedimiento explícito; no regenerarlos para corregir un deploy.

`VITE_API_URL` y `VITE_BASE_DOMAIN` son argumentos de build: cambiar sus valores
requiere reconstruir las webs. Las variables de runtime requieren **Apply/refresh**,
que recrea los contenedores. Un restart solo reinicia con la configuración antigua.

`ADMIN_URL` es el origen HTTPS exacto de administración y forma parte de la
frontera de autorización de sus peticiones. Añadirlo a `TRUSTED_ORIGINS`, publicar
su DNS y enrutarlo al servicio `admin` antes de habilitar personal. Aplicar las
migraciones antes de API/worker; no hay fallback de seguridad para tablas
administrativas ausentes. El bootstrap nominal y TOTP se describen en
`development.md`.

### IP de quien pide

`CLIENT_IP_HEADER` es la cabecera de la que la API toma la IP de cada persona
para el límite de intentos de Better Auth (3 inicios de sesión cada 10 s por
dirección, por ejemplo) y para la IP de cada sesión. Vacía, nadie tiene IP: todas
las clínicas comparten un límite por ruta, la API lo avisa al arrancar y Better
Auth con «Rate limiting could not determine a client IP».

Va una cabecera que **reescribe** siempre quien está delante, nunca una que solo
reenvía: cualquier otra la escribe el cliente y estrena un límite en cada intento.
Una sola: si la petición no la trae, Better Auth vuelve al límite compartido.

- Con el túnel: `CLIENT_IP_HEADER=cf-connecting-ip`. Cloudflare la reescribe en cada
  visita y el túnel es la única entrada. Deja de ser segura si los dominios de
  odentIA vuelven al borde de OpenShip: el servidor acepta HTTPS directo, sin
  Cloudflare, y el borde la deja pasar tal como llega.
- Por el borde de OpenShip (vuelta atrás): `CLIENT_IP_HEADER=x-real-ip`. El borde
  la reescribe con la dirección que vio conectar, que toma de `CF-Connecting-IP`
  solo cuando conecta un rango de Cloudflare (`set_real_ip_from`).
- Nunca `x-forwarded-for`: los proxies le añaden su dirección a la que trae la
  petición, así que llega con dos o más y Better Auth no la acepta.

### Modelo del agente

La clínica elige «ChatGPT 6» o «Claude 5.5» y odentIA pone la cuenta
(`docs/decisions/0022-la-clinica-elige-entre-dos-modelos-de-odentia.md`). API y
worker leen `LLM_OPENAI_API_KEY` y `LLM_ANTHROPIC_API_KEY`; sin la del proveedor
del modelo elegido, Recepción no se enciende («El modelo responde»), el agente
deriva cada caso y Soporte del back-office recibe el caso automático «Modelo sin
responder» con la variable que falta. La clínica nunca ve la variable.
`LLM_OPENAI_BASE_URL` y `LLM_ANTHROPIC_BASE_URL` solo hacen falta con una
pasarela propia. `LLM_MODEL=fake` es solo para desarrollo y pruebas: con
`NODE_ENV=production` y canales reales (`CHANNEL_SENDER_MODE=live` en el worker,
`CHANNEL_VALIDATE_EXTERNAL` distinto de `false` en la API) ni la API ni el worker
arrancan con él.

### Búsqueda con vectores del agente

API y worker leen `EMBEDDINGS_MODEL`, `EMBEDDINGS_BASE_URL` y `EMBEDDINGS_API_KEY`
(cualquier endpoint compatible con OpenAI; `EMBEDDINGS_TIMEOUT_MS` opcional) y la
base necesita la extensión `vector`. Sin `EMBEDDINGS_MODEL` el agente busca solo
por palabras: el banco de la ADR 0021 midió 11 de 35 aciertos así, contra 32 de 35
con vectores. `fake` vectoriza por letras sin red y es solo para desarrollo y
pruebas. Detalle en `development.md`.

### SMTP

`SMTP_PORT=465` usa TLS implícito; `587` usa STARTTLS cuando el servidor lo
ofrece. El mailer deja esa selección a Nodemailer y respeta un `secure` explícito
del caller. SMTP local de desarrollo, como Mailpit en 1025, sigue sin TLS.
No desactivar la validación de certificados para corregir la conexión. Autenticar
contra SMTP no demuestra que el proveedor acepte el remitente ni entregue el correo.

`SUPPORT_INBOX_EMAIL` es el buzón de soporte de odentIA: el worker le envía
«Caso nuevo» y «La clínica respondió», con el botón a Soporte en `ADMIN_URL`.
Vacío, esos avisos quedan pendientes y el caso sigue en la bandeja de Soporte.

## CI y despliegue automático

`.github/workflows/ci.yml` instala dependencias con el lockfile, ejecuta typecheck,
construye la imagen de PostgreSQL para las pruebas de integración, ejecuta los tests
sin E2E y, en cada PR y en `main`, comprueba que la imagen de la app construye. No
hay entornos por PR: esa comprobación es lo único que valida la imagen antes de
fusionar. Solo después de que ambos jobs pasen, un push a `main` ejecuta el CLI
oficial `openship deploy --commit "$GITHUB_SHA" --watch`. El CLI envía el
despliegue y espera su resultado; no hay controlador propio ni bucle HTTP de espera.

Configurar en GitHub:

- Variables `OPENSHIP_URL` (origen HTTPS del panel) y `OPENSHIP_PROJECT_ID`.
- Secreto `OPENSHIP_DEPLOY_TOKEN`: grants `project:<id>:read,write` y
  `github_repository:darvin2c/odentIA:read`. El permiso del proyecto no concede
  acceso al origen Git. Tiene caducidad; renovarlo antes de que expire.

El job registra el token con `openship context add … --use`, no con `login`:
`login` lo valida listando tokens, algo que un token acotado no puede hacer, y
falla con «Could not validate the token». El acceso real lo comprueba `deploy`.

En OpenShip, mantener **Auto-deploy por push desactivado en producción**: el job
anterior es el único disparador automático. La GitHub App sigue dando acceso al
repo. El deploy manual queda disponible para operación y recuperación, pero no
sustituye las comprobaciones del CI. Para operar a mano, instalar el CLI oficial y
ejecutar `openship login`; en esta instalación el API se alcanza bajo
`https://ops.darvincotrina.com/api/proxy`. El token queda en el contexto privado
del CLI; no guardarlo en el repositorio. Nunca ejecutar `project delete` sobre el
ID de producción.

OpenShip publica además un check `build:<servicio>` por servicio desplegado y
marca como fallidos los que no llegaron a desplegarse porque otro falló antes;
esos checks no los crea el repositorio y no indican un fallo de código.

Los dominios de odentIA no se exponen en OpenShip: son rutas del túnel. Exponerlos
reabre la entrada directa al servidor y hace falsificable `cf-connecting-ip`; solo
como vuelta atrás (ver «Entrada por Cloudflare Tunnel»), y entonces cada superficie
se expone una vez: `api.` (api, 3001), `app.` (panel, 3000), `admin.` (admin,
3000), el dominio raíz y `www.` (web, 3000) y el comodín `*.` (platform, 3000), que
requiere DNS-01 con el proveedor DNS conectado a OpenShip; el resto usa HTTP-01.

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
- Un bucket vacío desactiva el servicio, solo admisible fuera de producción. En
  producción deben configurarse bucket y credenciales.
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

## Límites operativos

El VPS y sus volúmenes siguen siendo un único punto de fallo. Mantener backups
fuera del host y un procedimiento de recuperación independiente del panel. No
exponer bases ni puertos internos al público. MCP no recibe facultades productivas
irreversibles sin aprobación humana.
