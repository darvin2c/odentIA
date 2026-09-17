# AGENTS.md — odentIA

Monorepo pnpm 9.15 + turbo. Node >= 24. Comentarios, mensajes de error y commits en español.

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
pnpm --filter @odentia/e2e test
```

## Tests

- DB y services usan testcontainers (`dentalagent-postgres:18.6`); en CI/local necesitan `DOCKER_HOST` apuntando al socket podman. Los `*.test.ts` fijan uno WSL por defecto con `??=` (sobrescribible por env).
- Cada test crea sus fixtures mínimas. `packages/services/src/seed-dev.ts` es solo manual: NUNCA importarlo en tests ni CI.
- Regla permanente: nueva pantalla o entidad → extender `seed-dev.ts` en la misma PR.

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
