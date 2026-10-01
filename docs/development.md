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

`.env` con finales LF: CRLF rompe su carga en sh. Los scripts tsx de db/services cargan `infra/dev/.env` con `--env-file-if-exists`; variables existentes tienen prioridad. Semilla manual determinista/idempotente, no para tests/CI.

Infra definida en `infra/dev/compose.yaml`: PostgreSQL :5432, MinIO :9000/:9001 y Mailpit :1025/:8025. En Windows lanzar `pnpm dev` desde Git Bash con pnpm en PATH; proxies Portless en 443. Panel: `app.odentia.localhost`; plataforma: `odentia.localhost`.

## Verificación

- `pnpm build|test|typecheck`: monorepo mediante Turbo; `pnpm --filter @odentia/services test|typecheck`: paquete.
- DB/services usan Testcontainers con `dentalagent-postgres:18.6`; construir con `podman build -t dentalagent-postgres:18.6 infra/dev/postgres`.
- Instalar Chromium: `pnpm --filter @odentia/e2e exec playwright install chromium`. Linux requiere dependencias de sistema del navegador.
- `pnpm e2e --workers=2` crea entorno efímero sin `.env`, compose dev ni semilla manual. Reglas en `e2e/AGENTS.md`.
- Windows/Podman (PowerShell): `$env:DOCKER_HOST='npipe:////./pipe/podman-machine-default'` y `$env:TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/run/podman/podman.sock'`. Confirmar nombre con `podman machine inspect` si cambia la máquina.
- Linux/WSL: `DOCKER_HOST=unix:///ruta/al/socket pnpm e2e`; socket accesible desde Node Linux. En Podman remoto, el override del socket apunta al host de contenedores. Docker estándar puede autodetectarse.
- Tests de paquetes fijan socket WSL con `??=`; sobrescribir por entorno cuando corresponda. No arrancar/reconfigurar runtime automáticamente.

## Herramientas de contexto

- TypeScript del workspace y `typescript-language-server` son dependencias de desarrollo raíz. `pnpm install` instala el servidor; OMP lo detecta por binario local y marcador de proyecto. Tras instalar, recargar LSP (`reload`, `file: "*"`).
- En VS Code usar la versión TypeScript del workspace (`node_modules/typescript/lib`); Biome conserva formato y lint. No confundir lint con navegación semántica.
- Antes de cambios de contratos consultar definiciones/referencias mediante LSP. No guardar mapas de símbolos en Markdown.
- Skills propias en `.agents/skills`; UX en `odentia-ux`, arquitectura en `odentia-arch`. Si el cliente no las descubre automáticamente, leer su `SKILL.md` explícitamente. No requieren instalar skills globales.

## Problemas operativos conocidos

- `CHANNEL_VALIDATE_EXTERNAL=false` en dev/e2e evita contactar Meta/Telegram al crear conexiones.
- Portless `already registered by PID 0`: comprobar entradas muertas de `~/.portless/routes.json` antes de retirarlas. Colisiones de puertos API/panel: reiniciar el stack para reasignar.
- Portless 0.15.6 está fijado y parcheado en `patches/portless@0.15.6.patch`: `PORTLESS_HTTP_REDIRECT=0` evita puerto 80 en E2E; configuración OpenSSL mínima evita `basicConstraints` duplicado en la CA.
- Ante TLS `unable to verify the first certificate`, inspeccionar CA del state dir afectado. Si es inválida, regenerar sus `ca*.pem`, `server*.pem` y `host-certs/` reiniciando solo ese proxy; no desactivar validación TLS ni modificar confianza global como solución.
- `scripts/local-network.mjs` resuelve `.localhost` a loopback con Undici en dev/previews SSR. No pertenece al bundle productivo ni cambia hosts/DNS global.
- Si loopback Windows no entrega saludo SMTP pero HTTP funciona, comprobar conectividad a la máquina Podman antes de usar su IP con `TESTCONTAINERS_HOST_OVERRIDE`; no omitir readiness.

Resultados, duraciones y límites de cada ejecución pertenecen al reporte/PR, no a esta guía.
