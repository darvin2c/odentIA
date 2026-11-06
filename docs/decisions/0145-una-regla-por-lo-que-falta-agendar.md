# 0145 · Lo que falta agendar: una regla por pregunta, en todas las pantallas

Fecha: 2026-11-06 · Estado: aceptada · Sigue a [0118](0118-cada-numero-donde-se-resuelve.md) (cada número donde se resuelve) · Ajusta a [0025](0025-un-pendiente-un-lugar.md) y [0127](0127-inicio-por-grupos-y-un-solo-panel.md) (la fila de Inicio de los controles)

## Problema

La ronda de QA del 2026-11-04 contó la misma pregunta con un número distinto en cada pantalla:

- **«Aceptó y no tiene cita»:** Inicio y Reportes contaban a la persona sin ninguna cita por venir (204); Pacientes › «Por agendar» y «Qué sigue», el tratamiento que ninguna cita lleva, un solo paso por persona (256); Argos, el presupuesto sin ninguna cita de la persona, con sus días (202). «Qué sigue» decía «falta su cita» a quien tenía otra.
- **Los controles:** Pacientes › «Control por reservar» contaba el próximo control de cada uno, también el futuro y el que ya tiene cita (272); Argos, el vencido de quien no tiene ninguna cita (124); Inicio no lo mostraba.

## Decisión y motivo

- **Una regla por pregunta, en código y en SQL** (`packages/services/src/to-schedule.ts`), que usan Inicio, Pacientes, «Qué sigue», la coordinación de recepción, Reportes y Argos:
  - *Aceptó y no tiene cita:* un tratamiento aceptado que aún se hace (pendiente, programado o en curso: lo que una cita puede traer) y que ninguna cita por venir lleva. Otra cita de la persona no lo agenda: un tratamiento necesita su tiempo, y «Qué sigue» y Argos dicen «su cita del 12 dic no lo lleva».
  - *Control vencido sin cita:* un control pendiente cuyo día ya pasó en la zona de la clínica, de una persona sin ninguna cita por venir. A un control le sirve cualquier visita.
- **Los atajos «Por agendar» y «Control vencido» de Pacientes son esa regla**, no un paso de «Qué sigue»: alguien puede estar en «Por agendar» aunque su siguiente paso sea enviar otro presupuesto. Así el número es el mismo que el de Inicio. Los atajos de presupuestos siguen el paso de «Qué sigue».
- **Argos usa la misma regla y suma sus días** (0015): el título los nombra («hace más de 7 días»). Cuenta presupuestos y controles; Pacientes, personas: cuando no coinciden, el título dice las dos cifras.
- **Inicio lleva a donde se resuelve** (0118): lo aceptado sin cita es una fila que abre Pacientes › «Por agendar», con «Reservar cita» en cada persona. Los controles vencidos son la línea de Argos «Avisar un control»: Inicio trae una fila con su misma consulta que abre su misma lista, salvo que Argos ya la recomiende ahí; entonces es esa fila. Nunca las dos (0025, 0127). Prendida, la línea avisa antes de que el control toque ([0141](0141-en-una-clinica-nueva-todo-viene-encendido.md) la prende en toda clínica nueva); lo que ya venció sigue saliendo en la fila.

## Alternativas descartadas

- *«Sin cita» por persona también para los tratamientos:* volvía a decir que no falta nada a quien tiene una limpieza mañana y una corona sin fecha.
- *«Sin cita» por tratamiento también para los controles:* una cita dada desde la Agenda no se une al control, y 56 de 272 personas con cita salían «por reservar».
- *Contar Inicio con «Qué sigue» de cada paciente:* el mismo número, pero recorrer paciente por paciente en cada carga de Inicio; con 1 000 pacientes la lista tardaba 12 s.
- *Una fila propia de controles en Inicio con Argos encendido:* el mismo pendiente en dos lugares.

## Consecuencias

- Inicio, Pacientes y Reportes dicen el mismo número de lo aceptado sin cita; Argos, el mismo con sus días.
- Argos deja tarea también a quien tiene otra cita que no lleva lo aceptado, y la cierra cuando una cita lo lleva.
- Sacrificio: una persona puede estar en «Por agendar» y en «Presupuesto sin enviar» a la vez.
- Se revisa si las clínicas piden que una cita de la Agenda del mismo día tome el control, como ya toma el tratamiento del mismo servicio.

## Referencias

`packages/services/src/to-schedule.ts`, `plan-next.ts`, `people-shortcuts.ts`, `report-finance.ts` (`upcomingWork`), `agent-admin.ts` (`budgetsWithoutAppointment`, `overdueControls`), `automation.ts` (validez de «Presupuesto aceptado sin cita»), `workspace.ts` (`acceptedUnbookedOf`, `overdueControlsOf`).
