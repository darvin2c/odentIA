# 0168 · El pedido, y los roles Ventas y Taller

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0167](0167-el-examen-de-la-vista-y-la-receta-de-lentes.md). Entrega 4 del plan «vistIA: plan para ópticas».

## Problema

En una óptica se vende y después se espera: se elige la montura, se paga un adelanto y los lentes se encargan al laboratorio o al taller propio, que los devuelve en unos días. El cliente pregunta cómo van y cuánto le falta pagar, y a veces hay que rehacerlos porque no ve bien. Hasta ahora la caja cobraba cargos sueltos, sin nada que dijera qué se encargó, a quién, para cuándo ni en qué paso está. Y quien vende en el mostrador de una óptica también cobra, pero no debe leer la historia clínica; el taller solo necesita lo que hay que hacer.

## Decisión y motivo

- **El pedido es común a los productos** (`job_order`, con sus líneas y sus pasos en `job_order_event`): lo que la clínica encarga a su taller o a un laboratorio para entregárselo a la persona. vistIA lo usa con los lentes y odentIA podrá usarlo con sus trabajos de laboratorio, sin otra tabla. En las pantallas aparece donde el producto lo declara (`productUi().orders`).
- **Pocos pasos, que dicen hechos de la clínica:** por enviar, en laboratorio, por revisar, listo y entregado, más anulado. Solo avanza (se puede saltar un paso: el taller propio no pasa por el laboratorio) y cada paso dice quién lo marcó y cuándo. Si algo salió mal, no se retrocede: **se rehace**, con un pedido nuevo unido al original y su motivo, que comparte sus cargos: no se cobra otra vez, lo que faltaba pagar sigue a la vista en el nuevo y el original queda reemplazado (ya no avanza ni se anula). Anular anula en la caja lo que no se cobró, salvo lo que comparte con otro pedido vivo; lo cobrado queda en su cuenta. El pedido sigue al cargo vigente aunque la caja lo reemplace en una devolución parcial.
- **La venta usa la caja de siempre:** cada cosa que lleva es un cargo (la montura con su precio y su stock del inventario; las lunas, a precio libre), y el adelanto se cobra con los medios que elija, en el mismo ticket. Puede ser parcial y la entrega no lo exige: lo que falta pagar se dice y se cobra con el cobro de siempre. Toda la venta va en una transacción, y un reintento con la misma clave devuelve el mismo pedido y el mismo ticket.
- **La montura es un producto del inventario** con lo de su etiqueta, todo opcional y común a cualquier producto: código de barras (el que lee el escáner), marca, modelo, color y medidas. Las lunas van a precio libre o como producto de la lista de la óptica.
- **El pedido lleva una copia de la receta** (vistIA: la de lentes vigente, por un gancho del producto, `saleReference`) y de las medidas para montar: el taller no abre la historia. Vencida o sin verificar se informa al vender y no impide.
- **Ventas y Taller son roles de vistIA** (`PRODUCT_ROLES`): Ventas hace lo de recepción y lo de caja, ve el inventario con precios y los pedidos, y ve la receta de lentes vigente sin el resto de la historia (`clinical.prescription`). Taller ve los pedidos con la copia de la receta (`orders.prescription`) y marca cómo van; nada más: anular y rehacer, que mueven la caja, son de quien la lleva. Leer la copia queda en «Consultas a la historia», y recepción y caja no la ven. En otro producto no se invitan ni se asignan: lo cuida el servidor (Better Auth) además de la pantalla. Caja también vende y entrega; recepción y quien atiende ven cómo va un pedido, sin cobrarlo. Lo que falta pagar solo lo ve quien ve la caja.

## Alternativas descartadas

- **Un estado de «pedido» en el cargo o en el ticket.** Un pedido junta varios cargos, se rehace sin cobrar y tiene pasos que no son de dinero.
- **Copiar los estados de un sistema de laboratorio** (recibido, tallado, biselado, montado…). Son pasos de quien fabrica; la óptica necesita saber si está y qué decirle al cliente.
- **Un rol «Óptico» con todo.** Mezcla vender con leer la historia, que la ley protege.

## Consecuencias

- «Tus lentes están listos», que Sofi responda cómo va y cuánto falta, y el pedido en el portal (entrega 5) leen este pedido.
- La venta de mostrador sin ficha (entrega 6) es otra cosa: no encarga nada.
- Lo que se mide para montar en cada óptica (alturas, distancia al vértice, ángulo pantoscópico) se confirma con la primera óptica real; hoy son las alturas de cada ojo.

## Referencias

`packages/db/src/schema/orders.ts`, `packages/db/drizzle/0072_pedidos.sql`, `packages/services/src/job-orders.ts`, `packages/services/src/optical/demo-orders.ts`, `packages/services/src/inventory.ts` (lo de la etiqueta), `apps/api/src/routes/orders.ts`, `packages/auth/src/permissions.ts` (`PRODUCT_ROLES`, `orders`, `clinical.prescription`), `packages/auth/src/index.ts` (`requireProductRole`).
