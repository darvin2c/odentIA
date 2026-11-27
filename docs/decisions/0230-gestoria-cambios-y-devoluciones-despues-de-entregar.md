# 0230 · En gestorIA, un cambio o una devolución después de entregar es un pedido nuevo enlazado

Fecha: 2026-11-27 · Estado: aceptada · Entrega 8 del lienzo «gestorIA como odentIA» (tableros 17,
7, 12 y 24; sobre el saldo del ADR 0222 y el kardex del ADR 0226)

## Problema

Un pedido entregado no se anula ni se cambia, y está bien: su total y su pago son verdad. Pero
cuando la clienta escribe «me quedó chica», el atajo era ajustar el stock a mano con un motivo y
anotar otro pedido desde cero: unos 20 toques y 4 textos. Si se le devolvía dinero, no quedaba en
ningún lado y Reportes lo seguía contando como vendido.

## Decisión y motivo

- **El entregado no se toca; el cambio es otro pedido** (`exchange_of_id`), con su número, su
  entrega y su cobro: «Cambio del 0147» y «Cambio en el 0171». Lo arma una persona (`createExchangeIn`
  de `cambios.ts`); Sofi los pasa a una persona y la base no la deja armarlos. No lleva la
  conversación del entregado, así Sofi y Argos no lo tocan ni lo siguen.
- **Lo que vuelve** (`sale_order_return`) son variantes y cantidades del entregado que todavía no
  volvieron en otro cambio sin anular, con su motivo. Vale lo que se pagó por ellas y se descuenta
  del total (`return_credit_cents`): total = lo que se lleva + el envío que paga la clienta − lo que
  vuelve. Entra al stock como **«devolución»**, un movimiento nuevo del kardex con su motivo y la
  referencia del cambio, cuando llega a la tienda: al marcar «Entregado» el cambio. Si el cambio no
  se entrega, nada vuelve.
- **Lo que se lleva** va en sus líneas, al precio de hoy; otra talla u otro color del mismo
  producto cuesta lo que pagó por lo que vuelve, sin bajar de su mínimo ni pasar del precio de hoy.
  Sin stock se crea igual y solo frena al salir, como «Cambiar».
- **El envío del cambio lo paga la clienta o la tienda**; que lo pague la tienda no gasta el margen
  de negociar: es una decisión de una persona.
- **La diferencia sale del saldo único.** Si falta cobrar, se cobra como cualquier pedido (gestorIA
  propone cobrar en la puerta, en el mismo viaje). Si cuesta menos o es una devolución, el total
  queda bajo cero y el saldo dice lo que sobra. El dinero devuelto se anota (`order_refund`) con su
  medio y quién lo hizo: gestorIA no lo mueve. `order_balance` resta lo devuelto de lo pagado; no se
  devuelve más de lo que sobra, y sirve también para un pago doble. Reportes resta lo devuelto de lo
  vendido y lo que volvió de lo más vendido.
- **El 1 %**: lo que vuelve de un pedido que armó Sofi queda anotado con su valor y la hora en que
  volvió (`agentReturnsIn`), para que el cobro de la Fase C lo descuente.

## Alternativas descartadas

- Rehacer el entregado con «Cambiar»: su cifra dejaría de ser verdad y el pago quedaría contra un
  total que no se cobró.
- Ajustar el stock a mano y anotar otro pedido (lo de antes): sin motivo de devolución, sin enlace
  y sin lugar para el dinero devuelto.
- Un pago con monto negativo para lo devuelto: cada lectura de los pagos (confirmar, deshacer,
  Caja) tendría que distinguirlo; una tabla aparte solo se suma al saldo.
- Un total que nunca baja de cero, con lo que se devuelve aparte: Reportes y el saldo tendrían que
  sumar dos cifras; con el total con signo, lo vendido neto es la suma de siempre.

## Consecuencias

- `sale_order_amounts_check` resta lo que vuelve; un total bajo cero solo existe en un cambio.
- Un cambio no se «Cambia»: se anula y se crea otro desde el entregado. Con dinero devuelto, ya no
  se anula.
- Una variante que ya no se vende recibe igual lo que vuelve. Lo que vuelve «fallado» entra al
  stock como todo lo que vuelve; la tienda lo saca con un ajuste si no se puede vender.
- Fuera de esta decisión: la franja y el repartidor del cambio y «Cambio» en Despachos (entrega 3),
  «Devuelto · Plin» en Caja y el cobro del 1 % (Fase C).
