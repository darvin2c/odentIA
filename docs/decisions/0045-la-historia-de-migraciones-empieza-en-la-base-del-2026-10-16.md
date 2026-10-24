# 0045 · La historia de migraciones empieza en la base del 2026-10-16; las anteriores están en git

Fecha: 2026-10-16 · Estado: sustituida por [0088](0088-la-historia-de-migraciones-empieza-en-la-base-del-2026-10-24.md)

## Problema

Había 108 migraciones (0000 a 0107) que contaban cómo se fue armando la base, con rellenos de datos de clínicas que nunca existieron en producción. Cada base nueva (cada contenedor de prueba, el e2e, cada preview) las aplicaba todas. Las fotos de drizzle-kit se habían quedado en la 0086, así que `generate` ya no podía comparar el esquema: preguntaba por renombres y, respondido, repetía lo ya hecho. Las fechas del journal desde la 0087 eran a mano y el migrador salta en silencio una migración con fecha anterior a la última aplicada. Además, el esquema TS había dejado de describir la base en varios puntos (nombres de claves foráneas, borrados en cascada, índices y un CHECK).

## Decisión y motivo

- **Dos archivos reemplazan a los 108.** `0000_base.sql` lo genera drizzle-kit desde `packages/db/src/schema/*.ts` (con su foto `0000_snapshot.json`), con las extensiones al inicio y los índices antes que las claves foráneas. `0001_base_reglas.sql`, escrito a partir de la base real, agrega por tabla lo que TS no declara: RLS y `FORCE`, políticas, permisos del rol de la aplicación, funciones, disparadores, CHECK, `EXCLUDE`, claves compuestas que TS no puede declarar sin ciclos, las colas de pgmq, el trabajo de pg_cron y las listas de diagnóstico. Cada bloque conserva el porqué de las migraciones de donde vino.
- **Se comprobó que dan la misma base.** Una base con las 108 y otra con las 2, volcadas y normalizadas (esquema, colas, cron, permisos de tablas, columnas y funciones, políticas, disparadores y RLS), solo difieren en el orden físico de las columnas, los nombres automáticos de los NOT NULL y `treatment_budget.plan_id`, que pasa a NOT NULL como declaraba el esquema TS desde su creación (la migración 0013 lo rellenó sin exigirlo). Sobre la base nueva, `generate` dice que no hay cambios.
- **El esquema TS se corrigió para describir la base**, no al revés: nombres de claves foráneas de las tablas creadas a mano, borrados en cascada, restricciones `UNIQUE` de cobro y el CHECK de categorías de documentos de la 0106.
- **Una prueba del journal** (`journal.test.ts`) exige `when` estrictamente creciente y que número y archivo coincidan. Así una rama con fecha atrasada falla en CI en vez de saltarse en silencio.
- **Se hace ahora** porque no hay datos reales: con producción, aplastar exigiría reescribir a mano `drizzle.__drizzle_migrations` en cada base.

## Alternativas descartadas

- **Seguir con las 108.** Cada base nueva paga transformaciones vacías y `generate` sigue roto.
- **Volcar la base con `pg_dump` como única migración.** Pierde los porqués, trae `SET search_path = ''` y deja a drizzle-kit sin foto del esquema.
- **Una plantilla de base para las pruebas.** Acelera, pero no arregla `generate` ni el journal.

## Consecuencias

- Beneficio: una base nueva se arma con dos archivos legibles; `generate` vuelve a producir solo el cambio pedido.
- Sacrificio: una base creada antes no se migra a la nueva: hay que recrear su volumen (`docs/development.md`). Las pruebas que solo probaban transformaciones de migraciones viejas se borraron; lo que aseguraban del estado final pasó a `rls.test.ts`.
- Revisar si alguna vez hay que aplastar con datos reales: entonces hace falta un procedimiento para `__drizzle_migrations`.

## Referencias

`packages/db/drizzle/`, `packages/db/src/journal.test.ts`, `infra/dev/postgres/init/01-role.sh` (rol y permisos por defecto). Las migraciones anteriores: `git show 405b732:packages/db/drizzle/`.
