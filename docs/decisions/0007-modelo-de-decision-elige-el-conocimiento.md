# 0007 · El modelo de decisión elige el conocimiento de cada turno

Fecha: 2026-10-10 · Estado: aceptada · Sustituye a [0002](0002-capa-de-decision-en-sombra.md)

## Problema

El agente recibía en cada llamada las diez respuestas oficiales más recientes de la clínica, recortadas: una clínica con más de diez no podía usar las demás, y una promoción vencida seguía citándose hasta que alguien la despublicaba. Enviar todo el conocimiento en cada llamada lo resuelve, pero su coste crece con el conocimiento y se paga en todas las llamadas del turno. El 0002 dejaba el modelo de decisión solo en sombra hasta tener evidencia propia; el producto necesita usarlo ya donde un error no puede causar un acto, para gastar menos en el modelo que escribe.

## Decisión y motivo

- **Se conserva del 0002:** el puerto propio con sus adaptadores, el estado mínimo (solo lo que escribió el contacto), que un fallo del modelo de decisión nunca reintenta ni corta el turno, y el triaje (responder, derivar, urgencia, intención, baja) **en sombra**: sobre actos, la confianza solo podrá endurecer, y su activación sigue pidiendo ejemplos etiquetados.
- **Uso nuevo, fuera de la sombra: elegir conocimiento** (`knowledge.v1`, modo `retrieval`). Con un modelo de decisión configurado, el bloque estable de la clínica lleva solo el índice de respuestas vigentes y, por turno, el modelo de decisión dice cuáles aplican al último mensaje:
  - seguro (probabilidad ≥ 0,6): solo esas respuestas viajan completas;
  - duda: se paga más solo ahí — van todas si caben; si no, el modelo que escribe elige con el índice y la búsqueda;
  - ninguna aplica: no se añade nada.
  No decide ningún acto: si elige mal, el modelo que escribe conserva el índice y `consultar_conocimiento`, y la comprobación previa al envío sigue activa.
- **Sin modelo de decisión**, van todas las respuestas vigentes si caben en el bloque (12 000 caracteres, cada una recortada a 600) y, si no, el índice.
- **Vigencia.** Solo lo publicado y dentro de sus fechas (en días de la clínica) llega al agente; lo vencido deja de usarse sin intervención.
- **Qué viaja al proveedor de decisión:** el último mensaje del contacto y los títulos y formas de preguntar de las respuestas oficiales. Nada de la ficha ni del texto de las respuestas.
- **Sin vectores.** El conocimiento de una clínica son decenas o pocos cientos de textos cortos: basta título, formas de preguntar y palabras significativas, y la elección entrega una probabilidad que un buscador por similitud no da.

## Ampliación (2026-10-10): también elige el camino del turno

El mismo modelo de decisión responde el triaje **antes** de llamar al modelo que escribe (`route.v2`, modo `route`), en una sola llamada:

- **Pasar a una persona, y avisarle (revisado el 2026-10-11).** Si la probabilidad de que haga falta una persona es ≥ 0,85, el caso se deriva antes de llamar al modelo que escribe: el equipo lo recibe al instante con su clase (reclamo, urgencia, consulta clínica, pide una persona), su prioridad (según la urgencia que entrega el modelo de decisión) y, en el resumen, lo que la persona escribió en sus mensajes seguidos. Después el modelo que escribe redacta solo el aviso a la persona, con una única herramienta a la vista; si falla o no lo deja, sale un aviso fijo. La primera versión derivaba sin redactar nada: medido con proveedores reales, la persona quedaba sin respuesta y el equipo recibía un motivo genérico. Es el único efecto sobre un acto y va en el sentido que este ADR ya permitía: endurece, nunca ejecuta nada por el interlocutor. Las palabras de derivación de la clínica siguen valiendo, con o sin modelo de decisión. Al redactar el aviso, el mismo paso deja escrito para el equipo qué pide la persona y qué falta preguntarle (campos de la derivación, no texto libre en el resumen): quien toma el caso lee una frase y no el hilo, y sin ese texto el resumen muestra los mensajes tal cual.
- **Decirle al que escribe por dónde ir.** Con una intención reconocida (probabilidad ≥ 0,6) el turno recibe una indicación: información o saludo → responder en ese mismo paso con lo que ya tiene arriba; consulta clínica → pasar el caso en ese paso; cambiar una cita → el código trae antes las citas del paciente (misma herramienta y misma autorización) cuando hay un único paciente vinculado.
- **El camino decide también qué herramientas se le enseñan al que escribe (2026-10-11).** El manual de las herramientas es la mayor parte de lo que viaja en cada llamada, y una pregunta de horario no necesita el de reservar ni el de oportunidades. Con camino elegido solo va el manual de las herramientas de ese camino (`ROUTE_TOOLS`), más una herramienta para pedir el resto si el camino se eligió mal (cuesta una llamada más, solo en ese caso). No es un permiso: lo que el agente puede hacer lo sigue fijando su ficha, y la ejecución admite todas. Con una propuesta esperando el sí del interlocutor, el turno recibe todas, sea cual sea el camino: un «sí» leído como saludo no puede dejar sin `confirmar_propuesta`. Sustituye a la decisión inicial de no variar la lista para conservar el prefijo en caché: medido con el proveedor real, el recorte pesa mucho más que lo que la caché devolvía entre mensajes; dentro de un mismo turno la lista no cambia salvo que se pida el resto.
- **Sin probabilidades, con duda o con fallo**, el turno es el de siempre. Con «elegir el camino» apagado (`decisionRoutingEnabled`), el modelo de decisión solo elige conocimiento y el triaje vuelve a registrarse en sombra.
- **Qué se mide:** el libro guarda el camino de cada mensaje y el Registro técnico compara las llamadas al modelo que escribe por camino frente a las corridas sin elección. Que una pregunta de información se resuelva en una sola llamada depende de que el modelo que escribe siga la indicación: hay que medirlo con el proveedor real. Los umbrales 0,85 y 0,6 son puntos de partida.
- Sacrificio: una derivación equivocada le cuesta tiempo al equipo y deja al interlocutor esperando a una persona; por eso el umbral es alto y solo vale con proveedores que entregan probabilidades.

## Alternativas descartadas

- *Todo el conocimiento en cada llamada*: lo más simple y lo que menos falla con poco conocimiento, pero el coste lo paga cada llamada y crece sin tope. Queda como camino de la duda.
- *Búsqueda por vectores (RAG)*: otro modelo, un índice que rehacer con cada cambio y resultados sin grado de seguridad; se justifica con miles de documentos o documentos largos, que hoy no existen.
- *Mantener el modelo de decisión solo en sombra*: no ahorra nada y aplaza medirlo en el único uso donde equivocarse es barato.

## Consecuencias

- Beneficio: el agente puede usar todas las respuestas vigentes; con modelo de decisión, el modelo que escribe recibe unas pocas en vez de todas.
- Sacrificio: una llamada más por turno al modelo de decisión, y su acierto eligiendo temas en español no está medido. El umbral 0,6 es un punto de partida.
- Con mensajes de pacientes reales, enviar el texto del contacto a un proveedor de decisión externo requiere la revisión de tratamiento de datos pendiente; hasta entonces solo la línea base y el modelo falso lo ven salvo que la plataforma configure claves.
- Revisar con la evaluación (`eval:decisions`) sobre el banco de preguntas: si un proveedor elige mal estando seguro más de 1 de cada 20 veces, esa organización vuelve al camino sin modelo de decisión; y si el conocimiento supera unos cientos de respuestas, añadir un filtro previo.

## Referencias

- `packages/agent/src/decision/knowledge.ts`, `packages/agent/src/decision/route.ts`, `packages/agent/src/decision/shadow.ts` (`decideRoute`), `packages/agent/src/graph.ts` (`selectKnowledge`, `prefetchPatientSummary`), `packages/services/src/knowledge.ts` (vigencia, índice, búsqueda), migración `0048`.
