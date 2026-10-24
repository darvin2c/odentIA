# 0088 · La historia de migraciones empieza en la base del 2026-10-24; las anteriores están en git

Fecha: 2026-10-24 · Estado: aceptada · Sustituye a [0045](0045-la-historia-de-migraciones-empieza-en-la-base-del-2026-10-16.md)

## Problema

Desde la base del 2026-10-16 se juntaron 106 migraciones (0000 a 0105): renombres neutros (ADR 0079), tablas mudadas a su esquema (ADR 0064 y 0079), rellenos de datos de clínicas que nunca existieron y vistas de Argos redefinidas varias veces. Cada base nueva (cada contenedor de prueba, el e2e, cada preview) las aplicaba todas, y para saber qué regla vale hoy en una tabla había que leer la historia completa. Producción todavía no tiene clínicas: solo catálogos, la política de alta y las condiciones comerciales, que las migraciones crean de nuevo.

## Decisión y motivo

- **Dos archivos reemplazan a los 106**, con la forma de la ADR 0045. `0000_base.sql` lo genera drizzle-kit desde `packages/db/src/schema/*.ts` (con su foto `0000_snapshot.json`), con las extensiones al inicio y los índices antes que las claves foráneas. `0001_base_reglas.sql` agrega por tabla lo que TS no declara.
- **Las reglas salen de la base real, no de releer la historia.** Se aplicaron las 106 en una base y solo `0000` en otra, y cada objeto que faltaba (funciones, CHECK, `EXCLUDE`, índices, RLS y `FORCE`, políticas, disparadores, permisos, claves compuestas y vistas de Argos) se copió con la definición de `pg_dump`. Así no se arrastran renombres ni mudanzas. Cada objeto conserva el comentario del porqué de la migración que lo creó: «(de la NNNN del 24-oct)» es de esas 106 y «(de la NNNN del 16-oct)», de las 108 anteriores. Una vista y un CHECK usan su texto original, porque PostgreSQL los reescribe con otra forma al leerlos.
- **Se comprobó que dan la misma base.** Comparadas por objeto (esquema con dueños, permisos de tablas, columnas y funciones, políticas, disparadores, RLS, colas de pgmq y el trabajo de pg_cron), más los roles con sus membresías, el `search_path` de la base y los datos, solo difieren en el nombre automático de un NOT NULL de `saas_payment_method`, que no tiene efecto. Sobre la base nueva, `generate` dice que no hay cambios.
- **El esquema TS se corrigió para describir la base**: tres índices únicos `(organization_id, id)` (`patient_document`, `service_catalog` y `branch`) vivían solo en las reglas, aunque claves foráneas declaradas en TS apuntaban a ellos.
- **Se hace ahora** porque no hay datos reales. Producción se recrea vacía antes del siguiente despliegue.

## Alternativas descartadas

- **Seguir con las 106.** Cada base nueva paga renombres y rellenos vacíos, y lo vigente de una tabla queda repartido en decenas de archivos.
- **Reescribir a mano la 0001 vieja sumándole lo nuevo.** Sus sentencias nombran tablas y columnas que ya no existen (`schedule_chair`, el esquema `public` de las tablas mudadas). Sería fácil equivocarse y nada garantizaría el resultado sin la misma comparación.
- **Volcar la base con `pg_dump` como única migración.** Pierde los porqués y deja a drizzle-kit sin foto del esquema (ADR 0045).

## Consecuencias

- Beneficio: una base nueva se arma con dos archivos. Lo que vale hoy en cada tabla se lee en un solo lugar.
- Sacrificio: una base creada antes no se migra a la nueva: hay que recrear su volumen (`docs/development.md`), también el de producción. Una rama abierta con migraciones nuevas tiene que regenerarlas sobre esta base.
- Revisar si alguna vez hay que aplastar con datos reales: entonces hace falta un procedimiento para `drizzle.__drizzle_migrations`.

## Referencias

`packages/db/drizzle/`, `packages/db/src/journal.test.ts`, `infra/dev/postgres/init/01-role.sh` (rol y permisos por defecto). Las migraciones anteriores: `git show 5aa7b2cc:packages/db/drizzle/`.
