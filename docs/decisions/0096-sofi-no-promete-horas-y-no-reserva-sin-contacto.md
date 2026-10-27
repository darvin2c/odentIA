# 0096 · Sofi no promete horas, no deja a nadie sin respuesta y no reserva sin dónde avisar

**Fecha:** 2026-10-27 · **Estado:** aceptada

## Problema

Una auditoría con 41 conversaciones simuladas por el recorrido real (odentIA y latidIA) dio 9 bien, 16 a medias y 16 mal. Lo que más pesaba:

- Si el modelo que escribe pasaba el caso sin aviso, nadie le respondía a la persona.
- Al pedir otra hora, la propuesta nueva se rechazaba por haber otra pendiente, y el «confirmo» reservaba la vieja.
- Con cualquier síntoma pasaba el caso al equipo en vez de ofrecer la cita. El manual decía «ante una urgencia (dolor fuerte, fiebre, un golpe)… pasar el tema», cosa que el ADR 0095 no cubrió.
- Prometía «te responderá antes de las 4:29 p. m.»: el vencimiento interno de la tarea le llegaba como hora de respuesta.
- Armaba enlaces que no existen (`…/cita`).
- Pedía documento y celular a quien aún no es paciente y después decía que no podía usarlos.
- En el chat web reservaba sin ningún WhatsApp ni correo: nadie podía recordarle la cita.

## Decisión y motivo

- **Derivar siempre avisa:** tras cualquier pase sin aviso que haya salido, sale el aviso fijo (`run.ts`). Con un tema abierto en el hilo, lo que vuelve a escribir se anota en ese tema (`latestOpenTopic`); solo se abre otro si sube a urgente.
- **La última propuesta manda:** una cita nueva reemplaza a la que espera el sí, como ya pasaba con la respuesta a un presupuesto (`createProposal`).
- **Un síntoma pide cita:** el manual de Recepción ofrece los horarios más próximos y, si no puede esperar, el teléfono para urgencias. El pase queda para pedir una persona, una queja, un consejo clínico o el riesgo de vida.
- **Sin horas prometidas:** el vencimiento de la tarea no llega al modelo, y ningún texto le pide decir «cuándo le responde».
- **Enlaces comprobados:** un enlace sale solo si lo trajo una fuente del turno (nuevo tipo `enlace` de la comprobación).
- **Quien aún no es paciente** lo sabe Sofi desde el primer mensaje. Con registro en línea, recibe su enlace al elegir la hora; si no, Sofi toma su nombre y su preferencia y pasa el caso una sola vez.
- **Chat web:** `proponer_cita` exige un WhatsApp o un correo cuando la clínica puede avisar por alguno. `guardar_contacto` los guarda con las reglas del formulario «¿Dónde te avisamos?».

## Alternativas descartadas

- **Registrar a la persona nueva por el chat:** el registro pide aceptar el aviso de privacidad (Ley 29733). Hacerlo en el chat necesita decidir cómo se acepta allí, y eso va al lienzo antes de programarlo.
- **«Solo con evaluación» → «precio exacto» como valor por defecto:** contradice la decisión C del 13 de octubre. La pantalla de la biblioteca ya agrega con «precio exacto»; lo que fallaba era la semilla de latidIA.

## Consecuencias

Sofi pasa menos casos y ofrece más citas. Si aparecen consultas clínicas que se agendan sin que nadie las vea, se revisa la regla del síntoma. Medido con `src/auditoria-sofi.ts` (dos tandas, antes y después).

## Referencias

ADR 0050, 0084, 0094, 0095. `packages/agent/src/run.ts`, `graph.ts`, `tools.ts`, `verify.ts`, `decision/route.ts`; `packages/services/src/agent-case.ts`, `agent-operations.ts`, `webchat.ts`.
