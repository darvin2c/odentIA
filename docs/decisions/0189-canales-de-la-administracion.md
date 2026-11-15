# 0189 · Los canales de la administración

Fecha: 2026-11-14 · Estado: aceptada · Extiende la [0185](0185-el-arm-de-la-administracion.md) y la [0186](0186-correo-de-la-administracion.md) (el correo entrante del ARM)

## Problema

Al ARM solo le llegaba el correo. Las clínicas y los interesados nos escriben por WhatsApp, Instagram y Messenger, y eso se conversaba en un celular: lo que decían no quedaba en su ficha, Kairós no lo veía, un mensaje sin responder no aparecía en Hoy, y el seguimiento por WhatsApp abría `wa.me` en un celular personal, así que la conversación se partía en dos. La 0185 dejó pendiente «revisar el WhatsApp de Sallca como bandeja».

## Decisión y motivo

- **Una app de Meta propia de la administración y un número nuevo de Sallca.** No es la app SALLCA de las clínicas: su propio secreto, su token de verificación y su webhook (`/api/webhooks/meta/admin`), que no pasa por `/meta/whatsapp`. Lo firmado con la app de las clínicas recibe 401. El número de Sallca solo necesita acceso estándar, así que no espera la revisión de Meta de SALLCA, y si una app falla o la restringen, la otra sigue. Las claves van en OpenShip (`ADMIN_META_*`, `ADMIN_WA_*`, `ADMIN_IG_ACCOUNT_ID`), como las de ZeptoMail; cada canal se prende solo cuando están las suyas.
- **Los tres canales a la vez, con un solo modelo.** WhatsApp, Instagram y Messenger salen de la misma app y entran igual: una conversación (`saas_chat`) por canal y remitente, y sus mensajes (`saas_inbound_message`). Lo que respondemos es un `saas_outreach` con `chat_id`, como el correo. Se conectan los tres sin esperar a ver si llegan mensajes por cada uno: conectarlos después costaba lo mismo y dejaba sin atender lo que llegue antes.
- **Quien escribe no es cliente hasta que una persona dice de quién es**, igual que el «correo sin cliente». Kairós lo pone en Hoy y una persona elige: el cliente que ya tenemos, una clínica nueva o «No es una clínica» (se deshace). Nunca se liga por el teléfono (invariante de persona única). En WhatsApp, si el celular es exactamente el de un solo contacto, se sugiere («Es de Rosa Quispe»), pero liga una persona. Tampoco al escribirle primero: si «Escribir por WhatsApp» o el mensaje de Kairós van a un celular que ya nos escribió sin decirse de quién es (o marcado «No es una clínica»), no se liga; el servidor responde 409 `CHAT_UNASSIGNED` con la conversación, la pantalla abre «¿De quién es?» (a Soporte le dice el motivo) y el mensaje de Kairós sigue en espera. Se puede mover a otra clínica con todos sus mensajes, archivos, respuestas y su «¿Es la carga de datos?», con auditoría. Kairós pide decir de quién es lo de los últimos 30 días y responder lo de los últimos 7: lo más viejo sigue en la conversación, no en Hoy.
- **Quién ve qué, decidido al escribirlo.** Lo de venta (sin cliente, o de un cliente que todavía no tiene su app) solo lo ve Administración. Lo de una clínica que ya tiene su app también lo ve Soporte, salvo la respuesta que Administración marca «Solo administración». Se fija al llegar el mensaje y al reservar la respuesta (`admin_only` en los dos), no al leer: lo que se habló mientras era venta (precios, la propuesta) no aparece después para Soporte cuando la clínica ya tiene su app o la conversación pasa a una que la tiene. Si pasa a un cliente sin app, sus mensajes, respuestas y actividades suben a solo Administración; nunca bajan (la base lo impide). El servidor lo niega con 404.
- **Se responde desde el ARM, con el ciclo del correo.** Se reserva, se envía después del commit y queda enviado, no salió o incierto; un incierto nunca se reintenta. «¿Salió?» se ofrece en lo incierto y en lo que sigue pendiente después de 10 minutos (la API se cortó entre reservar y enviar); antes, el servidor no deja resolverlo (409). En WhatsApp el mensaje lleva el id del envío (`biz_opaque_callback_data`), y si Meta avisa después que salió, pasa solo a «Salió». Firma quien escribe: «Ana · odentIA».
- **Las 24 horas de Meta.** Con texto libre se responde dentro de las 24 horas desde el último mensaje de la persona. Después, en WhatsApp, con una sola plantilla de utilidad («retomar_conversacion»); en Instagram y Messenger, por correo o por WhatsApp. La pantalla dice por qué.
- **Lo que llega no se pierde.** Si un mensaje del aviso no se pudo guardar (la base o el almacenamiento), los demás entran igual y el aviso responde 500: Meta lo vuelve a mandar, y lo que ya entró no se repite (su id de Meta). Lo que no es de Sallca o no se reconoce sigue con 200.
- **Archivos.** Fotos, PDF, audios y Excel se guardan en Documentos, solo para Administración, revisados por sus bytes, y no se borran. Se bajan con tope: hasta 25 MB, cortando apenas lo pasa (sin leerlo entero), y 20 segundos; en Messenger e Instagram, solo de los servidores de Meta (`fbcdn.net`, `fbsbx.com`, `cdninstagram.com`, `facebook.com`, `instagram.com`, por https y con hasta 2 redirecciones dentro de ellos), porque la dirección viene en el aviso. Lo que no se pudo bajar no se guarda y el mensaje entra sin él. Nadie los abre ni van al modelo. Si una persona marca «Es la carga de datos», se borran a los 30 días de llegar, igual que lo que llega por correo (0187), y Kairós sugiere «¿Es la carga de datos?» con los Excel, CSV y Word.
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
- Esquema: `packages/db/src/schema/admin-arm.ts`; migraciones `0127_canales_de_la_administracion` y `0128_canales_de_la_administracion_reglas`.
