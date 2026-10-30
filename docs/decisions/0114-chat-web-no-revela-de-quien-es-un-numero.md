# 0114 · El chat web no revela de quién es un número

- **Fecha:** 2026-10-30
- **Estado:** aceptada

## Problema

En «¿Dónde te avisamos?» del chat web, un número que ya era de otra persona de la clínica (su identidad de WhatsApp o el teléfono de otra ficha) se rechazaba con «No podemos avisarte por ese WhatsApp». El rechazo se decidía con datos de otras personas: cualquiera, sin cuenta, podía probar números y saber cuáles son pacientes o contactos de la clínica. En odontología eso ya es información de salud. Tampoco se puede usar ese número para avisarle: no se une a otra ficha por coincidir el teléfono (ADR 0001).

## Decisión y motivo

Un número que ya es de otra persona se guarda igual y al visitante se le responde como con un número libre, también por el agente (`guardar_contacto`). No se usa para avisarle: `webchatReplyRoutes` lo deja en `othersPhone`, la conversación sigue «Sin forma de avisarle» y la Bandeja le dice al equipo por qué, para que confirme con la persona antes de usarlo. Lo que se rechaza al visitante depende solo de lo que escribió y de la clínica (un fijo, sin WhatsApp ni buzón conectados), nunca de otras fichas.

## Alternativas descartadas

- **Mantener el aviso (caso 17 de latidIA):** honesto con el visitante, pero revela quién es de la clínica.
- **Un mensaje neutro para todo número:** no revela nada, pero el visitante con un número libre deja de saber que le llegará por WhatsApp.

## Consecuencias

- El visitante con un número ajeno puede creer que le avisarán por WhatsApp hasta que el equipo actúe; si cierra la pestaña antes, no le llega la respuesta.
- Revisar si el equipo deja esos casos sin atender: entonces conviene un paso guiado para confirmar la identidad y vincularlo.

## Referencias

`packages/services/src/webchat-reply.ts`, `packages/services/src/webchat.ts` (`saveVisitorContact`), `packages/agent/src/tools.ts` (`unsavedContact`), `packages/clinic-app/src/components/inbox/thread-view.tsx`.
