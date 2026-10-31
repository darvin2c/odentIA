# 0120 · Lo que sabe Sofi sale de los datos; se escribe solo lo que solo sabe la clínica

Fecha: 2026-10-31 · Estado: aceptada · Precisa [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md) y [0043](0043-un-dato-un-lugar.md)

## Problema

Conocimiento pedía responder «25 preguntas básicas» y marcaba solo 5 como cubiertas por los datos. Otras que el agente ya sabía (el horario, sacado de los horarios del equipo; la duración de una cita; los especialistas; cómo cambiar una cita) aparecían como faltantes, y la pantalla invitaba a escribirlas a mano. Un horario escrito contradice al del equipo apenas alguien cambia su turno: justo lo que la ADR 0021 evitaba («nada se escribe dos veces»). Las demos sembraban ese horario escrito. Había además preguntas de salud («¿el tratamiento duele?», «¿atienden a embarazadas?») que el agente debe pasar a un profesional, no responder con un texto. Y «Lo que toma de tus datos» mostraba dos filas de las ocho fuentes que el agente lee, con el horario enlazado a Sedes, donde no se edita.

## Decisión y motivo

- **Lo que está en los datos se muestra, no se pregunta.** «Lo que toma de tus datos» lista lo que el agente de recepción lee en el momento, contado con las mismas fuentes que su prompt (`getAgentDataSources`): horario de atención por sede, feriados y cierres, sedes, equipo, servicios y precios, promociones, medios de pago y teléfono de urgencias. Cada fila lleva a donde se edita; lo que falta y necesita va en ámbar, con su texto. Con «Informar» apagado, las filas que no le llegan lo dicen.
- **«Lo que solo tú sabes»: ocho preguntas opcionales** (`KNOWLEDGE_BASICS`): estacionamiento, accesibilidad, cuotas, seguros o convenios, atención sin cita, primera cita, llegar tarde y cómo pedir un presupuesto. Sin respuesta, el agente dice que lo confirma y la pasa al equipo; por eso no cuentan como algo que «necesita de ti». Las de salud salen de la lista.
- **Encender pide datos, no textos.** La comprobación «Lo básico de tu clínica» pasa a «Sabe tu horario y tus servicios»: hay horario del equipo en alguna sede y servicios activos.
- **Conocimiento es de recepción.** La pantalla lo dice: Clío y Argos no lo usan.
- Una respuesta de antes con una clave que ya no está en la lista la conserva al editarse; una nueva no puede usarla.

## Alternativas descartadas

- *Marcar como cubiertas por los datos más de las 25*: seguía presentando como tarea lo que no lo es, y mezclaba datos con textos en una sola cuenta.
- *Un horario de la sede escrito aparte*: dos fuentes del mismo dato (ADR 0118).
- *Quitar la lista entera*: las ocho que quedan son preguntas reales que ningún dato responde; ofrecerlas ahorra que el agente pase a una persona algo que la clínica puede dejar escrito.

## Consecuencias

- La pantalla dice lo que el agente recibe de verdad; corregir un dato es ir a donde vive.
- Las clínicas que ya escribieron una respuesta con una clave retirada (por ejemplo «horario») la conservan publicada; conviene revisarla, porque puede contradecir los datos.
- Revisar la lista si «No supo responder» muestra seguido otra pregunta que ningún dato cubre.

## Referencias

- `packages/services/src/knowledge.ts` (`KNOWLEDGE_BASICS`, `getKnowledgeBasics`), `agent-clinic-info.ts` (`getAgentDataSources`), `agent-overview.ts` (`knows`).
- `packages/clinic-app/src/components/agent/knowledge-sources.tsx`, `knowledge-basics.tsx`, `turn-on-drawer.tsx`; `routes/_org/agent.knowledge.tsx`.
