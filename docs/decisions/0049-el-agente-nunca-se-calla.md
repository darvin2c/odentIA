# 0049 · El agente nunca se calla: lo derivado es un tema, no la conversación

Fecha: 2026-10-18 · Estado: aceptada · Modifica a [0024](0024-ninguna-conversacion-queda-abierta.md) en «Lo que tiene una persona» · Complementa a [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md)

## Problema

Derivar a una persona apagaba al agente en toda la conversación (`agent_status = 'off'`), y escribir desde la Bandeja también. Rosa pregunta a las 19:40 si puede tomar ibuprofeno con su pastilla de la presión; el agente lo pasa a la doctora y se calla. A las 20:12 pregunta por una promoción y a las 20:15 por el horario, y nadie le responde hasta el día siguiente. Además, la Bandeja calculaba el estado con tres reglas distintas, y sus pestañas se superponían.

## Decisión y motivo

- **Lo que se deriva es un tema** (`agent_handoff`): el mensaje que lo originó (`source_message_id`), su responsable, su prioridad y su plazo. El plazo y el estado salen de su tarea, como antes. Derivar ya no apaga al agente.
- **El agente sigue con lo demás.** Nunca responde un tema que tiene una persona. Si le preguntan por él, dice quién lo tiene y cuándo responde, anota el mensaje en el tema (`asked_message_ids`) y le avisa al responsable.
- **Escribir desde la Bandeja también responde un tema.** La respuesta cita el mensaje de la persona (`message.reply_to_message_id`; en WhatsApp sale como `context.message_id` y en Telegram como `reply_parameters`). «Enviar y resolver» completa el tema; «Enviar, sigue pendiente» lo deja abierto con su plazo. Mientras una persona del equipo conversa en vivo, el agente espera 15 minutos desde su último mensaje y luego vuelve solo. «Tomar» la conversación y «Devolver al agente» desaparecen; quedan «Tomar este tema» (sin confirmación, se avisa a quien lo tenía) y «Pasar este tema a…».
- **Si nadie responde:** a las 2 horas de atención el tema sube a «Ahora». Al día siguiente, si es algo que el agente sabe hacer (una cita, un precio de lista), se ofrece a resolverlo; lo que decide una persona (un descuento, una duda clínica) nunca. Las dudas clínicas van al profesional que atiende al paciente; si no tiene uno, van a recepción.
- **Una sola regla de estado**, en `conversation-state.ts`, con cuatro vistas que no se superponen: «Por atender» (un tema abierto, o un mensaje sin responder que el agente no atiende), «Las atiende el agente», «Esperan al paciente» y «Cerradas».
- `agent_status` queda solo como el interruptor manual del agente en una conversación.

## Alternativas descartadas

- *Callar al agente mientras haya un caso abierto* (lo de antes): la persona se queda sin respuesta por cosas que el agente sí sabe, a menudo hasta el día siguiente.
- *Que el agente responda todo, también el tema derivado*: en una duda clínica o un descuento, la decisión es de una persona.
- *Un acuse fijo cada cierto tiempo*: deja de hacer falta si el agente sigue respondiendo.

## Consecuencias

- La persona siempre recibe respuesta. El equipo ve en cada fila la pregunta que le toca, no el último mensaje.
- El agente tiene que distinguir si un mensaje es del tema de alguien: ante la duda, lo trata como del tema y avisa al responsable.
- Sacrificio: el equipo y el agente escriben en la misma conversación. Los 15 minutos de espera evitan que se crucen, pero un mensaje enviado justo al terminar ese plazo puede cruzarse con una respuesta del equipo.
- Se revisa si las clínicas piden que derivar calle al agente en algún motivo concreto, por ejemplo un reclamo.

## Referencias

`packages/services/src/agent-operations.ts` (`createHandoff`), `packages/services/src/conversation-state.ts`, `packages/agent/src/tools.ts` (`request_human_handoff`, `recordar_tema`), `packages/db/drizzle/0009_temas_para_el_equipo.sql`.
