# 0002 · Capa de decisión detrás de un puerto propio, primero en sombra

Fecha: 2026-10-08 · Estado: sustituida por [0007](0007-modelo-de-decision-elige-el-conocimiento.md), que conserva el puerto, el estado mínimo y el triaje en sombra, y añade un uso fuera de la sombra

## Problema

Las decisiones acotadas del agente (¿requiere respuesta?, ¿derivar a una persona?, urgencia, intención, petición de baja) se toman hoy con tool calling libre del LLM generalista o con heurísticas frágiles (palabras clave sin acentos, lista de doce frases). Existen modelos especializados en decidir (Jev de TypeSafe AI y la Decisions API de OpenAI) que devuelven una opción con probabilidades, sin generar texto, con latencia y coste bajos. Ambos tienen semanas de vida, contratos en beta o acceso anticipado, ninguna evaluación en español latinoamericano y políticas de datos que no cubren salud; y los mensajes de pacientes no pueden enviarse a un tercero sin revisión legal.

## Decisión y motivo

- **Un puerto propio** (`DecisionModel`: preguntas sí/no, elección y puntuación sobre un estado; respuestas con probabilidades, confianza y `declined`) con cuatro adaptadores: Jev, OpenAI Decisions, línea base (el mismo LLM de conversación respondiendo JSON, sin probabilidades) y falso determinista para dev/e2e. El núcleo no conoce al proveedor; cambiarlo no toca reglas de negocio.
- **Sombra antes de actuar.** Cada organización elige su proveedor de decisión en Configuración › Agente; tras cada corrida por mensaje entrante el triaje se registra en `agent_decision_log` (huella del estado, preguntas versionadas, respuestas, qué habría hecho) sin efecto sobre el turno. Un fallo del modelo de decisión nunca reintenta ni deriva: queda como fila con error.
- **Estado mínimo.** Al proveedor viaja el último mensaje y hasta dos mensajes previos del propio contacto; nada de la ficha (nombre, notas, teléfono) ni de lo que escribió la clínica. Lo que el contacto escriba de sí mismo sí viaja: por eso la barrera organizativa es que la plataforma no configure claves de proveedores externos hasta la revisión legal. Las instrucciones y claves de opción van en inglés (idioma principal de los proveedores) y el estado en español.
- **Solo endurece.** Cuando se active (fuera de este ADR), la confianza podrá pasar un acto de `directo` a aprobación o subir una prioridad, nunca relajar lo configurado; y si el modelo de decisión falla, el agente sigue como hoy.
- **Activación condicionada a evidencia propia.** `eval:decisions` compara proveedores sobre ejemplos escritos por el equipo; con autorización legal se podrá etiquetar tráfico real y fijar umbrales por punto, adaptador y versión de pregunta. Hasta entonces la plataforma no define `JEV_API_KEY` ni `OPENAI_DECISIONS_API_KEY`: elegir esos proveedores queda registrado como «sin credenciales» y solo la línea base y el falso ven mensajes reales.

## Alternativas descartadas

- Activar el modelo de decisión de inmediato con los umbrales de ejemplo del proveedor: no están calibrados para español ni para este dominio, y un falso «no requiere respuesta» deja a un paciente sin atención.
- Un único proveedor: el usuario pidió ambos y su contrato es casi idéntico; el coste del segundo adaptador es pequeño y permite comparar.
- Usar `@langchain/typesafe` o el SDK de cada proveedor: versiones 0.x con cambios incompatibles recientes; un POST con validación Zod sobre un endpoint único es más estable y auditable.

## Consecuencias

- Beneficio: se puede medir a los modelos de decisión con tráfico propio sin riesgo para la atención, y el día que se activen el cableado ya existe.
- Sacrificio: hasta la activación no hay ahorro ni mejora de latencia; la sombra añade una llamada por corrida antes del ack del trabajo (plazo `DECISIONS_TIMEOUT_MS`, máximo 20 s, por debajo de la visibilidad de 30 s de la cola) para quien la habilite.
- Revisar cuando haya ≥300 ejemplos etiquetados por punto en español peruano, o si un proveedor cambia su contrato.

## Referencias

- `packages/agent/src/decision/` (puerto, adaptadores, puntos, sombra, evaluación), `packages/services/src/agent-decisions.ts`, migración `0036`.
- Contratos leídos el 2026-10-07/08: docs.typesafe.ai/api, developers.openai.com/api/docs/guides/decisions.
