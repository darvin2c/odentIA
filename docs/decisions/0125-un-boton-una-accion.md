# 0125 · Un botón, una acción, y se resuelve en el sitio

Fecha: 2026-10-31 · Estado: aceptada · Complementa a [0025](0025-un-pendiente-un-lugar.md) y [0124](0124-sin-panel-del-agente.md)

## Problema

Una revisión de todas las pantallas mostró que casi siempre la operación de fondo era la misma, pero el botón no:

- **Etiquetas que prometían otra cosa.** «Enviar» de Inicio llevaba al Plan sin enviar; «Cobrar» de la ficha solo abría la cuenta; «Enviar nuevo enlace» llevaba a otra sección.
- **Filas que sacaban de la pantalla sin necesidad.** La «Agenda de hoy» y «Reagendar» iban a la Agenda, aunque «Te espera» abría la misma cita al lado. Una fila pedía llamar y confirmar sin dejar hacer ninguna de las dos.
- **Una acción con varios nombres, y un nombre para varias acciones.** Cinco nombres para abrir la conversación y «Revisar» con cuatro destinos.
- **Reglas distintas para la misma cita.** A la misma hora, la Agenda ofrecía «Confirmar» e Inicio «Llegó».
- **Un cierre sin decidir.** Tareas ofrecía «Hecha» en lo que dejó el sistema, como un representante por confirmar: cerraba el pendiente sin vincular a nadie.

## Decisión y motivo

- **Mismo nombre, misma operación; misma operación, mismo nombre.** Si cambia el efecto, cambia la palabra; si solo cambia la pantalla, no.
- **Lo que una fila pide se hace ahí o al lado.** Se va a otra pantalla solo si el trabajo vive allí: escribir una atención, seguir una conversación o recorrer una lista completa.
- **Un botón que lleva a otra pantalla dice «Ver…» o «Abrir…».** Un verbo que promete hacer (enviar, cobrar) hace eso, o abre al lado lo que falta para hacerlo.
- **El paso de una cita sale de una sola regla** (`stepBeforeArrival`): la lista de la Agenda e Inicio ofrecen lo mismo a la misma hora. El cajón ofrece además lo demás que se puede hacer, como «Llegó» a quien llega tarde hoy.
- **Lo que dejó el sistema (`task.kind`) se decide en su fila de «Te espera»** y no aparece en Tareas ni en Contexto.
- **Un caso se pasa o se resuelve desde su resumen**, con las mismas operaciones de la Bandeja.
- **El pedido sobre sus datos y el reenvío del portal se hacen al lado**, con los mismos cajones de la ficha. Comprobar identidad ya vive en un cajón, y el reenvío no la vuelve a pedir.

Quien trabaja no debería tener que aprender qué hace cada botón en cada pantalla, ni salir de lo que estaba haciendo para resolver lo que ya tiene delante.

## Alternativas descartadas

- *Una constante por cada nombre*: agrega una capa para unas pocas palabras que las pruebas de recorrido ya comprueban.
- *Solo igualar los nombres*: seguiría prometiendo cosas que el botón no hace.
- *Hacer de Inicio una pantalla que lo resuelve todo*: una atención o un hilo necesitan su propio espacio.

## Consecuencias

- Beneficio: menos saltos entre pantallas y etiquetas que se pueden creer.
- Sacrificio: las filas de Inicio llevan más botones, y cada presupuesto sin enviar pide su vista previa al cargar.
- Sigue llevando a otra pantalla, con «Ver la ficha»: comparar una posible ficha repetida, que pide ver la ficha entera. Decidir son los botones de la fila.
- La regla no se comprueba sola: al añadir un botón, buscar cómo se llama esa acción en las demás pantallas.

## Referencias

`packages/clinic-app/src/lib/agenda.ts` (`stepBeforeArrival`), `components/agenda/arrival.tsx` (`useAppointmentVisitStatus`, `announceVisitStatus`), `components/home/waiting-list.tsx`, `components/home/today.tsx`, `components/agent/case-brief.tsx`, `components/inbox/pass-topic-dialog.tsx`, `packages/services/src/tasks.ts`.
