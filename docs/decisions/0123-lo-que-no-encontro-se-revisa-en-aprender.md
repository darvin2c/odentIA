# 0123 · Lo que Sofi no encontró se revisa en Aprender, y corregir siempre deja cómo deshacerlo

Fecha: 2026-10-31 · Estado: aceptada · Ajusta a [0118](0118-cada-numero-donde-se-resuelve.md) (el número del menú) y precisa [0120](0120-lo-que-sabe-sofi-sale-de-los-datos.md) (Conocimiento)

## Problema

- Había dos listas de lo mismo: «No supo responder» en Conocimiento y «Por revisar» en Aprender. No encontrar algo no siempre es un error: si la clínica no trabaja con alineadores, Sofi acierta al decir que lo confirma. Decidir eso pide ver lo que escribió la persona y lo que le dijo, y la lista de Conocimiento solo daba una frase.
- «Guardar como respuesta oficial» publicaba de un toque, sin lección: lo publicado así no se podía retirar desde «Lo aprendido».
- Cada pantalla contaba por su lado. El número de Aprender dependía de abrir su lista, porque la conciliación corre al leer.
- Las pestañas «Todos · Sofi · Clío · Argos» y el texto «lo usa cualquier agente» prometían algo que no ocurre: solo Sofi deja respuestas que se corrigen (`recordAnswerTrace` solo se llama desde `send_reply` y `despedirse_y_cerrar`) y solo ella recibe lo aprendido.
- «Estuvo bien» no decía qué pasaba después. La fila de una ráfaga mostraba solo su último mensaje, y un «Si» no se entendía sin lo anterior.
- En «Lo que Sofi debe saber», «Borrar» y «Retirar» eran lo mismo con dos nombres, sin forma de recuperar lo quitado; y escribir a mano una regla contradictoria no avisaba, aunque aprobarla sí.

## Decisión y motivo

- **Lo que no encontró es un motivo más de «Por revisar»** (`no_encontro`, «Buscó y no encontró»): lo que escribió, lo que buscó, lo que respondió y cuántas veces se preguntó. La persona decide «Estuvo bien» o «Corregir», como en cualquier otra fila.
- **Una fila sale de la pregunta abierta, no de la traza.** Lo que no encuentra suele terminar en un pase al equipo y ese aviso no deja traza, así que `trace_id` admite nulo y lo que respondió se lee del mensaje siguiente del agente. No se agregan trazas a los pases: entrarían todos a «el equipo tomó».
- **Varias personas, una fila**: se agrupa por lo buscado o lo escrito, normalizados; lo escrito muy corto no agrupa, porque el «Si» de dos personas no es la misma pregunta. Si la respuesta ya estaba por otra señal, queda en esa fila con este motivo; si ya se decidió, la pregunta se cierra con ella.
- **Publicar pasa siempre por una lección.** Se quita el botón de un toque; corregir propone, aprobar publica y «Lo aprendido» retira, también las formas de preguntar que sumó. Descartar la corrección devuelve la fila a la lista: la pregunta sigue sin responderse. Queda «Sumar a esa respuesta» sin lección, porque no cambia ningún texto: solo agrega lo buscado, y lo que escribió la persona si habla de eso, como otra forma de preguntar. En una ráfaga el último mensaje puede ser de otro tema, y esa forma llevaría a Sofi a la respuesta equivocada.
- **Un solo número**: `countLearningPending` suma las búsquedas abiertas sin fila, una vez que Sofi respondió, así el menú no depende de haber abierto la lista. La pantalla usa el total aunque su lista tenga tope, y lo dice. Conocimiento y el Resumen dejan de contar aparte.
- **Conocimiento muestra solo lo que Sofi sabe.**
- **«Estuvo bien» dice que no cambia nada**, y su aviso lleva «Deshacer» y «Guardar como ejemplo». Dar por buena una respuesta no impide corregirla después desde «En qué se basó».
- **Corregir muestra la conversación arriba**, con todo lo escrito seguido y lo que se le dijo antes; lo del equipo no viene escrito («Usar este texto»), para no publicar sin leer. El pie dice en qué se convierte, según lo que define el servidor (`lessonKinds`).
- **Sin pestañas por agente ni «a quién se aplica»** mientras solo Sofi reciba correcciones.
- **Una regla escrita se trata como una aprendida**: «Retirar» con el mismo diálogo, «Retiradas» con «Restaurar», y aviso si contradice otra («Reemplazar», «Mantener las dos», «Seguir editando»). El aviso no impide guardar.
- No cambia lo que Sofi lee ni lo que dice: ni prompt ni herramientas. Por eso no pide una medición con modelo.

## Alternativas descartadas

- *Mantener las dos listas*: la misma decisión en dos pantallas, con dos números y dos caminos para publicar.
- *Dejar traza en los pases al equipo*: llenaría «el equipo tomó» de casos que no son una respuesta dudosa.
- *Conciliar también al contar*: el número haría escrituras en cada carga del menú.
- *Agrupar con un modelo*: Por revisar entra por señales deterministas, y dos filas parecidas cuestan menos que una llamada por búsqueda.
- *Conservar el botón de publicar de un toque*: es lo único que publicaba sin dejar cómo retirarlo.

## Consecuencias

- Una clínica con preguntas abiertas las ve entrar sola a «Por revisar» al abrir Aprender, sin migrar datos a mano.
- Corregir una de estas filas cuenta como «corregida» en el Resumen, aunque Sofi no se haya equivocado: el dato faltaba.
- Algo dado por bueno vuelve si lo preguntan otra vez. Es a propósito: para que no vuelva, se le enseña.
- Las respuestas publicadas antes desde «No supo responder» no tienen lección: se quitan con «Despublicar», como cualquier otra respuesta.
- Una pregunta con muchos mensajes seguidos sobre varios temas se agrupa por lo buscado, no por lo escrito completo.
- Queda fuera lo que Sofi dice cuando no encuentra algo: cambiarlo sí pide medir con el modelo.

## Referencias

- `packages/db/drizzle/0033_lo_que_no_encontro.sql`, `packages/db/src/schema/agent.ts` (`agentReviewItem`, `agentKnowledgeGap`).
- `packages/services/src/agent-learning.ts` (`syncGapsIntoReview`, `countLearningPending`, `correctAnswer`, `addReviewToAnswer`, `getReviewConversation`), `agent-guidance.ts` (`findTextConflict`, `retireReplaced`), `knowledge.ts` (`recordKnowledgeGap`, `addAskFormsToAnswer`).
- `packages/clinic-app/src/routes/_org/agent.learn.tsx`, `components/agent/correct-drawer.tsx`, `agent-guidance.tsx`.
