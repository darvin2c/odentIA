# 0176 · Controles del servicio, uno por fecha, y «Vino»

Fecha: 2026-11-10 · Estado: aceptada (decisiones B1, B3, B4 y B5 del repaso final de la atención). Precisa ADR 0152 (controles) y ADR 0032 (citas).

## Problema

La espera entre sesiones (7 días en cualquier endodoncia) y el control radiográfico al año de los conductos eran reglas fijas del código de odentIA. La clínica no podía ajustarlas, quien firmaba no veía qué controles iban a quedar ni podía cambiarlos para ese paciente, y dos endodoncias del mismo día dejaban dos controles, dos citas y dos recordatorios. Además, una cita pasada a la que la persona sí vino solo se cerraba abriendo una atención, y la corona esperaba a la ventana del control para reservarse.

## Decisión y motivo

- **La regla vive en los datos del servicio.** `treatment_template.session_gap_days` y `finish_controls` traen lo de la guía clínica (`seeds/biblioteca_controles.csv`, con su fuente en `procedure-codes.ts`); `service_catalog` guarda solo lo que la clínica cambió (nulo es «lo de la guía», como las sesiones habituales del ADR 0164). Así una mejora de la guía sigue llegando a quien no tocó nada. Vale para los tres productos: la biblioteca médica y la óptica nacen sin controles.
- **Los controles al terminar se crean en lo común** (`finish-controls.ts`), donde se termina un tratamiento, con `finish_after_days`. **Uno por fecha**: el mismo control el mismo día por otro tratamiento se suma al que ya existe (`clinical_follow_up_item`) y su título nombra todos los sitios. Deshacer un tratamiento lo saca; sin ninguno, el control se cancela.
- **El cierre los muestra antes de firmar** («Controles que quedan») y quien firma los cambia de fecha o los quita para esa persona (`finishControlChanges`, aplicado en la misma firma). Lo ya creado se cambia con `changeFollowUpDue`; el que tiene cita, moviendo la cita.
- **Lo aceptado no espera la ventana del control**: el control se suma a la cita solo si su día cae en la ventana (`createAppointment` lo deja fuera y lo dice).
- **«Vino»** (`markAppointmentCame`) es la única excepción a «atendida solo al firmar su atención»: la marca una persona del equipo, queda en la actividad con `by: "vino"` y sin atención, y no registra nada clínico (el control vuelve a pendiente).

## Alternativas descartadas

- Editar en el cierre controles que todavía no existen guardando un estado «por crear»: duplicaba la regla de creación. Se aplican después de crearlos, en la misma transacción.
- Una fila por pieza agrupada solo al mostrarla: dejaba dos recordatorios y dos reservas para la misma visita.
- «Vino» como solo la llegada anotada: la cita quedaba «Llegó» para siempre y seguía pidiendo cerrarse.

## Consecuencias

- La pulpotomía y la apexificación ya no esperan 7 días por ser del tipo «endodoncia»: lo pone la clínica si lo quiere.
- Una cita «Vino» cuenta como asistida en Reportes sin una atención detrás; la actividad lo distingue.
- Revisar si hace falta juntar controles de días cercanos (no solo el mismo día), o si el agente necesita cambiar el plazo.

## Referencias

`packages/services/src/finish-controls.ts`, `follow-ups.ts` (`changeFollowUpDue`), `appointments.ts` (`markAppointmentCame`, `freedAppointmentsOf`, `reuseAppointment`), `session-gap.ts`, migraciones 0086 y 0087.
