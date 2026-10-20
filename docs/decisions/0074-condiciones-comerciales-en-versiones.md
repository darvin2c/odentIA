# 0074 · Las condiciones comerciales viven en versiones y cada regla usa la de su día

Fecha: 2026-10-20 · Estado: aceptada · Amplía a [0031](0031-cobro-por-accion-con-un-plan-que-vuelve-en-credito.md) y [0054](0054-spam-y-bloquear.md)

## Problema

Las reglas que acompañan al precio estaban escritas en el código (issue 167): la ventana de una conversación, el plazo de la cita recuperada, el spam que se devuelve al instante, los plazos de la revisión de cobros, los días para pagar, la gracia, la espera por un comprobante, el cobro quincenal, la prueba sin plan por defecto, los avisos del tope, la respuesta a una invitación, los meses de comisión y con cuántos días de anticipación se avisa el fin de un precio especial o de lo garantizado a una Fundadora. Cambiar una exigía programar y desplegar, y la web, la plataforma y la administración las repetían a mano: ya no coincidían.

Una regla cambiada no puede reescribir lo que ya empezó. Si Rosa reservó cuando el plazo de cita recuperada era de 7 días, su cita no deja de contar porque después se baje a 3.

## Decisión y motivo

- **Una tabla de versiones, `saas_commercial_terms` (esquema `admin`).** Cada cambio agrega una fila que rige desde que se guarda (`effective_from`). Ninguna se reescribe ni se borra: lo impide un disparador. La primera versión son los valores que estaban en el código, vigentes desde siempre, para que desplegar no cambie nada.
- **Cada regla usa la versión del día en que empezó lo que mide.** La conversación, el día del mensaje. La cita recuperada, el día de la reserva (en el mismo SQL de `recoveredSql`). La revisión, el día en que se pide. El plazo de pago, el día en que se emite el cargo. El cobro quincenal, el día en que empieza el tramo. La gracia y la espera por comprobante, el día en que empiezan. La prueba, el día en que se abre la clínica (también en el disparador de la base). La invitación, el día de la solicitud. La comisión, el día en que entra la clínica. Los avisos (del tope, del fin de un precio especial y del fin de lo garantizado a una Fundadora) solo avisan: usan la versión de hoy.
- **El historial son las mismas versiones con que se calcula.** «Ver cambios» compara cada versión con la anterior; lo que dice coincide siempre con lo que se cobró. Cada cambio también queda en la auditoría de la administración, con antes, después y el motivo si se escribió.
- **El servicio arma las palabras.** Frases, nombres, límites y «desde cuándo rige» viven en `saas-commercial-terms.ts`. La web las recibe con los precios, y el panel, la plataforma y la administración, por sus rutas. Nadie repite una cifra.
- **Solo la administración las cambia; el rol app solo las lee.** La aplicación cuenta conversaciones y citas dentro del contexto de la clínica, así que necesita leerlas. Si dos personas editan a la vez, la segunda recibe «Alguien cambió estas condiciones…» en vez de pisar el cambio.

## Alternativas descartadas

- *Una fila única que se actualiza, como `saas_signup_policy`.* Un cambio alcanzaría hacia atrás lo que ya empezó (una reserva hecha, una gracia en curso) y el historial tendría que reconstruirse desde la auditoría.
- *Condiciones por plan.* Son reglas del negocio de odentIA, iguales para todas las clínicas; repetirlas en cada plan multiplica lo que hay que mantener al día.
- *Copiar cada condición en la fila que la usa (cargo, suscripción, reserva).* Algunas ya se guardan así (fecha de pago, fin de la gracia). Hacerlo con todas obliga a una columna nueva por regla en tablas de la clínica.

## Consecuencias

- **Beneficio:** una cifra se cambia en Cobros y planes y la web, el panel y los correos la dicen en menos de un minuto.
- **Sacrificio:** cada cálculo que usa una regla lee la versión de su día; el ciclo del cobro las carga una vez por vuelta.
- **Fuera de esta decisión:**
  - El peor costo de cada acción y el mínimo del doble (`SAAS_WORST_COST_MICROS`, `SAAS_PRICE_FLOOR_MULTIPLE`) salen de medir la IA, no de una decisión comercial.
  - Avisar a las clínicas de un cambio va con la cláusula de ajuste (issue 79).
- **Revisar si:** una condición pasa a negociarse por clínica.

## Referencias

- `packages/services/src/saas-commercial-terms.ts`
- `packages/db/drizzle/0050_condiciones_comerciales.sql`
- `packages/db/drizzle/0051_condiciones_comerciales_reglas.sql`
- `apps/admin/src/components/commercial-terms.tsx`
- Lienzo «Condiciones comerciales odentIA», aprobado el 2026-10-20.
