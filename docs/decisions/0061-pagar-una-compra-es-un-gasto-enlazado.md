# 0061 · Pagar una compra es un gasto de Materiales enlazado a su orden

Fecha: 2026-10-18 · Estado: aceptada · Opción B del lienzo de Reportes v2 (tableros 6c y 6d, issue 113)

## Problema

Las compras de Inventario nunca llegaban a Finanzas. Una orden de compra registra un compromiso, no un pago, y el gasto de los insumos se anotaba aparte, a mano, si alguien se acordaba. Así:

- Reportes no sabía cuánto se debía a los proveedores.
- Una compra podía pagarse dos veces (una en Gastos, otra «de memoria») o ninguna.
- Los pagos en partes, los adelantos y lo pagado de más no tenían dónde quedar.

## Decisión y motivo

- **El pago de una compra es un gasto de Materiales con `expense.purchase_order_id`**, en la sede del almacén y en la moneda de la orden. La base exige que sea de Materiales y que la orden sea de la misma clínica. Lo pagado de una compra es la suma de sus gastos vigentes: no hay otro registro del pago.
- **Una sola operación** (`payPurchaseOrder` en `finance.ts`), la misma desde Inventario («Registrar pago») y desde Finanzas › Gastos («¿Es el pago de una compra?»). Se paga en partes o por adelantado; una orden en borrador o cancelada no se paga.
- **Por pagar = lo recibido por su costo − lo pagado, nunca menos de cero** (`purchase-balance.ts`). Un adelanto de lo que aún no llega no se debe: ya salió el dinero.
- **Lo pagado de más queda a favor con el proveedor** cuando la compra cierra (recibida entera, o cancelada dejando sus pagos a favor). Se usa para pagar otra compra suya con `supplier_credit_use`, que no es un gasto. Nunca se usa más de lo que hay a favor: anular el pago que lo originó exige anular antes ese uso.
- **Cancelar una compra pagada exige decidir**: anular sus pagos (el proveedor devolvió el dinero) o dejarlos a favor. Nunca quedan sueltos.
- Cada orden lleva su número sin saltos («OC-0012»), para nombrarla en el gasto y en las pantallas.

## Alternativas descartadas

- *Una tabla de pagos de compras aparte de los gastos (opción A):* dos registros del mismo dinero; Finanzas tendría que sumar ambos o se contaría dos veces.
- *Que la orden recibida cree el gasto sola:* la recepción no es el pago; se paga antes, después o en partes.
- *Neteo automático de todo lo de un proveedor:* el «por pagar» de cada orden dejaría de leerse solo.

## Consecuencias

- Reportes › Finanzas suma las compras sin pagar en «Lo que debes» y Finanzas › Gastos las avisa.
- La cascada cuenta el pago de una compra como gasto de Materiales del día en que se pagó (caja), no el día en que llegó la mercadería.
- Una orden recibida en parte no se puede «dar por cerrada» con lo que llegó: lo pagado de más sigue como adelanto hasta que llegue lo demás. Si hace falta, se agrega esa operación en Inventario.
- La descarga automática de inventario (#144), los impuestos (#145) y la rentabilidad (#143) siguen fuera.

## Referencias

- `packages/services/src/finance.ts` (`payPurchaseOrder`, `voidSupplierCreditUse`, `getPurchasesToPay`), `packages/services/src/purchase-balance.ts`, `packages/services/src/inventory.ts` (`cancelPurchaseOrder`).
- Migraciones `0017_compras_pagadas_y_horario_con_historia` y `0018_…_reglas`.
