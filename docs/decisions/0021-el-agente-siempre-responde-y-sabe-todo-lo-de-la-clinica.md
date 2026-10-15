# 0021 · El agente siempre responde, sabe todo lo de la clínica y dice cada precio como la clínica lo eligió

Fecha: 2026-10-14 · Estado: aceptada · Reemplaza en [0008](0008-fichas-de-agentes-y-declaracion-unica-de-campos.md) los «niveles en lugar de una tabla de actos»

## Problema

- Recepción tenía dos controles para lo mismo: interruptores por función (Informar, Agendar, Seguimiento) y tres niveles (Supervisado, Equilibrado, Autónomo). Supervisado dejaba al paciente sin respuesta, aunque solo escribiera «hola», hasta que alguien aprobara el borrador. El dueño del producto lo juzgó sin valor: un agente que no responde solo añade trabajo.
- Con Agendar apagado el agente no tenía el enlace de reserva y pasaba a una persona a quien solo quería sacar una cita.
- «Informar» sabía poco: los primeros 50 servicios, el nombre de las promociones sin precio, condiciones ni fin, y nada de horarios de atención ni de profesionales. Buscaba por palabras exactas: «dientes amarillos» no encontraba el blanqueamiento.
- Siempre daba el precio de la tarifa, aunque en ortodoncia o implantes el precio real sale de la evaluación.

## Decisión y motivo

- **Sin niveles.** La clínica decide qué funciones enciende; quién dice que sí a cada acción es fijo para todas (`DEFAULT_AUTONOMY_MODES`): el agente responde al momento; reservar, mover o cancelar una cita lo confirma el paciente; lo comercial (crear, mover, anotar el seguimiento y cerrar una oportunidad) va directo porque es interno y se deshace. Cerrar como perdida solo si la persona lo dijo claro, nunca porque dejó de responder. «Probar» y «Aprender» cubren lo que Supervisado pretendía: ver qué diría antes de soltarlo. Los mensajes del Administrador ya no esperan aprobación: prender la línea es aprobarlos.
- **El enlace de reserva no depende de Agendar.** Encendido, el agente reserva por el chat o manda el enlace cuando ver todo ayuda; apagado, solo manda el enlace.
- **Informar con todo lo que existe, leído al momento.** Horario de atención de cada sede (la suma de los horarios de su equipo, más los cierres de toda la sede de los próximos 14 días), profesionales con sus especialidades y días, servicios y promociones vigentes con precio, condiciones y fecha de fin. Nada se escribe dos veces. Una clínica chica entra entera en el prompt; una grande se consulta con `buscar_en_la_clinica`, que devuelve solo lo que coincide.
- **Búsqueda por significado con vectores en la misma base (pgvector).** Se vectoriza solo texto descriptivo (nombres, especialidades, condiciones, respuestas oficiales); nunca precios, fechas ni datos de personas. El vector solo ordena: lo que se dice se lee de su tabla en ese momento, así que una promoción vencida o un precio cambiado nunca salen. El índice (`agent_search_item`) se concilia y se vectoriza en el ciclo del trabajador, fuera de las transacciones; si el proveedor falla, la búsqueda sigue por palabras. Cada fila guarda el modelo que la vectorizó y solo se compara con vectores del mismo.
- **Vectoriza un proveedor de la plataforma**, igual para todas las clínicas y compatible con OpenAI (`EMBEDDINGS_*`), no el modelo propio de cada clínica: no todos ofrecen vectores. `fake` (por trozos de letras, sin red) sirve para desarrollo y pruebas y no entiende significado.
- **Cómo dice el precio** cada servicio y cada servicio de una promoción: exacto, «desde» o solo con evaluación, con la evaluación que ofrece. Solo cambia lo que se le dice a una persona: caja y presupuesto usan siempre la tarifa y el ajuste por línea que ya existía. Con «solo con evaluación» el número no llega al agente; con «desde», la comprobación antes de enviar no deja salir ese importe sin «desde». Un servicio nuevo nace «solo con evaluación» (decisión del dueño del producto); los que ya existían pasaron como «exacto» para no cambiar lo que el agente decía.

## Alternativas descartadas

- *Conservar los niveles y añadir un aviso inmediato en Supervisado*: sigue sin responder lo que el paciente pregunta.
- *Mandar al modelo todo el catálogo*: con miles de servicios es caro, lento y confunde al modelo.
- *Guardar el precio en el vector*: un cambio de precio o el fin de una promoción tardaría en verse y el agente podría decir algo falso.
- *Un servicio de vectores aparte*: otro sistema que operar para pocas filas por clínica; pgvector en la misma base hereda el aislamiento por organización.
- *Una evaluación «general» de la clínica por defecto*: no hay hoy un dato que diga cuál es; cada servicio elige la suya y, sin ella, el agente ofrece agendar una evaluación.

## Consecuencias

- `agent_policy` queda solo para que las pruebas ejerciten los otros modos de la máquina de propuestas; ninguna ruta ni pantalla la cambia.
- La imagen de Postgres de desarrollo y pruebas incluye pgvector; la base de producción debe tenerlo.
- Medido el 2026-10-14 con `eval:search` (banco propio de 38 preguntas, `text-embedding-3-small`, umbral 0,65): lo correcto sale primero en 32 de 35 preguntas con respuesta (33 entre los tres primeros), frente a 11 de 35 solo por palabras; igual con 3 024 servicios, y el modelo recibe unos 1 000 caracteres por búsqueda. El índice lleva qué es cada cosa y las palabras con que la gente nombra cada especialidad: sin eso eran 27 de 35. Lo que la clínica no ofrece («cirugía de nariz») queda a la misma distancia que una pregunta válida: ningún umbral lo separa, así que la búsqueda trae lo más parecido y le dice al modelo que diga que la clínica no lo ofrece si no es lo pedido. Banco chico y propio: no es una medición independiente.
- ~~`LLM_REASONING_EFFORT` (opcional) fija `reasoning_effort` del modelo de la plataforma.~~ Reemplazado por [0022](0022-la-clinica-elige-entre-dos-modelos-de-odentia.md): `reasoning_effort: "none"` (sin él `gpt-6-luna` en chat/completions rechaza herramientas) va fijo en el catálogo de modelos.
- Revisión del 2026-10-14 (código y conversaciones con el modelo real), corregido en el mismo cambio:
  - Una promoción no compara con la tarifa ni dice el ahorro si el servicio no dice su precio exacto: delataría el número.
  - Basta con que una fuente dé un importe como mínimo para exigir «desde», aunque el mismo número aparezca suelto en otra (lo que escribió la persona, una hora).
  - Con «Informar» apagado, `ver_sedes_y_servicios` (que sigue por Agendar) solo trae sedes y horarios.
  - El valor de una oportunidad no llega al agente: es una cifra interna, no un precio.
  - El índice se refresca en segundo plano cada 5 minutos, sin bloquear las colas del trabajador; en la conversación se espera al proveedor de vectores 3 s y luego se busca por palabras. Sin `EMBEDDINGS_MODEL` no hay vectores (el doble `fake` solo si se pide).
  - `buscar_huecos` entrega cada hueco en hora local de la sede con el nombre del profesional, y acepta el rango en hora local: con horas UTC el modelo se confundía, decía horarios falsos y llegó a enviar su razonamiento a la persona.
  - Reglas en el prompt: lo que se envía es solo la respuesta final; atiende solo lo de la clínica; una cita solo existe si se propuso y confirmó con sus herramientas; la promoción se ofrece una vez por conversación.
  - Sin cambiar: `update_followup` va directo, pero la corrida de coordinación no lo tiene entre sus herramientas, así que el agente no encadena mensajes por su cuenta.
- ~~Privacidad, por decidir: la frase que busca el agente viaja al proveedor de vectores de la plataforma también en clínicas con modelo propio.~~ Resuelto por [0022](0022-la-clinica-elige-entre-dos-modelos-de-odentia.md): ya no hay modelo propio y todos los proveedores los elige odentIA. El índice lleva nombres de profesionales de la clínica, nunca de pacientes.
- Fuera de tema (2026-10-14): el modelo de decisión aprendió la intención `off_topic`. Medido con Jev, dos repeticiones (`eval:off-topic`): con umbral 0,9 reconoce 30/30 mensajes ajenos (recetas, tareas, código, política, chistes) y no marca ninguno de los 112 de la clínica, incluidos los que lo parecen («qué como después de una extracción», «se me cayó una calza mientras comía», que salió con 0,62–0,66). Lo ajeno se responde con un texto fijo, sin el modelo que escribe: unos 0,3 s y sin tokens del modelo, frente a ~9 000 por mensaje antes. Banco chico y propio.
- Ráfaga que termina en un agradecimiento (2026-10-14): con varios mensajes seguidos el camino «saludo» no se aplica (`guardBurst`). Se eligió una regla del código y no mejorar la pregunta al modelo de decisión ni ampliar el camino «saludo»: la primera seguiría dependiendo de que el modelo acierte y la segunda quitaría el ahorro a todos los saludos. Verificado con Jev y el modelo real: «¿cuánto cuesta un blanqueamiento? / gracias» salió como saludo (0,62), la regla lo pasó al camino abierto y el agente dio el precio; «muchas gracias!» solo siguió como saludo (una llamada, ~3 400 tokens).
