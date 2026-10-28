# 0102 · Clío reserva la próxima cita y arma el presupuesto a pedido, sin salir de la atención

Fecha: 2026-10-28 · Estado: aceptada · Lienzo «Clío: la próxima cita y el presupuesto» (5 tableros, aprobado) · Precisa la 0100

## Problema

Dentro de la atención solo se reservaba desde un control pendiente, y el presupuesto se armaba recién al firmar: no había cómo enseñárselo al paciente mientras seguía en la unidad dental. Lo que se dictaba («cítalo en quince días», «arma el presupuesto para enseñárselo») quedaba en un control sin hora o en nada.

## Decisión y motivo

- **Reservar se dice pidiendo reservar.** «Cítalo…», «que vuelva el jueves a las cuatro» es una cita con hora; decir cuándo volver a verlo («control en seis meses») sigue siendo un control. Si no queda claro, es un control: no ocupa la agenda y recepción lo reserva después.
- **El hueco sale de la agenda, no del modelo.** El modelo solo dice el día y, si la dijo, la hora. El servicio busca el primer hueco libre de quien lleva la atención desde ese día, en su sede y con la duración del servicio (`listAvailableSlots`), y ofrece otros dos cerca para tocar. Una hora que no está libre es un aviso, con la más cercana ya elegida. Si ya tiene una cita cerca de ese día, no se reserva otra.
- **Reservar es «Nueva cita».** `createAppointment`, con quien atiende, el tratamiento aceptado de ese servicio y el aviso a la persona como cuando reserva recepción. Antes se vuelve a mirar el hueco: si se ocupó mientras atendía, la sugerencia queda con el más cercano y sin reservar, también al firmar.
- **Armar no es enviar.** «Arma el presupuesto» confirma lo dictado que lleva y deja en el borrador lo indicado en la atención, con la misma regla que al firmar (`assembleEncounterBudget` con `onRequest`, también donde es opcional). «Mostrar a {nombre}» abre el mismo PDF a pantalla completa y no cambia nada; imprimirlo o enviarlo es entregarlo, como desde el Plan. «Envíaselo» por voz no lo envía: Clío no le escribe al paciente.

## Alternativas descartadas

- *Que el modelo elija la hora:* inventaría huecos. La agenda es la única fuente.
- *Reservar siempre que se dice cuándo volver:* llenaría la agenda de citas que el paciente no pidió.
- *Enviar el presupuesto por voz:* un mensaje al paciente es una acción del equipo, con su botón.

## Consecuencias

- Dos clases nuevas de sugerencia, comunes a los dos productos: `cita` y `presupuesto` (migración 0014).
- Se mide con `eval:dictado` (banco de siempre y `eval/dictado-caotico.json`) y `eval:dictado-medico`.

## Referencias

- `packages/services/src/encounter-dictation.ts` (`settleAppointment`, `confirmAppointment`, `previewBudget`, `confirmBudget`), `budgets.ts` (`assembleEncounterBudget`), `operation-fields.ts` (`cita.dictada`, `presupuesto.armar`).
- `packages/agent/src/dictation.ts` (`appointmentAndBudgetPrompt`).
- `packages/clinic-app/src/components/patient/dictation-suggestions.tsx` (`AppointmentChoices`, `BudgetLines`), `plan/budget-show.tsx`.
