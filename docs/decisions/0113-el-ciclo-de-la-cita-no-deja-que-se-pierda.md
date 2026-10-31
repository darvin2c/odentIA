# 0113 · El ciclo de la cita: que la persona sepa que la tiene y no la pierda

- Fecha: 2026-10-30.
- Estado: aceptada. Precisa la [0026](0026-recordar-la-cita-viene-prendida.md) y la [0027](0027-escribirle-y-avisar-la-cita.md) (qué hace «Recordar la cita») y la [0109](0109-un-solo-formulario-con-lo-que-ya-sabemos.md) (el recordatorio de una cita confirmada).

## Problema

Una persona reservó por WhatsApp una cita para dentro de tres minutos y no llegó. Nadie le escribió: la despedida del día siguiente decía «Paciente, cuando desee retomar…». Al revisar el ciclo de una cita aparecieron cinco huecos:

- **Confirmar cancelaba lo que faltaba.** Quien confirmaba con el recordatorio de un día antes ya no recibía el de pocas horas antes: justo quien dijo que venía se quedaba sin el «te esperamos».
- **Nada miraba la hora de la cita.** Si la persona no llegaba, solo «Reprogramar tras una inasistencia» le escribía, al día siguiente y solo si alguien la marcaba «No vino».
- **Dos recordatorios el mismo día.** El de pocas horas antes de una cita temprana cae antes del «Horario para escribir» y se corre a la noche anterior, el mismo día del de un día antes.
- **La despedida no miraba la cita.** Cerrar por silencio una atención que terminó en una cita reservada mandaba «cuando quieras retomar».
- **Se ofrecían horas sin tiempo para llegar.** El enlace y Sofi ofrecían el primer hueco libre aunque empezara en minutos.

Además, la demo cerraba de noche como «atendida» también la cita que reservó alguien de verdad al probar a Sofi, y el saludo usaba «Paciente» como si fuera un nombre.

La clínica quiere que esto pase solo, sin insistir de más y siempre en horario decente.

## Decisión y motivo

Todo sigue en «Recordar la cita», la línea que ya viene prendida: no hay que buscar otra.

1. **Confirmar no cancela los recordatorios.** Llegar, atenderla, cancelarla o marcarla «No vino» sí los cancela. El de pocas horas antes sale igual, con el texto de la cita confirmada («Te esperamos hoy… a las 3:00 p. m.»), sin «Confirmar».
2. **Uno por cita y por día.** Si ya salió hoy un recordatorio de esa cita, el siguiente se da por cubierto. Así nunca llegan dos el mismo día, y una cita temprana recibe uno el día anterior.
3. **«¿Vienes en camino?»** A los 15 minutos de la hora, si la cita sigue en pie y sin llegada, Sofi pregunta: «Te esperamos en… ¿Vienes en camino? Si no puedes llegar, responde y te ayudamos a cambiarla». Lleva los botones «Voy en camino», «No podré ir» y «No más recordatorios».
   - **Solo en una sede que ya marcó alguna llegada en las últimas 12 horas.** Donde no se registran llegadas, que falte la llegada no dice nada, y se le escribiría a quien ya está en el sillón.
   - **Solo dentro del «Horario para escribir», y nunca después.** Pasada una hora desde el inicio, o terminada la cita, ya no sale.
   - **Una vez por cita.** No espera al día siguiente por el tope diario: mañana ya no serviría.
   - **Si no se le puede escribir, queda la llamada para recepción:** «Llamar a … no ha llegado a su cita».
   - **Es un recordatorio:** lo apaga «No más recordatorios».
4. **Una atención que dejó una cita** (reservada por Sofi o desde el enlace de esa conversación) **no espera al paciente**. Si no queda nada por responder, a la hora sin mensajes se cierra como resuelta y sin despedida: lo que sigue lo dicen sus recordatorios. Antes se quedaba en «Esperan al paciente» hasta cerrarse por silencio, unas 22 horas después.
   - Lo que la persona hace en el enlace que le dio Sofi (reservar, mover o cancelar) queda en el hilo y en la fila de la Bandeja como lo que hizo Sofi. Así también se cobra (ADR 0085).
5. **Media hora de margen al reservar sola.** Lo que la persona reserva por su cuenta (su enlace o Sofi) empieza al menos 30 minutos después. Recepción sigue viendo el primer hueco libre.
6. **La demo no cierra una cita que salió de una conversación.** Su llegada o su falta las dice la clínica.
7. **El saludo no toma por nombre** «Paciente», «Cliente», «Prueba» ni palabras parecidas.

Con todo esto, una cita recibe como mucho:
- el aviso al reservar (o el «Listo» de la conversación);
- un recordatorio el día anterior, que pide confirmar si falta;
- el «te esperamos» unas horas antes, si cae otro día;
- el «¿vienes en camino?», si no llegó.

Las horas de los recordatorios siguen siendo 24 y 3 por defecto, y cada clínica las ajusta.

## Alternativas descartadas

- *Una línea nueva para «no llegó».* Habría que prenderla, y la clínica mediana no lo haría (el mismo motivo de la 0026).
- *Marcar «No vino» automáticamente a la hora.* Cambiaría el estado de la cita sin una persona, y en una sede que no marca llegadas sería falso.
- *Preguntar siempre a los 15 minutos, aunque la sede no marque llegadas.* Le escribiría a quien ya está atendiéndose.
- *Bajar el recordatorio por defecto a 2 horas.* Ayuda a las citas de media mañana, pero cambia lo que ya ven las clínicas y la web. Cada clínica puede ponerlo.
- *Prender los recordatorios en las demos.* Sus pacientes son de mentira y la semilla deja las líneas apagadas a propósito.

## Consecuencias

- Beneficio: quien confirma recibe el «te esperamos» y quien se retrasa recibe una pregunta en el momento, no al día siguiente.
- Sacrificio: un mensaje más en el catálogo (`cita_sin_llegar`, dieciocho en total), que WhatsApp debe aprobar. Mientras no esté aprobado, sale como respuesta a quien escribió en las últimas 24 horas o por correo; si no, queda la llamada.
- Una plantilla de recordatorio todavía puede decir «Hola, Paciente» si así está guardado el nombre, porque el dato de WhatsApp no puede ir vacío. Ese nombre lo pone la Agenda al crear una cita sin nombre (`booking-drawer.tsx`).
- Revisar si las clínicas que marcan llegadas tarde reciben preguntas a quien ya llegó, o si 15 minutos es poco para su zona.

## Referencias

`packages/services/src/automation.ts` (`syncArrivalChecks`, `stillValid`), `automation-messages.ts` (`APPOINTMENT_ARRIVAL_KEY`), `appointments.ts` (`setAppointmentStatus`), `conversation-close.ts` (`bookedInAttention`, `greetingName`), `availability.ts` (`selfBookingNotBefore`), `demo-build.ts` (`closeVisits`).
