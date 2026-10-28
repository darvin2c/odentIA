# 0097 · Sofi no promete horas, no deja a nadie sin respuesta y no reserva sin dónde avisar

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
- **Jev también (`triage.v6`, `route.v6`):** «¿la toma una persona?» dice que sí ante un pedido de persona, una queja, alguien angustiado, un consejo clínico o una emergencia con riesgo de vida (incluida la cara hinchada). Un dolor, aunque sea fuerte, para preguntar dónde o cuándo atenderse, es una cita. Con Jev acierta lo mismo que `triage.v5` en `sintomas-y-cita.json` (15/15) y en `decisiones-ejemplos.json` (37/38), y ya no pasa «tengo un dolor de diente, ¿dónde me pueden atender?».
- **Bebé que no lacta (latidIA):** es una señal de alarma (signo general de peligro de AIEPI/IMCI de la OMS): el aviso empieza por el número de emergencias.
- **Sin horas prometidas:** el vencimiento de la tarea no llega al modelo, y ningún texto le pide decir «cuándo le responde».
- **Enlaces comprobados:** un enlace sale solo si lo trajo una fuente del turno (nuevo tipo `enlace` de la comprobación).
- **Quien aún no es paciente** lo sabe Sofi desde el primer mensaje. Con registro en línea, recibe su enlace al elegir la hora; si no, Sofi toma su nombre y su preferencia y pasa el caso una sola vez.
- **Chat web:** reservar (`confirmar_propuesta`) exige un WhatsApp o un correo cuando la clínica puede avisar por alguno; proponer no, para no dejar a la persona sin horario. `guardar_contacto` los guarda con las reglas del formulario «¿Dónde te avisamos?».
- **Quien ya eligió la hora** («resérvame mañana a las 2 con la Dra. Ana») no tiene que decir sí otra vez: si el modelo de decisión entiende que pidió reservar esa misma cita, `proponer_cita` la confirma con ese mensaje. Vale solo su último mensaje y de los diez minutos previos a la propuesta, y queda auditado como `eligio_esa_hora`.

## Alternativas descartadas

- **Registrar a la persona nueva por el chat:** se decidió después en el lienzo y lo sustituye ADR 0099 (un solo sí reserva, registra y acepta el aviso).
- **«Solo con evaluación» → «precio exacto» como valor por defecto:** contradice la decisión C del 13 de octubre. La pantalla de la biblioteca ya agrega con «precio exacto»; lo que fallaba era la semilla de latidIA y el armado de las demos para presentar (ADR 0096), que ahora agregan como la pantalla y con el registro en línea activo.

## Consecuencias

Sofi pasa menos casos y ofrece más citas. Si aparecen consultas clínicas que se agendan sin que nadie las vea, se revisa la regla del síntoma. Medido con `src/auditoria-sofi.ts` (dos tandas, antes y después).

## Referencias

ADR 0050, 0084, 0094, 0095. `packages/agent/src/run.ts`, `graph.ts`, `tools.ts`, `verify.ts`, `decision/route.ts`; `packages/services/src/agent-case.ts`, `agent-operations.ts`, `webchat.ts`.
