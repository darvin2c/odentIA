# 0198 · Una visita es la cita atendida o la atención firmada sin cita

**Fecha:** 16 nov 2026 · **Estado:** aceptada

## Problema

«Vino» se contaba de cuatro maneras. La base (`argos.pacientes`, migración 0047), la primera visita y el embudo de Reportes contaban también la atención firmada sin cita; «Última visita» de Pacientes, los activos, «volvieron» y «sin venir» de Reportes e «Invitar a volver» contaban solo la cita atendida. Quien se atiende sin reservar (la urgencia, la medida al paso de vistIA, Marta atendida dos veces hoy) salía con «Última visita —», no contaba como activa y la invitación a volver se calculaba como si nunca hubiera venido. «Invitar a volver» es un mensaje automático: cambiar la regla cambia a quién le llega.

## Decisión y motivo

Una visita es una cita atendida (sin las de prueba) o una atención firmada sin cita; la atención de una cita cuenta con su cita, nunca dos veces. Es una sola regla en SQL (`visitRowsSql`, `packages/services/src/report-visits.ts`), igual a la de la base, y la usan la primera y la última visita, los activos, «volvieron», «sin venir» e «Invitar a volver». El caso de la invitación es esa visita: su clave para no repetirla lleva el id de la cita o, sin cita, el de la atención; con una cita la clave no cambia, así que lo ya encolado no se duplica.

Es lo que la clínica entiende por «vino» y lo que ya decía la base: una sola respuesta en Pacientes, Reportes, Argos y los mensajes.

## Alternativas descartadas

- **Seguir contando solo la cita.** Deja sin última visita ni invitación a quien se atiende sin cita: en vistIA, a casi todos.
- **Crear una cita «atendida» al firmar una atención sin cita.** Inventa una reserva que nadie hizo y ensucia la Agenda y sus cifras de ocupación e inasistencia.
- **Contar también «Vino» o la atención sin firmar.** «Vino» ya deja la cita atendida; un borrador puede anularse y no es una visita registrada.

## Consecuencias

- Empieza a recibir «Invitar a volver» quien solo vino sin cita hace más de los meses del producto; deja de recibirla quien vino sin cita hace poco (al entregarla, `stillValid` la descarta). La línea solo toma a quien cumplió el plazo desde que se prendió (`activeSince`). Se mide por clínica y producto antes de unir.
- Las cifras de activos y «volvieron» cambian hacia atrás, y las citas de prueba dejan de contar en ellas.
- Las cifras de Argos que leen la vista `citas` (pacientes activos, volvieron, reactivados, días entre visitas) siguen contando solo la cita hasta que una vista de visitas las cubra; Pregúntale a Argos ya usa esta regla.
- Se revisa si una clínica necesita que una atención firmada sin cita no cuente como visita (por ejemplo, una atención solo administrativa).

## Referencias

`packages/services/src/report-visits.ts` (`visitRowsSql`, `lastVisitAtSql`, `firstVisitSql`), `report-patients.ts` (`attendedSql`, `lapsedSql`), `return-invites.ts` (`lapsedToInvite`), `automation.ts` (`syncLapsedInvites`), `people.ts`; `packages/db/drizzle/0047_pacientes_sin_cita.sql`; prueba `ultima-visita.test.ts`.
