# 0023 · El Administrador detecta, Recepción habla y el equipo atiende lo que no se resuelve solo

Fecha: 2026-10-14 · Estado: aceptada · Ajusta a [0015](0015-administrador-lineas-prendidas-o-apagadas.md) y a [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md) · Ajustada por [0028](0028-ventas-que-se-mueven-solas.md): los casos de «Retomar una oportunidad» son las oportunidades con su tarea vencida, y esa misma tarea es la que queda o se da por hecha

## Problema

Ocho de las nueve líneas del Administrador seguían una misma regla: prender la línea es aprobarla, el sistema anota cada caso, Recepción escribe con un mensaje del catálogo y lo que no se pudo queda como aviso y tarea. «Retomar una oportunidad» no: con conversación, el modelo redactaba un mensaje propio en una corrida especial; sin conversación, el sistema buscaba en la cuenta de WhatsApp una plantilla cuyo nombre dijera «seguimiento» y proponía abrir el hilo, y esa propuesta esperaba que alguien del equipo la aprobara caso por caso.

Eso dejaba dos reglas para lo mismo, una tabla de coordinación, una corrida del agente sin mensaje entrante, propuestas sin hilo y una pantalla de «Revisar y aprobar» que solo existía para ese caso. Y una clínica que prendía la línea igual tenía que aprobar cada mensaje.

## Decisión y motivo

- **Una sola regla, en tres pasos.** El Administrador detecta qué toca (una consulta, sin modelo), Recepción habla (el mensaje del catálogo, por la vía que corresponde a cada persona) y el equipo atiende lo que no se resuelve solo (el aviso por causa y la tarea a quien lleva el caso). «Retomar una oportunidad» es una línea más: sus casos son las oportunidades abiertas con la próxima acción vencida y su seguimiento abierto, desde que se prende.
- **Prender es aprobar.** Nadie aprueba caso por caso. Por eso ninguna propuesta del agente espera al equipo: lo único que queda pendiente es la cita que confirma el paciente en su conversación.
- **Un catálogo de mensajes.** Lo que se le escribe a la persona está declarado en `AUTOMATION_MESSAGES` (ahora seis, más «Retomar la conversación»), con sus datos y sus botones; la clínica le cambia el texto y odentIA lo pide a WhatsApp al conectar. No se buscan plantillas por su nombre.
- **El agente no conversa por su cuenta.** Toda corrida responde a un mensaje entrante. Cuando la persona contesta, Recepción sigue la conversación como con cualquier mensaje automático, y la oportunidad queda con el hilo por el que se le escribió.

## Alternativas descartadas

- *Conservar la aprobación por caso solo para quien nunca escribió*: dos reglas para la misma línea y trabajo diario para el equipo que justamente prendió la línea para no hacerlo.
- *Que el modelo redacte el mensaje de retomar*: fuera de las 24 horas WhatsApp solo deja texto aprobado, y un texto que no se puede comprobar no sale sin que alguien lo lea.
- *Seguir buscando una plantilla «de seguimiento» en la cuenta*: depende de cómo alguien nombró una plantilla, no lleva datos y no se puede cambiar desde odentIA.

## Consecuencias

- Se retiran la tabla de coordinación comercial, la corrida de coordinación (`overdue_opportunity_follow_up`), las propuestas sin hilo (`agent_proposal.conversation_id` es obligatorio), el estado `rechazada` y el modo `aprobar_equipo` (migración `0079`). Sin decisión del equipo no hay ruta para aprobar o rechazar una propuesta.
- Aprobaciones, el panel del agente e Inicio muestran lo que de verdad espera a una persona: los casos derivados. Las citas que esperan el sí del paciente se ven aparte y el equipo solo registra una confirmación que el paciente ya dio en el chat.
- Sacrificio: un retomar sin conversación ya no lo revisa nadie antes de salir; lo cubren el permiso de mensajes de la persona, «¿ya avisó algo?» y el texto aprobado de la clínica.
- Se revisa si las clínicas necesitan retomar una oportunidad con datos que el mensaje no lleva, o si piden de nuevo revisar cada mensaje antes de salir.

## Referencias

- `packages/services/src/admin-lines.ts`, `automation.ts` (`syncOpportunityFollowUps`), `automation-messages.ts`, `automation-routing.ts`, `agent-admin.ts`, `agent-operations.ts`.
- `apps/dental-clinic/src/routes/_org/agent.approvals.tsx`, `components/agent-panel.tsx`, `routes/_org/home.tsx`, `routes/_org/inbox.tsx`.
- Migración `0079_retomar_oportunidad_como_las_demas`.
