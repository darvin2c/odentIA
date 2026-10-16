# Desarrollo y herramientas

## Instalación

Node >=24, pnpm 9.15. Desde la raíz:

```sh
cp infra/dev/.env.example infra/dev/.env
# Generar SECRETS_KEY: openssl rand -hex 32
pnpm install
pnpm --filter @odentia/db migrate
pnpm --filter @odentia/db seed:cie10
pnpm --filter @odentia/db seed:procedures
pnpm db:seed
```

`seed:cie10` carga por defecto el capítulo de cavidad bucal (K00–K14). El catálogo oficial completo se carga con `CIE10_FILE=<csv> CIE10_SHA256=<hash publicado>`: el archivo se rechaza si su hash no coincide.

`.env` con finales LF: CRLF rompe su carga en sh. Los scripts tsx de db/services cargan `infra/dev/.env` con `--env-file-if-exists`; variables existentes tienen prioridad. Semilla manual determinista/idempotente, no para tests/CI.

Infra definida en `infra/dev/compose.yaml`: PostgreSQL :5432, MinIO :9000/:9001 y Mailpit :1025/:8025. En Windows lanzar `pnpm dev` desde Git Bash con pnpm en PATH; proxies Portless en 443. Panel: `app.odentia.localhost`; administración: `admin.odentia.localhost`; plataforma: `odentia.localhost`.

### Administración de odentIA

`apps/admin` usa la API compartida, no un backend ni una base independientes.
Configurar `ADMIN_URL` con el origen HTTPS exacto del backoffice. La cuenta del
cliente conserva organizaciones, invitaciones, soporte y Plan y pagos en `panel`.
`admin` y `storage` son subdominios reservados: la migración rechaza una colisión
con una clínica existente para que se resuelva explícitamente antes del despliegue.

Para el primer administrador, registrar y verificar antes su cuenta nominal y,
con `DATABASE_URL` propietario disponible, ejecutar:

```sh
pnpm --filter @odentia/api bootstrap:admin -- correo@ejemplo.pe
```

El comando rechaza crear otro administrador cuando ya existe uno activo; las altas
siguientes son invitaciones desde Equipo. Abrir `ADMIN_URL`, iniciar sesión y
enrolar TOTP en Seguridad de acceso; guardar los códigos de respaldo fuera del
navegador. Ser propietario de una clínica nunca habilita el backoffice.

La semilla manual incluye `admin@odentia.dev` y `support@odentia.dev` con la
contraseña de demostración `Demo1234`, sin segundo factor preconfigurado; hay que
enrolarlo. No ejecutar esa semilla en producción. Planes, medios y clínicas
comerciales de la semilla son ficticios. En producción se configuran planes y
datos de cobro reales desde administración; no hay cobro automático con tarjeta
ni emisión fiscal integrada.


### Modelo real

La clínica elige entre dos modelos que odentIA validó y odentIA pone la cuenta
(`docs/decisions/0022-la-clinica-elige-entre-dos-modelos-de-odentia.md`):
«ChatGPT 6» (OpenAI, el de toda clínica) y «Claude 5.5» (Anthropic). El modelo
exacto y sus opciones viven en `packages/agent/src/llm.ts` (`LLM_CATALOG`).

En `infra/dev/.env`: quitar `LLM_MODEL=fake` y poner `LLM_OPENAI_API_KEY` y, para
probar Claude, `LLM_ANTHROPIC_API_KEY`. `LLM_OPENAI_BASE_URL` y
`LLM_ANTHROPIC_BASE_URL` solo hacen falta con una pasarela propia; sin ellas va la
API pública de cada proveedor. Sin la clave del proveedor del modelo elegido el
agente deriva y avisa con el nombre de la variable que falta.
`LLM_TIMEOUT_MS` y `LLM_MAX_RETRIES` acotan cada llamada. Las evaluaciones
(`eval:decisions`, `eval:admin`…) aceptan `--llm=chatgpt_6|claude_5_5`.
`AGENT_BURST_WINDOW_SECONDS` (worker, 6 por defecto, 0–30) es lo que el agente
espera tras un mensaje entrante antes de leer el hilo: normalmente agrupa una
ráfaga en una sola corrida y una sola respuesta (mejor esfuerzo; límites en
`docs/decisions/0005-uso-del-modelo-rafagas-y-prefijo.md`), a cambio de esa
demora en cada respuesta; `0` responde sin esperar.

API y worker leen las mismas variables; reiniciarlos tras cambiarlas. Nunca
poner la key en una variable `VITE_*`, un campo de conversación ni el repositorio.

### Modelo de decisión

Ver `docs/decisions/0007-modelo-de-decision-elige-el-conocimiento.md`. El worker y la API leen
`JEV_API_KEY`/`JEV_BASE_URL` y `OPENAI_DECISIONS_API_KEY`/`OPENAI_DECISIONS_BASE_URL`
(la API, para entender lo que se le pide al Administrador con palabras);
sin ellas, elegir ese proveedor en Configuración → Agente deja cada triaje como
fila con error en Agente › Registro técnico. `pnpm --filter @odentia/agent eval:decisions
-- --provider=jev` compara un proveedor con los ejemplos propios de
`packages/agent/eval/`; no enviar mensajes reales de pacientes sin autorización. `eval:off-topic` mide si reconoce lo que no es de la clínica sin marcar lo que sí lo es. `eval:admin`
mide, con un proveedor real, cuántos pedidos al Administrador entiende y los tokens
por llamada; `eval:month` corre un mes de una clínica inventada y proyecta los tokens
del mes (necesita el runtime de contenedores, como las pruebas).

En producción, usar las mismas variables en los secretos de despliegue de API y
worker o en `infra/prod/.env`. `CHANNEL_SENDER_MODE=mock` sigue impidiendo envíos
reales aunque el LLM sea real; habilitar `live` y validación externa de conexiones
solo para una prueba autorizada, con destinatarios consentidos. Una respuesta
del modelo no demuestra entrega del canal ni sustituye la observación humana.

### Búsqueda por significado del agente

Ver `docs/decisions/0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md`.
Necesita la extensión `vector` (pgvector) en PostgreSQL: la imagen
`dentalagent-postgres:18.6` la trae desde el 2026-10-14. Con una imagen anterior,
reconstruirla (`podman build -t dentalagent-postgres:18.6 infra/dev/postgres`) y
recrear el contenedor de desarrollo antes de migrar; el volumen de datos se conserva.
La base de producción debe tenerla instalada.

Worker y API leen `EMBEDDINGS_MODEL`, `EMBEDDINGS_BASE_URL` y `EMBEDDINGS_API_KEY`
(cualquier endpoint compatible con OpenAI). `fake` (el de `.env.example`) vectoriza por
trozos de letras, sin red: encuentra palabras mal escritas pero no entiende
significado y no acredita a ningún proveedor. Vacío: el agente busca solo por
palabras. El índice se concilia y se vectoriza en el ciclo de automatizaciones
del worker; cambiar de modelo vuelve a vectorizar todo de a poco. `pnpm --filter @odentia/agent eval:search` mide la búsqueda con el banco `packages/agent/eval/busqueda-clinica.json` (por palabras, con `fake` y con el proveedor real; luego con 3 000 servicios de relleno) en una base efímera. Turbo solo pasa a las apps las variables declaradas en `turbo.json`: una variable nueva de entorno se declara ahí.

### WhatsApp con «Conectar con Facebook» (opcional)

WhatsApp se conecta de dos maneras. A mano, con los datos de la app de Meta de
cada clínica: funciona desde el primer día y no necesita nada de esta sección.
Con el botón «Conectar con Facebook» (Embedded Signup de Meta, versión 4): la
clínica entra con su Facebook y vuelve conectada. El botón necesita que odentIA
tenga su propia app aprobada por Meta; motivos en
`docs/decisions/0020-conectar-whatsapp-con-facebook.md`.

**Este camino no se ha probado contra Meta**: la app de odentIA todavía no
existe. El código sigue la documentación de Meta leída el 2026-10-13 y sus
pruebas usan respuestas con la forma que esa documentación publica. Antes de
ofrecerlo a una clínica hay que recorrerlo entero con una cuenta real.

Variables, solo en la API (`infra/dev/.env` o los secretos del despliegue):

| Variable | Qué es | Dónde se obtiene |
| --- | --- | --- |
| `META_APP_ID` | Identificador de la app de odentIA | Arriba en el panel de la app |
| `META_APP_SECRET` | Clave secreta de la app: canjea el código y firma los avisos | Configuración de la app › Básica |
| `META_LOGIN_CONFIG_ID` | Configuración de «Facebook Login for Business» | Facebook Login for Business › Configuraciones |
| `META_WEBHOOK_VERIFY_TOKEN` | Texto que elige odentIA para que Meta verifique la dirección de avisos | Se inventa (`openssl rand -hex 24`) y se pega igual en Meta |
| `META_GRAPH_VERSION` | Versión del Graph API (`v25.0` si falta) | La vigente al crear la app |

Sin las cuatro primeras el botón no existe y nada más cambia; con solo algunas,
la API lo dice al arrancar y sigue sin botón. Tampoco existe con
`CHANNEL_VALIDATE_EXTERNAL=false`, porque ahí no se llama a Meta. La clave
secreta no sale del servidor: la pantalla recibe el identificador de la app, el
de la configuración y la versión.

Trámite ante Meta, en este orden (lo hace quien administra odentIA, no una clínica):

1. Verificar la empresa de odentIA en Meta (Business Verification).
2. Crear la app con el caso de uso de WhatsApp y unirla a ese portafolio; en
   «Tech Provider onboarding» seguir los pasos que muestra el panel.
3. Pedir en App Review el acceso avanzado a `whatsapp_business_management` y
   `whatsapp_business_messaging`. Meta pide dos videos: un mensaje enviado desde
   la app y recibido en WhatsApp, y la creación de una plantilla. Hasta que
   apruebe, el botón solo sirve a quien tiene un rol en la app (administrador o
   desarrollador): alcanza para probar.
4. En Facebook Login for Business › Configuración, activar el inicio de sesión
   con el SDK de JavaScript y los demás interruptores que lista la guía de
   implementación, y agregar a «Dominios permitidos» y a «URI de redirección de
   OAuth válidos» el dominio donde se abre la plataforma. Solo HTTPS con
   certificado válido. Cada clínica entra por su subdominio: confirmar con Meta
   si admite comodín o hay que servir el botón desde un único dominio.
5. Crear la configuración de «Facebook Login for Business» con la variante
   «WhatsApp Embedded Signup» y elegir los productos: eso fija la versión 4. Su
   identificador es `META_LOGIN_CONFIG_ID`.
6. En el producto Webhooks de la app (objeto «WhatsApp Business Account»), poner
   como dirección `https://<API>/api/webhooks/meta/whatsapp` y como clave de
   verificación el valor de `META_WEBHOOK_VERIFY_TOKEN`; suscribir los campos
   `messages` y `message_template_status_update`, que son los que odentIA usa, y
   `account_update`, que la guía de Meta exige (odentIA lo recibe y no hace nada
   con él). Es una sola dirección para todas las clínicas. La API debe estar
   arriba con las variables puestas para responder la verificación.
7. Con la API reiniciada, conectar una cuenta de prueba y comprobar: el canje
   del código, la suscripción, el registro del número, un mensaje que entra, uno
   que sale y el aviso de una plantilla aprobada.

Límites que pone Meta: al principio se pueden conectar hasta 10 clínicas nuevas
cada 7 días (200 al completar la verificación de la empresa, App Review y la
verificación de acceso). El código que devuelve la ventana vive 30 segundos. Un
número debe registrarse dentro de los 14 días siguientes a la ventana, con un
máximo de 10 intentos cada 72 horas. La forma de pago la agrega cada clínica en
su cuenta de WhatsApp: no hay llamada que lo haga por ella.

Hoy la plataforma no envía una política de seguridad de contenido. Si llega a
tenerla, el botón necesita al menos `script-src https://connect.facebook.net`
(el SDK); lo demás que el SDK pida a `https://www.facebook.com`,
`https://web.facebook.com` o `https://graph.facebook.com` (`connect-src`,
`frame-src`, `img-src`) se confirma con la consola del navegador en la primera
prueba real: Meta no lo publica en la guía del botón. La ventana de Meta es
emergente y avisa a la página que la abrió: una cabecera
`Cross-Origin-Opener-Policy: same-origin` cortaría ese aviso; tendría que ser
`same-origin-allow-popups`.

## Verificación

- `pnpm build|test|typecheck`: monorepo mediante Turbo; `pnpm --filter @odentia/services test|typecheck`: paquete.
- DB/services usan Testcontainers con `dentalagent-postgres:18.6`; construir con `podman build -t dentalagent-postgres:18.6 infra/dev/postgres`.
- Instalar Chromium: `pnpm --filter @odentia/e2e exec playwright install chromium`. Linux requiere dependencias de sistema del navegador.
- `pnpm e2e --workers=2` crea entorno efímero sin `.env`, compose dev ni semilla manual. Reglas en `e2e/AGENTS.md`.
- Windows/Podman (PowerShell): `$env:DOCKER_HOST='npipe:////./pipe/podman-machine-default'` y `$env:TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/run/podman/podman.sock'`. Confirmar nombre con `podman machine inspect` si cambia la máquina.
- Si el pipe no existe, reenviar el socket root de la conexión por defecto (`podman system connection list`) con `ssh -N -L 127.0.0.1:<puerto>:/run/podman/podman.sock` y usar `DOCKER_HOST=tcp://127.0.0.1:<puerto>`. En Git Bash, exportar `MSYS2_ENV_CONV_EXCL=TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` para que la ruta del override no se convierta a una ruta de Windows.
- Linux/WSL: `DOCKER_HOST=unix:///ruta/al/socket pnpm e2e`; socket accesible desde Node Linux. En Podman remoto, el override del socket apunta al host de contenedores. Docker estándar puede autodetectarse.
- Tests de paquetes fijan socket WSL con `??=`; sobrescribir por entorno cuando corresponda. No arrancar/reconfigurar runtime automáticamente.

### Accesibilidad de las superficies principales

- `pnpm e2e accessibility.spec.ts --workers=2` recorre login, registro, onboarding, Inicio, Configuración y alta de paciente con Chromium y Axe, en 1440px/390px y temas claro/oscuro. Incluye errores de formulario, selector de zona horaria abierto, navegación móvil y cierre con retorno de foco del panel/drawer.
- La salida de Axe y las capturas quedan como adjuntos de cada caso en `e2e/test-results/<runId>/results.json` y `playwright/`. Revisar también los resultados incompletos que requieran juicio humano; cero violaciones automáticas no acredita WCAG completa.
- Completar una lectura con Narrador/NVDA o equivalente: landmarks, nombre/rol/estado de controles, selección y errores asociados. Registrar el lector y el recorrido efectivamente ejecutado en el reporte, no asumirlo a partir del árbol accesible.

### Borradores, estados remotos e Inicio

- `pnpm e2e page-drafts.spec.ts --workers=1`: navegación por sidebar/SectionNav, atrás/adelante, recarga, fallo y guardado en formularios de página. Tras «Descartar y salir», esperar el contenido del destino antes de volver a navegar: la URL cambia antes de desmontar la página.
- `pnpm e2e remote-states.spec.ts --workers=2`: 500/red, 404 y 403 con reintento real; una respuesta perdida tras aplicar un POST conserva la entrada y no reenvía la operación.
- `pnpm e2e home-start.spec.ts --workers=2`: organización nueva, parcial, configurada sin actividad, jornada activa, error recuperable y roles en 1440px/390px.

### Verificación operativa del agente

- `pnpm --filter @odentia/agent test` recorre herramientas y propuestas con PostgreSQL real: reserva, reprogramación, cancelación, obsolescencia, reentrega idempotente y derivación humana.
- `pnpm e2e crm.spec.ts --workers=1 --grep "crm derivación"` comprueba en la plataforma la cola con plazo y la toma de un caso.
- `pnpm --filter @odentia/services test -- automation-flow.test.ts` recorre las líneas del Administrador, también «Retomar una oportunidad»: caso al vencer, sin duplicar, vía por persona, causa y tarea cuando no se puede, y los botones; requiere el mismo PostgreSQL efímero.
- La prueba real de un seguimiento debe observar vencimiento → caso → mensaje (o aviso y tarea) y reinicio del worker. Un envío `unknown` se concilia en el proveedor y no se reintenta.
- En Reportes, los controles se cuentan por la fecha en que tocaban y según su estado a hoy; uno marcado como realizado sin atención cerrada que lo respalde no cuenta como venido. `pnpm e2e reports.spec.ts --workers=2` recorre las cuatro preguntas, el cambio de periodo y la lista detrás de una cifra en 1440px/390px.
- Los modos fake/mock prueban contratos internos, no entrega de proveedor, calidad de un LLM real ni observación con usuarios. El cierre de una validación integral exige proveedor/modelo reales identificados, datos consentidos o sintéticos y observación de recepción, clínico y caja.

## Identidad visual y temas

La única firma vigente es `Odentia[32]`: O mayúscula, IBM Plex Mono Regular y separación ajustada; el isotipo independiente conserva `[32]`. `Brand` en `@odentia/ui-patterns` sirve la firma y su variante `compact`. Los activos canónicos viven en `assets/brand/`: maestros SVG con curvas editables, PNG transparentes, PDF vectoriales RGB, favicon SVG/ICO, licencia, guía y ZIP. Panel y plataforma importan los favicons de esa carpeta mediante Vite. No se mantienen propuestas descartadas en `refs/`.

Los colores de identidad usan `--identity-accent` y `--identity-ink`, separados de `--primary`: las organizaciones pueden cambiar el color de sus acciones sin recolorear la marca de la plataforma. Claro: cian `#0e7490` y tinta `#0f172a`; oscuro: cian `#4fc3d7` y tinta `#f1f5f9`. No redefinir los tokens de identidad en paletas de organización. La marca de una clínica y la de la plataforma son identidades distintas.

Para comprobar la firma, el isotipo y su independencia del primario, ejecutar `pnpm --filter @odentia/ui-patterns storybook` y abrir `Identidad/Marca/Temas`. `Identidad/Marca/Acceso` muestra la composición de autenticación en escritorio y móvil; `Patrones/AppShell` permite comprobar la cabecera expandida y el riel colapsado.

`Identidad/Cargas/Recorridos` y `Recorridos oscuros` presentan la variante B elegida (corchetes y barrido luminoso del 32) sobre tabla, acciones, drawer, inputs y cambio de contexto. La tabla permite crear/editar datos sintéticos y observar el guardado y la recarga como operaciones separadas; «Fallar recarga tras guardar» demuestra cómo reintentar solo la lista sin repetir la mutación. También se muestra invalidación por evento externo, primera consulta con skeleton, búsqueda con debounce de 300 ms, opciones dependientes, carga incremental y vista previa.

La variante B es la primitiva `Spinner` de `@odentia/ui`: corchetes y barrido luminoso, sin giro del logo; respeta movimiento reducido. `SubmitButton` la muestra solo durante `pending`, conserva su nombre y bloquea el botón, sin reservar espacio en reposo. `SearchInput.isFetching` y `FilterBar.searchPending` representan la lectura real del servidor sin bloquear escritura ni limpieza.

`DataTable.isFetching` añade el estado fijo de actualización sin sustituir filas. La primera consulta usa `DataTableSkeleton`; `LoadingState` usa skeleton por defecto y acepta `kind="indeterminate"` para preparar documentos o esperar sin estructura conocida. Una revalidación fallida conserva los datos recibidos y ofrece reintentar la lectura; un guardado confirmado no se repite porque falle esa lectura. La firma global permanece estática. Subidas y descargas con progreso medido conservan su progreso real.

Las stories consumen los componentes reales; únicamente sus demoras, almacén sintético y respuestas son de demostración y no pertenecen al producto.

## Herramientas de contexto

- TypeScript del workspace y `typescript-language-server` son dependencias de desarrollo raíz. `pnpm install` instala el servidor; OMP lo detecta por binario local y marcador de proyecto. Tras instalar, recargar LSP (`reload`, `file: "*"`).
- En VS Code usar la versión TypeScript del workspace (`node_modules/typescript/lib`); Biome conserva formato y lint. No confundir lint con navegación semántica.
- Antes de cambios de contratos consultar definiciones/referencias mediante LSP. No guardar mapas de símbolos en Markdown.
- Skills propias en `.agents/skills`; UX en `odentia-ux`, arquitectura en `odentia-arch`. Si el cliente no las descubre automáticamente, leer su `SKILL.md` explícitamente. No requieren instalar skills globales.

## Problemas operativos conocidos

- `CHANNEL_VALIDATE_EXTERNAL=false` en dev/e2e evita contactar Meta/Telegram al crear conexiones.
- Portless `already registered by PID 0`: comprobar entradas muertas de `~/.portless/routes.json` antes de retirarlas. Colisiones de puertos API/panel: reiniciar el stack para reasignar.
- Portless 0.15.6 está fijado y parcheado en `patches/portless@0.15.6.patch`: `PORTLESS_HTTP_REDIRECT=0` evita puerto 80 en E2E; configuración OpenSSL mínima evita `basicConstraints` duplicado en la CA; sus procesos OpenSSL se crean ocultos para que la generación dinámica de certificados no abra ventanas de Terminal en Windows.
- En Windows, el supervisor E2E lanza todo proceso y sus descendientes dentro de una consola propia oculta (`e2e/windows-child-runner.cjs`) y vigila el recorrido completo con `e2e/windows-terminal-monitor.ps1`; cualquier ventana nueva de Windows Terminal hace fallar la ejecución. `patches/testcontainers@12.1.0.patch` aplica la misma restricción al helper `docker-credential-desktop`.
- Base UI 1.8.0 usa `aria-hidden` en controles externos a un combobox editable aun cuando permite alcanzarlos con Tab. `patches/@base-ui__react@1.8.0.patch` conserva esos controles en el árbol accesible, sin cambiar el aislamiento de los diálogos modales; aplica a ESM y CommonJS.
- `patches/react-resizable-panels@4.12.4.patch` suscribe el separador antes de registrarlo y recalcula sus vecinos al habilitarlo/deshabilitarlo. Así resize por teclado y `aria-valuenow` funcionan desde la apertura de un panel inicialmente colapsado. Al actualizar la librería, comprobar ambos comportamientos.
- Ante TLS `unable to verify the first certificate`, inspeccionar CA del state dir afectado. Si es inválida, regenerar sus `ca*.pem`, `server*.pem` y `host-certs/` reiniciando solo ese proxy; no desactivar validación TLS ni modificar confianza global como solución.
- `scripts/local-network.mjs` resuelve `.localhost` a loopback con Undici en dev/previews SSR. No pertenece al bundle productivo ni cambia hosts/DNS global.
- Si loopback Windows no entrega saludo SMTP pero HTTP funciona, comprobar conectividad a la máquina Podman antes de usar su IP con `TESTCONTAINERS_HOST_OVERRIDE`; no omitir readiness.

Resultados, duraciones y límites de cada ejecución pertenecen al reporte/PR, no a esta guía.
