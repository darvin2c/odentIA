# 0014 · Reservar desde un enlace personal y efímero

Fecha: 2026-10-11 · Estado: aceptada

## Problema

Reservar una cita conversando con el agente exige varias idas y vueltas (para quién, sede, día, hora, confirmación). Medido con proveedores reales, una reserva tomó siete mensajes, con respuestas de entre 12 y 114 segundos y más de cien mil tokens de entrada. Además, que alguien dicte tres horas por chat ayuda menos que ver la semana y tocar una.

## Decisión y motivo

- **El agente puede entregar un enlace para que la persona elija ella misma** el día y la hora viendo los horarios libres (`enviar_enlace_cita`). Es una opción para su comodidad junto a reservar conversando, nunca la única vía ni una obligación.
- **El enlace es personal, efímero y de un solo uso.** Se crea para una conversación y su persona, vence a las 24 horas, deja de servir al reservar y solo se guarda su huella. Un enlace nuevo deja sin efecto el anterior de esa conversación. No es una dirección pública de la clínica: una página abierta expondría la disponibilidad y permitiría llenar la agenda de reservas falsas.
- **Sirve a quien ya es paciente y a quien recién se contacta.** La mayoría de quienes escriben por primera vez ya son contactos pero aún no pacientes, y dejarlos fuera le quitaba el sentido. Quien no tiene ficha elige su horario, completa sus datos y entonces se reserva. Sus datos entran por el **registro de pacientes de la clínica** (`registerPatient`), que es quien crea la ficha: mismos campos, mismo aviso de privacidad y mismas reglas de identidad que cualquier otro registro; el enlace de reserva solo lo autoriza para esa persona. Por eso exige que la clínica tenga activo su registro en línea: sin él no hay con qué pedir los datos ni el consentimiento, y a quien no es paciente no se le emite enlace.
- **La reserva usa la operación de Agenda** (`createAppointment`), la misma de recepción y del agente: valen las mismas reglas de horario, ausencias, feriados y solapes, y la cita queda con su origen (`enlace`) y sin autora del equipo.
- **La página no muestra tarifas ni el catálogo.** Reserva el servicio del que ya se habló en la conversación o, sin servicio, una cita regular de la sede. Qué precios se dicen y cuándo es otra decisión, aún abierta (darvin2c/odentIA#58).
- **A quien elige se le ofrece un horario por cada cita que cabe**, no cada cuarto de hora: menos opciones y las mismas posibilidades reales.
- **El agente y el equipo se enteran sin que nadie avise:** la reserva deja una nota en la memoria del caso y un mensaje de confirmación en la conversación, sujeto a la misma política de envío que cualquier mensaje del agente.

## Alternativas descartadas

- *Una página pública de reservas por clínica*: útil como canal aparte, pero necesita sus propios límites y no sabe quién reserva ni a qué conversación volver.
- *Reutilizar el portal del paciente*: pide verificación de identidad (PIN o llave de acceso) pensada para ver presupuestos y documentos; es demasiada fricción para elegir una hora, y su alcance es mucho mayor del que este enlace necesita.
- *Un formulario propio de datos mínimos para quien no es paciente*: duplicaría las reglas del registro de pacientes (documento, consentimiento, fichas repetidas). Se usa ese registro tal cual.
- *Limitarlo a quien ya es paciente* (primera versión, descartada el mismo día): dejaba fuera justo a quien más lo necesita, el que escribe por primera vez.

## Consecuencias

- Beneficio: una cita se reserva con un mensaje y unos toques, sin llamadas al modelo mientras la persona elige.
- Sacrificio: un enlace de registro puede emitirlo ahora el sistema, no solo una persona del equipo (`patient_registration_link.created_by` admite vacío); el horario elegido no queda apartado mientras la persona llena sus datos, y si alguien lo toma debe elegir otro; cambiar o cancelar la cita sigue siendo por el chat.
- No construido todavía: apartar el horario mientras se completan los datos, cambiar o cancelar desde el enlace, añadir la cita al calendario, y que recepción envíe el enlace desde la Bandeja.
- Revisar cuando se decida la política de precios y de servicios reservables en línea: entonces la página puede ofrecer elegir el servicio.

## Referencias

- `packages/services/src/booking-links.ts`, `apps/api/src/routes/public-booking.ts`, `apps/platform/src/routes/reserva.tsx`, herramienta `enviar_enlace_cita` (`packages/agent/src/tools.ts`), migración `0056`.
