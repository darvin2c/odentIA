# 0027 · «Escribirle» y el aviso de la cita

Fecha: 2026-10-15 · Estado: aceptada · Precisa [0001](0001-persona-unica.md) (identidad) y amplía [0023](0023-el-administrador-detecta-y-recepcion-habla.md)

## Problema

Para escribirle por WhatsApp a alguien que recepción anotó por teléfono había que agregar una «identidad» escribiendo «wa:» y los dígitos, elegir identidad y conexión en dos selectores y pulsar un botón con cuatro nombres distintos. Sin esa identidad, las automatizaciones decían «no tiene WhatsApp» aunque la ficha tuviera su número. Y cuando el equipo reservaba, movía o cancelaba una cita, nadie se lo decía a la persona.

A la vez, la regla raíz prohíbe verificar identidad por coincidencia de teléfono: un mensaje que llega no se une a una ficha porque su número coincida.

## Decisión y motivo

**Escribirle.** Una sola vía, `writeToPerson`, con un solo nombre en pantalla («Escribirle»; «Nueva conversación» en la Bandeja). Devuelve la conversación por la que se le escribe: la que tiene abierta (escribió en las últimas 24 horas), su WhatsApp o uno nuevo con su número, y si no, su conversación más reciente.

- **El teléfono pasa a ser su WhatsApp solo por la decisión de una persona del equipo**: quien pulsa «Escribirle» con el número de la ficha a la vista, o escribe uno. Queda auditado a su nombre (`contact.identity_added`). Es el mismo acto que el alta manual de un canal, sin escribir códigos.
- **Nunca nace de un mensaje que entra**: la ingesta sigue resolviendo por la identidad del proveedor; un entrante cuyo número coincide con una ficha crea su propia persona provisional, como siempre. Tampoco nace sola de la ficha: un teléfono declarado no es WhatsApp hasta que alguien elige escribirle.
- Si el número ya es de otra persona de la clínica, no se mueve: se dice. Reasignar sigue siendo «Reasignar canal».

**El aviso de la cita.** Son parte de «Recordar la cita», no una línea nueva: al reservar, mover o cancelar una cita, el agente le avisa a la persona con un mensaje del catálogo (cita reservada, cambio de fecha, cita cancelada con «¿Te buscamos otra fecha?»). Siguen la misma regla que todo lo que escribe el Administrador: respuesta si escribió en 24 horas, mensaje aprobado si no, correo de respaldo; permiso de recordatorios; horario de silencio; se piden a WhatsApp al conectar.

- No se avisa lo que ya se dijo donde ocurrió: lo que el agente hizo en la conversación y lo que la persona hizo desde su enlace de reserva (ese ya responde por la conversación, ADR 0014).
- **Tope de un mensaje al día**: un aviso de cambio de cita no espera a mañana, porque la cita cambió hoy (una cancelación de esta tarde no puede avisarse mañana). Sí cuenta como el mensaje del día de esa persona: lo demás de ese día espera. Si el recordatorio de la misma cita sale en ese momento, el aviso de reserva se da por cubierto.
- No deja tarea si no puede salir: la llamada la pide el recordatorio cuando toca.

## Alternativas descartadas

- *Crear la identidad de WhatsApp al guardar el teléfono en la ficha*: convertiría un dato declarado en canal sin que nadie lo decidiera, y un número mal escrito empezaría a recibir mensajes.
- *Emparejar el entrante con la ficha por su número*: es justo lo que prohíbe la regla raíz; un teléfono compartido no identifica a nadie.
- *Una línea propia para los avisos*: otra cosa que prender; el aviso solo tiene sentido con los recordatorios.
- *Avisos fuera del tope*: con varias citas movidas en un día, la persona recibiría varios mensajes además de los seguimientos.

## Consecuencias

- Recepción escribe a cualquiera con un clic y el agente comunica los cambios de cita sin que nadie escriba.
- Sacrificio: tres mensajes más en el catálogo (diez en total) que WhatsApp debe aprobar; mientras no estén aprobados, el aviso solo sale como respuesta o por correo.

## Referencias

- `packages/services/src/conversations.ts` (`writeToPerson`), `contacts.ts` (identidad de canal), `automation.ts` (`enqueueAppointmentNotice`, `rescheduleAppointmentReminders`, `appointmentConfirmationPlan`), `automation-messages.ts` (`APPOINTMENT_NOTICE_KEYS`), `appointments.ts` (`notice`).
- `apps/platform/src/components/write-to-person.tsx`, `components/inbox-new-conversation.tsx`, `components/agenda/appointment-drawer.tsx`.
