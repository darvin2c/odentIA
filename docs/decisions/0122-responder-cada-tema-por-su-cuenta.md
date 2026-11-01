# 0122 · Bandeja: cada tema se responde por su cuenta

- Fecha: 2026-11-01.
- Estado: aceptada. Precisa el [0050](0050-el-agente-nunca-se-calla.md) y el [0112](0112-bandeja-mas-espacio-y-lo-que-hace-el-agente-en-el-hilo.md) en cómo se responde un tema.

## Problema

En una conversación real con tres temas abiertos, la caja respondía siempre al más antiguo y volvía a él después de cada envío. Dos respuestas sobre otras preguntas le llegaron a la persona citando un mensaje del día anterior. Con «Enviar y resolver» se habría cerrado el tema equivocado.

También pedía respuesta lo que no la necesitaba. Un «Si» a Sofi se anotaba como que volvió a preguntar: se resaltaba y, por ser el segundo, subía el tema a «Ahora». Un «gracias» citando a alguien del equipo le abría un tema.

Y el ciclo daba por respondidos todos los temas abiertos con cualquier mensaje del equipo, incluidos los que nunca se respondieron y los que alguien dejó pendientes a propósito.

## Decisión y motivo

- **La caja elige sola solo si no hay duda:** un único tema, de quien mira. Con varios, una lista con lo que escribió la persona: tocar una fila elige el tema y lleva a su mensaje. Sin nada elegido sale un mensaje normal y no se resuelve nada. Equivocarse así no le llega a la persona.
- **Responder como en WhatsApp:** «Responder» junto a cada mensaje de la persona y la cita sobre la caja, con su X. Esto reemplaza las opciones «Responder a…» del «…».
- **Un solo botón, «Enviar», y corregir después.** Enviar no se puede deshacer; resolver sí, porque no le manda nada a la persona. Por eso lo reversible no pide una decisión antes de lo irreversible: «Dejar pendiente» aparece al enviar.
- **«Resolver» en cada fila propia,** para lo que no necesita respuesta. Lo de otra persona no se cierra de un toque: se elige y se resuelve en su «…».
- **Lo que solo asiente o agradece no pide nada** (`onlyCourtesy`, `asksNothingNew`): no entra a un tema ni le abre uno. La excepción es lo que contesta una pregunta del equipo, porque alguien espera ese sí. Una lista fija de palabras basta: fallar cuesta un resaltado o un tema que se cierra con «Resolver».
- **El ciclo solo da por respondido un tema que está solo,** con un mensaje sin cita o que cita ese tema, y posterior a que lo dejaran pendiente (`kept_pending_at`).

## Alternativas descartadas

- *Una respuesta para dos temas de una vez:* pide selección múltiple, un modo sin cita (WhatsApp cita un solo mensaje) y cambios en el servidor. Responder uno y tocar «Resolver» en el otro cuesta un toque más.
- *Detectar promesas para dejar el tema abierto solo:* ninguna lista cubre las formas de decirlo («déjame ver», «mañana le digo»), y un modelo agrega costo y espera a cada respuesta por una marca que se corrige con un toque. Quien promete lo sabe, y «Dejar pendiente» aparece justo después de enviar.
- *Conservar «Enviar, sigue pendiente»:* obliga a decidir en cada mensaje algo que casi siempre es lo mismo.
- *Una línea fija bajo cada mensaje con el estado de su tema:* pide consultar los temas cerrados por mensaje. El aviso que ya existía basta.
- *Un botón flotante con los pendientes:* hay que recorrerlos uno por uno sin ver qué son.

## Consecuencias

- Un tema resuelto por error sale de «Por atender» y el aviso con «Dejar pendiente» desaparece al cambiar de conversación. A la persona no le pasa nada y se le puede seguir escribiendo; lo que se pierde es el recordatorio. Si «Dejar pendiente» se usa seguido, se revisa.
- Con varios temas y sin nada elegido, un mensaje que los responde no los cierra: quedan en «Por atender» hasta que alguien toque «Resolver».
- Sofi responde un «gracias» que cita a alguien del equipo, como cualquier otro «gracias»; antes se callaba y abría un tema. Sus textos no cambian.
- «Sofi se ofrece» (`topic-retake.ts`) sigue contando cualquier mensaje del equipo como respuesta: un tema que no se respondió no se retoma si el equipo escribió por otro.

## Referencias

`packages/clinic-app/src/components/inbox/thread-view.tsx`, `topic-list.tsx`, `packages/services/src/topic-reply.ts` (`sendTeamReply`, `reopenTopic`), `agent-operations.ts` (`onlyCourtesy`, `asksNothingNew`), `conversation-close.ts` (`settleAnsweredTopics`).
