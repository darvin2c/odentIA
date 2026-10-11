# 0008 · Fichas de los agentes, la base común y una sola declaración de campos

Fecha: 2026-10-10 · Estado: aceptada

## Problema

El agente era una lista de herramientas y un prompt escritos a mano. La clínica no podía saber qué hace ni apagar una parte; la pantalla describía con texto propio lo que el código hacía por otro lado, y ambas cosas se separaban con cada cambio. Con cuatro agentes previstos (Recepción, Asistente clínico, Asesor, Ayuda) el problema se multiplica. Además, los campos de una misma operación se declaraban tres veces —ruta, herramienta del agente y formulario— con límites distintos: el agente aceptaba un inicio de cita sin zona que la pantalla rechazaba, y un campo nuevo en la pantalla no llegaba al agente.

## Decisión y motivo

- **Una ficha por agente** (`AGENT_ROLES`): para qué existe, sus funciones (cada una con las herramientas que aporta), lo que ve y no ve, lo que nunca hace, quién confirma y de qué aprende. De la ficha salen tres cosas: las herramientas que recibe el modelo, lo que se le dice en el prompt y lo que la clínica ve en su página. Una prueba exige que la ficha de Recepción y las herramientas reales coincidan.
- **Apagar una función quita capacidad, no solo instrucción.** Las herramientas de una función apagada no llegan al modelo (salvo que otra función encendida las traiga) y el prompt dice qué hacer si alguien la pide. Las funciones fijas (ordenar el caso, pasar a una persona) no se apagan.
- **La base** tiene dos partes: lo que fija odentIA para todos los agentes (`AGENT_BASE_PRINCIPLES`, no editable y por delante de cualquier indicación) y la voz de la clínica (nombre, trato, tono y unas líneas sobre quiénes son). Lo propio de cada agente —funciones, indicaciones, límites— vive en su ficha y no se comparte.
- **Niveles en lugar de una tabla de actos.** Supervisado, Equilibrado y Autónomo son políticas de autonomía completas; Equilibrado es la política por defecto, así que una clínica que ya usaba el agente responde igual. La tabla acto por acto sigue en Ajustes técnicos y se muestra como «Personalizado».
- **Límites del sistema:** canales y franja horaria en que responde. Fuera de ellos el hilo queda para el equipo, como cuando está apagado, sin llamar al modelo.
- **Probar** conversa con el agente tal como está configurado, con varios turnos y propuestas simuladas; el estado de la prueba viaja en el navegador y no se escribe nada salvo un contador de mensajes de prueba.
- **Una sola declaración de campos por operación** (`OPERATIONS` en `packages/services/src/operation-fields.ts`). Cada campo dice qué es, sus límites, cómo viaja desde la pantalla y quién lo pone cuando actúa el agente (él, el sistema desde la conversación, o solo una persona). De ahí se generan la validación de la ruta y el esquema de la herramienta, con la descripción de cada campo para el modelo. Una herramienta que escribe debe figurar con su operación (`TOOL_OPERATION`), como lectura (`READ_TOOLS`) o como excepción con motivo (`TOOLS_WITHOUT_OPERATION`); si no, la prueba del agente falla.

## Alternativas descartadas

- *Un agente por prompt, sin fichas*: es lo que había; no permite apagar funciones ni mostrar a la clínica algo que no se desvíe del código.
- *Un solo prompt grande para los cuatro agentes*: mezcla públicos y permisos distintos; cada agente debe ver solo lo suyo.
- *Mantener la tabla de autonomía como única vista*: correcta pero ilegible para quien no es técnico.
- *Declaraciones separadas con una prueba que las compare*: detecta la deriva pero no la evita, y un campo nuevo sigue sin llegar al agente.

## Consecuencias

- Beneficio: lo que la clínica ve es lo que el agente puede hacer; un campo nuevo en una operación declarada llega a la herramienta sin tocarla, con las mismas validaciones que la pantalla.
- Sacrificio: `@odentia/services` depende de `zod` para generar los esquemas. Los formularios de la interfaz aún no se generan de la declaración: validan en la ruta.
- Deuda conocida, con su motivo en `TOOLS_WITHOUT_OPERATION`: editar contacto y etiquetas, y el seguimiento de una oportunidad, todavía declaran sus campos por separado.
- Al unificar se endurecieron validaciones del agente (inicio de cita en ISO 8601 con zona, versión de la cita desde 1) y se añadió un máximo de 480 minutos a la duración de una cita en la ruta.
- Los otros tres agentes tienen ficha pero no están construidos: `available: false` los muestra como «Aún no disponible».

## Referencias

- `packages/services/src/agent-roles.ts`, `agent-overview.ts`, `operation-fields.ts`; `packages/agent/src/graph.ts` (`receptionPrompt`), `run.ts` (`orgToolExclusions`, `agentLimit`, `simulateAgentSandbox`); migración `0049`.
