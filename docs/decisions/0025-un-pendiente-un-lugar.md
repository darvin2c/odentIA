# 0025 · Un pendiente, un lugar

Fecha: 2026-10-15 · Estado: aceptada · Ajusta a [0024](0024-ninguna-conversacion-queda-abierta.md) (el aviso de la conversación que sigue abierta)

## Problema

Un mismo caso que el agente pasaba al equipo aparecía en unos diez sitios: dos o tres filas de «Te espera» (el caso, su tarea «Derivación (alta): …» y dentro de «N personas esperan respuesta»), dos o tres avisos de la campana que nunca se retiraban, cinco contadores con el mismo número (que además contaban lo que ya había tomado otra persona) y siete nombres distintos, con la prioridad en código en los avisos. La campana mezclaba trabajo con información, crecía sin fin y tres clases de aviso nunca llegaban a nadie porque la API solo dejaba pasar permisos de lectura.

## Decisión y motivo

- **«Te espera» es la única lista de lo que hay que hacer**, una fila por asunto. El caso y su tarea son una sola fila; la conversación del caso no cuenta en «esperan respuesta». También entran ahí la cita que sigue sin confirmar tras el primer recordatorio del agente («no confirmó · llamar») y la conversación que sigue abierta con una persona a cargo (antes era un aviso, ver 0024).
- **La campana es solo para enterarse.** No trae nada de lo que está en «Te espera». Abrir un aviso lo marca leído y hay «Marcar todo leído». Un aviso con asunto se retira solo cuando el asunto se resuelve, con una sola regla en el servidor (`settleWorkspaceNotifications`), y vuelve si el asunto vuelve. Nadie recibe aviso de lo que hizo. Cada aviso llega a quien tiene el permiso que declara, sea de lectura o de escritura.
- **Un solo contador y un solo nombre.** El número va solo en el menú del Agente y cuenta lo que nadie tomó más lo propio. En pantalla, «Te lo pasó el agente» en cada fila y «Casos del agente» como lista; la urgencia es siempre «Ahora / Hoy / Sin apuro».
- **Terminar un caso avisa igual en todas partes.** Completar su tarea en Tareas o en «Contexto» muestra antes lo mismo que «Resolver».

El equipo de una clínica mediana trabaja desde una lista, no desde varias que se contradicen; lo repetido se ignora y lo que se ignora deja de servir.

## Alternativas descartadas

- *Campana con todo y filtros*: obliga a decidir qué mirar y sigue duplicando «Te espera».
- *Retirar avisos desde cada pantalla al resolver*: la regla se repite y se olvida en algún sitio; una sola consulta por clase de asunto no se desincroniza.
- *Borrar los avisos resueltos*: la aplicación no borra avisos (privilegio retirado en 0026_saas_invariants); se marcan como retirados.
- *Mantener contadores por pantalla*: cinco números iguales no dicen nada nuevo y contaban lo ajeno.

## Consecuencias

- Quien atiende sin acceso a los casos sigue viendo la conversación en «esperan respuesta»: es la única fila que la muestra.
- La conversación abierta con una persona a cargo ya no avisa: aparece en «Te espera» de quien la lleva (o de quien atiende lo del agente, si nadie la tiene).
- Sacrificio: quien no abre Inicio no se entera de lo nuevo por la campana. Se revisa si el equipo pide un aviso en tiempo real para los casos «Ahora».

## Referencias

- `packages/services/src/workspace.ts` (`settleWorkspaceNotifications`, `NOTICE_SUBJECTS`, `getWorkspaceHome`), `workspace-home.ts`, `conversation-state.ts` (`stillOpenWithPersonSql`), `automation.ts` (`remindedUnconfirmedSql`), `conversation-close.ts` (`getTaskResolvePreview`).
- `apps/dental-clinic/src/components/home/waiting-list.tsx`, `components/workspace-notifications.tsx`, `components/crm/resolve-preview.tsx`, `lib/agent.ts` (`AGENT_CASE_ROW`, `AGENT_CASES_TITLE`).
- Migración `0085_un_pendiente_un_lugar`.
