# gestorIA

La app del Grupo Sallca para quien vende productos con envío por WhatsApp, Instagram y Messenger
(lienzo B). Es otro sistema: 100 % aparte de las clínicas (ADR 0203). Comparte solo la cuenta
única (ADR 0201) y, más adelante, la administración.

## Límites

- Nunca importa paquetes de las clínicas (`apps/`, `packages/`) ni de la administración (`admin/`),
  ni ellas a gestorIA: lo prueba `apps/api/src/gestoria-boundaries.test.ts`. Usa lo de uso general
  (`shared/packages/`) como biblioteca. Si algo de las clínicas le sirve, se mueve a `shared/` en
  su propio cambio.
- Nunca lee la base de las clínicas. La persona llega con el token firmado de la cuenta
  (`apps/api/src/cuenta.ts`, `aud` gestoria); lo que gestorIA guarda de ella es su copia
  (`account_copy`), que nadie edita: se pone al día con cada token, con los avisos firmados de la
  cuenta (`/avisos/cuenta`) y con la revisión diaria.
- Su base es `gestoria` (`packages/db`), con sus migraciones y sus reglas por tienda (RLS). Toda
  tabla nueva nace cerrada a `gestoria_app`: su migración de reglas concede solo lo que la
  aplicación usa. Lo que hace el sistema por su cuenta (avisos, revisión, la copia) usa el dueño.
- Sus variables llevan `GESTORIA_` (nunca `DATABASE_URL` a secas): así no toma la base ni la cuenta
  de las clínicas por error.

## Tiendas y permisos

- Una persona puede tener o atender varias tiendas y elige al entrar (decisión 8). Cada tienda
  vende en una sola moneda (ISO 4217), la que eligió al crearse (decisión 9).
- Roles (decisión 7): Dueño, con todo y el plan; Administrador, todo menos el plan; Ventas atiende,
  confirma pagos y entrega, sin tocar la configuración ni el equipo. La matriz única es
  `apps/api/src/permisos.ts`; el servidor la aplica en cada pedido. Solo un Dueño da, quita o toca
  el rol de Dueño, y una tienda nunca se queda sin Dueño.
- La tienda de cada pedido sale del equipo de la persona, nunca del navegador (`inStore`).
- Una invitación se acepta solo entrando con la cuenta del correo invitado; el enlace no basta.
  No cambia lo que dice: se anula y se hace otra. Cada cambio del equipo queda en `store_event`
  con quién lo hizo.

## La configuración de la tienda (B3)

- Medios de pago con los tipos de UN/CEFACT 4461 y cómo se confirma el pago, en el orden en que
  cobrará Sofi: link, comprobante (lo confirma una persona) y al recibir. Formas de entrega con la
  lista `DeliveryMethod` de Schema.org, su costo y lo que Sofi puede negociar del envío.
- El catálogo: un producto agrupa hasta tres opciones (Schema.org `ProductGroup`); cada
  combinación es una variante con su código, su stock y, si quiere, su precio y su foto. Sin precio
  mínimo, el producto no se negocia; el aviso del mínimo frente al costo solo avisa.
- El stock no lo escribe la aplicación: solo cambia con un movimiento del kardex, que la base pone
  al día (ADR 0206). Un ajuste a mano pide motivo escrito. Nunca `on conflict do nothing` al
  agregar un movimiento. Las ventas de B4 usan `recordSale` y `cancelSale` (`apps/api/src/stock.ts`).
- Ventas ve el catálogo, el stock y la configuración (`catalogo.ver`, `tienda.ver`), sin cambiarlos
  (`configuracion`). Lo que costó cada producto (costo de las entradas y aviso del mínimo) es
  `costos.ver`: la API no se lo devuelve a Ventas.
- Las fotos van en la base, por su contenido (JPEG, PNG o WebP); la hoja del catálogo, en CSV.

## Los pedidos (B4)

- Una sola operación arma un pedido para el equipo y para Sofi: `createOrderIn` (`apps/api/src/pedidos.ts`),
  con el precio de `precio.ts`. Ningún precio baja del mínimo; lo cedido (descuento, envío que pone
  la tienda, regalo a su mínimo) sale de un solo margen y queda escrito; el precio negociado vence
  a las 24 horas (ADR 0207). Lo acordado no se cambia: un pedido se anula con motivo y se anota otro.
- El stock baja al confirmar el pago, o al salir si se paga al recibir, y vuelve al anular. Si al
  pagar no alcanza, el pago se confirma igual y el pedido no sale hasta que entre stock.
- El cobro va en orden: link de pago (se confirma solo), captura (la confirma quien tiene
  `pagos.confirmar`; «No coincide» pide motivo) y al recibir (quien entrega anota lo que cobró).
  Un pedido pagado lo anula solo quien confirma pagos; uno entregado no se anula.
- El link de pago es un adaptador (`link-de-pago.ts`). El aviso del proveedor solo dice qué pago
  mirar: se lee del proveedor con el token de la tienda. Lo que no coincide queda por confirmar,
  nunca se descarta. Las credenciales van cifradas (`secretos.ts`) y nunca vuelven al navegador.
- Los avisos al cliente quedan en la historia del pedido (`order_event`, `aviso`) sin enviarse
  hasta B2. Ninguna pantalla dice que se enviaron.

## Sofi y Argos (B5)

- Sofi usa las operaciones de `pedidos.ts` (`quoteOrderIn`, `createOrderIn`, `addReceiptIn`,
  `createPaymentLinkWith`, `cancelOrderIn`); sus herramientas (`apps/api/src/sofi/herramientas.ts`)
  no repiten reglas de precio, stock ni estados. Solo ve y toca los pedidos de su conversación.
- Sofi y Argos entran con el rol de la aplicación y su remitente (`withAgent`, `agente:sofi`,
  `agente:argos`), nunca con el dueño de la base. La base les niega revisar pagos, mover stock,
  dar un pedido por pagado y tocar la configuración (`0007_reglas_sofi.sql`): toda tabla nueva
  que el agente no deba escribir suma su regla restrictiva. Solo el agente escribe como Sofi.
- Lo que escribe el cliente va siempre como mensaje del cliente, nunca en el mensaje de sistema.
  Nada sale sin `checkReply` (`revisar.ts`): importes, porcentajes y pagos. Si no pasa dos veces,
  sale el aviso fijo y la conversación pasa a una persona.
- Arma un pedido solo con una cotización que el cliente ya vio. Nunca confirma un pago.
- Los pedidos de «Probar a Sofi» llevan `test`: no mueven stock, no crean un link real y no
  cuentan en Reportes ni en Argos. Ninguna pantalla dice que un mensaje se envió (no hay canal).
- Argos no usa modelo: Reportes y «Te toca» son cálculos fijos y los seguimientos son textos
  fijos, uno por motivo y pedido. Solo Dueño y Administrador ven Reportes (`reportes.ver`).
- Un cambio en lo que Sofi lee o puede hacer (prompt, herramientas, modelo) se mide con
  `pnpm --filter @gestoria/api eval:sofi` (banco `apps/api/eval/sofi.json`), un solo juez para
  las dos versiones (`--juzgar=a.json,b.json`). Las pruebas usan un modelo controlado, nunca la red.

## Trabajo

- Sin mesa de voces: es una app más simple. Del plan a construir, con pruebas y revisión.
- La tienda de ejemplo es Calzados Rosa (`apps/api/src/semilla.ts`, `seed:dev`): cada entrega le
  suma lo suyo. Nunca se importa en pruebas ni corre en producción.
- Local: `gestoria/infra/dev/.env` (desde `.env.example`), `pnpm --filter @gestoria/db migrate`,
  `pnpm --filter @gestoria/api local` y `pnpm --filter @gestoria/web local`. La entrada necesita la
  API de las clínicas con `GESTORIA_DOMAIN`. No corren con el `pnpm dev` de la raíz.
- Pruebas: `pnpm --filter @gestoria/db test` y `pnpm --filter @gestoria/api test` (PostgreSQL con
  testcontainers, imagen `postgres:18.6-bookworm`).
