# 0104 · Sofi trabaja con la atención entera y sabe cómo va

Fecha: 2026-10-28 · Estado: aceptada el 2026-10-29 (en la auditoría del issue #328, cumplir todo pasó del 14 % a entre el 30 % y el 43 % en rondas completas de 40; ver Consecuencias) · Precisa [0006](0006-memoria-del-caso-y-comprobacion-de-respuestas.md) y [0010](0010-memoria-de-la-persona-sin-datos-clinicos.md)

## Problema

En la auditoría con conversaciones reales (issue #328), solo el 14 % de las conversaciones cumplió todo, y la fluidez llegó al 23 %. Las reglas de texto que se añadieron en cada ronda no movieron la fluidez: el manual pasó de 9 345 a 12 057 caracteres. La causa está en cómo se arma el contexto, no en las reglas:

- Sofi leía solo los últimos 20 mensajes (`HISTORY_LIMIT`). En WhatsApp la gente escribe en pedazos, así que son tres o cuatro vueltas. Con más de 20 mensajes, la fluidez falló en 30 de 31 conversaciones: volvía a pedir el nombre, la hora o el motivo.
- La indicación de cada turno salía del último mensaje y no de cómo iba la atención: «ofrécele horarios» aunque ya los había ofrecido, «pregúntale qué le pasa» cada vez que la persona lo volvía a contar, y «preséntate solo la primera vez» dependía de que el modelo lo recordara. Por eso repetía también en conversaciones cortas (81 de 129).
- El modelo de decisión solo lee lo que escribe la persona. Un «dale» a «¿cuál prefieres?» le parecía un saludo, y en ese camino Sofi no tenía con qué reservar.
- La memoria estaba repartida y dependía del modelo:
  - las notas libres se acumulaban («prefiere el martes» y «mejor el jueves» a la vez);
  - guardar el nombre o una nota costaba otra llamada al modelo, porque la respuesta tenía que ir sola en su paso;
  - en el chat web no veía si la persona ya había dejado su WhatsApp;
  - la ficha traía líneas vacías («sin etiquetas») y el vencimiento de las tareas, en contra de ADR 0097.

## Decisión y motivo

- **La atención entera.** Cada turno lee la atención en curso desde que empezó (`listAttentionMessages`), y al menos los últimos 20 mensajes, para no perder el aviso que la abrió. Tiene un tope por tamaño (`fitHistory`, unas 6 000 palabras): si no cabe, quedan cómo empezó y lo último, y el contexto dice cuántos mensajes no ve. Entre turnos no se guarda nada (ADR 0051).
- **El código cuenta cómo va la atención.** `attentionProgress` lee de sus fuentes si Sofi ya respondió, si ya ofreció horarios, qué cita espera el sí, qué quedó hecho y si ya se le dijo, qué promoción ya nombró, cuántas veces le preguntó su nombre y si ya le habló por él. El manual dice cada regla una sola vez; el turno dice si ya se cumplió. La indicación del camino dice lo que falta (`appointmentStep`).
- **Lo que la persona sigue escribiendo entra mientras Sofi redacta.** Las corridas van en su propio ciclo del worker. En un solo ciclo, una corrida frenaba la ingesta: lo que la persona escribía mientras tanto quedaba en la cola sin guardarse y Sofi respondía a pedazos. Si llega algo nuevo antes de un paso, la corrida solo guarda lo que la persona dijo y termina: no actúa con lo de antes. Como la ingesta corre a la vez, lee la conversación con la fila bloqueada y la despedida no cierra si llegó algo nuevo (ADR 0024).
- **Lo que va a salir se compara con lo que consta**, sin modelo y una vez por corrida cada cosa, como `verifyReply`: el idioma, el trato de usted, el pase o la nota que dice haber hecho, el nombre preguntado dos veces y volver a empezar con «Entiendo…» o a decir «anoté que…». Lo que espera su sí se pregunta y nunca se afirma antes; a quien aún no es paciente, el registro va en la frase del aviso (ADR 0101).
- **Lo que no puede hacer ni responder lo pasa al equipo**, en vez de decirle que llame.
- **Recepción razona poco antes de responder** (`receptionReasoning` de `AGENT_MODEL`), con el mismo modelo: sin cambiar de modelo, gasta menos tokens por conversación y repite y afirma de más con menos frecuencia.
- **Responder no es saludar** (`guardAnswer`). Si lo último que envió la clínica preguntaba algo, el camino «saludo» pasa a ser el abierto. Es una regla del código, como `guardBurst`.
- **Una memoria clara.**
  - «Con quién hablas» junta quién es, por quién escribe, dónde avisarle en el chat web y lo que se recuerda de la persona.
  - Lo interno de la ficha va aparte, solo si hay algo y sin vencimientos.
  - `anotar_caso` anota con nombre propio para quién es, qué pide y qué prefiere. De cada cosa vale lo último, y quien toma el caso lo ve con ese nombre.
  - Lo que solo guarda lo que dijo la persona (`anotar_caso`, `recordar_dato`, `update_contact`) puede ir en el mismo paso que `send_reply`. Así anotar no cuesta otra llamada.
- **El manual dice el objetivo** del issue #328 y cómo trabajar: leer todo antes de responder y tomar como un solo pedido lo que la persona escribió seguido. Se quitan las reglas que tapaban la pérdida de contexto.

## Alternativas descartadas

- **Más reglas de texto:** es lo que se venía haciendo; no movió la fluidez y encarece cada llamada.
- **Un resumen del hilo escrito por un modelo** (ya descartado en ADR 0006): suma una llamada por turno y el texto puede inventar. La atención entera cabe casi siempre, y el estado lo cuenta el código.
- **Guardar el estado del grafo entre turnos** (ADR 0051): crece sin control y arrastra datos caducados.
- **Que el modelo de decisión lea lo que dijo la clínica:** llevaría datos de la cita al proveedor, y basta con saber si preguntaba algo.

## Consecuencias

- Se espera que suban la fluidez y «sabe con quién habla». Se mide con `auditoria-masiva.ts`, siempre igual: base sembrada de nuevo, un worker, CAOS = 0,5, 40 conversaciones y el mismo juez, con la calidad y el costo. Se mide un cambio por ronda, en el orden de este ADR. El que no mejore se quita.
- Las atenciones de más de 20 mensajes gastan más tokens. Las herramientas crecen unos 900 caracteres por las notas con nombre propio. El manual queda igual de largo, pero sin parches.
- El tope por tamaño puede dejar fuera la mitad de una atención muy larga. El contexto lo dice, y las notas con nombre propio lo cubren.
- Lo que cuenta el código se basa en lo que Sofi escribió: si dice una promoción con otras palabras, no cuenta como ofrecida.
- Con las corridas en su propio ciclo, la que se corta porque la persona siguió escribiendo se paga hasta el paso en que se corta.
- Las comprobaciones por forma no cubren todas las maneras de decir lo mismo: el modelo encuentra otras.
- Razonar alarga un poco la respuesta (alrededor de un segundo en la mediana).
- En latidIA, lo urgente sin señal de alarma que va a una cita empieza por el teléfono para urgencias del consultorio (`urgentFirst`): el caso del dolor abdominal que empeora al caminar, que fallaba en todas las versiones, pasó, y la ronda cumplió todo el 45 % frente al 35 %.
- Entre dos corridas del mismo código cambian de resultado unas 9 a 14 de 40 conversaciones: una ronda sola no distingue diferencias de dos o tres. Una ronda cortada engaña más: con 17 casos, el tema al día parecía cumplir el 65 %, y en la ronda completa cumplió el 30 %.
- Se descartaron, medidas: exigir que la respuesta use el nombre (llenaba de «Gracias, Mariela…»), un revisor con el modelo antes de enviar (sus reescrituras bajaban la fluidez), pedir de nuevo «Entiendo…» y «anoté que…» desde la primera vez (las fórmulas bajaron de 22 a 6 en 40 conversaciones, pero cumplió todo el 30 % en vez del 43 % y costó un 23 % más), tratar de usted a quien saluda con formalidad sin verbos de usted (el juez dejó de citar el trato, pero cumplió todo en 3 de 17 casos) y mostrar en cada tema del equipo lo que pide y lo que falta para que `recordar_tema` lo deje al día (en rondas completas cumplió todo el 30 % en odentIA y el 35 % en latidIA, y costó más).

## Referencias

`packages/agent/src/attention.ts`; `graph.ts` (`readThread`, `loadContext`, `runTools`); `claims.ts`, `treatment.ts` y `language.ts` (lo que se compara antes de enviar); `tools.ts` (`ASK_YES`); `decision/route.ts` (`appointmentStep`, `guardAnswer`); `decision/shadow.ts`; `apps/worker/src/index.ts` (el ciclo de las corridas); `packages/services/src/conversations.ts` (`listAttentionMessages`, `ingestInbound`); `conversation-close.ts` (`closeConversationWith`); `product-agent.ts` (`urgentFirst`); `agent-case.ts` (`CASE_SLOTS`); `agent-case-brief.ts`. Issue #328.
