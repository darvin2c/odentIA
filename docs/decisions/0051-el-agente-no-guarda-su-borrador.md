# 0051 · El agente no guarda su borrador

Fecha: 2026-10-17 · Estado: aceptada · Precisa [0006](0006-memoria-del-caso-y-comprobacion-de-respuestas.md) y [0024](0024-ninguna-conversacion-queda-abierta.md)

## Problema

El grafo de Recepción usaba el checkpointer de LangGraph (`PostgresSaver`). En cada paso de cada corrida guardaba entero el sistema, el historial y lo que devolvió cada herramienta, en `checkpoints`, `checkpoint_blobs` y `checkpoint_writes`. Nada lo borraba.

Medido con `eval:month` el 2026-10-17:

- Cada respuesta del agente suma unos 122 KB a la base; 96 KB son ese estado, en unas 7 fotos por corrida.
- En la clínica mediana es cerca del 55 % de lo que crece la base: 0,06 de 0,10 GB al mes.
- El disco libre del VPS compartido alcanzaba para 42 clínicas medianas durante un año.
- Los 14 respaldos diarios copian todo eso.

Nadie volvía a leerlo:

- `loadContext` arma cada turno desde la base: los últimos mensajes, las propuestas (`agent_proposal`) y las notas del caso (`agent_case_memory`). Ese lote reemplazaba lo guardado; 0006 ya había descartado apoyarse en lo guardado entre turnos.
- `run.ts` siempre empieza con una entrada nueva, nunca reanuda una corrida a medias.
- Ninguna pantalla ni servicio lo consulta.
- Cada atención tenía su propio hilo (0024): el anterior quedaba huérfano.

Eran copias de datos personales que no usaba nadie, entre ellas mensajes, el resumen del paciente y presupuestos con tratamientos.

## Decisión y motivo

- **El grafo se compila sin checkpointer** (`compileAgentGraph(model, toolCtx)`), igual que ya hacían «Probar» y la simulación. Cada corrida empieza vacía y lo que debe quedar tiene su tabla:
  - lo dicho, en `message`;
  - en qué se apoyó cada respuesta y qué se comprobó, en `agent_answer_trace`;
  - lo propuesto y lo hecho, en `agent_proposal` y en la auditoría;
  - tokens, costo y herramientas, en `agent_run_ledger`;
  - las notas, en `agent_case_memory`.
- **La migración `0015` borra las cuatro tablas** de LangGraph. Las creaba el worker al arrancar, fuera de la historia de migraciones, y sus políticas de RLS se van con ellas. No hay clínicas reales: no se conserva nada.
- Salen `@langchain/langgraph-checkpoint-postgres` y `setupAgentMemory`.

## Alternativas descartadas

- *Borrarlo a los 7 días con un trabajo nocturno:* deja una semana para ver el texto exacto que recibió el modelo. Ahorra casi el mismo disco, pero agrega un trabajo que puede fallar y conserva copias de datos personales. Nadie tiene hoy cómo leerlas sin acceso de dueño a la base.
- *Borrarlo al cerrar la conversación:* mezcla el cierre (servicios) con lo interno del agente. Una conversación a cargo del equipo puede seguir abierta días, así que igual haría falta el barrido.

## Consecuencias

- La base de la clínica mediana pasa de 1,19 a 0,49 GB al año.
- El disco libre alcanza para unas 100 clínicas medianas durante un año, en lugar de 42.
- Cada respuesta deja de escribir sus fotos.
- Sacrificio: ya no se puede ver el texto exacto que recibió el modelo en una respuesta pasada. Para investigar una respuesta quedan su traza, «Probar» y `eval:month`.
- Revisar si se necesita retomar una corrida a medias o una pausa del grafo esperando a una persona. Hoy las propuestas viven en `agent_proposal` (0023), no en el grafo. Lo que se guarde entonces llevaría su caducidad.

## Referencias

- `packages/agent/src/graph.ts` (`compileAgentGraph`, `loadContext`), `run.ts`, `apps/worker/src/index.ts`.
- `packages/db/drizzle/0015_el_agente_no_guarda_su_borrador.sql`.
- Prueba «el agente no guarda su borrador…» de `agent.test.ts`.
