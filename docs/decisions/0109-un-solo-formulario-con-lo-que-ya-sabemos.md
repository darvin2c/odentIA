# 0109. Un solo formulario para reservar, con lo que ya sabemos y sus permisos

- **Fecha:** 2026-10-30
- **Estado:** aceptada. Precisa la 0014 (qué se pide al reservar), la 0037 (qué muestra «Su enlace»), la 0030 (dónde se pregunta por novedades) y la 0101 (lo que falta después de reservar por el chat).

## Problema

Quien reservaba desde su enlace dejaba sus datos en tres lugares: el chat, el formulario de reserva y «Tus datos» después. Además, el formulario venía en blanco aunque ya supiéramos su nombre. Recién reservada la cita, todavía le faltaban datos («Faltan 2»: la fecha y el sexo) y se le pedía «Confirmar» la cita que acababa de elegir. Un enlace mandado para completar datos podía abrir la reserva. A casi nadie que reservaba por el enlace se le preguntaba por novedades y promociones. Y «Te avisaremos por WhatsApp» solo se mostraba: no quedaba guardado. La clínica necesita poder escribirle, y la persona necesita que sea simple y que nada se pierda.

## Decisión y motivo

1. **Un solo formulario.** «Revisa y reserva» y «Tus datos» sirven a cualquier camino: persona nueva, quien ya es paciente, una reserva para un hijo, desde el chat o desde la Agenda. Lo que ya sabemos viene escrito y se puede corregir: lo que dijo en la conversación, el nombre de su perfil de WhatsApp y su celular (`getBookingLinkRegistrationForm.known`). Quien ya es paciente ve su nombre, su documento abreviado («DNI ••••8912») y su celular, y solo se le pide lo que falta.
2. **Lo obligatorio se pide al reservar, una sola vez.** Además de la identidad y el celular, se pide la fecha de nacimiento y lo que la clínica marca obligatorio de `BOOKING_ASKED_FIELDS` (sexo, correo, documento). Si exige otros datos, como la dirección o el contacto de emergencia, la página abre «Tus datos» justo después de reservar.
3. **Los permisos van en el mismo paso.**
   - El aviso de privacidad, si aún no lo aceptó.
   - «Te escribiremos por WhatsApp sobre tu cita: la confirmación, los recordatorios y los cambios.». Queda guardado como su permiso de recordatorios, con su fecha y su origen.
   - La pregunta de novedades y promociones, que se responde una sola vez por persona. «Sí, quiero» va primero, pero nunca viene marcada.
4. **La cita que elige la persona nace confirmada**, en su enlace o con su sí en el chat. Solo la que da el equipo pide «Confirmar».
5. **Cada enlace abre lo que dice su mensaje.**
   - Un enlace dado para completar datos deja de ofrecer la reserva que no usó.
   - Reservar por el chat cierra la reserva de su enlace.
   - Con datos pendientes, el enlace abre directo «Tus datos».
6. **En lo que llena la persona, el sexo es «Femenino» o «Masculino».** «Indeterminado» es un dato clínico (CIE-10 Q56), que registra el equipo.

## Alternativas descartadas

- *La casilla de promociones marcada de antemano.* Así no vale como su sí: el consentimiento para publicidad tiene que ser previo y expreso.
- *Editar desde el enlace los datos ya guardados.* El enlace prueba que tiene su chat, no quién es. Para corregir un dato guardado se le pide al equipo.
- *Términos y condiciones de la clínica.* Hoy no existen: lo que se acepta es el aviso de privacidad.
- *Pedir solo lo esencial al reservar y completar el resto después.* Era el diseño anterior: dejaba «Faltan datos» apenas se reservaba.

## Consecuencias

- Reservar pide unos datos más en una clínica que exige muchos. A cambio, no queda nada pendiente ni se repite nada.
- El recordatorio de una cita confirmada sin «Confirmar» necesita una plantilla nueva aprobada por Meta. Mientras no exista, sale la de hoy.
- Sofi sigue registrando por el chat con el nombre y el documento. Lo que falte se le pide con el enlace que abre «Tus datos».
- Revisar si las clínicas reportan que el paso de reservar es largo o que la pregunta de promociones frena la reserva.

## Referencias

`packages/clinical/src/patient-registration.ts` (`BOOKING_ASKED_FIELDS`, alcance `essentials`), `packages/services/src/booking-links.ts`, `packages/services/src/su-enlace.ts` (`reservePersonalLink`, `saveLinkData`), `packages/services/src/agent-operations.ts`, `packages/clinic-app/src/components/booking-data-form.tsx`, `components/public/choose-appointment.tsx` y `routes/public/reserva.tsx`; lienzo «Reservar por pasos en Su enlace».
