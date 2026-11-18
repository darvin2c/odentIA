# gestorIA

La app del Grupo Sallca para quien vende productos con envío por WhatsApp, Instagram y Messenger
(lienzo B). Es otro sistema: 100 % aparte de las clínicas (ADR 0203). Comparte solo la cuenta
única (ADR 0201) y, más adelante, la administración.

## Límites

- Nunca importa paquetes de las clínicas (`apps/`, `packages/`) ni de la administración (`admin/`),
  ni ellas a gestorIA: lo prueba `apps/api/src/gestoria-boundaries.test.ts`. Usa lo de uso general
  (`shared/packages/`) como biblioteca. Si algo de las clínicas le sirve, se mueve a `shared/` en
  su propio cambio.
- Nunca lee la base de las clínicas. La persona llega con el token firmado de la cuenta
  (`apps/api/src/cuenta.ts`, `aud` gestoria); lo que gestorIA guarda de ella es su copia
  (`account_copy`), que nadie edita: se pone al día con cada token, con los avisos firmados de la
  cuenta (`/avisos/cuenta`) y con la revisión diaria.
- Su base es `gestoria` (`packages/db`), con sus migraciones y sus reglas por tienda (RLS). Toda
  tabla nueva nace cerrada a `gestoria_app`: su migración de reglas concede solo lo que la
  aplicación usa. Lo que hace el sistema por su cuenta (avisos, revisión, la copia) usa el dueño.
- Sus variables llevan `GESTORIA_` (nunca `DATABASE_URL` a secas): así no toma la base ni la cuenta
  de las clínicas por error.

## Tiendas y permisos

- Una persona puede tener o atender varias tiendas y elige al entrar (decisión 8). Cada tienda
  vende en una sola moneda (ISO 4217), la que eligió al crearse (decisión 9).
- Roles (decisión 7): Dueño, con todo y el plan; Administrador, todo menos el plan; Ventas atiende,
  confirma pagos y entrega, sin tocar la configuración ni el equipo. La matriz única es
  `apps/api/src/permisos.ts`; el servidor la aplica en cada pedido. Solo un Dueño da, quita o toca
  el rol de Dueño, y una tienda nunca se queda sin Dueño.
- La tienda de cada pedido sale del equipo de la persona, nunca del navegador (`inStore`).
- Una invitación se acepta solo entrando con la cuenta del correo invitado; el enlace no basta.
  No cambia lo que dice: se anula y se hace otra. Cada cambio del equipo queda en `store_event`
  con quién lo hizo.

## Trabajo

- Sin mesa de voces: es una app más simple. Del plan a construir, con pruebas y revisión.
- La tienda de ejemplo es Calzados Rosa (`apps/api/src/semilla.ts`, `seed:dev`): cada entrega le
  suma lo suyo. Nunca se importa en pruebas ni corre en producción.
- Local: `gestoria/infra/dev/.env` (desde `.env.example`), `pnpm --filter @gestoria/db migrate`,
  `pnpm --filter @gestoria/api local` y `pnpm --filter @gestoria/web local`. La entrada necesita la
  API de las clínicas con `GESTORIA_DOMAIN`. No corren con el `pnpm dev` de la raíz.
- Pruebas: `pnpm --filter @gestoria/db test` y `pnpm --filter @gestoria/api test` (PostgreSQL con
  testcontainers, imagen `postgres:18.6-bookworm`).
