# 0009 · El agente aprende por lecciones que una persona aprueba

Fecha: 2026-10-10 · Estado: aceptada

## Problema

Cuando el agente respondía mal, la única salida era reescribir a mano las indicaciones o el conocimiento, sin saber qué más cambiaba con eso ni poder volver atrás. El equipo ya corrige al agente sin proponérselo —toma la conversación y responde otra cosa, o cambia un borrador antes de aprobarlo— y esa corrección se perdía. Queremos que el agente mejore con el uso sin que nada cambie solo: una respuesta dirigida a pacientes no puede depender de algo que nadie aprobó.

## Decisión y motivo

- **Tres piezas, en este orden.** *Por revisar*: respuestas que conviene que una persona mire. *Lección*: lo que se propone aprender de una corrección. *Caso de prueba*: la pregunta real con la respuesta que una persona dio por buena.
- **Qué entra a revisión** se decide con reglas, no con un modelo: alguien del equipo escribió justo después de la respuesta, el interlocutor repitió la pregunta, una muestra al azar (1 de cada 20), lo que alguien marca desde la Bandeja y los borradores que el equipo cambia antes de aprobar. Son señales para mirar, no un veredicto.
- **Una lección no cambia nada hasta que la aprueba quien administra el agente** (`agent.write`). Revisar y corregir lo hace quien decide por el agente (`agent.decide`).
- **Tres clases, con alcance distinto.** Una *respuesta oficial* es un dato de la clínica: al aprobarse entra al conocimiento (nueva, o cambiando la que ya trataba el tema) y la usa cualquier agente. Una *regla* y un *ejemplo* son del agente que recibió la corrección: las reglas van siempre en su prompt, por debajo de los principios fijos; los ejemplos, solo cuando la pregunta se parece.
- **La clase se propone por lo que falló** (dato equivocado o faltante → respuesta oficial; tono u otra cosa → ejemplo; no debió responder → regla) y la persona la puede cambiar antes de aprobar. No la redacta un modelo: el texto es el que escribió la persona.
- **Retirar devuelve todo a como estaba**: deja de usarse al instante, la respuesta oficial vuelve a su texto anterior (o se despublica si la lección la creó) y se puede restaurar. Si alguien reescribió esa respuesta después, retirar no la toca: manda lo último que escribió una persona. Nada se borra.
- **Probar antes de decidir cuesta solo donde hace falta.** A qué casos toca una lección se calcula comparando textos, sin modelo. Volver a responder esos casos «hoy» y «con el cambio» sí usa el modelo, y por eso se hace a pedido y con tope (la pregunta de origen y hasta completar tres casos), nunca al listar.
- **Aprobar con edición**: el equipo puede cambiar el texto de un mensaje al aprobarlo. Sale su texto; el borrador del agente se conserva en la propuesta como evidencia, y se propone una lección con lo que cambió.

## Alternativas descartadas

- *Que el agente aprenda solo de cada corrección*: un error del equipo o una excepción puntual pasarían a ser la respuesta para todos.
- *Ajuste fino del modelo*: caro, opaco, no se puede retirar una lección concreta y ata a un proveedor.
- *Un modelo que juzgue cada respuesta*: duplica el coste por respuesta y sus juicios tampoco se podrían explicar; las señales del propio trabajo del equipo son gratis y concretas.
- *Volver a correr todos los casos de prueba con el modelo en cada cambio*: el coste crece con cada lección aprobada; se corre solo lo que toca el tema.

## Consecuencias

- Beneficio: una corrección aprobada llega a la siguiente respuesta a esa pregunta; cada respuesta dice qué lección usó; todo se puede retirar.
- Sacrificio: «toca el tema» es una comparación de palabras: puede dejar fuera un caso que sí cambiaría o incluir uno que no. La comparación «responde igual» es de texto, y un modelo real puede variar la redacción sin cambiar el contenido.
- El contador de usos es aproximado: una regla cuenta cuando la pregunta toca su tema, y una respuesta oficial solo cuando el agente la buscó expresamente.
- Revisar si la cola de revisión crece más de lo que el equipo puede mirar (ajustar la muestra) o si las reglas activas pasan de unas veinte (el prompt lleva las más recientes).

## Referencias

- `packages/services/src/agent-learning.ts`, `packages/agent/src/graph.ts` (reglas y ejemplos en el contexto), `packages/agent/src/run.ts` (`previewLesson`), migración `0050`.
