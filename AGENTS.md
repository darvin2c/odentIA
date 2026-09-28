# AGENTS.md — odentIA

Monorepo pnpm 9.15 + turbo. Node >= 24. Comentarios, mensajes de error y commits en español.

## Objetivo

CRM odontológico omnicanal orientado a la persona.

- La persona es el centro: paciente ≠ interlocutor ≠ responsable; todo lo que entra por cualquier canal converge en la misma persona y en su única historia clínica. Ninguna vía de entrada crea una ficha paralela.
- Omnicanal: el núcleo trabaja con conceptos propios (contacto, conversación, mensaje) y nunca depende de un proveedor concreto; cada canal es un adaptador intercambiable.
- UX para el usuario final (recepción, clínico): sencilla, minimalista y profesional. Menos opciones a la vista, una acción clara por pantalla, cero jerga técnica, accesible conforme a WCAG.
- Estándares: donde exista estándar internacional se usa (clínica, datos, seguridad, accesibilidad); donde solo haya norma nacional aplicable, esa; nunca se inventa un formato propio habiendo estándar. Toda desviación justificada se documenta en el código que la introduce.

## Mapa

- `apps/api` (Hono + `tsx watch`), `apps/worker` (ingesta/envío/agente), `apps/panel` (`app.odentia.localhost`, Vite), `apps/platform` (`odentia.localhost`, Vite)
- `packages/db` (drizzle + migraciones + RLS), `packages/services` (lógica de negocio), `packages/auth` (better-auth), `packages/channels` (adaptadores WhatsApp/Telegram), `packages/agent`, `packages/mail`, `packages/ui`
- `e2e/`, `infra/dev/` (compose, postgres custom `dentalagent-postgres:18.6`, `.env.example`)

## Setup dev

```sh
cp infra/dev/.env.example infra/dev/.env
# generar SECRETS_KEY: openssl rand -hex 32
# El .env debe tener finales LF: CRLF rompe `set -a && . ./infra/dev/.env`
pnpm install
pnpm --filter @odentia/db migrate
pnpm --filter @odentia/db seed:cie10   # prerrequisito de db:seed
pnpm --filter @odentia/db seed:procedures  # biblioteca CPMS oficial 1:1
pnpm db:seed                            # seed dev determinista (idempotente)
```

Infra: postgres :5432, minio :9000/:9001, mailpit :1025/:8025. En Windows el dev (`turbo dev`, proxies `portless` en 443) corre en Git Bash con `pnpm` en PATH.

Biblioteca CPMS: `pnpm --filter @odentia/db import:cpms` regenera los CSV desde el XLSX oficial y verifica SHA-256. La edición `RM-550-2023-MINSA` incluye las secciones 1.3 Odontología y 2.7 Salud Bucal completas (505 procedimientos); no afirma equivalencia con CDT/ICHI ni vigencia normativa posterior. `seed:procedures` concilia códigos, plantillas y procedencia en una transacción, conserva versiones retiradas y rechaza reactivar una edición retirada sobre otra vigente. La migración 0019 convierte las ofertas de las antiguas plantillas internas en propias sin cambiar precios ni snapshots clínicos.

## Comandos

```sh
pnpm dev | pnpm build | pnpm test | pnpm typecheck          # turbo, todo el repo
pnpm --filter @odentia/services test|typecheck              # por paquete
pnpm --filter @odentia/db generate|migrate|seed:cie10|seed:procedures
pnpm e2e --workers=2                                    # entorno efímero propio
```

## Tests

- DB y services usan testcontainers (`dentalagent-postgres:18.6`); en CI/local necesitan `DOCKER_HOST` apuntando al socket podman. Los `*.test.ts` fijan uno WSL por defecto con `??=` (sobrescribible por env).
- Cada test crea sus fixtures mínimas. `packages/services/src/seed-dev.ts` es solo manual: NUNCA importarlo en tests ni CI.
- Regla permanente: nueva pantalla o entidad → extender `seed-dev.ts` en la misma PR.

### E2E efímeros

- `pnpm e2e [specs] [opciones Playwright]` crea PostgreSQL, MinIO y Mailpit propios, un proxy HTTPS con CA temporal y builds independientes de panel/platform. No carga `.env`, no reutiliza dev ni sus puertos/datos y no admite `E2E_KEEP`/`E2E_HARNESS`. Playwright directo sin supervisor falla explícitamente.
- Prerrequisitos: Node >=24, `pnpm install`, `pnpm --filter @odentia/e2e exec playwright install chromium` y la imagen `dentalagent-postgres:18.6` (`podman build -t dentalagent-postgres:18.6 infra/dev/postgres`). Linux necesita además las dependencias de sistema de Chromium. No hace falta levantar compose ni ejecutar el seed manual.
- Windows nativo con la máquina Podman de este entorno (PowerShell): `$env:DOCKER_HOST='npipe:////./pipe/podman-machine-default'`; `$env:TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/run/podman/podman.sock'`; después `pnpm e2e`. Confirmar los nombres con `podman machine inspect` si la máquina es otra. El supervisor normaliza el pipe para Testcontainers sin cambiar de daemon.
- Linux/WSL: `DOCKER_HOST=unix:///ruta/al/socket pnpm e2e`; debe ser un socket accesible desde Node Linux. En Podman remoto, `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` designa el socket dentro del host de contenedores. Docker estándar puede usar autodetección. No se arranca ni reconfigura el runtime automáticamente.
- Dos workers por defecto; `--workers=1` o `E2E_WORKERS=1` reduce concurrencia. Sin retries. Cada caso tiene identidad/tenant independientes; solo hash y cliente DB cerrable se comparten por worker. Registro, verificación e invitaciones mantienen sus recorridos UI.
- `pnpm e2e cut.spec.ts --grep 'registro, verificación' --debug` conserva el entorno mientras está abierto el inspector. Al terminar, cerrar el inspector o pulsar Ctrl+C, el supervisor retira sus procesos, contenedores, volúmenes, CA y bundles. Ryuk sigue habilitado salvo configuración explícita del usuario. SIGKILL/apagón no ejecutan ese cierre: no prometer recuperación automática de procesos/archivos.
- Logs, resultados JSON, capturas y trazas fallidas quedan en `e2e/test-results/<runId>/`. `runtime.json` identifica recursos propios sin credenciales; las trazas sí pueden contener credenciales de prueba y son privadas. Las duraciones separan infraestructura, catálogos, builds, readiness, tests y cierre; comparar runs con el mismo estado de imágenes.
- Portless 0.15.6 está fijado y parcheado mediante pnpm para permitir `PORTLESS_HTTP_REDIRECT=0`: E2E no abre el puerto global 80. Solo el proceso del proxy amplía el intento TCP de Happy Eyeballs de 250 ms a 5 s, el mismo plazo HTTP del harness; evita cancelar IPv4 bajo carga antes de probar un IPv6 donde el preview no escucha. No desactiva TLS ni reintenta navegaciones.
- La resolución local de SSR vive en `scripts/local-network.mjs`, cargado explícitamente por los comandos dev de los frontends y los previews E2E. Solo resuelve `.localhost` a loopback mediante Undici; el resto usa DNS del SO. No forma parte del bundle productivo, no modifica hosts/DNS global y SSR sigue usando el origen HTTPS público por Portless.
- Verificación del corte (Windows x64, Node 24.11.1, Podman; imágenes ya disponibles): 25/25 con un worker (125,6 s total; 102,7 s tests) y 25/25 con dos (96,9 s total; 73,1 s tests), sin retries. Probados SSR autenticado en preview, Ctrl+C, caída del worker, cierre del inspector, rollback parcial y correo con más de 50 mensajes. Linux/WSL no se ejecutó: las distribuciones disponibles no tienen Node Linux. Tampoco se reinició dev para comprobar SSR dev; la prueba de aislamiento usa otra ejecución E2E como testigo.

## Convenciones de código

- TypeScript `strict`. Servicios en `packages/services/src`: toda función recibe `tx: Db` que YA corre con tenant (`withOrgContext` lo abren rutas/worker, nunca los servicios).
- Dos roles DB: `owner` (migraciones/seed, bypasea RLS) vía `DATABASE_URL`; `app` (runtime, sujeto a RLS) vía `APP_DATABASE_URL`.
- Tablas de dominio llevan `organization_id`; `cie10_code` e `inbound_event` son globales sin RLS.
- Secretos de conexión: AES-256-GCM vía `encryptJson`/`secretsKeyFromEnv` (`packages/services/src/secrets.ts`).
- Passwords: scrypt de `better-auth/crypto` (`hashPassword`); no hay otro hasher en el repo.
- Commits: `feat(scope): descripción` (ej. `feat(patients): ficha clínica completa`).

## Gotchas verificados

- `CHANNEL_VALIDATE_EXTERNAL=false` en dev/e2e para no llamar a Meta/Telegram al crear conexiones.
- Si `portless` dice `already registered by PID 0`: podar entradas muertas de `~/.portless/routes.json`. Si API y panel colisionan en puerto, reiniciar el stack para reasignar.
- `pnpm dev` en Windows falla con cmd: el script raíz usa sintaxis sh; lanzarlo desde Git Bash.
