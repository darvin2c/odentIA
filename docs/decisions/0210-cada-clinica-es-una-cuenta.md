# 0210 · Cada clínica es una cuenta

Fecha: 2026-11-21 · Estado: aceptada · Paso 3 del lienzo A («una sola administración para todas las apps»)

## Problema

La suscripción, los cargos y sus líneas, los pagos, las comisiones, los avisos del ciclo, lo que
se cuenta para cobrar (acciones, almacenamiento, revisiones) y los casos de soporte colgaban de
la organización de una clínica (`organization_id`, con clave foránea a `organization`). El paso 4
necesita que la administración tenga un plan, cargos, pagos y soporte para una cuenta de una app
que no es una clínica, como una tienda de gestorIA, que vive en otra base y no tiene organización
aquí (ADR 0203). Las clínicas en producción tienen cobros reales: antes y después tienen que dar
igual sus cargos, sus pagos y sus saldos, sin pasos a mano y sin que nadie note el cambio.

## Decisión y motivo

- **La cuenta de cliente es una tabla de la administración** (`admin.saas_account`): a quién le
  cobra y le da soporte la administración. No es la cuenta de la persona (`auth.user`). Todo lo
  del cobro y del soporte cuelga de ella; el acceso de soporte a los datos de una clínica
  (`support_access_grant`, `support_access_audit`) sigue con la organización, porque es acceso a
  esa clínica.
- **Una clínica es la cuenta con su mismo id.** Para cada organización hay una cuenta con
  `id = organization_id`; la migración la crea para las que ya existen (determinista e
  idempotente) y la base la crea al crear cada clínica nueva, por cualquier vía. Así ningún dato
  se mueve ni se reescribe: los cargos, los pagos y los saldos son las mismas filas, la RLS de la
  clínica es la misma y ningún servicio cambia lo que lee. Lo único que cambia es a qué apuntan
  las claves foráneas, con lo mismo al borrar: la organización se lleva su cuenta y la cuenta lo
  suyo.
- **Una cuenta de otra app no tiene organización**: guarda su app (solo una que es otro sistema,
  `SAAS_ACCOUNT_EXTERNAL_APPS`; una de odentIA, latidIA o vistIA siempre es una clínica) y su
  referencia en ese sistema (`external_ref`, una por cuenta y app). Su id nunca es el de una
  clínica, porque toda clínica ya tiene la suya con ese id, y una clínica nueva no puede tomar el
  id de una cuenta que ya existe: la RLS de una clínica nunca alcanza lo de otra app.
- **La app de una clínica no se guarda en su cuenta**: es la de su producto, que no cambia
  (ADR 0087). Guardarla dos veces abriría la puerta a que no coincidan.
- **Las columnas se siguen llamando `organization_id`.** En una clínica es su organización; en
  una cuenta de otra app, el id de la cuenta. Cambiarles el nombre obliga a dos despliegues
  (`migrate` corre antes que la API) y a tocar cada consulta del cobro, sin cambiar lo que pasa.

## Alternativas descartadas

- **Una columna `account_id` nueva en cada tabla**, copiada desde `organization_id` y leída en su
  lugar: dos fuentes de la misma verdad durante la transición, unos sesenta archivos que leen el dinero
  reescritas, la RLS de la clínica igual sobre `organization_id`, y el borrado de lo viejo en otra
  entrega. Más riesgo en dinero para llegar al mismo modelo.
- **Colgar el cobro del cliente del ARM (`saas_client`)**: el cliente existe desde el primer
  contacto, no todas las organizaciones tienen uno (las demos nunca) y su id es otro: habría que
  mover datos.
- **Guardar la app también en la cuenta de la clínica**: el disparador del alta no conoce todavía
  el producto (`org_profile` llega después) y serían dos fuentes.

## Consecuencias

- El paso 4 abre una cuenta de gestorIA insertando su fila con su app y su tienda, y le cuelga
  suscripción, cargos, pagos y soporte con las mismas tablas, sin tocar a las clínicas.
- Antes de que exista la primera cuenta de otra app, el paso 4 tiene que separar lo que solo es
  de clínicas: el ciclo del cobro (`tickSaasBilling`, `closeSaasPeriods`,
  `generateSaasPeriodCharges`) y los avisos asumen una clínica (su nombre, su panel, sus
  propietarios); los planes son de un producto clínico (`saas_plan.product`); y las listas de la
  administración parten de las organizaciones.
- El nombre `organization_id` en esas tablas ya no dice toda la verdad: renombrarla a
  `account_id` queda pendiente, si se decide, en dos entregas.
- Una demo que se borra con los disparadores apagados (`demo-build.ts`) borra también su cuenta.

## Referencias

`packages/db/src/schema/admin-accounts.ts`, migración `0152_cada_clinica_es_una_cuenta.sql`
(`saas_account_on_org_create`), `packages/services/src/saas-account.test.ts` (los cobros de cada
clínica antes y después de la migración), lienzo A, tableros 5 y 12.
