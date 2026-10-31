# 0050 · El agente nunca se calla: lo derivado es un tema, no la conversación

Fecha: 2026-10-18, precisada el 2026-10-20 · Estado: aceptada · Modifica a [0024](0024-ninguna-conversacion-queda-abierta.md) en «Lo que tiene una persona» · Complementa a [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md)

## Problema

Derivar a una persona apagaba al agente en toda la conversación (`agent_status = 'off'`), y escribir desde la Bandeja también. Rosa pregunta a las 19:40 si puede tomar ibuprofeno con su pastilla de la presión; el agente lo pasa a la doctora y se calla. A las 20:12 pregunta por una promoción y a las 20:15 por el horario, y nadie le responde hasta el día siguiente. Además, la Bandeja calculaba el estado con tres reglas distintas, y sus pestañas se superponían.

## Decisión y motivo

- **Lo que se deriva es un tema** (`agent_handoff`): el mensaje que lo originó (`source_message_id`), su responsable, su prioridad y su plazo. El plazo y el estado salen de su tarea, como antes. Derivar ya no apaga al agente.
- **El agente sigue con lo demás.** Nunca responde un tema que tiene una persona. Si le preguntan por él, dice quién lo tiene y cuándo responde, anota el mensaje en el tema (`asked_message_ids`) y le avisa al responsable.
- **Escribir desde la Bandeja también responde un tema.** La respuesta cita el mensaje de la persona (`message.reply_to_message_id`; en WhatsApp sale como `context.message_id` y en Telegram como `reply_parameters`). «Enviar y resolver» completa el tema; «Enviar, sigue pendiente» lo deja abierto con su plazo. Mientras una persona del equipo conversa en vivo, el agente espera 15 minutos desde su último mensaje y luego vuelve solo. «Tomar» la conversación y «Devolver al agente» desaparecen; quedan «Tomar este tema» (sin confirmación, se avisa a quien lo tenía) y «Pasar este tema a…».
- **Si nadie responde:** a las 2 horas de atención el tema sube a «Ahora». Al día siguiente, si es algo que el agente sabe hacer (una cita, un precio de lista), se ofrece a resolverlo; lo que decide una persona (un descuento, una duda clínica) nunca. Las dudas clínicas van al profesional que atiende al paciente; si no tiene uno, van a recepción.
- **Una sola regla de estado**, en `conversation-state.ts`, con cuatro vistas que no se superponen: «Por atender» (un tema abierto, un mensaje sin responder que el agente no atiende o, desde el 2026-10-31, un último mensaje que no salió: nadie atiende a quien no recibió lo que se le dijo, y el ciclo no lo cierra), «Las atiende el agente», «Esperan al paciente» y «Cerradas».
- `agent_status` queda solo como el interruptor manual del agente en una conversación.

### Precisado por el pulido de la Bandeja (2026-10-20, issues 94, 96 y 111)

- **«Ahora» cuenta horas de clínica abierta.** Dos horas de reloj marcaban en rojo, el lunes, un tema del sábado a las 18:30. El tema guarda cuándo pasa a «Ahora» (`urgent_at`) con las horas en que atiende alguna sede, y la Bandeja, Inicio y el panel lo leen de ahí.
- **Cada tema dice de qué trata** (cita, precio, clínico, pago u otro). Un pago va a caja, que lo responde desde Inicio sin ver la Bandeja (un permiso estrecho, `conversations.topics`). Una duda clínica va a quien atendió por última vez, que también la responde desde Inicio.
- **Pasadas las 24 horas de WhatsApp el equipo responde igual.** La respuesta queda «Por entregar» y sale un mensaje aprobado, «Ver respuesta». Al tocarlo, o al volver a escribir, la persona recibe la respuesta citando su pregunta. El tema se da por resuelto al escribir: no depende de que la persona toque el botón. Instagram y Messenger no admiten mensajes aprobados: la respuesta va a su WhatsApp, si tiene uno marcado como suyo.
- **El agente se ofrece al día siguiente** con un texto fijo, en la primera hora del horario para escribir. Solo lo hace con citas y precios de lista: retoma la conversación y lo que la persona conteste lo atiende él. Una duda clínica, un descuento o un pago siempre esperan a una persona.

## Alternativas descartadas

- *Dar el tema por resuelto cuando la persona toca «Ver respuesta»*: quien respondió quedaría con un pendiente que no depende de su trabajo.
- *Que el agente espere a que la persona vuelva a escribir*: quien preguntó un precio el sábado probablemente ya no vuelve.

- *Callar al agente mientras haya un caso abierto* (lo de antes): la persona se queda sin respuesta por cosas que el agente sí sabe, a menudo hasta el día siguiente.
- *Que el agente responda todo, también el tema derivado*: en una duda clínica o un descuento, la decisión es de una persona.
- *Un acuse fijo cada cierto tiempo*: deja de hacer falta si el agente sigue respondiendo.

## Consecuencias

- La persona siempre recibe respuesta. El equipo ve en cada fila la pregunta que le toca, no el último mensaje.
- El agente tiene que distinguir si un mensaje es del tema de alguien: ante la duda, lo trata como del tema y avisa al responsable.
- Sacrificio: el equipo y el agente escriben en la misma conversación. Los 15 minutos de espera evitan que se crucen, pero un mensaje enviado justo al terminar ese plazo puede cruzarse con una respuesta del equipo.
- Se revisa si las clínicas piden que derivar calle al agente en algún motivo concreto, por ejemplo un reclamo.

## Referencias

`packages/services/src/agent-operations.ts` (`createHandoff`), `packages/services/src/conversation-state.ts`, `packages/agent/src/tools.ts` (`request_human_handoff`, `recordar_tema`), `packages/db/drizzle/0014_temas_para_el_equipo.sql`. Pulido: `topic-urgency.ts`, `held-replies.ts`, `topic-retake.ts`, `topic-reply.ts` (`replyToTopic`, `replyByWhatsApp`) y las migraciones 0053 a 0055.
