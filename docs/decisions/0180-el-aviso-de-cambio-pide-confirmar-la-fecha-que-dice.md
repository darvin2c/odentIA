# 0180 · El aviso de cambio pide confirmar, y cada «Confirmar» vale para la fecha que dice su mensaje

Fecha: 2026-11-11 · Estado: aceptada · Precisa la [0027](0027-escribirle-y-avisar-la-cita.md)

## Problema

La 0027 dejó los avisos de la cita (reservada, movida, cancelada) sin «Confirmar»: eso lo pedía el recordatorio, cerca de la fecha. Desde que la cita confirmada que el equipo lleva a otro día vuelve a «por confirmar» (#583, #585), la persona recibe «tu cita cambió» y, para confirmar la fecha nueva, tiene que escribir «sí» o esperar al recordatorio. Además, un botón «Confirmar» se resolvía con la fecha que tuviera la cita al tocarlo: el de un mensaje viejo podía confirmar una fecha que nadie le dijo.

## Decisión y motivo

- **Una variante del aviso de cambio con «Confirmar» y «No podré ir»** (`aviso_cita_movida_confirmar`, plantilla `odentia_aviso_cita_movida_confirmar_v1`). Sale en lugar del aviso de siempre cuando, después de moverla, todas sus citas quedan «por confirmar»; la cita que sigue confirmada (mismo día, la movió la persona, «Ya confirmó conmigo») recibe el de siempre. Es la misma forma que el recordatorio de la cita confirmada (ADR 0109): un mensaje del catálogo que se elige al entregar, no otro tipo de trabajo. Sigue siendo un aviso: sin baja (ADR 0040).
- **Mientras WhatsApp no la aprueba**, sale como respuesta a quien escribió en las últimas 24 horas y, a los demás, el aviso de siempre. Por correo, con «Para confirmar» y «Si no podrás ir», como el recordatorio, y solo si la clínica tiene su página.
- **Cada «Confirmar» vale para la fecha que dijo su mensaje.** Al salir, cada trabajo guarda esa fecha (`announcedStartsAt`); el botón la compara, por día y en la zona de la sede, con la de la cita. Si cambió de día, no confirma: dice la fecha nueva y pregunta. Vale también para el recordatorio. Los trabajos que salieron antes, sin esa fecha, siguen la regla del «sí» escrito.
- **El «sí» escrito** responde al último recordatorio o aviso de cambio, y no confirma la cita que cambió de día después de cualquiera de los dos mientras no se le haya escrito por esa conversación (`answersEarlierDate`).

## Alternativas descartadas

- **Esperar al recordatorio:** la persona se entera del cambio y no puede decir que sí con un toque; si la fecha nueva queda lejos, la cita pasa días por confirmar.
- **Deducir la fecha del mensaje desde la auditoría** (el `from` del primer movimiento posterior): `created_at` es la hora en que empieza cada transacción, y un movimiento que empieza antes de la entrega y termina después no cuenta como posterior; el botón confirmaría la fecha nueva.
- **Cambiar el texto del aviso de siempre:** una plantilla aprobada no se cambia (es otra con otro nombre), y la cita confirmada no tiene nada que confirmar.

## Consecuencias

- Una plantilla más que se pide sola en cada conexión (23 del catálogo de odentIA). Sin paso a mano.
- El aviso de la Agenda al mover no dice si el aviso salió con «Confirmar»: depende de lo que WhatsApp aprobó y de la ventana de 24 horas, que se deciden al entregar.
- Sigue igual: el aviso de reserva pendiente que cubre el cambio sale sin «Confirmar»; el recordatorio que agrupa varias citas, con una sola cambiada, confirma las otras.

## Referencias

- `packages/services/src/automation-messages.ts` (`MOVED_TO_CONFIRM_KEY`), `automation.ts` (`movedToConfirmFor`, `handleAutomationReply`, `answersEarlierDate`, `JobPayload.announcedStartsAt`), `automation-routing.ts` (`ComposedMessage.announced`), `agent-operations.ts` (`lastReminderAppointments`).
