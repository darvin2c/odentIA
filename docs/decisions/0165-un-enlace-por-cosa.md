# 0165 · Un enlace por cosa: el destino va en la dirección

Fecha: 2026-11-08 · Estado: aceptada · Sustituye en [0037](0037-su-enlace-y-portal-en-un-paso.md) la parte de «Su enlace» (una página con todo, «Un enlace por cosa» descartado) · Precisa [0156](0156-cada-envio-manda-el-pdf-y-el-portal-muestra-todo-lo-suyo.md)

## Problema

Cada mensaje abría la misma página, «Su enlace», con todo lo pendiente: quien recibía «firma tu consentimiento» llegaba a una lista y tenía que buscarlo. Además, el QA del 6 de noviembre encontró que un familiar sin autorización recibía el enlace del paciente y manejaba su cita (S3), que «Quitar enlace» no cortaba el botón de los correos de recordatorio (S4), que el servidor aceptaba una firma a distancia con cualquier número si la ficha no tenía documento, y que «Confirmar» lo firmado por enlace era un clic desde la ficha, sin constancia de en qué atención se informó a la persona.

## Decisión y motivo

- **El destino va en la dirección, sin tabla nueva.** El token sigue siendo uno por persona y paciente (0037): cada envío lo renueva, así que guardar el destino en la fila cambiaría el de los mensajes anteriores. `personalLinkAddress(origin, token, abre)` arma `/pendientes?abre=firma|presupuesto|cita|datos|mensajes&token=…`; sin `abre`, «Tus pendientes». `/reserva` queda como «Elige tu cita» y, si el enlace ya no ofrece reservar, lleva a «Tus pendientes». El token va siempre al final: en el botón de una plantilla es su único dato.
- **Solo a quien decide, y se mira al abrir.** La cita la ve y la maneja quien tiene la misma facultad que pide el chat (`resolveAgentPatientContext`); se mira al resolver el enlace, así corta también los ya enviados. Quitar el enlace o terminar el vínculo vence los tokens de confirmar y cancelar del correo, y antes de emitir desde el correo se mira la facultad de hoy. La baja nunca se toca.
- **Firma a distancia solo con algo con qué comparar.** Sin documento en la ficha de quien firma, sin fecha de nacimiento del paciente o con la propia persona menor de edad, el servidor no la acepta; la página lo dice antes de leer («Este lo firmas en tu cita», o «tú en la cita de Mateo» a quien decide por él). El documento se registra una vez, en la ficha: lo pone recepción o la propia persona en «Tus datos». Si al firmar todavía falta, la hoja dice «Para firmar desde aquí, primero completa tus datos» y lleva a «Tus datos»; al firmar lo vuelve a escribir solo para comprobar que es ella, sin registrarlo otra vez (decidido por el usuario el 8 nov: quien abre el enlace es la misma persona a la que se envió, y el profesional confirma la firma en la atención, con ella delante).
- **Confirmar se hace dentro de la atención.** `consent_document.informed_encounter_id` guarda en qué atención en curso del paciente se confirmó, que debe ser de hoy (empezó hoy o es la de su cita de hoy): una atención olvidada en borrador no sirve, porque se confirma con la persona delante. La historia y el PDF lo dicen. La atención muestra arriba lo firmado por enlace sin confirmar, también lo enviado desde Documentos, sin frenar nada.
- **Una plantilla por aviso nuevo, sin tocar las aprobadas.** Entran «Firma tu consentimiento» y «Antes de tu cita» (el recordatorio cuenta lo que quien decide puede hacer desde su teléfono, con la misma definición de lo pendiente que la página, y abre «Tus pendientes»). Las ya aprobadas conservan su botón: cambiar su dirección sería otra plantilla. Mientras Meta no aprueba las nuevas, sale lo de hoy. Dentro de las 24 horas y por correo, la dirección escrita ya lleva su destino. Ningún mensaje dice nada clínico.
- **«Reservar otra» desde «Tu cita», con tope.** Quien decide, desde un enlace que muestra su cita por venir, puede tener hasta dos citas por venir; más, las agenda recepción. La otra no reemplaza «Tu cita».

## Alternativas descartadas

- *Una fila por mensaje con su destino*: rompe «uno por persona y paciente», «Quitar enlace» y el QR impreso.
- *Cambiar la dirección de las plantillas aprobadas*: obliga a pedirlas otra vez a Meta en cada clínica; mientras tanto no saldrían.
- *Retener los envíos del equipo para juntarlos en un aviso*: demora lo que el profesional mandó. Solo el recordatorio los junta.

## Consecuencias

- La persona llega directo a lo que dice el mensaje; los enlaces ya enviados siguen sirviendo hasta vencer.
- Sacrificio: dos plantillas más por clínica que aprobar, y la página pública cambia de ruta (`/pendientes`).
- Quedan fuera: plantillas propias de presupuesto, cita y datos; comparar lo firmado con el plan de hoy; que confirme solo el profesional asignado; recortar el plazo del enlace a la hora de la cita. Revisar el tope de «Reservar otra» si una clínica lo pide.

## Referencias

`packages/services/src/public-links.ts` (`personalLinkAddress`), `booking-links.ts` (`contactHandlesAppointment`, `bookAnotherOf`), `pair-access.ts` (`expireEmailAppointmentTokens`), `clinical-forms.ts` (`remoteSignBlock`, `confirmLinkSignedConsent`, `listLinkSignedToConfirm`), `su-enlace.ts` (`sendConsentToSign`), `automation.ts` (`pendingNoticesFor`), `automation-messages.ts` (`CONSENT_TO_SIGN_MESSAGE`, `REMINDER_PENDING_KEY`), migración `0068_confirmado_en_la_atencion`.
