# 0037 · «Su enlace» para lo del servicio y el portal en un paso

Fecha: 2026-10-16 · Estado: aceptada · Precisa: [0014](0014-reservar-desde-un-enlace-personal.md)

## Problema

Había cinco páginas públicas y cuatro tipos de enlace, además de un código y una llave. Pedro Ríos, a quien recepción reservó por teléfono con su nombre y su teléfono, no tenía cómo completar su documento y su fecha de nacimiento: el registro le respondía «No pudimos completar el registro» porque ya tenía ficha, y el QR de la clínica le creaba una segunda. Dar acceso al portal eran 16 acciones en dos pasos, recepción no podía compartir presupuestos, guardar la llave era opcional y sin ella la sesión se perdía a las 48 horas. Un mensaje como «necesito el link para reservar» se tomaba como pedido de portal y el agente dejaba de responder.

## Decisión y motivo

- **«Su enlace», una página personal para lo del servicio** (`/reserva`). Muestra lo mismo que se le mandaría por su chat, una cosa a la vez: su cita (confirmar, cambiar, cancelar), sus datos por completar, el presupuesto que se le envió, el consentimiento por firmar y el cuestionario. Nunca la historia ni lo guardado: tener el enlace es tener su chat, no probar quién es.
- **Uno por persona y paciente, y vence cuando ya no hace falta.** Precisa la 0014: el enlace deja de ser «de una sola cita y de 24 horas». Se renueva el vivo (siete días desde el último envío) y cada cosa deja de servir sola: la cita al pasar, los datos al enviarlos (una vez), el presupuesto al decidirlo, el consentimiento al firmarlo. Abierto sin nada pendiente dice «Este enlace ya no sirve. Responde el mensaje y te enviamos uno nuevo». El enlace del agente para reservar sigue igual (de una conversación); el de la cita, cuando faltan datos, va como botón del mismo aviso de reserva (`aviso_cita_reservada_datos`) para no mandar un segundo mensaje.
- **«Tus datos» usa las reglas de la ficha.** Solo pide lo que falta; si la fecha lo hace menor, pide a su representante en la misma operación; un documento que ya es de otra persona no se guarda y queda «Posible ficha repetida» en «Te espera». Nunca se unen fichas solas.
- **El presupuesto y el consentimiento, con las operaciones de siempre.** Responder es `decideBudgetByPerson`, la misma del portal y del chat; lo aceptado se agenda ahí mismo. El consentimiento firmado por enlace queda pendiente hasta que el profesional lo confirme: aprobación de la persona y confirmación del profesional son estados distintos.
- **El portal, para lo privado, en un paso y apagado por defecto.** Se configura solo el encendido y lo que puede verse; lo demás son valores fijos (enlace de 3 días, sesión de 48 horas o 30 días recordada). «Dar acceso» son cuatro preguntas en una pantalla, con la comprobación en persona de su documento, nombrado con su tipo. Lo que se comparte depende de los permisos de quien lo da: recepción comparte presupuestos. La primera vez, guardar la llave es el paso principal. El acceso no vence; «Quitar acceso» cierra todo.
- **Volver a entrar lo hace una persona.** El agente entiende el pedido y lo deja en «Te espera»; recepción envía un enlace nuevo sin volver a comprobar su identidad y dice el código aparte. Salen las solicitudes públicas y la detección por palabras.

## Alternativas descartadas

- *Que «Su enlace» abra el portal*: el teléfono no identifica a nadie; mostraría lo privado a quien tenga su chat.
- *Mantener «Opciones avanzadas» del portal*: ninguna clínica las necesitaba y cada una era una forma de romperlo (sin canal marcado, «Enviar enlace» fallaba).
- *Un enlace por cosa (cita, datos, presupuesto)*: más mensajes y más páginas para la misma persona.

## Consecuencias

- Beneficio: Pedro completa lo suyo desde el aviso de su cita, sin que recepción haga nada; dar acceso al portal toma cuatro clics.
- Sacrificio: el enlace sirve para más cosas, así que quien tenga su chat puede ver su cita y responder su presupuesto (no su historia). Las tablas de solicitudes de portal y las opciones avanzadas se borran (migración `0096`; no hay datos reales).
- Revisar si una clínica necesita otra duración del acceso o del enlace: hoy son valores fijos.

## Referencias

- `packages/services/src/su-enlace.ts`, `booking-links.ts`, `portal-access.ts`, `portal-policy.ts`; `apps/api/src/routes/public-booking.ts`, `portal.ts`; `apps/platform/src/routes/reserva.tsx`, `portal.tsx`, `components/portal/portal-access-section.tsx`; migración `0096`; lienzo de la fase 3, tablero 6 v2 y decisiones 8 y 9.
