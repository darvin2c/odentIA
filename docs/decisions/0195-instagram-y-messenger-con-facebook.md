# 0195 · Instagram y Messenger se conectan con Facebook; varias cuentas salvo WhatsApp

Fecha: 2026-11-16 · Estado: aceptada · Extiende la [0020](0020-conectar-whatsapp-con-facebook.md) y la [0059](0059-conectar-con-facebook-desde-el-panel.md)

## Problema

WhatsApp se conecta con un botón de Facebook; Instagram y Messenger pedían crear una app propia en Meta y pegar claves, dirección de avisos y clave de verificación. Una clínica no sabe hacerlo, y la clave de Instagram hecha así vence a los 60 días sin que nadie lo note. Además, la regla de «una cuenta activa por canal» era para WhatsApp (por ahí sale lo automático), pero se aplicaba a todos: una clínica con dos sedes y dos páginas no podía conectar las dos.

## Decisión y motivo

- **Varias cuentas en Instagram, Messenger y Telegram, como el correo.** Solo WhatsApp queda con una, en el servidor y en la base (`channel_connection_one_active_per_channel_uidx` solo para `channel = 'whatsapp'`). Cada conversación dice por cuál entró y se responde por esa.
- **Un botón conecta Messenger e Instagram de las páginas que la persona marca**, con Facebook Login for Business por redirección, como Gmail: la API arma la ventana con la configuración de páginas de la app de odentIA (`META_PAGES_CONFIG_ID`) y una vuelta fija (`META_PAGES_REDIRECT_URI`), con el `state` firmado y de un solo uso de `mailbox_oauth_state` (proveedor `meta_pages`). WhatsApp necesita la página del panel porque su ventana es la del SDK; estas no.
- **Cada página es una conexión de Messenger y su Instagram unido es otra**, con la clave de la página: la de una página sacada de una clave de larga duración no vence. Instagram habla con `graph.facebook.com` con esa clave (`pageAccessToken` en la configuración); la conexión hecha a mano sigue con Instagram Login.
- **Una cuenta que ya tenía la clínica (desconectada o hecha a mano) pasa al botón con sus conversaciones**; una activa en otra clínica no se toca y se dice.
- **Los avisos llegan a una sola dirección de la app** (`/api/webhooks/meta/pages`), firmados con su clave, y se reparten por `entry.id` a la conexión activa hecha con el botón. Desconectar no quita la suscripción de la página: así el Instagram de la misma página sigue recibiendo, y lo que llega para una conexión desconectada se descarta.
- **Lo respondido desde Meta Business Suite entra a la Bandeja** como respuesta del equipo (`fromBusinessApp`), sin despertar al agente: el eco trae la app que lo envió y se descartan solo los de la app de odentIA, que ya están en la Bandeja.
- **La vuelta diaria** pregunta a Facebook si sigue aceptando la clave de cada página; si no, la fila dice «Necesita atención» y la campana avisa (`clave-meta:<conexión>`). La clave de Instagram hecha a mano se renueva cada 7 días y solo avisa si no se pudo (`renovar-instagram:<conexión>`).

## Alternativas descartadas

- *Una página del panel también para Instagram y Messenger.* Solo hace falta para el SDK de WhatsApp; aquí es un paso más sin motivo.
- *Instagram Login para el botón.* Daría solo Instagram y otra ventana; con Facebook una sola vez conecta la página y su Instagram.
- *Quitar la suscripción al desconectar.* Cortaría al Instagram de la misma página, o a la misma página en otra clínica.
- *Una cuenta por canal en todos.* Deja fuera a las clínicas con varias sedes o marcas; la razón de la regla (lo automático sale por un solo número) es solo de WhatsApp.

## Consecuencias

- Depende de que Meta apruebe para la app de odentIA `pages_show_list`, `pages_manage_metadata`, `pages_messaging`, `pages_read_engagement`, `instagram_basic` e `instagram_manage_messages`. Sin la configuración de páginas el botón no aparece y queda «Con tu propia app de Meta».
- Sin probar contra Meta real: las pruebas usan respuestas con la forma que publica Meta.

## Cambio del 16 nov, antes de abrir el botón a las clínicas

- **Instagram se conecta con Instagram** («Conectar con Instagram», Business Login de Instagram): sirve a una cuenta profesional sin página de Facebook. Usa la app de Instagram del caso de uso (`META_INSTAGRAM_APP_ID`, `META_INSTAGRAM_APP_SECRET`, `META_INSTAGRAM_REDIRECT_URI`); sus avisos llegan a la misma dirección firmados con esa clave, que solo vale para avisos de Instagram. La clave dura 60 días y la vuelta diaria la renueva cada 7. Sin esa app, Instagram sigue por su página de Facebook.
- **Una página a la vez.** Si en Facebook se marcan varias páginas, no se conecta ninguna: quedan cifradas 10 minutos (`mailbox_oauth_state.payload_encrypted`) y la clínica elige una en Messenger, con o sin su Instagram. Con una sola marcada se conecta directo. Así no entra por error una página que no es de la clínica.
