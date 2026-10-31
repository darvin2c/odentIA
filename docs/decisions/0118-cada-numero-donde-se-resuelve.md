# 0118 · Cada número donde se resuelve, y el horario de la sede a la vista

Fecha: 2026-10-31 · Estado: aceptada · Ajusta a [0025](0025-un-pendiente-un-lugar.md) (el contador del menú del Agente)

## Problema

- El número del menú «Agente» contaba los casos que el agente pasó al equipo (0025), pero ninguna pestaña de Agente los lista: se toman en «Te espera» y en el panel del botón «Agente» de la cabecera. Quien abría Agente veía otra cifra (Aprender · 4 con un 7 en el menú) y no encontraba qué resolver.
- «Esperan su sí» (decisión 21) repetía lo que la Bandeja ya muestra en cada conversación («Espera su sí», con «Registrar confirmación») y el panel del agente en su pestaña «Esperan». Era la única pestaña que veía recepción, que no supervisa al agente.
- El horario de atención de una sede ya existe: es la suma de los horarios del equipo más sus cierres, y el agente lo dice (0021). No se veía en ninguna pantalla, y la clínica creía tener que escribirlo otra vez.

## Decisión y motivo

- **El menú «Agente» cuenta lo que se resuelve dentro de Agente**: respuestas por revisar, lecciones por aprobar y lo que no supo responder (`countAgentWork`). Es la suma de los números de sus pestañas, y solo lo ve quien supervisa al agente (`agent.read`).
- **Los casos que pasó el agente van en el botón «Agente» de la cabecera**, que abre el panel donde se toman (lo que nadie tomó más lo propio, como contaba 0025). Sigue siendo un solo número por asunto: el de los casos no se repite en el menú.
- **Se retira «Esperan su sí»**. Lo que espera el sí de la persona se ve y se registra en su conversación de la Bandeja y en el panel. Las direcciones viejas (`/agent/pendientes`, `/agent/approvals`) llevan a la Bandeja. Recepción, que solo decide (`agent.decide`), deja de ver la entrada «Agente» del menú: lo suyo está en la Bandeja, en «Te espera» y en el panel.
- **El horario de atención de la sede se muestra donde se forma**: «Horarios y ausencias» › «De la sede» lo dice tal como lo dice el agente (`getBranchHours`). No se agrega un horario de la sede escrito aparte: con nadie del equipo en ese tramo, el agente ofrecería horas que no existen (0097).

## Alternativas descartadas

- *Listar los casos dentro de Agente*: otra lista del mismo pendiente; 0025 la retiró por eso.
- *Conservar «Esperan su sí» solo para recepción*: la misma información en tres lugares.
- *Un horario de atención por sede escrito a mano*: dos fuentes del mismo dato que se contradicen apenas cambia el horario de alguien.

## Consecuencias

- El menú y las pestañas dicen lo mismo; el número de casos vive junto al panel que los resuelve.
- Sacrificio: en el teléfono el botón de la cabecera va en el menú ⋯, con su número al lado.
- La recepción que abre antes que el primer profesional no tiene cómo decirlo; si una clínica lo pide, se revisa con un horario propio de recepción, no de la sede.

## Referencias

- `packages/services/src/agent-overview.ts` (`countAgentWork`), `agent-operations.ts` (`getAgentPanelSummary`), `agent-clinic-info.ts` (`getBranchHours`).
- `packages/clinic-app/src/routes/_org.tsx`, `components/agent-panel.tsx` (`AgentPanelButton`), `components/agent-tabs.tsx`, `routes/_org/settings.availability.tsx` (`BranchHoursCard`).
