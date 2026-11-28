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
  cobrará Sofi: link, comprobante (lo confirma una persona) y al recibir. Cada forma lleva sus datos
  (ADR 0232, `apps/api/src/cobros.ts`): Yape y Plin con su celular en E.164, su titular y su QR (en
  la base, por su contenido); la transferencia con su banco de la lista y su CCI, revisado con sus
  dígitos de control (`cci.ts`) y del mismo banco. Lo que Sofi envía (`details`) lo arma el
  servidor con esos datos; nunca se pide un texto libre para lo que tiene campos. Formas de entrega con la
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
- La hoja del catálogo llega en CSV o Excel (.xlsx), con las tallas en filas o en columnas
  (`leer-hoja.ts`); todo pasa por la misma revisión (`planSheet`) y se guarda con `createPlanned`.

## Las fotos y los videos (ADR 0236)

- Van al bucket privado de gestorIA (`archivos.ts`, variables `GESTORIA_S3_*`), nunca a la base ni
  al de las clínicas: la base guarda su carpeta (`object_key`). Una foto nueva no lleva `content`
  (regla de la base); las de antes se mudan solas (`moveStoredPhotos`).
- Subir pasa por el servidor (`medios.ts`): permiso, tipo por sus primeros bytes y tamaño (foto 8
  MB; video 16 MB y 30 s, listo para WhatsApp según `video.ts`). La original se guarda tal cual;
  las copias (miniatura, vitrina, WhatsApp) las arma `imagenes.ts`. El video no se rearma.
- Ver es un enlace firmado que vence: la app (`catalogo.ver`), la vitrina pública
  (`/vitrina/:link/:producto/medios`, solo lo que se ve en la web, nunca la original) y lo que
  manda Sofi (`sofiMediaIn`, la copia de WhatsApp de la foto del color pedido o el video; la
  elige su herramienta `mandar_foto`, y sin almacenamiento elige igual y no firma).
- La foto sin fondo es una propuesta (`cutout`), cada una en su carpeta (`cutout_id`); la original
  no se borra nunca. Nadie borra un
  archivo directo: la base anota la carpeta en `media_trash` al borrar la fila (también en
  cascada) y el servidor la borra (`emptyMediaTrash`).
- La pantalla (`apps/web/src/ficha/fotos.tsx`, `cargar.tsx`, `lib/medios.ts`) achica la foto y
  prepara el video en el navegador (Mediabunny) antes de subirlo; sin almacenamiento
  (`MEDIA_OFF`) lo dice con `ErrorState` y deja seguir. Reordenar es arrastrar o «Mover»/Alt y
  flechas; la ★ de Sofi es la foto del color en la cuadrícula.
- «Cargar muchos» (`cargas.ts`): una carga abierta con sus productos y sus fotos; nada pasa al
  catálogo hasta «Crear», que guarda todo o nada y deja las fotos en su misma carpeta. Una carga
  creada o descartada ya no cambia. El agente no ve las cargas ni toca videos.

## La IA de fotos (lienzo «La ficha del producto», decisiones 3, 7, 9 y 10)

- Mira y propone; nunca guarda sola. Cada vez que mira es un `ai_look` (cuenta para el tope y
  anota lo que costó) y sus propuestas, `ai_proposal` (campo, valor, por qué, estado propuesta /
  usada / cambiada / descartada, quién y cuándo). Pedir, usar, cambiar, descartar y «Aplicar
  todos» es `configuracion`; ver, `catalogo.ver` (las de una carga, `configuracion`). Sofi y
  Argos no las ven (`0066_reglas_ia_de_fotos.sql`).
- Usar una propuesta pasa por la operación de siempre (`updateProductIn`, `saveGridIn`,
  `updatePhotoIn`; en la carga, `applyItem` y `joinPhotosIn`), con «Propuesta de la IA» en el
  historial. En un producto de una carga solo se usan el nombre, la categoría, la descripción y
  el color; lo demás pasa a la ficha al «Crear» (`carryProposalsIn`). «Agregar desde fotos» es
  una carga de un producto.
- Nunca el precio, el peso ni las medidas, ni un dato que no se ve: la plantilla dice qué puede
  proponer (`visible` en `rubros.ts`: «foto» o «etiqueta», que solo vale si está escrito en las
  fotos). Lo demás que la tienda necesita o tiene su pregunta se pregunta, desde la plantilla,
  nunca desde el modelo. `reviewLook` (`ia-fotos.ts`) descarta cifras que no se leen, precios,
  cualidades que una foto no muestra y lo que contradice una pregunta. «Mejorar el texto» solo
  reescribe: si suma un dato, no se propone (`addedFacts`).
- El modelo es el de Sofi (`gpt-6-luna`, `GESTORIA_FOTOS_MODEL`), con salida estructurada, y se
  llama fuera de toda transacción. Lo escrito en las fotos es dato, nunca instrucción.
- El tope son fotos por día y tienda (`GESTORIA_FOTOS_TOPE_DIA`, el día de la tienda); se detiene
  también si la administración detuvo a Sofi por el saldo o el tope del plan. Al llegar, la
  persona lo sabe (`capIn`) y sigue a mano: nada más se frena. Lo que costó queda en `ai_look` y
  sale del saldo del plan con `countPhotoLook` (`uso.contado`, `ia_fotos`): en la transacción que
  cierra la mirada, una vez, con su id como clave. Lo que no respondió y lo de `fake` no cuentan.
- Quitar el fondo no lo hace este modelo (solo lee imágenes): el servidor recibe la propuesta ya
  hecha (`POST fotos/:id/sin-fondo`).
- En la pantalla, las propuestas usan las piezas comunes (`AiSuggestion`, `AiSuggestionBar`,
  `AiSuggestionChips`, `AiQuestion` de `@odentia/ui-patterns`): «Agregar desde fotos»
  (`apps/web/src/agregar.tsx`; en el celular, «Tomar fotos» abre la cámara), los ✦ de la ficha
  (`ficha/ia.tsx`: «Completar», «Mejorar», «Aplicar todos») y «Juntar con IA» en «Cargar muchos»
  (`cargar-ia.tsx`). Usar en la ficha guarda antes el borrador. Una pregunta se responde en su
  campo de siempre. El tope y la IA apagada se dicen y nada se frena.
- Un cambio en lo que lee o propone se mide con `pnpm --filter @gestoria/api eval:fotos` (banco
  `apps/api/eval/fotos.json`, con los créditos de cada foto); `--estimar` dice cuánto costará.
  Las pruebas usan un modelo controlado, nunca la red.

## La ficha del producto (lienzo «La ficha del producto»)

- Las plantillas de los rubros son fijas en `apps/api/src/rubros.ts`; la tienda guarda solo lo que
  ajusta (`store_template_field`). Los datos del rubro se validan contra esa plantilla, con «No
  aplica». Lo que falta nunca frena una venta: es el nivel de `readinessOf`, calculado en la API.
- Qué colores hay y su orden son los valores de la opción del color (`product.color_option`);
  `product_color` guarda solo su hex y la foto que manda Sofi. No hay dos listas de colores.
- «Tallas y stock» (`ficha.ts`, `saveGrid`) guarda todo de una vez: cambiar un nombre no rehace
  la variante y el stock entra al kardex (subir es entrada; bajar o quitar con stock pide motivo).
- El estado lo pone la tienda (encargo, cupo, preventa, liquidación, ya no se vende); disponible
  y agotado salen del stock (`saleStateOf`). Por encargo, cupo o preventa se anota sin stock; lo
  que ya no se vende no entra a un pedido nuevo. El cupo por día todavía no se cuenta.
- El precio de revendedora, el combo, las promociones de un color o una talla y la liquidación
  son opciones de `autoUnit`/`floorOf` en `precio.ts`; lo que Sofi puede ofrecer de cada producto
  solo la frena a ella (`byAgent`). El simulador es `lowestQuote`: nunca otra cuenta.
- Lo que Sofi no supo (`preguntas.ts`, ADR 0237): Sofi solo anota la pregunta (`anotar_pregunta`);
  va a «Te toca» (iguales del mismo producto, una línea) y al celular, salvo las de la prueba, que
  quedan solo en la ficha. Ventas responde (una vez para todas, `answerQuestions`) y propone
  guardarla; quien tiene `configuracion` la guarda. «Que Sofi se lo diga» le escribe a cada clienta
  por su tubería (`tellAnswer`), sin prometer una hora. Cada cambio de la ficha va al historial
  (`product_event`), campo por campo, con la forma de `productPatch`.
- La página del producto en la vitrina (`vitrina.ts`, `apps/web/src/vitrina/`) es una pieza: la
  vista previa de la ficha y «Probar como clienta» la usan y la usará el catálogo por link. Da
  solo lo vendible (ni costo, ni mínimo, ni lo que Sofi puede ofrecer, ni códigos, ni el stock
  exacto: «quedan pocas» hasta 3); la ruta pública, solo si `web_visible`.
- La pantalla de la ficha (`apps/web/src/ficha/`) es una página completa que se guarda sola: un
  borrador (`FichaStore` de `ficha/borrador.ts`) con deshacer y rehacer, que envía solo lo que
  cambió y dice siempre cómo está («Guardando…», «Guardado», lo rechazado en su campo). Cada
  celda de la cuadrícula va con el stock que vio la pantalla (`seenStock`): el servidor guarda la
  diferencia sobre el stock de ahora (`saveGrid`), nunca un total que pise una venta, y dice lo
  que se vendió mientras tanto (`meanwhile`); si baja el stock, espera el motivo sin frenar lo
  demás. El margen se dibuja con el costo
  que da el servidor solo con `costos.ver`; lo que cobraría Sofi es siempre `POST /simular`. Las
  propuestas de la IA entran con `AiSuggestion`, nunca dibujadas a mano.

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
- Inicio y «Lo que falta» cuentan con la misma función (`setupProgress` de
  `apps/web/src/lib/configuracion.ts`), sobre los pasos del servidor y su `sells`: lo que no frena
  la venta (invitar al equipo, Tu marca, el link de pago) se muestra, pero nunca se cuenta como
  falta ni deja abierta la lista. Un link de pago sin pasarela no es una forma de cobrar
  (`chargingPaymentsIn`).
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
  los bloquea `linkNameProblem`. Si está libre se dice al escribirlo (`checkLinkName`); de otra
  tienda solo se sabe si tiene el nombre (`store_link_taken`, `0052`), nunca cuál.
- Tu marca se guarda una sola vez (`saveStoreBrand`): el nombre, el color, el link, el logo y la
  portada en una transacción; si algo no se puede, no queda nada a medias. El logo se suelta, se
  elige o se pega (arrastrar nunca es la única forma), se recorta con `ImageAdjust` y sube como
  imagen con `renderAdjustedImage`: un SVG se pasa a imagen en el navegador, nunca se guarda como
  SVG (el servidor mira el contenido). La vista previa de la clienta dice que el catálogo con link
  aún no se publica.

## Entregas por distrito (lienzo «gestorIA · Configuración, de nuevo», tablero 7; ADR 0233)

- Los distritos son códigos UBIGEO del INEI (`apps/api/src/distritos.ts`: los 43 de Lima y los 7
  del Callao), nunca texto: la pantalla los elige del mapa esquemático o de la lista de cada zona.
  Un distrito está en una sola zona en toda la tienda (`checkZonesIn`).
- El precio de un envío sale solo de `deliveryPriceOf` (`apps/api/src/entregas.ts`), con el pago
  al recibir y el envío gratis por zona (`payOnDeliveryOf`, `freeFromOf`): pedidos, «Cambiar»,
  cambios y Sofi la usan; nadie más calcula el envío. Cuándo llega se cuenta en la hora de la tienda.
- Las franjas de una zona son de las de la tienda (`store.delivery_slots`): no hay otra lista.
- Quién paga el viaje fallido es `store.failed_trip`: se informa (Sofi, «No se entregó»); cobrar
  otro viaje no está hecho.

## Inicio y los primeros pasos (entregas 3 y 6 del lienzo «gestorIA como odentIA»; ADR 0227)

- gestorIA abre en Inicio, primero en el menú, para quien atiende (`ventas.atender`); soporte entra
  por el catálogo. Sus cifras salen de las mismas funciones que Reportes (`collectedSinceIn`,
  `pendingNowIn` de `sofi/reportes.ts`), sobre el saldo único: Inicio no recalcula nada. Los
  montos del día son de `reportes.ver`; no se crea un permiso para ellos.
- «Te toca» (`apps/api/src/inicio.ts`) vive solo en Inicio: cada línea, para quien puede
  resolverla, con su único botón y la operación de siempre (el pedido con su captura, «Pasar a…»,
  «Comparar», «Responder» lo que Sofi no supo). Una línea que depende de una pantalla que no existe va en `waiting` y no se dibuja.
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
- La pasarela se conecta entrando a la cuenta (OAuth con PKCE, `pasarela.ts`; ADR 0232): nunca se
  pide copiar llaves. El intento vale 10 minutos, una vez y para quien lo empezó; el token se renueva
  solo antes de vencer. En modo prueba (`store_payment_link.mode`) solo se paga el link de S/ 1 de la
  tienda: ningún pedido se cobra por link, Sofi no lo ofrece (`chargesOrders`) y un pago de prueba
  nunca paga un pedido. El aviso `mp-connect` se comprueba con el proveedor antes de creerlo.
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
  lo resta de lo pagado: lo que sobra es lo que falta devolver. Reportes resta lo devuelto, y el cobro
  del 1 % también lo descuenta. `agentReturnsIn` solo mide lo que volvió de lo que vendió Sofi.

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
- A Sofi se la configura eligiendo (ADR 0234): cada opción de `store_agent` (tono, trato, emojis,
  lo que ofrece, cuándo pasa el chat, el horario) tiene su frase fija en `sofi/opciones.ts`; nada
  que escriba la tienda va como instrucción. Lo que puede ofrecer lo frenan también cotizar y
  armar_pedido. «Lo que sabe» llega por `leer_lo_que_sabe` (las preguntas, como JSON en los datos);
  «Lo que aprendió» lo anota solo Sofi, en chats de verdad, y lo cierra solo una persona: nada se
  agrega solo. «Por qué» en la prueba sale solo de lo anotado en su respuesta (`whyOf`).
- Guardar opciones de Sofi manda solo lo que cambió y la versión que se vio (`version`); sobre una
  versión vieja la API responde 409. Encender o pausar es su propia operación
  (`PATCH …/sofi/estado`, `setAgentEnabled`), que no cambia esa versión: guardar opciones nunca
  enciende ni pausa a Sofi.
- Ofrece una sola vez por conversación, del mismo margen y a cambio de pagar a una hora exacta
  (ADR 0224). Lo frena la herramienta, no solo el prompt (`bargainProblem` de
  `sofi/herramientas.ts`, en cotizar y armar_pedido): nada se cede antes de que Sofi haya dicho el
  precio completo de lo que lleva, ni sin una duda de la clienta después de oírlo (`isObjection`;
  preguntar el precio no es una duda), y la primera oferta cede como mucho la mitad del margen
  sobre los mínimos. «Por qué» dice la duda que abrió la oferta o por qué no ofreció. Lo que sabe de la clienta para elegirla sale de su ficha, por cualquier chat
  (`conversationCustomerOrdersIn` de `clientes.ts`), nunca del teléfono.
- Los pedidos de «Probar a Sofi» llevan `test`: no mueven stock, no crean un link real y no
  cuentan en Reportes ni en Argos. Ninguna pantalla dice que un mensaje se envió (no hay canal).
- «Probar como clienta» (ficha, ADR 0237) es esa misma conversación de prueba, nunca un panel
  aparte: el chat y la vitrina con el mismo carrito (el pedido de la conversación), la oferta con
  plazo y «Pagar ahora», que se simula (`payTestOrderIn`) y lo dice. Lo que la tienda le pide decir
  (que pagó, una respuesta) va como aviso de sistema (`StoreNotice`), nunca como mensaje de la
  clienta. Lo que llega con el mensaje de la clienta (`detail.desde`, `detail.carrito`) son datos.
- Sofi lee la ficha (`sofi/ficha.ts`): los datos del rubro, el estado con lo que dice en cada uno,
  las preguntas guardadas, los colores con su foto, el video y lo que puede ofrecer de ese
  producto. Lo que la ficha no dice no lo afirma: lo deja a la tienda. «Qué usó Sofi» sale de lo
  que leyó y está en lo que escribió (`usedIn`), no del modelo.
- Argos no decide con el modelo: Reportes y «Te toca» son cálculos fijos y los seguimientos son
  textos fijos, uno por motivo y pedido. El modelo solo lee lo que dijo la clienta (abajo, «El perfil
  de la clienta»). Solo Dueño y Administrador ven Reportes (`reportes.ver`).
- Un cambio en lo que Sofi lee o puede hacer (prompt, herramientas, modelo) se mide con
  `pnpm --filter @gestoria/api eval:sofi` (banco `apps/api/eval/sofi.json`), un solo juez para
  las dos versiones (`--juzgar=a.json,b.json`). Las pruebas usan un modelo controlado, nunca la red.

## El perfil de la clienta (ADR 0240)

- Argos perfila solo (`apps/api/src/sofi/perfilar.ts`, en su vuelta) y la ficha lo muestra
  (`customerProfileIn` de `apps/api/src/perfil.ts`, sobre la familia de fichas unidas). Cada dato es
  una fila de `customer_fact` con su fuente, su cita y su hora: nada se edita. El de hoy es el último
  de la tienda o, si no hay, el último. Lo que corrige una persona («Corregir», `ventas.atender`)
  queda «Lo puso la tienda» y Argos no lo vuelve a escribir; la base también se lo niega (`0051`).
- Argos usa el modelo (el de Sofi) SOLO para leer lo que ella escribió y la dirección de su última
  entrega: lo de ella va como mensaje del usuario y cada dato trae su cita, que el código comprueba
  tal cual en el mensaje o la dirección, con la medida del catálogo y una fecha que existe; lo demás
  se descarta. Lee cada mensaje una vez (`argos_reading`), nunca a media conversación ni «Probar a
  Sofi». Las cifras (la medida de sus compras, su canal) y toda decisión siguen siendo cuentas fijas.
  Lo que cuesta leer queda en el registro de la vuelta: no se cobra.
- El permiso para escribirle (`customer_consent`) lo anota solo Sofi, del último mensaje de ella y con
  sus palabras. Nadie del equipo dice por ella que sí.
- Argos y Sofi anotan en la ficha propia del pedido del chat (`conversationFichasIn`), no en la que se
  ve: «Separar» se lleva lo suyo. Un chat con pedidos de familias distintas puede no ser de ella: no
  se le anota nada de lo que dice y su permiso queda sin ficha, que no cuenta para nadie.

## El acuerdo con la administración (B7)

- gestorIA le habla a la administración solo con `@odentia/contract` (ADR 0211 y 0212), firmado
  con `GESTORIA_CONTRACT_SECRET`, en la misma entrada de la cuenta. Sin secreto no envía ni pregunta.
- Todo aviso va por `apps/api/src/acuerdo.ts` a `contract_outbox`, en la misma transacción que lo
  que lo causó; nunca se envía directo. Su id es su clave y no cambia al reintentar. Un cambio de
  nombre, país o Dueño de la tienda llama a `noteStoreAccount`; todo cambio del equipo (alta,
  baja, rol) o del nombre, también a `noteStoreTeam` (ADR 0217): el equipo entero, que la cuenta
  usa para el selector de las clínicas y para no cerrar la cuenta del único Dueño.
- Lo que usó Sofi se cuenta con `countConversation`: una vez por conversación cada 24 horas, y sube
  a «pedido» si tomó uno. Lo de prueba nunca se cuenta. Solo el agente anota uso de conversaciones
  (`0009_reglas_acuerdo.sql`); una persona, solo el de una mirada suya de la IA de fotos (`0042`).
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
  se reintenta. Lo de la misma persona y lo de «Probar a Sofi» no avisan. Lo que Sofi no supo
  es su tipo (`preguntas`, con `questions_seen` como cursor), para quien atiende.
- La tarjeta para instalar y activar (`InstallCard`) va en la pantalla de entrada de la tienda.

## La web pública (B8)

- `gestoria24.com` es `apps/sitio`: Astro armado una vez al publicar, solo archivos en el Worker
  `gestoria-sitio`, aparte de la app (`gestoria-web`) y de las webs de las clínicas. No usa nada
  de `apps/web` de las clínicas (lo vigila `src/lib/limites.test.ts`).
- Existen siempre `/terminos`, `/privacidad` y `/contacto`: los enlazan los correos de la cuenta.
  El armado lo comprueba (`scripts/comprobar-armado.mjs`) y no se publica sin ellas.
- Solo dice lo que gestorIA hace; lo que todavía no existe va como «pronto» y nunca se muestra como
  pantalla. El precio es el que definió el usuario: USD 19 al mes, que vuelven como saldo, más el
  1 % del total (con el envío) de cada venta completada: pagada y entregada, o despachada por
  agencia, venga de donde venga; lo devuelto se descuenta. Términos y
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
