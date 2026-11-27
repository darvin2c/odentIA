# 0228 · En gestorIA, Despachos, el repartidor de la tienda y la caja del efectivo

Fecha: 2026-11-27 · Estado: aceptada · Entrega 3 del lienzo «gestorIA como odentIA» (tableros 4, 6,
17, 23 y 24; sobre el saldo del ADR 0222 y las correcciones del ADR 0226)

## Problema

Lo que salía cada día estaba en un filtro de Pedidos («Para entregar hoy») que no sabía de franjas
ni de quién lo llevaba. Lo cobrado en la puerta quedaba a nombre de quien tocaba el botón, no de
quien tenía el dinero, y nadie anotaba cuándo ese efectivo llegaba a la tienda. «Entregado» aceptaba
cobrar menos de lo que faltaba o entregar con una captura todavía sin revisar, contra la regla del
tablero 24: sin pago confirmado no se entrega.

## Decisión y motivo

- **Despachos es una vista, no otra operación**: lee los pedidos y sus novedades de entrega
  (`order_event`) por día de la tienda, y cada botón llama a la operación del pedido (`pedidos.ts`),
  la misma de Pedidos. «No se entregó» es la última novedad de entrega, sin columna aparte que se
  pueda desincronizar. «Cobrar» es el saldo único (`order_balance`).
- **La franja es una copia en el pedido** (`slot_start`, `slot_end`, en minutos de la tienda), como
  la forma de entrega: cambiar las franjas de la tienda (`store.delivery_slots`) no mueve los
  pedidos. Son opcionales.
- **El repartidor es de la tienda** (`store_courier`): una persona del equipo (con su cuenta) o un
  nombre externo, sin borrarse nunca. Cuando llegue gestorIA Reparto, el externo que acepte su
  invitación queda enlazado a su cuenta en ese mismo registro, sin tocar sus pedidos ni su
  efectivo. Lo cobrado en la puerta lleva el repartidor del pedido (`order_payment.courier_id`); la
  base no deja anotarlo a nombre de otro.
- **Sin pago confirmado no se entrega**: «Entregado» con saldo pendiente obliga a anotar en ese paso
  todo lo que falta (uno o varios medios que se cobran al recibir, con la foto del voucher si la
  hay), y un pago por confirmar se confirma antes. El Yape a la tienda sigue siendo una captura que
  confirma una persona, no un cobro en la puerta.
- **«Recibí» solo se agrega** (`cash_handover`): quién recibe, cuánto debía y cuánto recibió, con la
  diferencia escrita si no cuadra. Cada pago en efectivo entra en uno solo, por la clave de
  `cash_handover_payment`: así no se marca el pago (que solo da los pasos de su revisión) y no se
  recibe dos veces.
- **Las cifras salen de un solo lugar**: lo cobrado de Caja y de Reportes es la misma consulta
  (`collectedBetween`), y lo que falta cobrar en las entregas del día es la suma del saldo de las
  filas de Despachos.

## Alternativas descartadas

- Una columna «no se entregó» en el pedido: repite lo que ya dice su historia.
- El nombre del repartidor como texto en el pedido: el efectivo no se podría juntar por persona ni
  enlazar a su cuenta después.
- Marcar el pago como recibido: chocaría con `order_payment_step` y no guardaría la diferencia.
- Un permiso nuevo para Ventas en Caja: Caja muestra los totales de dinero del día, que Ventas no ve
  (como Reportes). Caja es `caja`, de Dueño y Administrador.

## Consecuencias

- Un cobro en la puerta distinto de lo que falta ya no se acepta: se anota todo o se pasa a otro día.
- Pendiente para gestorIA Reparto: el rol Reparto, la invitación, «Mi plata» y la regla de la base
  que le deja ver solo lo asignado. El pago al repartidor por entrega queda fuera hasta que una
  tienda real confirme cómo se paga.
