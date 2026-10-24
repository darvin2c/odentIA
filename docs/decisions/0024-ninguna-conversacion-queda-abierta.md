# 0024 · Ninguna conversación queda abierta

Fecha: 2026-10-15 · Estado: aceptada; «fuera de horario se responde al abrir» la reemplaza [0084](0084-sofi-responde-siempre.md): Sofi responde siempre y el único horario es el de recontacto · Complementa a [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md) y a [0023](0023-el-administrador-detecta-y-recepcion-habla.md)

## Problema

Nada cerraba una conversación por sí solo, y cerrarla tenía efectos peligrosos: un entrante a una cerrada no la reabría y quedaba escondido; tocar «Confirmar» o «No enviar más» en un hilo cerrado revertía la ingesta y el mensaje se perdía; el agente corría en hilos cerrados; cinco de los siete caminos de derivación no le decían nada a la persona; lo que llegaba fuera del horario del agente se omitía para siempre; escribir a una cerrada respondía 409 y el correo saliente lo reportaba como «sin conexión». La Bandeja acumulaba hilos abiertos que nadie sabía si esperaban algo, y cerrar a mano no guardaba por qué ni quién.

## Decisión y motivo

- **El agente siempre cierra, la persona siempre reabre.** Cada conversación termina con un motivo: `resuelta` (la persona se despidió y no quedaba nada pendiente; el agente se despide con `despedirse_y_cerrar`), `sin_respuesta` (dejó de responder), `equipo` («Resolver» o completar el último caso derivado) o `manual` (cerrar sin resolver). Todo mensaje de la persona y todo envío de la clínica la reabren con una atención nueva (`attention_started_at`): nada se pierde y nada se rechaza por estar cerrado.
- **Una sola forma de cerrar** (`closeConversationWith`): vencen las propuestas pendientes, se quita la asignación, el agente queda encendido, los casos derivados se completan solo si cierra el equipo, y las notas del caso no pasan a la atención siguiente: queda una línea con cómo terminó.
- **Tiempos.** El agente insiste una sola vez a las 3 horas de su último mensaje, si había algo por responder (una propuesta esperando el sí, una pregunta, una oferta). Cierra a las 22 horas de silencio, configurable de 6 a 23: después de 24 horas WhatsApp ya no deja despedirse sin un mensaje aprobado, y se deja una hora de margen. Ambas cosas solo en **horario oportuno**: el de atención de la clínica ese día (o de 8:00 a 21:00 si no atiende) y el del agente; si las 22 horas caen de noche, se despide en la última hora oportuna anterior, nunca antes de una hora después de insistir. Sin ventana para escribir, cierra sin mensaje. Los textos son fijos, sin modelo, en la voz de la clínica.
- **Lo que tiene una persona no se cierra solo.** Con alguien a cargo (asignada, agente apagado o canal que el agente no atiende) o un caso derivado abierto, el ciclo no toca la conversación; pasadas las horas configuradas sin mensajes aparece en «Te espera» de quien la lleva (antes era un aviso; lo cambió [0025](0025-un-pendiente-un-lugar.md)).
- **Derivar siempre avisa** y **fuera de horario se responde al abrir**: la corrida vuelve a la cola para la apertura y atiende todo lo que quedó sin responder.
- **Una definición de lo que espera cada conversación** (`conversation-state.ts`): esperan respuesta, con el equipo, esperan al paciente, con el agente, cerradas. La comparten la Bandeja, sus totales, el panel de contexto, Inicio y el ciclo.

## Alternativas descartadas

- *Cerrar solo a mano*: es lo que había; la Bandeja nunca se vacía y nadie distingue lo que espera de lo terminado.
- *Cerrar por inactividad sin despedirse*: la persona no sabe que puede volver a escribir y la conversación se siente abandonada.
- *Insistir varias veces o con texto del modelo*: presiona a la persona y gasta llamadas; un texto fijo se revisa una vez.
- *Mantener el 409 al escribir a una cerrada*: obligaba a reabrir antes y perdía mensajes del sistema (confirmaciones de reserva, botones).

## Consecuencias

- La Bandeja muestra el motivo de cada cierre y lo que espera cada abierta; las vistas viejas (`human`, `approval`, `handoff`) desaparecen.
- La auditoría distingue cerrar, resolver, reabrir y los cierres del agente con su motivo.
- Sacrificio: una persona que vuelve días después abre una atención nueva y el agente solo recibe una línea de la anterior; el historial de mensajes sigue a la vista.
- Se revisa si las clínicas piden insistir más de una vez, otro horario por defecto o cerrar antes de 6 horas.

## Referencias

- `packages/services/src/conversation-close.ts`, `conversation-state.ts`, `opportune-hours.ts`, `conversations.ts` (`reopenIfClosed`), `inbox.ts`, `agent-admin.ts` (`tickAutomations`).
- `packages/agent/src/tools.ts` (`despedirse_y_cerrar`, `noticeAfterHandoff`), `run.ts` (corrida pospuesta), `graph.ts`.
- Migración `0080_conversaciones_abrir_y_cerrar`.
