# 0188 · Los canales de la administración

Fecha: 2026-11-14 · Estado: aceptada · Extiende la [0185](0185-el-arm-de-la-administracion.md) y la [0186](0186-correo-de-la-administracion.md) (el correo entrante del ARM)

## Problema

Al ARM solo le llegaba el correo. Las clínicas y los interesados nos escriben por WhatsApp, Instagram y Messenger, y eso se conversaba en un celular: lo que decían no quedaba en su ficha, Kairós no lo veía, un mensaje sin responder no aparecía en Hoy, y el seguimiento por WhatsApp abría `wa.me` en un celular personal, así que la conversación se partía en dos. La 0185 dejó pendiente «revisar el WhatsApp de Sallca como bandeja».

## Decisión y motivo

- **Una app de Meta propia de la administración y un número nuevo de Sallca.** No es la app SALLCA de las clínicas: su propio secreto, su token de verificación y su webhook (`/api/webhooks/meta/admin`), que no pasa por `/meta/whatsapp`. Lo firmado con la app de las clínicas recibe 401. El número de Sallca solo necesita acceso estándar, así que no espera la revisión de Meta de SALLCA, y si una app falla o la restringen, la otra sigue. Las claves van en OpenShip (`ADMIN_META_*`, `ADMIN_WA_*`, `ADMIN_IG_ACCOUNT_ID`), como las de ZeptoMail; cada canal se prende solo cuando están las suyas.
- **Los tres canales a la vez, con un solo modelo.** WhatsApp, Instagram y Messenger salen de la misma app y entran igual: una conversación (`saas_chat`) por canal y remitente, y sus mensajes (`saas_inbound_message`). Lo que respondemos es un `saas_outreach` con `chat_id`, como el correo. Se conectan los tres sin esperar a ver si llegan mensajes por cada uno: conectarlos después costaba lo mismo y dejaba sin atender lo que llegue antes.
- **Quien escribe no es cliente hasta que una persona dice de quién es**, igual que el «correo sin cliente». Kairós lo pone en Hoy y una persona elige: el cliente que ya tenemos, una clínica nueva o «No es una clínica» (se deshace). Nunca se liga por el teléfono (invariante de persona única). En WhatsApp, si el celular es exactamente el de un solo contacto, se sugiere («Es de Rosa Quispe»), pero liga una persona. Se puede mover a otra clínica con todos sus mensajes, archivos y respuestas, con auditoría.
- **Quién ve qué.** Lo de venta (sin cliente, o de un cliente que todavía no tiene su app) solo lo ve Administración. Lo de una clínica que ya tiene su app también lo ve Soporte, salvo la respuesta que Administración marca «Solo administración». El servidor lo niega con 404.
- **Se responde desde el ARM, con el ciclo del correo.** Se reserva, se envía después del commit y queda enviado, no salió o incierto; un incierto nunca se reintenta. En WhatsApp el mensaje lleva el id del envío (`biz_opaque_callback_data`), y si Meta avisa después que salió, pasa solo a «Salió». Firma quien escribe: «Ana · odentIA».
- **Las 24 horas de Meta.** Con texto libre se responde dentro de las 24 horas desde el último mensaje de la persona. Después, en WhatsApp, con una sola plantilla de utilidad («retomar_conversacion»); en Instagram y Messenger, por correo o por WhatsApp. La pantalla dice por qué.
- **Archivos.** Fotos, PDF, audios y Excel se guardan en Documentos, solo para Administración, revisados por sus bytes, y no se borran. Nadie los abre ni van al modelo. Si una persona marca «Es la carga de datos», se borran a los 30 días de llegar, igual que lo que llega por correo (0187), y Kairós sugiere «¿Es la carga de datos?» con los Excel, CSV y Word.
- **`wa.me` se queda solo mientras el número no esté.** Con WhatsApp configurado, «Escribir» y el mensaje que prepara Kairós salen por el número de Sallca; sin configurar, siguen abriendo `wa.me` como antes, para no dejar sin forma de escribir mientras se crea la app.

## Alternativas descartadas

- *Una ficha «persona» que existe sin clínica, como en HubSpot.* Más pantallas y reglas para un equipo chico; el «sin cliente» del correo ya funciona y el equipo lo conoce.
- *Usar la app SALLCA de las clínicas.* Mezclaría los datos de Sallca con el reparto por clínica y la haría depender de la revisión de Meta de esa app.
- *Conectar solo WhatsApp y esperar a ver Instagram y Messenger.* Lo que llegara por ahí mientras tanto se perdería en el celular.
- *Dejar `wa.me` como segunda opción con el número ya conectado.* La clínica respondería al celular personal y la conversación se partiría otra vez.

## Consecuencias

- Todo lo que llega por los tres canales queda en la ficha y en Hoy. A cambio, hay que crear la app de Meta, el número y la plantilla, y suscribir el webhook (pasos a mano, del dueño).
- Instagram se responde por la página de Facebook (la API de Messenger para Instagram), con el token de la página; su texto tiene un tope de 1000 bytes.
- Quien oculta su número en WhatsApp (solo con su usuario) no entra todavía: queda en el registro.
- No se muestra «Entregado» ni «Leído»; solo si salió.
- Kairós no responde solo ni redacta en estos canales: eso es la entrega siguiente («Kairós vende»), con su propia decisión.

## Referencias

- Servicios: `packages/services/src/admin-inbound-chat.ts`, `admin-channels.ts`, `admin-kairos.ts` (`chat_sin_cliente`, `responder_chat`).
- Rutas: `apps/api/src/routes/admin-meta-webhook.ts`, `admin-chats.ts`.
- Esquema: `packages/db/src/schema/admin-arm.ts`; migraciones `0123_canales_de_la_administracion` y `0124_canales_de_la_administracion_reglas`.
