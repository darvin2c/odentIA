# 0190 · Kairós vende en los chats y agenda las presentaciones

Fecha: 2026-11-15 · Estado: aceptada · Cambia la [0185](0185-el-arm-de-la-administracion.md) («Kairós solo prepara») para los chats; se apoya en la [0189](0189-canales-de-la-administracion.md)

## Problema

En un chat, la clínica que pregunta espera respuesta en minutos, también de noche y el fin de semana, y pasadas 24 horas ya no se le puede escribir libremente. Con Kairós preparando y esperando el sí de una persona, el «¿cuánto cuesta?» de un sábado a las 21:47 se respondía el lunes. Agendar una presentación pedía ir y venir con horas que nadie tenía a la vista, y no había horarios del equipo, ni ausencias, ni sala.

## Decisión y motivo

- **Kairós responde solo en los chats, solo a quien todavía no tiene su app.** WhatsApp, Instagram y Messenger, con un chat sin cliente o de un cliente sin cuenta. A una clínica con app no le responde (la atiende Soporte, y después Ariadna). En el correo sigue preparando y esperando el sí.
- **Qué puede decir:** lo de las webs (un texto curado por producto en `kairos-sales-facts.ts`), los precios vigentes de los planes, que salen de `getPublicPricing` (el mismo lugar que la web), y todo lo de agendar. Nunca descuentos ni precios especiales: eso, y lo que no sabe, pasa al equipo con un aviso fijo y queda en Hoy.
- **Se comprueba antes de enviar.** Toda hora o fecha debe ser una que Kairós ofreció, propuso o agendó en ese turno (o la que pidió la persona, solo para decir que no hay); todo importe, uno de los planes con su moneda. Decir que agendó, movió o canceló («quedó agendada», «te reservé», «cancelé») solo vale si la herramienta lo hizo en ese turno. Si no, no se envía y sale el aviso fijo. Si el modelo falla, tarda o no escribe después de agendar, sale la confirmación armada desde la reserva.
- **Su tiempo es su límite.** Pasados los 45 segundos del turno, nada de lo que pida el modelo se hace: ninguna herramienta escribe y lo que estaba escribiendo se deshace. Antes de cada herramienta que escribe y al reservar la respuesta se vuelve a mirar que Kairós pueda actuar (prendido, sin pausa, no «No es una clínica», sin app, no archivado, dentro de las 24 horas).
- **Si su respuesta no sale, pasa al equipo.** Meta la rechaza o no se sabe si salió: la conversación queda pausada con el motivo y «Responder» sale en Hoy.
- **Agenda como Sofi** (0097): 45 minutos, con el responsable del cliente o, si no tiene o está ausente, con quien tenga el horario libre más pronto (sin cambiar el responsable), desde 2 horas hasta 14 días, en hora de Lima. Para mover, solo con quien ya la presenta. La última propuesta manda, y una hora que otro se ganó deja su propuesta vencida. Dos presentaciones de la misma persona no se cruzan: el servicio lo comprueba con un candado por persona.
- **Una persona puede cruzarlas, avisada.** Agendar o mover a mano encima de otra presentación de quien presenta o de su ausencia responde `SLOT_TAKEN` con el porqué, y la pantalla ofrece «Agendar igual» (o «Mover igual»). Lo forzado queda en la auditoría. Kairós nunca fuerza. «Mover» de Hoy cambia solo el día: la presentación conserva su hora.
- **Horarios, sala y ausencias en Equipo.** Cada persona marca sus horas semanales, su sala fija (Meet o Zoom) y sus ausencias; Administración puede hacerlo por otra. Una ausencia que choca con presentaciones aparece en Hoy con «Pasar a…» o «Pedir otra hora». Nada se mueve solo. Las tareas de alguien ausente las ve el resto como «De Ana, ausente».
- **Avisa y recuerda.** Al agendar, manda día, hora, con quién y la sala. El día anterior, la plantilla de utilidad `recordatorio_presentacion` en WhatsApp, o el correo, con «hoy» o «mañana» según cuándo sale; no si la confirmación o el aviso de un cambio de esa misma hora salieron a menos de 24 horas de empezar. Un cambio hecho por una persona (también con «Mover» de Hoy) se avisa. En Instagram y Messenger, antes de agendar pide un WhatsApp o un correo para avisar.
- **Un aviso no es una respuesta.** Los recordatorios, «otra hora» y los cambios se guardan como `aviso` (`saas_outreach.purpose`): no dan por respondido el último mensaje de la persona. «Respondido» se mide con nuestro reloj (cuándo guardamos su mensaje), no con la hora que dice Meta.
- **Topes por día de Lima.** 30 respuestas por conversación y 500 entre todas, contando los avisos; 10 presentaciones agendadas por Kairós entre todas y una abierta por conversación o clínica. Pasado un tope, la conversación pasa al equipo con el motivo («tope») en Hoy.
- **El equipo conserva el control.** Kairós dice que es el asistente de Sallca y firma «Kairós». «Lo atiendo yo» lo pausa en una conversación; un interruptor de Administración lo apaga del todo; lo que hace queda en el historial a su nombre.
- **Se prende después de medirlo.** El interruptor nace apagado. Se mide con un banco de conversaciones escrito por el equipo (`eval:kairos-vende`), con el modelo real: es grave inventar un precio, prometer un descuento, agendar una hora no ofrecida u ocupada, responder a una clínica con app o tratar a un paciente como venta. Se prende con cero graves y el sí del dueño.

## Alternativas descartadas

- *Que también responda solo los correos.* El correo aguanta la espera, y una respuesta mala por correo se reenvía y queda.
- *Conectar el Google Calendar de cada persona.* Más permisos y otra integración que mantener; las horas semanales en el ARM y lo ya agendado alcanzan para no ofrecer una hora ocupada en el ARM.
- *Crear un Meet por presentación.* Pide el calendario; la sala fija ya la tiene cada uno.
- *Repartir por turnos.* Quien presenta sigue la venta; con el responsable, o el primero libre, basta.
- *Que Kairós mueva solo lo agendado cuando alguien sale de vacaciones.* Cambia lo que se le prometió a la clínica: lo decide una persona.

## Consecuencias

- Lo que escribe cualquiera por esos canales llega al modelo (filtrado de datos de pacientes). Un mensaje puede intentar torcer las instrucciones; las herramientas solo actúan sobre esa conversación y la comprobación de horas y precios no depende del modelo.
- Kairós no ve los calendarios de fuera del ARM: una reunión que no está en el ARM puede chocar.
- Agendar o mover a mano todavía permite cruzar dos presentaciones o caer en una ausencia, pero solo después del aviso y con «Agendar igual»; queda en la auditoría. Lo que ofrece Kairós lo descuenta.
- Los avisos por correo van a la dirección que la persona dejó en el chat, sin verificarla: alguien podría dar una ajena. Se acepta porque sin ella no hay cómo recordar por Instagram o Messenger; cuentan en el tope del día de Kairós.
- Un tope del día deja sin respuesta automática a quien escribe después: lo ve el equipo en Hoy.
- El motivo de una ausencia lo ven solo quien se ausenta y Administración; el resto ve solo el tramo.
- Pasos a mano: crear y aprobar la plantilla `recordatorio_presentacion` (utilidad, es) y poner en el worker las claves de los canales y del correo de conversaciones.

## Referencias

- Agente: `packages/agent/src/kairos-vende.ts` (`SELLER_SYSTEM`), banco `packages/agent/eval/kairos-vende.json` y sus mediciones.
- Servicios: `packages/services/src/kairos-sells.ts`, `admin-staff-schedule.ts`, `kairos-sales-facts.ts`, `admin-kairos.ts` (`ausencia_choca`).
- Worker: la cola `kairos-vende`. Migraciones `0131_kairos_vende` y `0132_kairos_vende_reglas`.
