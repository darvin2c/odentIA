# 0233 · En gestorIA, las zonas de entrega se arman con distritos UBIGEO y una plantilla de Lima

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA · Configuración, de nuevo», tablero 7
(decisiones 5 y 6 del tablero 13)

## Problema

Cada zona de reparto era un texto libre («Surco y Miraflores») con un precio. Nadie sabía si Lince
o Surquillo entraban, Sofi no podía cotizar el envío a un distrito y el formulario mezclaba
reparto, recojo y provincia en «Tipo», «Detalle» y «Costo». Faltaban la hora de corte, los
horarios, las agencias y qué pasa si la clienta no está. El usuario lo llamó «imposible de llenar».

## Decisión y motivo

- **Los distritos son códigos UBIGEO del INEI** (los 43 de Lima y los 7 del Callao,
  `apps/api/src/distritos.ts`), nunca texto. Una zona guarda una lista de códigos y un distrito está
  en una sola zona en toda la tienda (`checkZonesIn`, con las formas de entrega bloqueadas en la
  transacción). Las zonas siguen en `store_delivery_method.zones` (jsonb): las leen pedidos,
  Despachos y cambios por su nombre y así no cambia nada de lo que ya funciona.
- **La plantilla de Lima** (decisión 5) parte de las zonas de Ipsos («Perfiles Zonales 2025»), con
  Centro y Lima Moderna juntas, y una zona nuestra, «Lejanos y playas» (14 distritos donde los
  couriers cobran más o van en días fijos). Los precios (S/ 10, S/ 12, S/ 18) son de partida: la
  zona desde la que despacha la tienda va a S/ 10 y hoy antes de la 1 p. m. Solo para tiendas en
  soles.
- **Cada zona dice cuándo llega**: hoy antes de una hora de corte (en la hora de la tienda,
  `store.time_zone`), al día siguiente o en días fijos (ISO 8601). Sus franjas se eligen de las de
  la tienda (las de Despachos): un solo lugar para las franjas.
- **Una sola regla del precio del envío** (`deliveryPriceOf` de `entregas.ts`) para «Anotar un
  pedido», «Cambiar», un cambio y Sofi: por zona, la del distrito (o la elegida por su nombre); por
  agencia, llevarlo más el flete si la tienda lo cobra antes. El pago al recibir y el envío gratis
  son por zona (`payOnDeliveryOf`, `freeFromOf`).
- **Quién paga el viaje fallido** (decisión 6) es una regla de la tienda, `store.failed_trip`, que
  nace en «la primera vez lo asume la tienda; el siguiente viaje lo paga la clienta». Sofi la dice
  antes de que pague y «No se entregó» la recuerda.
- **Sofi cotiza por distrito**: `cotizar` recibe el distrito como lo dice la clienta («SJL») y
  `ver_envio` dice zona, precio, día, franjas, pago al recibir y envío gratis. Lo único que se lee
  de un texto es el nombre del distrito; si puede ser más de uno, pregunta.
- **El mapa es esquemático**: un dibujo propio, cada distrito un botón con su nombre y su zona,
  con teclado, y la lista de cada zona (buscador y casillas) siempre como alternativa. No es un
  mapa de calles.
- **Agencias sin seguimiento conectado**: Shalom y Olva no ofrecen una conexión pública; va el
  número de envío con el link a su web.

## Alternativas descartadas

- Una tabla de zonas y otra de distritos con su clave única: lo garantiza la base, pero cambia
  cómo leen la zona pedidos, Despachos, cambios, Clientes y Sofi a la vez. Con la regla en una
  sola función y el bloqueo de la transacción basta por ahora.
- Un mapa de calles o polígonos por radio: pesado, impreciso en Lima y no accesible con teclado.
- Cobrar solo el envío del siguiente viaje: necesita un cargo nuevo en el saldo del pedido. Queda
  fuera hasta decidirlo; hoy la regla se informa.

## Consecuencias

- Las zonas de antes quedan sin distritos (la migración 0037 les pone lo de siempre): siguen
  funcionando por su nombre; Sofi no las encuentra por distrito hasta que la tienda los marque.
- Fuera de Lima y el Callao no hay distritos que marcar: una tienda de provincia usa zonas por
  nombre o la agencia, como antes.
