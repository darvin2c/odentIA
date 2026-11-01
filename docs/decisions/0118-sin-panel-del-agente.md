# 0118 · Sin panel del agente: el trabajo va en Inicio y la actividad en su página

Fecha: 2026-10-31 · Estado: aceptada · Ajusta a [0025](0025-un-pendiente-un-lugar.md) (dónde va el contador)

## Problema

El botón «Agente» de la cabecera abría un panel con tres pestañas, y casi nada de lo que mostraba era suyo:

- **Casos** repetía «Te espera» y la Bandeja, con otros botones: el mismo caso se tomaba, se abría y se resolvía de cuatro formas según la pantalla. Además, los números no coincidían: recepción veía 2 en el menú y en Inicio, y 6 en el panel, porque este incluía lo que ya tenía otra persona.
- **Esperan** repetía Agente › «Esperan su sí», sin su «Confirmó por teléfono».
- **Actividad** era lo único propio, y solo sirve para supervisar.

El contador del menú iba en «Agente», pero al tocarlo se abría una página sin casos. Había dos «Agente» con contenido distinto. Y su única ventaja, trabajar con el panel al lado, solo existe desde 1536 px: por debajo tapa la página.

## Decisión y motivo

- **No hay botón ni panel del agente en la cabecera.** Lo que espera a una persona está en «Te espera» y en la Bandeja.
- **«Actividad» es una pestaña de la página Agente** (`/agent/actividad`), para quien supervisa y para quien decide por el agente, como recepción.
- **El único contador va en «Inicio».** Cuenta las personas que esperan a quien mira (`countWorkspaceWaiting`): casos sin tomar o suyos, más las conversaciones que esperan respuesta. Como lo cuenta el servidor para cada rol, también lo ven odontología y caja. En el teléfono va sobre el icono del menú, porque plegado no se ve, y con el menú en íconos queda un punto.
- **La columna lateral sigue** para los Avisos y los formularios.

Si el equipo se entera desde cualquier pantalla de que alguien espera, abrir Inicio basta: un solo lugar con un solo juego de botones es más simple que dos listas parecidas.

## Alternativas descartadas

- *Dejar el botón solo con la actividad*: un botón siempre a la vista para algo que se consulta de vez en cuando.
- *Que el botón abra lo mismo que Inicio*: sería otra entrada a lo que el menú ya abre, tapando la página en la mayoría de las pantallas y ocupando la columna que necesita un detalle.
- *Igualar los botones del panel con los de Inicio*: quita la diferencia, pero no la lista repetida.

## Consecuencias

- Beneficio: una lista menos, un número que coincide con lo que se ve y la columna lateral libre.
- Sacrificio: ya no se ven los casos al lado mientras se trabaja en otra pantalla con un monitor grande. No hay medición de cuánto se usaba.
- Revisar si el equipo dice que pierde tiempo yendo a Inicio desde la Agenda o una ficha: entonces conviene abrir esa misma lista al lado, nunca otra.

## Referencias

`packages/services/src/workspace.ts` (`countWorkspaceWaiting`), `packages/clinic-app/src/components/notices-column.tsx`, `routes/_org/agent.actividad.tsx`, `lib/agent-work.ts`, `packages/ui-patterns/src/page-header.tsx` (`MobileNavTrigger`).
