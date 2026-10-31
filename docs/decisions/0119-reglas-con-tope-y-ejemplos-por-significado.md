# 0119 · Reglas con tope y ejemplos buscados por significado

Fecha: 2026-10-31 · Estado: aceptada · Precisa [0009](0009-el-agente-aprende-por-lecciones-aprobadas.md) y el «Revisar» de su cierre

## Problema

Lo que aprende un agente llega a su prompt de tres maneras, y dos fallaban en silencio al crecer:

- **Reglas.** Van todas en cada mensaje, porque se cumplen aunque la pregunta no se parezca («No ofrezcas descuentos» vale también cuando preguntan un horario). Llegaban hasta 40, recortadas a 300 caracteres. Pasadas las 40, las más antiguas dejaban de llegar, y una regla escrita admitía 2000 caracteres (la pantalla, 600): al agente le llegaban los primeros 300 sin que nadie lo supiera.
- **Ejemplos.** Solo van los parecidos a la pregunta, como mucho dos. Se comparaban por palabras con los 200 más recientes: pasado ese número, los anteriores dejaban de usarse, y «dientes amarillos» no encontraba un ejemplo sobre blanqueamiento.
- **Respuestas oficiales.** Ya estaban acotadas (ADR 0007: todas si caben en 12 000 caracteres; si no, el índice y el modelo de decisión elige). No cambian.

## Decisión y motivo

- **Tope duro de 40 reglas activas por agente** (`LESSON_RULE_LIMIT`). Con el tope lleno no se agrega ni se restaura otra (`RULE_LIMIT`); aprobar una regla nueva exige elegir cuál reemplaza (`findRuleConflict` devuelve las activas en `full` y «Aprender» las muestra para elegir). El costo por mensaje queda fijo y ninguna regla desaparece sin que una persona lo decida.
- **Cada regla mide como mucho 300 caracteres** (`RULE_BODY_CHARS`), al escribirla, editarla, aprobarla o restaurarla. Lo que no cabe se dice junto al campo: lo largo casi siempre es un ejemplo o una respuesta oficial. Las anteriores más largas siguen llegando cortadas y la lista lo dice en cada una.
- **Los ejemplos se buscan por significado entre todos**, con el índice vectorial que ya existía (ADR 0021, `agent_search_item`, tipo `ejemplo`): se indexa la pregunta del ejemplo y, en cada turno con algún ejemplo activo, la frase de la persona se vectoriza fuera de la transacción (`examplesByMeaning` de `graph.ts`, con el mismo plazo de 3 s que `buscar_en_la_clinica`). Llegan los dos más cercanos; si falta, los parecidos por palabras entre los 200 más recientes. Sin vectorizador o si falla, solo palabras. El vector solo ordena: el texto se lee de la lección en ese momento, así que uno retirado deja de usarse al instante.

## Alternativas descartadas

- *Buscar también las reglas por parecido*: una regla que no se parece a la pregunta igual tiene que cumplirse; con búsqueda, a veces no llegaría.
- *Que un modelo resuma las reglas cuando pasan del tope*: el texto que recibe el agente dejaría de ser el que aprobó una persona (ADR 0009).
- *Subir el tope*: el bloque va en cada llamada; 40 reglas cortas ya son unos 3 000 tokens y una clínica real usa pocas.
- *Búsqueda de texto de Postgres para los ejemplos*: escala, pero sigue sin entender sinónimos; el índice vectorial ya está en la misma base.

## Consecuencias

- Por mensaje, lo aprendido pesa como mucho 40 reglas de 300 caracteres y 2 ejemplos, tenga la clínica los que tenga.
- Sacrificio: una llamada al vectorizador por turno en las clínicas con ejemplos (se anota en su uso, origen `recepcion`) y hasta 3 s de espera si el proveedor tarda. El índice ahora guarda la pregunta de cada ejemplo, que escribió una persona y ya estaba en su lección.
- Revisar si las clínicas llegan seguido al tope: sería señal de que lo que se escribe como regla debería ser otra cosa, no de subirlo.

## Referencias

- `packages/services/src/agent-learning.ts` (`LESSON_RULE_LIMIT`, `RULE_BODY_CHARS`, `assertRuleRoom`, `lessonsForTurn`), `agent-guidance.ts` (`findRuleConflict`), `agent-search-index.ts`.
- `packages/agent/src/graph.ts` (`examplesByMeaning`).
- `packages/clinic-app/src/components/agent/lesson-drawer.tsx`, `agent-guidance.tsx`.
- Migración `0026_ejemplos_en_el_indice`.
