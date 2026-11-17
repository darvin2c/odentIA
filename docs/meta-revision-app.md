# Revisión de la app SALLCA ante Meta (Messenger e Instagram)

Lo que hay que enviar para que «Conectar con Facebook» y «Conectar con Instagram»
sirvan a cualquier clínica, no solo a las cuentas con rol en la app. Meta revisa en
inglés: los textos van en inglés, listos para pegar.

## Antes de enviar

- Configuración › Básica (ya está): política de privacidad `https://odentia32.com/privacidad`,
  términos `https://odentia32.com/terminos`, ícono, categoría, verificación del negocio.
- Borrado de datos: cambiar a `https://odentia32.com/privacidad#meta` (sección que lo explica).
- En «Configuración del inicio de sesión del negocio» de Instagram: quitar la dirección de
  prueba (hecho el 17 nov); dejar solo
  `https://api.odentia32.com/api/meta-pages/instagram/callback`. Completar ahí y en
  Facebook Login for Business › Configuración: «autorización cancelada» =
  `https://api.odentia32.com/api/meta-pages/deauthorize` y «eliminación de datos» =
  `https://api.odentia32.com/api/meta-pages/data-deletion` (responden firmados; el borrado
  abre un caso en Soporte con su código).
- Una cuenta de prueba para el revisor: una clínica de demostración en odentIA con su
  correo y contraseña. El revisor entra, va a Configuración › Integraciones y conecta.

## Qué pedir

En **Revisar › Revisión de la app**, «Acceso avanzado» para:

| Permiso | Caso de uso |
| --- | --- |
| `pages_show_list` | Messenger |
| `pages_manage_metadata` | Messenger |
| `pages_messaging` | Messenger |
| `pages_read_engagement` | Messenger |
| `instagram_basic` | Messenger (Instagram por la página) |
| `instagram_manage_messages` | Messenger (Instagram por la página) |
| `instagram_business_basic` | API de Instagram (inicio de sesión con Instagram) |
| `instagram_business_manage_messages` | API de Instagram (inicio de sesión con Instagram) |

## Texto común (cómo usa la app los datos)

> odentIA is a practice-management platform for dental and medical clinics. Each clinic
> connects its own Facebook Page, its Messenger inbox and its Instagram professional
> account so that the messages patients send arrive in the clinic's shared inbox inside
> odentIA, where the clinic's staff (or the clinic's virtual receptionist) reply. We only
> access the Pages and Instagram accounts the clinic selects in the login dialog, only to
> receive and answer their direct messages. We do not use the data for advertising and do
> not sell or share it. Tokens are stored encrypted. The clinic can disconnect at any
> time from Settings › Integrations.

## Por permiso

- **pages_show_list:** «After Facebook Login for Business, we list the Pages the clinic
  selected so the clinic chooses which one to connect (one at a time).»
- **pages_manage_metadata:** «We subscribe our app to the selected Page's messaging
  webhooks (`/{page-id}/subscribed_apps`) so new messages reach the clinic's inbox.»
- **pages_messaging:** «We receive the messages sent to the clinic's Page and send the
  replies written by the clinic's staff from odentIA's inbox, within the standard
  messaging window.»
- **pages_read_engagement:** «Required to read the Page's name, picture and the linked
  Instagram professional account, shown to the clinic when it chooses which Page to connect.»
- **instagram_basic:** «We read the username and ID of the Instagram professional account
  linked to the Page, to show which account is connected and to route its messages.»
- **instagram_manage_messages:** «We receive Instagram direct messages sent to the clinic's
  account and send the clinic's replies from odentIA's inbox.»
- **instagram_business_basic:** «For clinics whose Instagram professional account is not
  linked to a Facebook Page, they log in with Instagram; we read the account's username
  and ID to show it as connected.»
- **instagram_business_manage_messages:** «Same as above: we receive the account's direct
  messages and send the clinic's replies from odentIA's inbox.»

## Pasos para el revisor

1. Go to `https://<demo>.odentia32.com` and sign in with the test account provided.
2. Open Settings › Integrations › Messenger and click «Conectar con Facebook» («Connect with
   Facebook»). Log in and select one Page (and its Instagram account).
3. You return to odentIA with the Page connected. Send a message to that Page from another
   Facebook account: it appears in «Bandeja» (Inbox). Reply from odentIA: the reply arrives
   in Messenger.
4. Open Settings › Integrations › Instagram and click «Conectar con Instagram» («Connect with
   Instagram»). Log in with an Instagram professional account. Send it a direct message: it
   appears in the Inbox; reply from odentIA.

## Videos (uno por caso de uso, 1–2 minutos, con la pantalla completa)

1. **Messenger y su Instagram:** Integraciones › Messenger › «Conectar con Facebook» →
   ventana de Facebook (se ven los permisos) → elegir una página y su Instagram → volver a
   odentIA con «Conectado» → mandar un mensaje a la página desde otra cuenta → aparece en la
   Bandeja → responder → la respuesta llega a Messenger. Repetir el mensaje por Instagram.
2. **Instagram sin página:** Integraciones › Instagram › «Conectar con Instagram» → ventana de
   Instagram → «Permitir» → volver a odentIA conectado → mensaje directo desde otra cuenta →
   aparece en la Bandeja → responder → llega a Instagram.

Mientras Meta revisa, cualquier cuenta que tenga que probar se agrega en Roles de la app:
«Evaluador» para Facebook y «Evaluador de Instagram» para Instagram, y acepta la invitación.
