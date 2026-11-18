# 0203 · gestorIA aparte: su base, su servidor y su app

Fecha: 2026-11-18 · Estado: aceptada · Paso B1 del lienzo B (gestorIA)

## Problema

gestorIA es la app del Grupo Sallca para quien vende productos por WhatsApp y redes. Tiene que
ser 100 % aparte de las clínicas (odentIA, latidIA, vistIA): si falla, las clínicas no lo notan, y
nada de lo suyo lee la base de las clínicas. Comparte solo la cuenta única (ADR 0201) y, más
adelante, la administración. Vive en el mismo repositorio (decisión 9 del lienzo A) y en el mismo
VPS mientras sea chica. Había que decidir dónde vive su base, dónde corre su servidor, cómo se
publica su app y cómo reconoce a la persona.

## Decisión y motivo

- **Su base, en el mismo PostgreSQL** (decisión 10 del lienzo A): la base `gestoria`, con su dueño
  y su rol de aplicación, sin permiso para conectarse a la base de las clínicas ni al revés
  (`gestoria/infra/crear-base.sh`), con tope de conexiones y de tiempo por consulta. Sus
  migraciones son suyas (`gestoria/packages/db/drizzle`, numeradas aparte) y su RLS por tienda
  (`app.user_id`, `app.user_email`, `app.store_id`). Sin claves foráneas entre bases. Entra al
  respaldo diario como una base más, con su propia comprobación.
- **Su servidor, en el mismo VPS pero en su propio proyecto de OpenShip**
  (`gestoria/compose.prod.yaml`, `gestoria/Dockerfile`): otra imagen, otros contenedores con
  límite de memoria y CPU, y su propio trabajo de despliegue en el CI. Se une a la red de las
  clínicas solo para llegar a PostgreSQL y al túnel de Cloudflare. Sin su proyecto, no corre.
- **Su app, en Cloudflare Workers como solo archivos**: una página que corre en el navegador
  (Vite, sin servidor propio), como las demás pantallas del grupo pero sin el armado del lado del
  servidor, porque no lo necesita. Se publica solo con sus direcciones puestas en el repositorio.
- **La persona llega por la cuenta, nunca por su base**: la app entra con la entrada de gestorIA a
  la cuenta (ADR 0201) y le pide el token firmado; el servidor de gestorIA lo comprueba con la
  llave pública de la cuenta y guarda una copia de nombre, correo y foto (decisión 11 del lienzo
  A). La copia se pone al día con cada token, con los avisos firmados (Standard Webhooks) y con una
  revisión diaria en la que gestorIA pregunta, firmando con el mismo secreto, por quienes ya
  conoce. Un aviso que gestorIA no conoce se resuelve preguntando lo vigente: los avisos nuevos de
  la cuenta no obligan a cambiar gestorIA.
- **Sus tiendas, su equipo y sus permisos son suyos** (decisiones 7 y 8 del lienzo B): Dueño,
  Administrador y Ventas en `gestoria/apps/api/src/permisos.ts`; una invitación se acepta solo
  entrando con la cuenta del correo invitado.
- **La separación se prueba**: `gestoria-boundaries.test.ts` falla si gestorIA importa algo de las
  clínicas o de la administración, o si ellas importan a gestorIA. Lo que sirva a los dos va a
  `shared/` en su propio cambio.

## Alternativas descartadas

- **Un esquema dentro de la base de las clínicas**: una consulta mal escrita o una migración
  podría tocar a las clínicas, y el respaldo y la mudanza serían de todo junto.
- **Un servidor de base aparte**: más costo y operación sin necesidad mientras gestorIA sea chica;
  el tope por usuario cuida al servidor compartido.
- **Sus servicios en el compose de las clínicas**: un fallo de gestorIA podría frenar el
  despliegue de las clínicas.
- **Su app con armado en el servidor (TanStack Start)**: no tiene páginas públicas que lo pidan;
  solo archivos es más simple y no tiene código de servidor que mantener.
- **Su propio inicio de sesión**: el usuario lo descartó; quiere una sola cuenta.

## Consecuencias

- gestorIA se despliega y se cae sin tocar a las clínicas; su CI solo prueba lo suyo cuando solo
  cambia lo suyo (`scripts/ci-alcance.mjs`).
- Hasta el paso 7 del lienzo A la cuenta vive con las clínicas: si su servidor cae, nadie nuevo
  entra a gestorIA; quien ya entró sigue hasta que venza su token.
- Usuarios nuevos de la base de las clínicas necesitan su permiso de conectarse (`GRANT CONNECT`),
  porque `crear-base.sh` se lo quita a todos.
- Revisar si gestorIA crece hasta necesitar su propio servidor de base o su propio VPS.

## Referencias

`gestoria/`, `gestoria/AGENTS.md`, `apps/api/src/routes/account-review.ts`,
`packages/services/src/account-events.ts` (`reviewAccounts`), `infra/prod/backup/backup.sh`,
`docs/deployment.md` («gestorIA: su servidor, su base y su app»). Standard Webhooks:
https://www.standardwebhooks.com.
