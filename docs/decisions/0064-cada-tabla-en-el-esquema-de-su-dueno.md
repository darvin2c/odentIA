# 0064 · Cada tabla en el esquema de su dueño

Fecha: 2026-10-18 · Estado: aceptada · Complementa [0063](0063-una-tabla-nueva-nace-cerrada-al-rol-de-la-app.md)

## Problema

Las 185 tablas vivían en `public`. Las de la clínica (pacientes, citas, cobros) estaban mezcladas con las del negocio de odentIA (vendedores, comisiones, lista de precios, administración), con listas oficiales que nadie escribe y con las cuentas de acceso. Qué era de quién solo se sabía tabla por tabla, por un `REVOKE` o por el nombre. Y la protección de las tablas de odentIA dependía de que cada migración se acordara de cerrarlas: la 0063 encontró tres que habían quedado abiertas.

La frontera de aislamiento sigue siendo la organización (RLS). Separar por área (agenda, clínica, finanzas) no protegería nada, porque esas áreas comparten a la misma persona.

## Decisión y motivo

- **En `public` queda lo que pertenece a una clínica**: cada fila es de una clínica concreta. Incluye su suscripción, sus cobros de odentIA, su soporte, la clínica y su equipo (`organization`, `member`, `invitation`) y dos tablas técnicas que llegan antes de saber su organización (`inbound_event`, `webchat_rate_limit`).
- **`admin`**, el negocio de odentIA: administración, cuentas bloqueadas y su recuperación, vendedores con sus comisiones y liquidaciones, lista de precios, negociaciones, Fundadores, Libro de Reclamaciones y avisos legales.
  - El rol app entra al esquema, pero solo puede leer la lista de precios que la clínica ve al elegir plan y pagar.
  - La comisión del vendedor ya solo la escribía el admin al confirmar un pago, así que no cambia nada de lo que hace la clínica.
- **`catalog`**: diagnósticos, procedimientos y la biblioteca de plantillas. Es de solo lectura para el rol app.
- **`auth`**: usuarios, sesiones, credenciales, verificación y doble factor. Una persona puede trabajar en varias clínicas, así que no son de ninguna. El adaptador de Better Auth arma sus consultas con los objetos de Drizzle, que ya llevan el esquema.
- **Nombres en inglés**, como las tablas. Los prefijos de tabla no cambian.
- **El SQL a mano sigue nombrando la tabla sin esquema.** La base fija `search_path = public, catalog, auth, admin`, y `rls.test.ts` exige que ningún nombre se repita entre esquemas. Así se evitan unas 200 ediciones, casi todas en pruebas.

## Alternativas descartadas

- *Un esquema por área funcional:* daría orden aparente, no protección, y pondría llaves cruzando esquemas en todas partes.
- *Solo `admin`, con catálogos y cuentas en `public`:* deja en `public` tablas que no son de ninguna clínica, y la regla deja de leerse en una frase.
- *Un esquema `ops` para las dos tablas técnicas:* las dos son de una clínica, aunque todavía no lleven su `organization_id`.
- *Nombrar siempre el esquema en el SQL a mano:* es más explícito, pero obliga a cientos de cambios y a recordarlo en cada consulta nueva. La prueba de nombres únicos da la misma seguridad.

## Consecuencias

- Los permisos se leen por esquema. Una tabla nueva en `admin` no la ve ninguna clínica sin que nadie tenga que recordarlo, y en DbGate se ve de quién es cada tabla.
- Una tabla nueva tiene que nombrar su esquema en `schema/*.ts`. Si no lo hace, nace en `public`, cerrada (0063), y la prueba de RLS avisa si lleva `organization_id`.
- Las funciones que fijaban `search_path=public` pasaron a usar el camino completo.
- Revisar si Better Auth deja de aceptar el esquema `auth`, o si aparece un nombre de tabla que convenga repetir entre esquemas.

## Referencias

`packages/db/src/schema/schemas.ts`, `packages/db/drizzle/0034_cada_tabla_en_el_esquema_de_su_dueno.sql`, `packages/db/src/rls.test.ts`, `packages/db/AGENTS.md`.
