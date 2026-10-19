# 0063 · Una tabla nueva nace cerrada al rol de la app

Fecha: 2026-10-18 · Estado: aceptada

## Problema

El rol de runtime `dentalagent_app` recibía por permiso por defecto lectura y escritura completas sobre cada tabla nueva de `public`. Cada migración tenía que acordarse de hacer `REVOKE` en las tablas que no son de la clínica. Olvidarlo no rompía nada: la tabla solo quedaba abierta a cualquier conexión de clínica, sin que ninguna prueba lo notara.

Ya había pasado: `saas_seller` (con el porcentaje de cada vendedor), `saas_commission_settlement` y `saas_commission_settlement_line` (lo pagado a cada vendedor, con la clínica de cada línea y sin RLS) eran legibles por el rol app. Sin embargo, solo el admin las usa, siempre con owner.

## Decisión y motivo

- **Los permisos por defecto de `public` ya no conceden nada al rol app** (migración 0033). Cada migración que crea una tabla concede con `GRANT` lo que la aplicación necesita, como ya hacían todas las migraciones de reglas desde la 0001. Olvidar el `GRANT` falla al primer uso, de forma visible. Olvidar un `REVOKE` fallaba en silencio.
- **Vendedores y liquidaciones quedan sin acceso para el rol app.** Siguen en `public`, sin moverse de esquema.
- **`rls.test.ts` lo vigila**: una tabla nueva no da acceso al rol app, y toda tabla con `organization_id` que ese rol alcance tiene RLS. Las únicas excepciones son `member` e `invitation`, del adaptador de identidad.

## Alternativas descartadas

- *Mover lo que no es de la clínica a un esquema `admin`:* también protege, pero mueve unas 14 tablas y su SQL. Queda estudiado y sin decidir. Esta decisión no lo impide.
- *Mantener el permiso por defecto y solo añadir la prueba:* la prueba no distingue una tabla de la clínica olvidada de una de odentIA abierta por error.

## Consecuencias

- Una tabla nueva sin su `GRANT` responde «permission denied» al rol app. Hay que concederlo en la migración de reglas, junto con su RLS.
- El init de la imagen (`infra/dev/postgres/init/01-role.sh`) sigue concediendo por defecto. La 0033 lo retira después de crear las tablas de la base, así que una base nueva y una migrada terminan iguales.

## Referencias

`packages/db/drizzle/0033_tablas_nuevas_cerradas_a_la_app.sql`, `packages/db/src/rls.test.ts`, `packages/db/AGENTS.md`.
