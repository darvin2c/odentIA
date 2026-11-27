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

## La cuenta de la persona

- Mi perfil y Soporte de la cuenta son las pantallas comunes de `@odentia/ui-patterns`
  (`AccountProfilePage`, `AccountSupportPage`; ADR 0218), en `/cuenta` y `/cuenta/soporte`, con la
  API de la cuenta en su dominio (`ACCOUNT_API`). No se rehacen aquí: lo propio de gestorIA entra
  por sus ranuras. Cerrar la cuenta no se ofrece mientras sea el único Dueño de una tienda
  (`onlyOwner` de `/api/yo`).

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

## Las clientas (entrega 4)

- La clienta es la persona (ADR 0221): una ficha (`customer`) por clienta, y cada pedido lleva la
  suya desde `createOrderIn` (`customerForOrderIn` de `apps/api/src/clientes.ts`): la elegida al
  anotarlo, la de los pedidos anteriores del mismo chat o una nueva. Nunca se busca ni se une por
  el teléfono o el nombre: eso solo sugiere «¿Es la misma clienta?», que no frena ninguna venta.
  Los pedidos de «Probar a Sofi» y los de antes de Clientes no tienen ficha.
- Unir, separar y «son distintas» los decide una persona que atiende (`ventas.atender`). Unir deja
  la ficha más nueva dentro de la más antigua (`merged_into`), sin mover ni borrar nada; «Separar»
  la deja sola, con las que se le unieron antes. Lo decidido va a `customer_event` y no se vuelve a
  preguntar. Un pedido no cambia de ficha. Sofi abre fichas, pero no las cambia ni anota
  decisiones (`0015_reglas_clientas.sql`).
- Lo que debe una clienta no se calcula en Clientes: sale del saldo de cada pedido.

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

## El acuerdo con la administración (B7)

- gestorIA le habla a la administración solo con `@odentia/contract` (ADR 0211 y 0212), firmado
  con `GESTORIA_CONTRACT_SECRET`, en la misma entrada de la cuenta. Sin secreto no envía ni pregunta.
- Todo aviso va por `apps/api/src/acuerdo.ts` a `contract_outbox`, en la misma transacción que lo
  que lo causó; nunca se envía directo. Su id es su clave y no cambia al reintentar. Un cambio de
  nombre, país o Dueño de la tienda llama a `noteStoreAccount`; todo cambio del equipo (alta,
  baja, rol) o del nombre, también a `noteStoreTeam` (ADR 0217): el equipo entero, que la cuenta
  usa para el selector de las clínicas y para no cerrar la cuenta del único Dueño.
- Lo que usó Sofi se cuenta con `countConversation`: una vez por conversación cada 24 horas, y sube
  a «pedido» si tomó uno. Lo de prueba nunca se cuenta. Solo el agente anota uso (`0009_reglas_acuerdo.sql`).
- La app nunca se detiene por la administración: se usa lo último guardado en `contract_state`;
  sin nada, se deja trabajar. Solo Sofi se detiene (`agentStopOf`), y solo en lo que se cobra; la
  conversación que no atiende (en pausa o apagada) pasa a «Espera a una persona» con su motivo.
- «Plan y pagos» es del Dueño (`plan`). Los textos los escribe gestorIA; la administración manda datos.
  El comprobante de un cargo sale en su aviso (`pago.comprobante`), mirado por su contenido.
- Lo enviado se borra de la bandeja a la semana (`purgeOutbox`), menos el último `cuenta.abierta`.
- Lo que pide la administración (ADR 0214) llega a `/acuerdo/pedidos` y se aplica en
  `apps/api/src/acuerdo-pedidos.ts`, una vez por su clave (`contract_request_receipt`), con las
  reglas de la tienda: nunca sin Dueño. Responde «hecho» o «falló» con su motivo.
- Soporte de gestorIA entra solo con el sí del Dueño o un Administrador (`soporte.ts`), con su
  cuenta, solo a mirar (`support` en `permisos.ts`) y hasta que vence o lo sacan. No es del equipo:
  `inStore` lo reconoce por su entrada vigente. Un permiso nuevo de solo lectura se le suma solo
  si leer con él no escribe nada.
- Soporte mira solo desde la administración (ADR 0219): su lugar exige la entrada vigente y la
  marca `staffVerified` del token (la sesión pasó el código del personal), en `/api/yo` y en
  `seatIn` a la vez. A quien tuvo una entrada, el servidor le dice cómo está la suya
  (`supportStateOf`); a cualquier otra persona, 404. «Salir» termina solo la entrada, nunca la
  sesión. Ventas ve solo quién mira y hasta cuándo; soporte no ve la lista de soporte.

## La web pública (B8)

- `gestoria24.com` es `apps/sitio`: Astro armado una vez al publicar, solo archivos en el Worker
  `gestoria-sitio`, aparte de la app (`gestoria-web`) y de las webs de las clínicas. No usa nada
  de `apps/web` de las clínicas (lo vigila `src/lib/limites.test.ts`).
- Existen siempre `/terminos`, `/privacidad` y `/contacto`: los enlazan los correos de la cuenta.
  El armado lo comprueba (`scripts/comprobar-armado.mjs`) y no se publica sin ellas.
- Solo dice lo que gestorIA ya hace. Sin precios hasta que el usuario defina los planes. Términos y
  Privacidad llevan «[Por completar]» en lo que falta y, mientras tengan marcas, `noindex` y fuera
  del mapa del sitio; los datos de la empresa son los de odentia32.com/privacidad.
- El botón principal es el WhatsApp de ventas (`vars.SALES_WHATSAPP`) mientras los chats esperan a
  Meta; `TIENDAS_ABIERTAS` en `src/lib/sitio.ts` lo pasa a «Crea tu tienda».
- El logo es el de la marca común guardado como archivo (`src/assets/`, lo vigila `marca.test.tsx`).

## Trabajo

- La mesa y la QA llevan las voces de gestorIA: comercial (la experta en vender), novato, desarrollo,
  auditor y diseño UX; nunca clínica (`.claude/skills/odentia-qa/references/mesa.md`, «Quién entra»).
  Su recorrido base: subir un producto con tallas y stock, venderlo en «Probar a Sofi», anotar un
  pedido, cobrarlo con captura y entregarlo.
- La tienda de ejemplo es Calzados Rosa (`apps/api/src/semilla.ts`, `seed:dev`): cada entrega le
  suma lo suyo. Nunca se importa en pruebas ni corre en producción.
- Local: `gestoria/infra/dev/.env` (desde `.env.example`), `pnpm --filter @gestoria/db migrate`,
  `pnpm --filter @gestoria/api local` y `pnpm --filter @gestoria/web local` (la web pública: `pnpm --filter @gestoria/sitio local`). La entrada necesita la
  API de las clínicas con `GESTORIA_DOMAIN`. No corren con el `pnpm dev` de la raíz.
- Pruebas: `pnpm --filter @gestoria/db test` y `pnpm --filter @gestoria/api test` (PostgreSQL con
  testcontainers, imagen `postgres:18.6-bookworm`).
