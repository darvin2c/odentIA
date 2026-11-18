# 0201 · La cuenta conoce las apps

Fecha: 2026-11-17 · Estado: aceptada · Paso 2 del lienzo A («una sola administración para todas las apps»)

## Problema

Una sola cuenta por persona sirve para la administración y para todas las apps del grupo: odentIA, latidIA, vistIA y, después, gestorIA. Cada app tiene su pantalla de entrada con su marca y sus propios permisos. Hoy la cuenta vive con las clínicas y solo conocía productos clínicos:

- No recordaba en qué app se registró cada persona: el aviso «crea tu clínica» le llegaría a un vendedor de gestorIA, y los avisos de quien se registró en latidIA o vistIA salían con la marca y el panel de odentIA.
- gestorIA es otro sistema, con su base y su servidor. No puede leer las tablas de la cuenta para saber quién entró ni enterarse de que una cuenta se cerró.
- Un dominio desconocido caía en odentIA: si el de gestorIA apuntara a la API, abriría las rutas de las clínicas.

## Decisión y motivo

- **Las apps son una lista** (`ACCOUNT_APPS`, `ACCOUNT_APP_INFO`): nombre, producto de sus clínicas (nulo si es otro sistema) y marca de sus correos. La clave de una app de clínicas es la marca de su producto. Sumar una app es sumarla a la lista, y el compilador señala lo que decide algo por app.
- **La cuenta recuerda la app de la entrada** (`user.signup_app`, la pone el servidor al crear la cuenta). Los avisos de la cuenta salen con la marca, el panel y el dominio de esa app, y el de crear clínica solo va a las de clínicas. Quien se registró antes queda en la app base.
- **Una app que es otro sistema reconoce a quien entró con un token firmado:** el plugin `jwt` de Better Auth (JWT EdDSA de 15 minutos, `sub` la cuenta y `aud` la app) y la llave pública en `/api/auth/jwks` (RFC 7517 y 7519). Nadie fuera de la cuenta guarda contraseñas ni sesiones.
- **El cierre, el bloqueo y la reapertura de una cuenta se avisan a esas apps** (`cuenta.cerrada`, `cuenta.bloqueada` con su fecha de fin si la tiene, y `cuenta.reabierta` al quitar el bloqueo, también el de un cierre), firmados con Standard Webhooks (HMAC-SHA256, un secreto por app). El aviso se escribe en la transacción del cambio, sale en el momento y el trabajador lo reintenta. Reintentar es seguro por el acuerdo: la app reconoce un repetido por su `webhook-id`, que no cambia.
- **Los avisos de una persona llegan en orden:** uno no sale mientras otro anterior suyo a esa app espera, así que el último que recibe la app es el estado vigente. El orden lo da la hora de la base al anotarlo, después de escribir el bloqueo de la cuenta, que deja su fila tomada hasta terminar.
- **En el dominio de una app que es otro sistema solo responde su entrada a la cuenta**, sin las rutas de organizaciones (que son clínicas). Mientras la entrada no se pueda encender, ese dominio responde 404.
- **Todo lo nuevo queda apagado hasta configurarlo:** sin `GESTORIA_DOMAIN` no hay entrada ni dominio; sin la dirección y el secreto de sus avisos, los avisos esperan guardados. La entrada de gestorIA tampoco se enciende mientras sus correos no tengan su marca: nunca sale una verificación con la marca de otra app.

## Alternativas descartadas

- **Una cuenta por app:** el usuario la descartó; quiere una sola.
- **Que gestorIA lea la sesión en la base de las clínicas:** rompe la regla de que nadie lee la base del otro y ata gestorIA a esta base.
- **Firmar los avisos con la misma llave del token:** juntaría dos usos con vidas distintas; el secreto por app se rota sin tocar los tokens.
- **Avisar también a las apps de clínicas:** ya se enteran en la misma transacción del cierre.
- **Avisar solo el cierre y que gestorIA pregunte por el bloqueo:** la obligaría a leer la cuenta en cada entrada o a esperar a que venza el token; con el aviso deja de dejarla entrar al momento.
- **Un aviso cuando vence un bloqueo con fecha:** el bloqueo ya trae su fecha de fin; la app la aplica igual que las clínicas, sin otro aviso.

## Consecuencias

- gestorIA puede construir su entrada con la cuenta sin tocar las rutas de las clínicas: le falta la marca de sus correos (`shared/packages/mail`, cambio aparte) y configurar su dominio.
- Los avisos de la cuenta salen al cerrarla, bloquearla y reabrirla (migración `0147_la_cuenta_avisa_bloqueo_y_reapertura`). Un aviso que la app no recibe frena los siguientes de esa persona a esa app hasta que lo reciba. Altas y cambios de nombre o correo (la copia de la cuenta en cada app, decisión 11 del lienzo) y la revisión diaria quedan para cuando gestorIA tenga su copia.
- Hasta el paso 7 la cuenta vive con las clínicas: si su servidor cae, nadie entra a ninguna app.
- Revisar si una app nueva necesita enterarse de otros cambios de la cuenta o si el token debe durar distinto.

## Referencias

`packages/auth/src/apps.ts`, `packages/auth/src/account-events.ts`, `packages/services/src/account-events.ts`, `apps/api/src/app.ts` (`externalApps`), `apps/worker/src/account-lifecycle.ts`; migraciones `0145_la_cuenta_conoce_las_apps.sql` y `0147_la_cuenta_avisa_bloqueo_y_reapertura.sql`. Standard Webhooks: https://www.standardwebhooks.com.
