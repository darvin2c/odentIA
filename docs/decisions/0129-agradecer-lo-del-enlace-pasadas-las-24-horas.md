# 0129 · Lo que la persona hace en su enlace se le responde también pasadas las 24 horas

Fecha: 2026-11-01 · Estado: aceptada · Precisa [0037](0037-su-enlace-y-portal-en-un-paso.md) y [0040](0040-el-agente-no-elige-plantillas-la-categoria-manda-tres-tipos-de-mensaje.md)

## Problema

Lo que la persona hace en su enlace (firmar, responder un presupuesto, enviar sus datos, mover su cita) se le responde por su conversación con un texto. Pero el enlace suele llegarle con «Su enlace» o con un recordatorio, y su botón es de dirección: tocarlo no abre las 24 horas de WhatsApp. El caso normal, entonces, es el que no podía responderse: la clínica envía a firmar, la persona firma y el chat queda en silencio.

## Decisión y motivo

- **Pasadas las 24 horas sale lo aprobado, no el texto.** Lo decide `tellConversation`, con la misma regla de ventana de siempre (`windowOpen`) y solo en los canales con plantillas. Dentro de las 24 horas no cambia nada. Con Sofi apagada, tampoco esto: nadie habla en su nombre.
- **El chat es el del último envío que lo dijo y, si no hay, su WhatsApp.** Así también se responde el enlace de un recordatorio o de un presupuesto, que no guardan conversación.
- **Reservar, mover y cancelar salen con el aviso de su cita** (`enqueueAppointmentNotice`): ya está aprobado y dice la fecha. Va a quien recibe los avisos de esa cita, que puede no ser quien la tocó.
- **Lo demás, o si ese aviso no sale, con un mensaje nuevo, «Recibido desde su enlace»** (`sendLinkReceivedNotice`). Lo envía el sistema, sin modelo (0040), y es un aviso de lo que pasó: solo lo frena «No quiero ningún mensaje».
- **Uno solo, sin decir qué se recibió, y a lo sumo uno al día por conversación.** Quien hace varias cosas seguidas las hace en una sola visita: un mensaje le basta, y cada plantilla se cobra. Sin un dato con «lo recibido», el texto no nombra el procedimiento (recepción lee la conversación y no la historia) y es más fácil que Meta lo apruebe como utilidad.
- **Mientras Meta no lo apruebe, o si lo rechaza, no sale nada más**: lo hecho vale, la nota queda en el caso y su página se lo confirma. Una respuesta nunca traba ni deshace lo que la persona hizo: si falla, se anota en el registro y lo hecho queda.
- **No le quita a recepción poder escribirle.** En la Bandeja un mensaje aprobado hace esperar un día al siguiente (`sendables`), pero este responde a lo que la persona hizo: no cuenta. Tampoco cuenta como su mensaje del día de las automatizaciones.

## Alternativas descartadas

- *No responder pasadas las 24 horas*: era lo primero que se hizo, porque cada plantilla se cobra. Deja sin respuesta justo el recorrido por el que se envía el enlace.
- *Un botón de respuesta en el mensaje que lleva el enlace*: abriría las 24 horas solo si la persona lo toca, y el que quiere firmar toca el del enlace.
- *Un mensaje por cada cosa, o un dato con lo recibido*: dice más, pero son más plantillas que aprobar y más mensajes cobrados por una sola visita, y ese dato abierto es lo que más cuesta aprobar.
- *Guardar el agradecimiento hasta que vuelva a escribir*: le llegaría días después, fuera de contexto.

## Consecuencias

- Beneficio: la persona recibe respuesta por su chat en el caso normal, sin que nadie del equipo haga nada.
- Sacrificio: un mensaje más en el catálogo (diecinueve), que cada clínica debe tener aprobado, y un costo de Meta por cada uno, a la tarifa de utilidad de su país. Desde el 1 de octubre de 2026 Meta también cobra el texto dentro de las 24 horas, después de los primeros 1000 de cada número al mes: la diferencia con la plantilla se reduce a esos 1000.
- Quien hace algo más el mismo día no recibe un segundo mensaje: se lo dice su página.
- Revisar si Meta lo rechaza o lo pasa a promoción, o si las clínicas piden que diga qué se recibió.

## Referencias

- `packages/services/src/booking-links.ts` (`tellConversation`), `clinic-messages.ts` (`sendLinkReceivedNotice`), `automation-messages.ts` (`LINK_RECEIVED_MESSAGE`), `automation.ts` (`enqueueAppointmentNotice`).
- Precios de Meta: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
