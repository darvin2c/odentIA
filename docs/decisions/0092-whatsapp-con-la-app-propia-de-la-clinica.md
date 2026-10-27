# 0092 · WhatsApp con la app propia de la clínica: el sistema hace en Meta lo que solo se puede por la API

Fecha: 2026-10-26 · Estado: aceptada · Amplía a [0020](0020-conectar-whatsapp-con-facebook.md) en el camino a mano

## Problema

«Conectar con Facebook» exige que la empresa de odentIA esté verificada en Meta y que la app pase la revisión de Meta. Eso puede demorar o ser rechazado. El camino a mano (la clínica crea su app y pega cuatro datos) es el plan B y sirve desde el primer día. Pero con un número real se traba donde la clínica no puede ver ni arreglar nada sola. Según la guía de Meta, leída el 2026-10-26:

- un número agregado desde la página de Meta no queda registrado: «solo se registra por la API»;
- sin suscribir la app a la cuenta (`POST /<WABA>/subscribed_apps`), los avisos de un número real no llegan;
- en modo desarrollo, Meta no envía algunos avisos;
- una clave temporal de 24 horas, o una clave secreta de otra app, fallan sin que nada lo diga.

## Decisión y motivo

- **odentIA hace por la clínica lo que solo se puede por la API**, con la clave de la clínica y las mismas llamadas del botón (`registerPhoneNumber`, `subscribeAppToAccount`): al conectar, al cambiar la clave, al «Probar conexión» y al «Volver a comprobar». El estado vive en `channel_connection.own_app`, separado de `signup`, que sigue marcando solo lo hecho con el botón.
- **El PIN lo inventa el sistema y se guarda cifrado antes de llamar**, como en el botón. Solo se pide a la clínica si el número ya tenía uno (Meta 133005/131031). Un PIN que Meta no aceptó se olvida y no se reintenta sin otro: el número tiene 10 intentos cada 72 horas. Un número que Meta ya muestra registrado (`platform_type: CLOUD_API`) no se registra de nuevo.
- **Las claves se comprueban antes de guardar.** `GET /app` dice de qué app es la clave, y `debug_token` con la clave de esa app (`<id>|<clave secreta>`) dice tipo, vencimiento y permisos. Si Meta no acepta la clave de la app, la clave secreta no es de esa app. Se rechazan la clave temporal (tipo `USER` o vence en menos de 2 días), la que no tiene los permisos de mensajes y la clave secreta ajena. Si Meta no responde o no dice de qué app es la clave, no se bloquea: se conecta sin afirmar nada de las claves.
- **Un aviso firmado con otra clave se anota** (`own_app.signatureRejectedAt`, como mucho cada 5 minutos, sin el aviso) y la pantalla lo dice con «Cambiar la clave secreta». Un aviso bien firmado lo borra. Meta reintenta durante 7 días, así que al corregir la clave los avisos llegan solos.
- **Una clave que vence no se puede renovar en este camino**: la campana avisa los últimos 7 días y el aviso se retira solo cuando se pega una clave que no vence.
- **Que la app esté publicada no se le puede preguntar a Meta con la clave de la clínica.** El paso 3 lo dice a los 3 minutos sin mensaje, junto con «¿marcaste messages?», y la guía lo explica.

## Alternativas descartadas

- *Pedirle a la clínica que registre el número y suscriba la app con curl*: una clínica mediana no tiene quien lo haga.
- *Comprobar la clave secreta con `appsecret_proof`*: Meta no publica qué responde cuando no coincide; con `debug_token` el rechazo es el de una clave de app inválida.
- *Reutilizar la columna `signup`*: los avisos de la app de odentIA se reparten por ella, y mezclar los dos caminos haría que una conexión a mano recibiera avisos ajenos.

## Consecuencias

- Beneficio: si Meta no aprueba el botón, una clínica puede conectar su número sola, con la guía y lo que el sistema comprueba.
- Sacrificio: más llamadas a Meta al conectar y al probar. Un aviso falso bien formado a la dirección de una conexión puede encender la alerta de firma. Esa dirección no es pública y la alerta se apaga con el próximo aviso bueno.
- **Nada de esto está probado con una cuenta real de Meta.** Falta confirmar que `GET /app` acepta una clave de usuario del sistema, la respuesta de `debug_token` con la clave de la app de la clínica, los códigos de registro de un número que sigue en un teléfono y que una app publicada recibe el primer mensaje.

## Referencias

- `packages/channels/src/whatsapp-own-app.ts`, `packages/services/src/whatsapp-own-app.ts`, `connections.ts` (`retryOwnApp`).
- `apps/api/src/routes/connections.ts` (`POST /:id/own-app`), `webhooks.ts`, `apps/worker/src/whatsapp-tokens.ts` (`runOwnAppTokenTick`).
- Pantalla: `packages/clinic-app/src/components/integrations/whatsapp/` (`connect.tsx`, `connect-steps.tsx`, `own-app-guide.tsx`, `own-app-status.tsx`).
- Migración `0004_whatsapp_app_propia`.
