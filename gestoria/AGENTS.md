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
- Equipo y repartidores (`apps/web/src/equipo.tsx`; ADR 0235): la invitación lleva nombre y celular
  (E.164) y sale por el WhatsApp del celular de quien invita. Lo envía la persona: se anota solo que
  se abrió (`shared_at`) y se dice «enviada por ti», nunca que llegó.
- El repartidor de fuera lleva su celular y lo que la tienda le paga por entrega
  (`apps/api/src/equipo-repartidores.ts`, `equipo.gestionar`): es un dato de la tienda, gestorIA no
  le paga ni lo suma a ninguna cifra, y Ventas y soporte no lo ven. «Sacar» deja «sin repartidor»
  lo que no salió (`unassignCourierIn`), con su línea en cada pedido. El link de un solo uso y la
  cuenta del repartidor son de gestorIA Reparto (tablero 23): no se ofrece un link que no lleva a
  nada.

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
- Ventas ve el catálogo y el stock (`catalogo.ver`), sin cambiarlos (`configuracion`); la API le
  da lo de la tienda que necesita para vender (`tienda.ver`), pero no ve Configuración. Lo que costó cada producto (costo de las entradas y aviso del mínimo) es
  `costos.ver`: la API no se lo devuelve a Ventas.
- Las fotos van en la base, por su contenido (JPEG, PNG o WebP); la hoja del catálogo, en CSV.

## El menú y Configuración (entrega 3 del lienzo «gestorIA como odentIA»; ADR 0225)

- El menú del día lleva solo pantallas que existen (Inicio, Despachos, Pedidos, Clientes y, en
  «Gestión», Catálogo, Caja y Reportes); al pie, Configuración. La Ayuda está en la cabecera, no en
  el menú. Una pantalla nueva entra en su lugar del tablero 4, no antes.
- Configuración es `SectionNav` con los grupos de `apps/web/src/lib/configuracion.ts`, con nombres
  de tarea (Tu tienda, Vender, Conexiones, Tu equipo, Para ti, Tu cuenta gestorIA): cada apartado
  lo ve quien puede cambiarlo (su `needs` de `permisos.ts`), soporte mira lo que su permiso lee y
  quien no ve ninguno no ve la entrada. Abrir uno ajeno lo dice, sin mostrarlo; quien no ve «Lo
  que falta» (Ventas) entra directo a lo suyo. Sus nombres y rutas son los de `HELP_SCREENS` de la
  Ayuda. Integraciones espera su pantalla (`INTEGRATIONS_READY`).
- Abre en «Lo que falta» (`/configuracion`; Datos de la tienda en `/configuracion/datos`): lo que
  falta para vender, cada cosa con su botón, y cada parte en una línea con su estado y un punto
  con texto si tiene algo pendiente. Todo sale de `GET /api/tiendas/:id/configuracion/resumen`
  (`configOverview` de `apps/api/src/configuracion.ts`): lo guardado en cada apartado y los mismos
  datos de los primeros pasos (`setupFactsIn`), nunca marcas a mano. Lo que todavía no existe no
  viene ni se dibuja. Soporte lo mira sin Sofi ni el plan; a nadie le llegan llaves, costos ni
  datos de cobro. Una parte nueva suma su línea ahí y en `configLines`.
- El buscador de Configuración no es el de Ctrl+K: es el `Combobox` común sobre `SEARCH_INDEX`
  (lo que hay dentro de cada parte, con las palabras de quien vende) y los nombres que guardó la
  tienda (`namesIndex`). Una pantalla que suma algo que se busca suma su entrada, solo de lo que
  existe.
- En el teléfono Configuración no lleva la barra de `SectionNav`: la portada es el índice y cada
  parte vuelve a ella con «Configuración». `SectionNav` aún no tiene ese modo: `ConfigFrame` esconde
  su barra (anotado para moverlo a `shared/` en su propio cambio).
- El pedido de soporte para mirar la tienda y quién mira ahora salen una sola vez, en la franja
  de arriba (`StoreStrip` de `tiendas.tsx`, una `NoticeStrip`), para quien puede responder
  (`equipo.gestionar`), y se responden en Equipo y repartidores: nunca una tarjeta en cada
  apartado.
- «Tu marca» (`apps/api/src/marca.ts`): el color pinta la app con `brandColorCss` de
  `@odentia/ui/lib/brand-color`, la cuenta común con las clínicas; no se copia aquí. El nombre del
  link es único entre tiendas (`store_link`), el de antes se queda con su tienda y los reservados
  los bloquea `linkNameProblem`.

## Inicio y los primeros pasos (entregas 3 y 6 del lienzo «gestorIA como odentIA»; ADR 0227)

- gestorIA abre en Inicio, primero en el menú, para quien atiende (`ventas.atender`); soporte entra
  por el catálogo. Sus cifras salen de las mismas funciones que Reportes (`collectedSinceIn`,
  `pendingNowIn` de `sofi/reportes.ts`), sobre el saldo único: Inicio no recalcula nada. Los
  montos del día son de `reportes.ver`; no se crea un permiso para ellos.
- «Te toca» (`apps/api/src/inicio.ts`) vive solo en Inicio: cada línea, para quien puede
  resolverla, con su único botón y la operación de siempre (el pedido con su captura, «Pasar a…»,
  «Comparar»). Una línea que depende de una pantalla que no existe va en `waiting` y no se dibuja.
- Los primeros pasos (`primeros-pasos.ts`) se marcan con lo guardado en cada apartado, nunca a
  mano; `store_setup` guarda solo lo saltado y cuándo quedó lista, y la lista no vuelve. Se saltan
  solo los pasos que no aplican a toda tienda (`SKIPPABLE_STEPS`). Los ve quien tiene
  `configuracion`.

## Los pedidos (B4)

- Una sola operación arma un pedido para el equipo y para Sofi: `createOrderIn` (`apps/api/src/pedidos.ts`),
  con el precio de `precio.ts`. Ningún precio baja del mínimo; lo cedido (descuento, envío que pone
  la tienda, regalo a su mínimo) sale de un solo margen y queda escrito; el precio negociado vence
  a las 24 horas (ADR 0207).
- Un pedido se corrige sin anularlo (ADR 0226): «Cambiar» (`changeOrderIn`) es el mismo pedido,
  con su número y sus pagos, mientras no sale; vuelve a calcular el precio y el saldo con el total
  nuevo. Las líneas se reemplazan enteras, nunca se editan. «No se entregó» y «Pasar a…» solo
  mueven el día. «Entregado» sin «Salió» deja las dos. Deshacer la confirmación de una captura
  pide motivo; un pago solo da los pasos de su revisión (`order_payment_step`).
- Lo que un pedido tiene fuera del stock es lo vendido menos lo que volvió en todas sus
  referencias («Pedido 0147», «Pedido 0147 · cambio 1»). Cada paso mueve solo la diferencia con
  sus líneas (`recordSale`), con su propia referencia; nunca se vuelve a descontar por la
  referencia del pedido. «Falta stock» compara las líneas con eso (`stockShortSql`).
- El stock baja al confirmar el pago, o al salir si se paga al recibir, y vuelve al anular. Si al
  pagar no alcanza, el pago se confirma igual y el pedido no sale hasta que entre stock.
- «Hoy» es el de la tienda, con su zona horaria (`store.time_zone`, `apps/api/src/hora.ts`; ADR
  0222): nunca el del servidor ni el del navegador. Todo lo que cuenta días la usa.
- Un solo saldo por pedido: la vista `order_balance` (`saldo.ts`). Falta cobrar = total −
  confirmado − por confirmar; «Pagado» es no deber nada con todo confirmado; «Pago doble», solo si
  lo confirmado pasa del total. Ninguna pantalla ni respuesta lo recalcula. Un pedido acepta varios
  pagos mientras falte cobrar, cada uno con su medio (el de la tienda, copiado).
- El cobro va en orden: link de pago (se confirma solo), captura (la confirma quien tiene
  `pagos.confirmar`; «No coincide» pide motivo) y al recibir (quien entrega anota lo que cobró y
  con qué medio; si pagó una parte antes, cobra lo que falta).
  Un pedido con un pago lo anula solo quien confirma pagos; uno entregado no se anula: se cambia o
  se devuelve con un pedido nuevo (abajo).
- El link de pago es un adaptador (`link-de-pago.ts`). El aviso del proveedor solo dice qué pago
  mirar: se lee del proveedor con el token de la tienda. Lo que no coincide queda por confirmar,
  nunca se descarta. Las credenciales van cifradas (`secretos.ts`) y nunca vuelven al navegador.
- Los avisos al cliente quedan en la historia del pedido (`order_event`, `aviso`) sin enviarse
  hasta B2. Ninguna pantalla dice que se enviaron.

## Despachos y Caja (entrega 3 del lienzo «gestorIA como odentIA»; ADR 0228)

- Despachos (`apps/api/src/despachos.ts`) es una vista: cada botón es la operación del pedido de
  `pedidos.ts`, la misma de Pedidos (`apps/web/src/entregas.tsx` las usa en las dos pantallas).
  «No se entregó» es la última novedad de entrega del pedido, nunca una columna aparte. «Pasar a…»
  es la única forma de mover una entrega: sin arrastrar.
- La franja y el repartidor son opcionales: un pedido sin ellos sale igual. La franja es una copia
  en el pedido (de `store.delivery_slots`); el repartidor es de la tienda (`store_courier`, del
  equipo o un nombre externo, listo para enlazarse a gestorIA Reparto) y no se borra.
- Sin pago confirmado no se entrega: «Entregado» con saldo anota en ese paso todo lo que falta, y un
  pago por confirmar se confirma antes, en la misma ventana (la revisión del pedido). Lo cobrado en
  la puerta queda a nombre del repartidor del pedido (`order_payment.courier_id`). Sofi no asigna
  repartidor, franja ni agencia: la base lo frena al anotar y al cambiar (`0027`).
- Lo que suma Caja de las entregas del día usa el mismo filtro que las filas de Despachos
  (`onBoard`), y «Sale hoy» de Inicio, que abre Despachos, el de lo que sale hoy (`dueOn`): una
  cifra nueva de entregas no arma su propia consulta.
- Caja (`apps/api/src/caja.ts`, `caja`: Dueño y Administrador) recibe el efectivo con «Recibí», que
  solo se agrega y toma cada pago una vez. Lo cobrado es la misma consulta de Reportes e Inicio
  (`collectedBetween`) y lo que falta cobrar, el saldo de las filas de Despachos: ninguna pantalla
  lo recalcula. El efectivo por recibir (`cashToReceiveIn`) es también una línea de «Te toca», solo
  para quien ve Caja.
- «Avisar» abre el WhatsApp del celular con el texto y queda «enviado por usted»: nunca entregado.

## Cambios y devoluciones (entrega 8; ADR 0230)

- El entregado no se toca: el cambio es otro pedido (`exchange_of_id`, `createExchangeIn` de
  `apps/api/src/cambios.ts`), con lo que se lleva en sus líneas y lo que vuelve en
  `sale_order_return`. Lo que vuelve vale lo que se pagó y se descuenta del total; un total bajo
  cero es lo que la tienda devuelve. Lo arma una persona: Sofi no (`0031_reglas_cambios_y_devoluciones.sql`).
- Lo que vuelve entra al kardex como «devolución», con su motivo y la referencia del cambio, al
  marcar «Entregado» el cambio (`recordReturn` de `stock.ts`); nunca antes. No vuelve dos veces lo
  mismo, salvo que el cambio se anule. Un cambio no se «Cambia».
- El dinero devuelto se anota en `order_refund` (medio y quién, `pagos.confirmar`) y el saldo único
  lo resta de lo pagado: lo que sobra es lo que falta devolver. Reportes resta lo devuelto; lo que
  vuelve de un pedido de Sofi queda para el cobro del 1 % (`agentReturnsIn`).

## Las clientas (entrega 4)

- La clienta es la persona (ADR 0223): una ficha (`customer`) por clienta, y cada pedido lleva la
  suya desde `createOrderIn` (`customerForOrderIn` de `apps/api/src/clientes.ts`): la elegida al
  anotarlo, la de los pedidos anteriores del mismo chat o una nueva. Nunca se busca ni se une por
  el teléfono o el nombre: eso solo sugiere «¿Es la misma clienta?», que no frena ninguna venta.
  Los pedidos de «Probar a Sofi» y los de antes de Clientes no tienen ficha.
- Unir, separar y «son distintas» los decide una persona que atiende (`ventas.atender`). Unir deja
  la ficha más nueva dentro de la más antigua (`merged_into`), sin mover ni borrar nada; «Separar»
  la deja sola, con las que se le unieron antes. Lo decidido va a `customer_event` y no se vuelve a
  preguntar. Un pedido no cambia de ficha. Sofi abre fichas, pero no las cambia ni anota
  decisiones (`0019_reglas_clientas.sql`).
- Lo que debe una clienta («Debe» en la lista y en la ficha) no se calcula en Clientes: es la suma
  del saldo de cada pedido (`order_balance`), en `summariesOf` de `clientes.ts`.
- «Escribirle» lee cada teléfono en E.164 con lo común (`toE164` de `@odentia/ui-patterns`): el
  que trae su código vale siempre; el anotado sin él, como del país de la tienda. Sin país, no se
  adivina.

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
- Ofrece una sola vez por conversación, del mismo margen y a cambio de pagar a una hora exacta
  (ADR 0224). Lo que sabe de la clienta para elegirla sale de su ficha, por cualquier chat
  (`conversationCustomerOrdersIn` de `clientes.ts`), nunca del teléfono.
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
  Arriba, la cuota, el saldo usado y lo que pasó del saldo, tal como lo manda la administración
  (`budget`): gestorIA no suma, no calcula impuestos ni precios; el total de cada cobro es el suyo. Los movimientos por pedido llegan cuando el
  acuerdo los mande (tablero 18): hasta entonces, un `EmptyState` que dice qué se verá, sin filas
  inventadas. Se pregunta desde la Ayuda de la cabecera, escribiendo a soporte, no con un
  formulario en la página; «Pedir otro tope» abre la Ayuda con ese mensaje ya escrito
  (`openSupportRequest` de `@odentia/ui-patterns`), que la persona completa y envía.
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

## La Ayuda (entrega 7 del lienzo «gestorIA como odentIA»; ADR 0227)

- Es la misma de las clínicas: el botón «Ayuda» de la cabecera abre el panel común (`HelpButton`
  de `@odentia/ui-patterns`, en `apps/web/src/ayuda.tsx`) con Ariadna; en el teléfono, o si la
  fila no cabe, va en el menú ⋯. No hay página `/ayuda`, ni «Ayuda» en el menú, ni otro botón para
  escribir a soporte. Abierta en una ventana ancha va en la columna lateral (`SideDockProvider` del
  armazón) y le quita ancho a la página: una tabla mira su propio ancho (`@container`, como
  Pedidos), no el de la ventana, y pasa a tarjetas si no cabe.
- La guía es `apps/api/src/ayuda.ts`, la única fuente: una pregunta por tarea, solo de lo que
  gestorIA hace hoy, y cada pantalla de `HELP_SCREENS` con su `purpose` y sus `terms` para
  Ariadna. Un cambio de pantalla, botón o permiso cambia su respuesta en el mismo cambio, y una
  pantalla nueva suma su pregunta. Quién puede sale de `needs` con `permisos.ts`, nunca del texto;
  lo que va entre «» existe en la pantalla (lo prueban `apps/api/src/ayuda.test.ts`, si cambia la
  guía, y `apps/web/src/lib/ayuda-guia.test.ts`, si cambia la pantalla).
- El servidor responde al panel en `/api/tiendas/:id/ayuda` (`screen`, `ask`, `ask/:id/feedback`,
  `ask/:id/none`, `requests` y `casos`). Cada pregunta lleva la guía entera, firmada, a Ariadna en
  la administración (`CONTRACT_PATHS.help`, `askAriadna`), sin nada de la tienda ni de la persona;
  vuelve en ids de la guía y aquí se hace texto para el rol (`helpReplyOf`): la pantalla solo si
  el rol la abre y, si no puede hacerlo, a quién pedírselo. Sin el acuerdo o si la administración
  no responde, solo se responde una pregunta que es exactamente de la guía; lo demás, «Ahora no
  puedo buscar bien en la guía.». Lo que dice la persona de una respuesta va a
  `CONTRACT_PATHS.helpFeedback`; si no llega, se dice (502/503).
- Escribir a soporte desde la Ayuda es de todo el equipo (`ayuda.pedir`; soporte no), con la
  pantalla y el rol: sale por `soporte.pedido` a la Bandeja de la administración. «Tus casos con
  soporte», dentro del panel, muestra a cada persona solo lo suyo y sus respuestas (`helpCases`,
  ADR 0221); «Plan y pagos» del Dueño, las de toda la tienda, y lo del cobro sigue siendo solo de
  `plan`. La administración no dice qué respuestas se leyeron: el botón no lleva número.

## Los avisos al celular (entrega 5 del lienzo «gestorIA como odentIA»; ADR 0229)

- gestorIA se instala desde el navegador (`public/manifest.webmanifest`, íconos en `public/pwa/`)
  y avisa por push web con la app cerrada. Lo del navegador es lo común (`device-push` de
  `@odentia/ui-patterns`); el service worker (`public/sw.js`) no tiene `fetch`: no guarda datos.
- El celular es de la persona (`push_device`): se activa una vez y le llega lo de todas sus
  tiendas. Lo que elige es por tienda y vale en todos sus celulares (`push_choice`).
- Qué le llega a cada rol sale de `permisos.ts` (`PUSH_KIND_INFO` de `apps/api/src/avisos.ts`),
  mirado al enviar. Un tipo nuevo suma su fuente y su permiso ahí, y su respuesta en la Ayuda.
- No es otra bandeja: avisa lo nuevo de los pedidos (`order_event`, cursor por persona y tienda) y
  de los chats que esperan, y abre la pantalla que lo resuelve. Se anota antes de enviar y nunca
  se reintenta. Lo de la misma persona y lo de «Probar a Sofi» no avisan.
- La tarjeta para instalar y activar (`InstallCard`) va en la pantalla de entrada de la tienda:
  Inicio (`inicio.tsx`). En Avisos al celular, cada persona elige los suyos; soporte no.

## La web pública (B8)

- `gestoria24.com` es `apps/sitio`: Astro armado una vez al publicar, solo archivos en el Worker
  `gestoria-sitio`, aparte de la app (`gestoria-web`) y de las webs de las clínicas. No usa nada
  de `apps/web` de las clínicas (lo vigila `src/lib/limites.test.ts`).
- Existen siempre `/terminos`, `/privacidad` y `/contacto`: los enlazan los correos de la cuenta.
  El armado lo comprueba (`scripts/comprobar-armado.mjs`) y no se publica sin ellas.
- Solo dice lo que gestorIA hace; lo que todavía no existe va como «pronto» y nunca se muestra como
  pantalla. El precio es el que definió el usuario: USD 19 al mes, que vuelven como saldo, más el
  1 % de cada pedido que gestorIA genera sola. Términos y
  Privacidad llevan «[Por completar]» en lo que falta y, mientras tengan marcas, `noindex` y fuera
  del mapa del sitio; los datos de la empresa son los de odentia32.com/privacidad.
- El botón principal es el WhatsApp de ventas (`vars.SALES_WHATSAPP`) mientras los chats esperan a
  Meta; `TIENDAS_ABIERTAS` en `src/lib/sitio.ts` lo pasa a «Crea tu tienda» cuando el usuario lo
  decida. «Entrar» lleva al ingreso de la app.
- «Producto» separa los agentes (Sofi y Argos, que trabajan solos) de las funciones (lo que la
  tienda usa en la app), en la cabecera y en el pie (`SITE_MAP.agentes` y `SITE_MAP.funciones`).
  Las páginas de los agentes usan las escenas del Inicio (`src/components/escenas/`) y las suyas
  (`src/scripts/agentes.ts`, `src/styles/agentes.css`).
- Las páginas del plan están en `SITE_MAP` de `src/lib/sitio.ts`: mientras una no existe,
  la cabecera y el pie llevan a su parte del Inicio o no la muestran; al armarla pasa a `lista`.
- El diseño es propio (web v5, versión clara del lienzo): `src/styles/base.css` (blanco, grises
  neutros, naranja vivo #FE4F02 en superficies y #CF3C00 en botones y textos chicos; Geist fina con
  la palabra clave en Instrument Serif cursiva), `inicio.css` y `paginas.css`. La cabecera es transparente sobre el héroe y blanca con desenfoque al bajar. Las
  pantallas de la app son capturas reales de la tienda de ejemplo (`src/assets/pantallas/`), enteras
  y con `astro:assets`; nunca dibujadas ni recortadas. El chat del héroe va en código: es lo que ve
  la clienta, no la app.
- Sofi es el objeto vivo de la web: un globo de chat de vidrio naranja con un shader propio
  (`src/scripts/sofi.ts`, three.js cargado aparte), en un solo lienzo fijo que viaja a cada
  `[data-sofi]` (su valor es el humor): flota, da saltitos, mueve la colita al hablar y da una vuelta
  al festejar. El chat del héroe se puede tocar y dice que sus respuestas son de muestra. El mar de
  puntos de los rubros es WebGL puro (`src/scripts/puntos.ts`). El movimiento del Inicio es GSAP con ScrollTrigger y Lenis
  (`src/scripts/inicio.ts`): sin JavaScript o con «reducir movimiento», la página está completa y
  quieta (lo que se esconde para entrar depende de la clase `mueve`).
- El logo es el de la marca común guardado como archivo (`src/assets/`, lo vigila `marca.test.tsx`).

## Las piezas comunes

- gestorIA no repite lo de `@odentia/ui-patterns`: todo formulario es `useAppForm` con sus campos
  (`field.TextField`, `field.SelectField`, `field.Control`, `RadioChips`) dentro de `FormDrawer` o
  `FormPanel`, en la columna lateral del armazón (`SideDockProvider`/`SideDockSlot` en `Shell`), con
  el aviso de borrador común (`useDraftSaved`, `UnsavedDialog`); detalles con `DetailDrawer`; estados
  con `EmptyState`, `ErrorState`, `LoadingState`; fechas con los controles de `dates/`. Lo único
  propio es lo que lo común no tiene (`campos.tsx`: el monto con la moneda de la tienda). Una pieza
  que falta se suma a `shared/` en su propio cambio, no se copia aquí. Lo vigila
  `apps/web/src/lib/sin-duplicar.test.ts`: falla si vuelve un `Sheet` propio de formulario o una de
  las piezas que se quitaron (`FormSheet`, `useDirty`, `SELECT_CLASSES`, `FormAlert`, `ErrorBlock`…).

## Trabajo

- La mesa y la QA llevan las voces de gestorIA: comercial (la experta en vender), novato, desarrollo,
  auditor y diseño UX; nunca clínica (`.claude/skills/odentia-qa/references/mesa.md`, «Quién entra»).
  Su recorrido base: subir un producto con tallas y stock, venderlo en «Probar a Sofi», anotar un
  pedido, cobrarlo con captura y entregarlo.
- La tienda de ejemplo es Calzados Rosa (`apps/api/src/semilla.ts`, `seed:dev`), con Tortas Carmen
  para los primeros pasos de una tienda que empieza: cada entrega le suma lo suyo. Nunca se importa
  en pruebas ni corre en producción.
- Local: `gestoria/infra/dev/.env` (desde `.env.example`), `pnpm --filter @gestoria/db migrate`,
  `pnpm --filter @gestoria/api local` y `pnpm --filter @gestoria/web local` (la web pública: `pnpm --filter @gestoria/sitio local`). La entrada necesita la
  API de las clínicas con `GESTORIA_DOMAIN`. No corren con el `pnpm dev` de la raíz.
- Pruebas: `pnpm --filter @gestoria/db test` y `pnpm --filter @gestoria/api test` (PostgreSQL con
  testcontainers, imagen `postgres:18.6-bookworm`).
