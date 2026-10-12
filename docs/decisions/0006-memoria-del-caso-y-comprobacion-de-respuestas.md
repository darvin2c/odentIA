# 0006 · Memoria del caso, traza y comprobación de cada respuesta

Fecha: 2026-10-10 · Estado: aceptada

## Problema

Entre turnos el agente recibía solo los últimos mensajes del hilo. Lo que había consultado y propuesto en el turno anterior desaparecía: no conocía el identificador de la propuesta que él mismo dejó pendiente, así que el «sí» del interlocutor no podía ejecutarla, y cada turno volvía a buscar lo mismo. Además no quedaba constancia de en qué se apoyó una respuesta ni había freno para un precio, una fecha o una hora que no saliera de ninguna fuente. El objetivo es que el agente continúe un caso sin empezar de cero y que cada respuesta pueda explicarse, sin acumular historial ni gastar llamadas al modelo.

## Decisión y motivo

- **El estado del caso se lee de su fuente, no de la memoria del modelo.** En cada turno el contexto incluye las propuestas pendientes del hilo (con su identificador y quién las decide) y lo resuelto en las últimas 48 horas, leídos de `agent_proposal`. Es determinista y no puede contradecir a la base.
- **Memoria propia mínima por conversación** (`agent_case_memory`): notas breves que el agente deja con `anotar_caso` (acotadas, sin datos clínicos) y la última consulta de las herramientas de lectura que conviene recordar (agenda, vínculo y resumen del paciente), con caducidad de horas. No guarda el historial ni resultados de otras herramientas.
- **El historial sigue reemplazándose entre turnos.** Los mensajes llevan cuándo se dijeron y el contexto avisa cuando el hilo es más largo de lo que el modelo ve.
- **Cada respuesta deja traza** (`agent_answer_trace`, solo anexado): fuentes consultadas y resultado de la comprobación, enlazada al mensaje o a la propuesta que lo envió.
- **Comprobación determinista antes de enviar.** Los precios, fechas y horas de la respuesta deben figurar en lo consultado o en el contexto del turno. Si no, la respuesta no sale: el modelo recibe qué dato falta y, a la segunda vez, el caso pasa a una persona. La organización puede apagarla.

## Alternativas descartadas

- *Conservar los mensajes de herramientas en el checkpoint entre turnos*: resuelve el identificador, pero hace crecer el contexto con cada turno y arrastra datos de agenda caducados como si fueran vigentes.
- *Resumen automático del hilo con el modelo*: una llamada más por turno largo y un texto que puede inventar; las notas las escribe el mismo turno que ya se paga.
- *Verificar con un segundo modelo*: duplica el coste por respuesta y tampoco garantiza nada; la comprobación por forma es gratuita y explicable.

## Consecuencias

- Beneficio: la reserva propuesta se confirma en el turno siguiente sin volver a buscar; el equipo ve en qué se basó cada respuesta; un precio u hora sin fuente no llega al interlocutor.
- Sacrificio: la comprobación solo mira datos con forma inequívoca y es conservadora: no revisa el resto del texto ni prueba que el dato sea el correcto, y puede frenar un importe calculado que no sea la suma de los consultados. Una afirmación sin cifra («sí, ese es el precio») no se detecta.
- La traza guarda el texto de la respuesta; su retención queda pendiente de definir antes de usarse con pacientes reales.
- Revisar si la tasa de respuestas bloqueadas o derivadas por la comprobación resulta alta con un proveedor real, o si las notas del agente no bastan para hilos largos.

## Referencias

- `packages/services/src/agent-case.ts`, `packages/agent/src/verify.ts`, `packages/agent/src/graph.ts` (contexto y fuentes), `packages/agent/src/tools.ts` (envío, traza y `anotar_caso`), `packages/db/drizzle/0047_agente_memoria_y_traza.sql`.
