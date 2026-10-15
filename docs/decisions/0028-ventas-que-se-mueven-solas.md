# 0028 · Ventas que se mueven solas, tareas que se cierran solas

Fecha: 2026-10-15 · Estado: aceptada · Ajusta a [0023](0023-el-administrador-detecta-y-recepcion-habla.md) («Retomar una oportunidad» trabaja sobre la tarea de la oportunidad)

## Problema

El tablero de oportunidades dependía de que alguien moviera cada tarjeta a mano. En una clínica mediana eso no pasa, y el tablero decía algo que no era cierto: la persona agendaba su evaluación y su tarjeta seguía en «Nuevo»; aceptaba el presupuesto y nada cambiaba. Además, cada identidad nueva creaba una oportunidad «Seguimiento · …» aunque solo dijera «hola», y luego el agente creaba la concreta: dos por persona, una línea del Administrador que pedía asignarlas y un «% ganadas» inflado.

La próxima acción vivía en tres sitios (un campo de la oportunidad, una tarea sincronizada con ese campo y la tarea del Administrador), ninguno se cerraba cuando el agente ya había escrito, y las tareas del Administrador quedaban abiertas aunque la cita ya hubiera pasado.

## Decisión y motivo

- **Una oportunidad es un interés concreto.** La crea el agente cuando la persona pide algo concreto (precio, tratamiento, evaluación) o el equipo; nunca un «hola». No se duplica una abierta del mismo interés (mismo contacto, paciente y servicio o título): el agente sigue con la que ya existe y el equipo recibe el aviso. Con servicio, su valor es el precio de la lista de precios. Sin responsable es de Recepción hasta que alguien la toma, así que la línea «Seguimiento sin responsable» sobra.
- **Cuatro pasos fijos con su momento** (`pipeline_stage.moment`): Interesado, Evaluación agendada (al agendar una cita para esa persona), Presupuesto enviado (al presentarle un presupuesto) y Decidió (al aceptarlo, aunque sea en parte, o rechazarlo). La clínica puede renombrarlos, nunca añadir ni quitar pasos: un paso sin momento no podría alcanzarse solo. Ya no se crean embudos desde la API.
- **Lo que pasa y lo que hace el equipo son la misma operación.** `moveOpportunity` y `closeOpportunity` reciben quién lo hizo (`origin`: persona, agente o automático) y, cuando pasó sola, por qué (`cause`, `cause_at`). El historial y la tarjeta lo dicen con palabras y la fecha de la clínica: «Pasó sola: agendó su evaluación para el jue 17». Solo se avanza hacia adelante; el presupuesto se une a la oportunidad abierta del mismo tratamiento o, si no hay, a la más reciente.
- **Una sola forma de cerrar**, con motivos de una lista (precio, eligió otra clínica, no responde, ya no lo necesita, otro; y los dos que pone el sistema, «Aceptó el presupuesto» y «Rechazó el presupuesto»). El tablero muestra lo abierto y lo decidido en 30 días; su total suma solo lo abierto.
- **La próxima acción es una tarea, y solo una** (único parcial por oportunidad abierta). «Retomar una oportunidad» trabaja sobre ella: si vence, el agente escribe y la tarea se da por hecha; si no puede, la misma tarea queda para quien la lleva, sin crear otra.
- **Las tareas se cierran solas cuando su motivo desaparece**, con una sola regla (`settleTasks`, en cada ciclo del worker): la de una oportunidad cerrada y la que dejó el Administrador cuando su caso ya no aplica (`stillValid`). Quedan hechas con `settled_reason`, que la pantalla dice como «Se cerró sola: …».

## Alternativas descartadas

- *Etapas libres con reglas configurables*: la clínica tendría que diseñar un embudo y mantener sus disparadores; el tablero volvería a depender de que alguien lo cuide.
- *Conservar la oportunidad automática y ocultarla*: seguiría inflando cifras y obligando al agente a elegir entre dos.
- *Cerrar las tareas vencidas por tiempo*: una llamada pendiente no deja de hacer falta porque pasen días; se cierra cuando su motivo desaparece.

## Consecuencias

- Migración `0082`: borra las oportunidades «Seguimiento · …» sin ningún dato de un interés, lleva cada embudo a los cuatro pasos (las de «Contactado» y otras etapas abiertas pasan a Interesado; las cerradas, a Decidió), convierte la próxima acción suelta en su tarea, deja una sola tarea abierta por oportunidad, guarda el texto libre de los cierres como nota y retira la línea «Seguimiento sin responsable».
- El tablero y Reportes dicen la verdad sin mantenimiento; Reportes muestra por qué se pierden las ventas.
- Sacrificio: una clínica que tenía etapas propias pierde esas columnas; puede renombrar los cuatro pasos.
- Se revisa si hace falta un quinto momento (por ejemplo, el tratamiento empezado) o si una cita cancelada debe devolver la oportunidad.

## Referencias

- `packages/services/src/opportunities.ts`, `pipelines.ts`, `tasks.ts` (`pageTasks`, `settleTask`), `automation.ts` (`syncOpportunityFollowUps`, `settleTasks`, `leaveTask`), `appointments.ts`, `budgets.ts`, `admin-lines.ts`.
- `apps/platform/src/routes/_org/pipeline.tsx`, `components/crm/opportunity-panel.tsx`, `close-opportunity-dialog.tsx`, `routes/_org/tasks.tsx`.
- Migración `0086_ventas_que_se_mueven_solas`.
