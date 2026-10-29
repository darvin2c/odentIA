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
- **Que el modelo de decisión lea lo que dijo la clínica:** llevaría datos de la cita al proveedor, y basta con saber si preguntaba algo (`guardAnswer`). Se midió en la auditoría: cumplió todo el 38 % frente al 30 % del main, pero 10 conversaciones mejoraron y 7 empeoraron, dentro del ruido, y costó un 15 % más.

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

## Actualización del 2026-10-29: lo que cambia en cada corrida va después del historial

En las rondas de la auditoría, cada llamada de Recepción llevaba unos 14 500 tokens de entrada. Algo más de la mitad salía de la caché de OpenAI, y todo el resto se escribía en ella a 1,25× de la entrada. gpt-6-luna, por /v1/responses, deja su corte automático al final del último mensaje del usuario. Solo lee un corte que ya escribió y con el mismo principio exacto: las herramientas, en su orden, y lo que sigue. Lo de cada corrida iba en el mismo mensaje de sistema que lo de la clínica, con la hora al final, así que ninguna corrida leía de la caché lo que dejó la anterior, ni siquiera lo de la clínica.

- **Antes del historial, solo lo que no cambia en la atención.**
  - El primer mensaje de sistema lleva lo igual para toda la clínica, con un corte explícito: `prompt_cache_breakpoint` en un bloque `input_text`, porque a un bloque `text` LangChain le quita la marca. Así lo lee cualquier conversación de la clínica, también en su primera corrida.
  - Le sigue lo del hilo que no cambia: el formato del canal y los otros canales.
  - Después va el historial y, al final, en otro mensaje de sistema, lo de la corrida: con quién habla, cómo va la atención, el camino, el idioma, el trato y la hora. Un mensaje de sistema después del historial no mueve el corte automático: la corrida siguiente lee de la caché todo lo anterior hasta el último mensaje de la persona.
- **Medido** como el resto de este ADR, con los mismos 40 casos de odentIA y 20 de latidIA y dos rondas por versión (120 conversaciones cada una):
  - El costo de Sofi por conversación bajó de USD 0,0083 a 0,0031 (−62 %): en odentIA, de 0,0093 a 0,0035 con Jev; en latidIA, de 0,0070 a 0,0033.
  - De la entrada de cada llamada, lo leído de la caché pasó del 56 % al 90 % y lo escrito, del 44 % al 7 %. Las llamadas por conversación no cambiaron (8,8).
  - Cumplió todo el 43 % frente al 30 %, más a menudo en las cuatro rondas: 22 conversaciones mejoraron, 10 empeoraron y 28 quedaron igual.

### Alternativas descartadas

- **Lo de la corrida como mensaje del usuario.** El corte automático cae después de él, y la corrida siguiente vuelve a escribir el historial (probado directo con la API).
- **Solo cortes explícitos** (`prompt_cache_options` en modo `explicit`). Sin el corte automático, un paso de la corrida ya no lee el anterior. Con lo de la corrida al final, el automático escribe justo lo que se vuelve a leer.
- **Una sola lista de herramientas, acotada con `allowed_tools`.** Las herramientas van antes que todo, y una lista por camino parte la caché. Con todas a la vista y el camino acotando lo que puede llamar se leyó más de la caché (93 % frente a 89 %), pero cada llamada llevó unos 3 300 tokens más y hubo más llamadas. En los mismos 36 casos costó un 10 % más y cumplió todo en 7 frente a 15. Queda en la rama `claude/sofi-lista-unica`.
- **Dejar fijos los mensajes de antes de la atención**: la atención entera y los 20 de antes de que empezara, en vez de al menos los últimos 20, para que en el hilo largo de quien vuelve la ventana no se corra. Se midió con casos propios de quien vuelve (`VUELVE=1` de `auditoria-masiva.ts`): 40 de odentIA y 12 de latidIA, cada uno con 30 a 48 mensajes de antes, y dos rondas por versión (104 conversaciones cada una). En las corridas de una sola llamada, lo escrito en la caché bajó de 741 a 125 tokens (mediana). Pero cada llamada llevó unos 720 tokens más de historial, y en el total lo escrito solo pasó del 8,4 % al 7,7 % de la entrada. Costó USD 0,000377 por llamada frente a 0,000375, y 0,00374 por conversación frente a 0,00347, con más llamadas (9,9 frente a 9,3). Cumplió todo el 27 % frente al 32 %: mejoraron 10 conversaciones y empeoraron 15. Queda en la rama `claude/sofi-ventana-anclada`.

### Consecuencias

- La caché vence a los 30 minutos sin uso. Una clínica con poca conversación vuelve a escribir lo suyo en la primera corrida que llega después. En las rondas hay cuatro conversaciones a la vez y lo de la clínica casi siempre está en la caché, así que una clínica tranquila ahorra menos.
- Lo que cambia el principio del historial deja esa corrida sin leerlo de la caché. Pasa cuando el camino cambia la lista de herramientas. También en el hilo largo de quien vuelve, mientras la atención tiene menos de 20 mensajes, porque la ventana de `listAttentionMessages` se corre. Eso cuesta poco: veinte mensajes de WhatsApp son unos 700 tokens de los cerca de 15 000 de cada llamada, y fijarlos no abarató a Sofi (ver lo descartado).
- `usage.test.ts` fija el orden: lo de la clínica, igual para dos personas; lo de la corrida, al final; y la corrida siguiente, igual a la anterior hasta su último mensaje.

Referencias: `graph.ts` (`loadContext`, `systemContent`); `llm.ts` (`createConfiguredChatModel`); `usage.test.ts`; `auditoria-masiva.ts` (`VUELVE`); la guía de la caché de OpenAI (developers.openai.com/api/docs/guides/prompt-caching).
