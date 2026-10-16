# 0032 · La cita registra la llegada; la atención la cierra

Fecha: 2026-10-16 · **Estado:** aceptada (fase 3, paso 2A; precisa el [0002](0002-atencion-cita-estados.md))

## Problema

En la clínica nada registraba que la persona llegó: recepción caminaba al consultorio a avisar, la doctora no veía quién la esperaba y no se sabía cuánto esperó cada persona. «Atendida» se ofrecía a mano justo a la hora de la cita; pulsarla al llegar liberaba el sillón y dejaba la cita sin poder atenderse. «Atender» pedía motivo y profesional en un formulario (y quien cubría a otro quedaba con la atención a nombre ajeno). El mismo estado tenía tres nombres y «en curso» lo decidía el reloj, no lo que pasaba.

## Decisión y motivo

- **«Llegó» es un hecho con hora, no un estado.** La cita guarda `arrived_at` y `arrived_by`; solo una cita confirmada o atendida puede tenerlos (check en la base). Los cinco estados y la exclusión de solapamientos no cambian, así que las más de treinta reglas que preguntan si una cita sigue en pie siguen igual, y la espera se puede medir. Llegar confirma la cita por confirmar, cancela sus recordatorios pendientes y vale solo para una cita de hoy; una cita «No vino» se recupera si su hueco sigue libre (si no, se dice y se ofrece reagendar). Se deshace mientras no empiece su atención y mover la cita a otro día la borra.
- **La atención cierra la cita.** «Atendida» solo llega al firmar la atención unida a la cita (el servicio lo comprueba contra la atención finalizada); una cita atendida ya no cambia, y una con llegada o atención en curso no se cancela ni se marca «No vino» sin deshacer antes eso. El `PATCH` de la cita deja de cambiar el estado: el estado tiene sus operaciones con sus efectos.
- **«Atender» en un clic.** Desde una cita abre la atención sin formulario, a nombre de quien pulsa; marca la llegada si nadie lo hizo (a la hora de inicio de la atención, así esa espera queda sin dato) y el motivo se escribe dentro (lo exige el cierre).
- **Un momento por cita, dicho una vez.** El servidor calcula `visit` (por confirmar, confirmada, llegó, en atención, atendida, no vino, cancelada) con la correspondencia HL7 FHIR R5 escrita una sola vez (`APPOINTMENT_VISIT_FHIR`): `booked` con la respuesta de la persona, `arrived`, `Encounter.in-progress`, `fulfilled`, `noshow`, `cancelled`. «Confirmada» no es un estado de la cita en FHIR sino la respuesta del participante; se conserva porque recepción trabaja con él. `checked-in` se une a «llegó». La interfaz usa un solo nombre por momento en toda la aplicación.
- **«En atención» es un hecho de la agenda.** Quién la atiende y desde cuándo lo ve quien ve la agenda (`appointments.read`), sin nada de la historia; no es una lectura clínica.

## Alternativas descartadas

- **Un estado `llego` en la cita.** Obliga a enseñar el nuevo estado a todas las reglas de «cita en pie» y aun así haría falta la hora para medir la espera.
- **Dejar «Atendida» a mano solo en «Ya pasaron».** Mantiene dos verdades (cita y atención) que el 0002 ya descartó; lo que pasó sin cerrarse sale en «Ya pasaron · sin cerrar» con «Registrar la atención» o «No vino».
- **Avisar en la campana o con sonido cuando llega la persona.** La sala se ve en vivo en Inicio y en la Agenda; la campana es para enterarse, no para trabajar (ADR 0025).

## Consecuencias

- Beneficio: recepción marca la llegada con un clic, quien atiende ve su sala de espera (también la dueña que atiende) y empieza en un clic; Reportes mide «Espera en sala» (mediana de minutos entre la llegada y el inicio de la atención, por profesional; «Sin datos» si nadie marca).
- Sacrificio: las citas antiguas no tienen llegada («sin dato») y una cita ya atendida no se corrige desde la agenda. Al anular una atención la cita conserva la llegada (la persona vino) y vuelve a «Llegó». Precisa el 0002: al anular, la cita no tenía nada que devolver porque abrir la atención no cambia su estado.
- Revisar si una clínica necesita un trámite de admisión distinto de llegar o la llegada por QR o WhatsApp.

## Referencias

`packages/db/drizzle/0091_llego_a_la_cita.sql`; `packages/services/src/appointments.ts` (`setAppointmentArrival`, `markArrivedOnAttend`, `appointmentVisit`, `APPOINTMENT_VISIT_FHIR`), `encounters.ts` (`createEncounter`), `workspace.ts` («Mis pacientes de hoy»), `reports.ts` (`waitInRoom`); `packages/ui-patterns/src/schedule/status.tsx` (`SCHEDULE_STATE_LABELS`). Lienzo de la fase 3, tablero 7 y decisiones 7 y 12.
