# 0218 · La cuenta dentro de cada app: las mismas pantallas, servidas por cada una

Fecha: 2026-11-25 · Estado: aceptada · Paso 4 del lienzo «Una cuenta, todas las apps» (decisión 7)

## Problema

Quien solo usa gestorIA no podía cambiar su contraseña, su foto ni activar los dos pasos: Mi
perfil, Soporte de la cuenta y cerrar la cuenta vivían solo en el panel de las clínicas
(`apps/panel`), que gestorIA no puede importar (`gestoria-boundaries.test.ts`, ADR 0203). El
lienzo pide las mismas pantallas, sin rehacerlas, en `gestoria24.com` y con su marca. En ese
dominio la cuenta solo respondía `/api/auth/*` (ADR 0201).

## Decisión y motivo

- **Las pantallas de la cuenta van a lo de uso general** (`shared/packages/ui-patterns/src/account/`):
  Mi perfil (`AccountProfilePage`: nombre, foto, correo, contraseña, dos pasos, sesiones y cerrar
  la cuenta), los cajones de dos pasos y Soporte de la cuenta (`AccountSupportPage`). Cada app
  las sirve con `AccountProvider`: su cliente de Better Auth, la API de la cuenta de su dominio,
  su nombre y su ruta. Lo propio de cada app entra por ranuras: el panel suma sus clínicas, sus
  invitaciones y el acceso diagnóstico a una clínica; gestorIA, su soporte y lo que impide
  cerrar la cuenta.
- **En el dominio de una app que es otro sistema la cuenta responde también lo de la persona**
  (`apps/api/src/app.ts`, `externalAccountRoutes`): `/api/account/two-factor`, cerrar la cuenta,
  la foto y los casos de soporte de la cuenta, con la sesión de su entrada. Sus clínicas, sus
  invitaciones, el acceso diagnóstico y los casos abiertos en una clínica no existen ahí. Una
  escritura que no viene de las pantallas de esa app no se acepta.
- **Cerrar la cuenta en gestorIA pregunta antes a gestorIA** si la persona es la única con el
  rol de Dueño de alguna tienda (`onlyOwner` en `/api/yo`): lo dice y no deja cerrar hasta que
  le dé el rol a otra persona, como el panel con las clínicas.
- **Un caso de soporte pedido desde gestorIA queda marcado** (`screen: /gestoria`): el aviso
  de la respuesta lleva a `/cuenta/soporte` de su app y sale con su marca.

## Alternativas descartadas

- **Servir el panel en una ruta de `app.gestoria24.com`:** el panel es la app de las clínicas
  (TanStack Start en su propio Worker); en ese dominio sus llamadas a sus clínicas, a la
  administración y al alta darían 404, saldría con la cabecera y la marca de las clínicas, y el
  panel tendría que conocer a gestorIA. Más infraestructura (otra ruta del Worker, `basepath`)
  para una pantalla peor.
- **Rehacer las pantallas en gestorIA:** dos copias de lo mismo, que el lienzo descartó.

## Consecuencias

- **Beneficio:** una sola versión de cada pantalla de la cuenta; una app nueva la sirve con su
  proveedor y, en la API, sumándose a `externalApps`.
- **Sacrificio:** `ui-patterns` depende de TanStack Query, zod y qrcode, y su prueba de cambios
  corre todas las de las clínicas. Que alguien sea el único Dueño de una tienda lo comprueba la
  pantalla de gestorIA, no la cuenta: cerrar la cuenta desde el panel no lo mira (gestorIA pasa
  el rol al Administrador más antiguo, si hay).
- **Cuándo revisarlo:** cuando la cuenta guarde las tiendas de cada persona (paso 7), la
  comprobación del único Dueño puede pasar a la cuenta, para todas las apps.

## Referencias

`shared/packages/ui-patterns/src/account/`, `apps/panel/src/lib/account.tsx`,
`gestoria/apps/web/src/cuenta.tsx`, `apps/api/src/routes/account.ts` (`personOnly`),
`apps/api/src/routes/account-support.ts` (`accountCasesOnly`), `apps/worker/src/support-notices.ts`.
ADR 0201, 0203 y 0215.
