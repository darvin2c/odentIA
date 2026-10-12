# 0014 · Reservar desde un enlace personal y efímero

Fecha: 2026-10-11 · Estado: aceptada

## Problema

Reservar una cita conversando con el agente exige varias idas y vueltas (para quién, sede, día, hora, confirmación). Medido con proveedores reales, una reserva tomó siete mensajes, con respuestas de entre 12 y 114 segundos y más de cien mil tokens de entrada. Además, que alguien dicte tres horas por chat ayuda menos que ver la semana y tocar una.

## Decisión y motivo

- **El agente puede entregar un enlace para que la persona elija ella misma** el día y la hora viendo los horarios libres (`enviar_enlace_cita`). Es una opción para su comodidad junto a reservar conversando, nunca la única vía ni una obligación.
- **El enlace es personal, efímero y de una sola cita.** Se crea para una conversación y su persona, vence a las 24 horas si no se usa, reserva una sola vez y solo se guarda su huella. **Con la cita reservada, el mismo enlace la muestra y permite cambiarla de horario o cancelarla hasta que empiece** (revisado el 2026-10-11, para cumplir lo que la página promete): cambiar es mover la cita en la Agenda (`moveAppointment`, misma sede y servicio) y cancelar es su cambio de estado con el motivo «paciente»; no se reserva una segunda cita. Pasada la hora de la cita, o ya cancelada, el enlace solo la muestra. Un enlace nuevo deja sin efecto el anterior de esa conversación. No es una dirección pública de la clínica: una página abierta expondría la disponibilidad y permitiría llenar la agenda de reservas falsas.
- **Sirve a quien ya es paciente y a quien recién se contacta.** La mayoría de quienes escriben por primera vez ya son contactos pero aún no pacientes, y dejarlos fuera le quitaba el sentido. Quien no tiene ficha elige su horario, deja sus datos y entonces se reserva. Sus datos entran por el **registro de pacientes de la clínica** (`registerPatient`), que es quien crea la ficha: mismo aviso de privacidad, mismo consentimiento, misma auditoría y mismas reglas de identidad que cualquier otro registro; el enlace de reserva solo lo autoriza para esa persona. Por eso exige que la clínica tenga activo su registro en línea: sin él no hay aviso ni con qué registrar el consentimiento, y a quien no es paciente no se le emite enlace.
- **Para reservar se piden solo los datos esenciales, en una pantalla** (revisado el 2026-10-11; antes el paso mostraba el formulario completo de la clínica). Es un alcance del mismo registro (`scope: "essentials"`), no otro formulario con reglas propias: nombres, apellidos, documento, celular y la aceptación del aviso; si la cita es para otra persona, además los datos de ella, su fecha de nacimiento y la relación, porque de la edad depende que el registro exija un representante legal con documento. Motivo: quien escribe por primera vez quiere una hora, y cinco pasos con salud y filiación antes de reservarla hacían que el enlace costara más que conversar. Lo que la clínica configuró como obligatorio y aquí no se pide no impide registrar: queda **por completar en la clínica**. Ese alcance solo se acepta con el enlace de una conversación; el registro público por QR o enlace de la clínica no cambia.
- **La reserva usa la operación de Agenda** (`createAppointment`), la misma de recepción y del agente: valen las mismas reglas de horario, ausencias, feriados y solapes, y la cita queda con su origen (`enlace`) y sin autora del equipo.
- **La página no muestra tarifas ni el catálogo.** Reserva el servicio del que ya se habló en la conversación o, sin servicio, una cita regular de la sede. Qué precios se dicen y cuándo es otra decisión, aún abierta (darvin2c/odentIA#58).
- **A quien elige se le ofrece un horario por cada cita que cabe**, no cada cuarto de hora: menos opciones y las mismas posibilidades reales.
- **El agente y el equipo se enteran sin que nadie avise:** la reserva deja una nota en la memoria del caso y un mensaje de confirmación en la conversación, sujeto a la misma política de envío que cualquier mensaje del agente.

## Alternativas descartadas

- *Una página pública de reservas por clínica*: útil como canal aparte, pero necesita sus propios límites y no sabe quién reserva ni a qué conversación volver.
- *Reutilizar el portal del paciente*: pide verificación de identidad (PIN o llave de acceso) pensada para ver presupuestos y documentos; es demasiada fricción para elegir una hora, y su alcance es mucho mayor del que este enlace necesita.
- *Un formulario propio de datos mínimos, con su propia alta, para quien no es paciente*: duplicaría las reglas del registro de pacientes (documento, consentimiento, fichas repetidas). Los datos mínimos son un alcance de ese mismo registro.
- *El formulario completo del registro dentro de la reserva* (lo que hubo hasta el 2026-10-11): no duplicaba nada, pero pedía salud y filiación a quien solo quería una hora.
- *Limitarlo a quien ya es paciente* (primera versión, descartada el mismo día): dejaba fuera justo a quien más lo necesita, el que escribe por primera vez.

## Consecuencias

- Beneficio: una cita se reserva con un mensaje y unos toques, sin llamadas al modelo mientras la persona elige.
- Sacrificio de los datos esenciales: la ficha nace incompleta. No trae la fecha de nacimiento cuando la cita es para quien escribe, así que el registro no puede saber ahí si es menor de edad: lo ve recepción al completar la ficha, que entonces exige al representante. Los apellidos llegan en un solo campo y se reparten sin certeza (dos palabras: paterno y materno; si no, todo como primer apellido), por lo que la ficha queda «identidad por revisar». Recepción lo ve con lo que ya existía: «Filiación incompleta» e «Identidad por revisar» en la ficha, y una nota en el caso de la conversación con lo que la clínica exige y falta. No hay un indicador en la ficha que siga la configuración de cada clínica: la lista de «Filiación incompleta» es fija, y la específica va en la nota del caso.
- Sacrificio: un enlace de registro puede emitirlo ahora el sistema, no solo una persona del equipo (`patient_registration_link.created_by` admite vacío; al reservar se emite y se consume en la misma transacción, sin salir del servidor); el horario elegido no queda apartado mientras la persona llena sus datos, y si alguien lo toma debe elegir otro; quien tenga el enlace puede cancelar esa cita mientras no haya empezado, que es el mismo alcance que tenía para reservarla.
- No construido todavía: apartar el horario mientras se completan los datos (necesita una reserva temporal en la Agenda que también respete recepción), un botón que devuelva al chat (el sistema no guarda la dirección pública de cada canal), y que recepción envíe el enlace desde la Bandeja. La cita se añade al calendario con un archivo iCalendar que arma la página.
- Revisar cuando se decida la política de precios y de servicios reservables en línea: entonces la página puede ofrecer elegir el servicio.

## Referencias

- `packages/services/src/booking-links.ts` (`registerFromBookingLink`), `packages/services/src/patient-registration.ts` y `packages/clinical/src/patient-registration.ts` (alcance `essentials`), `apps/api/src/routes/public-booking.ts`, `apps/platform/src/routes/reserva.tsx`, `apps/platform/src/components/booking-data-form.tsx`, herramienta `enviar_enlace_cita` (`packages/agent/src/tools.ts`), migración `0056`.
