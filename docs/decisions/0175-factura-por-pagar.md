# 0175. La factura por pagar: el papel aparte, sus pagos enlazados

- Estado: aceptada (9 nov 2026)
- Contexto: QA de Gastos del 8 nov (G20, G21, P-ODO-24, caso C10b) y lienzo «Gastos: lo que falta» (opción A).

## Contexto

La factura de la corona del laboratorio llega hoy y se paga a fin de mes, a veces en partes. Hasta ahora solo se podía anotar el gasto el día del pago: nadie sabía cuánto se le debía al laboratorio, y nada unía ese costo a la paciente ni a su tratamiento.

## Decisión

- **Una tabla aparte, `expense_payable`.** Guarda el papel: a quién se le debe y su RUC, el comprobante del país con su número, la fecha de emisión, el vencimiento, la moneda y el importe. Anotarla no paga, no toca la caja y no suma en «Gastado».
- **Cada pago es un gasto enlazado (`expense.payable_id`),** como el pago de una compra (ADR 0061). Lo pagado es la suma de sus gastos vigentes, sin otro registro. El pago va en la sede, el tipo y la moneda de su factura y nunca pasa de lo que falta; el servidor bloquea la factura mientras paga. Anular un pago la deja otra vez por pagar, y corregirlo (ADR 0167) lo deja en la misma factura.
- **De qué paciente y de qué tratamiento** (`patient_id`, `plan_item_id`, opcionales): se ata al tratamiento y no a la orden de laboratorio.
  - Caja no ve las órdenes clínicas.
  - La orden no guarda la pieza ni el costo.
  - En latidIA, una orden de laboratorio es un análisis.

  Dentalink lo ata a la prestación del plan del paciente.
- **Quién ve qué.**
  - Anotar, pagar, corregir (sin pagos) y anular la factura: `finance.write`, como un gasto. Caja ve de qué paciente y tratamiento es la factura, porque la paga y ya ve a los pacientes; no ve el margen.
  - El costo junto a lo cobrado del tratamiento, en la cuenta de la paciente: solo `commissions.write`.
  - Una historia bloqueada (ADR 0080) no dice de quién es la factura.
- **No se borra.** Se anula con su motivo y solo sin pagos vigentes; la base solo deja cambiar la anulación.
- **Dónde se ve.**
  - En Gastos › Por pagar, antes de lo que se repite, con su vencimiento.
  - En Reportes › Lo que debes, como «Facturas por pagar».
  - En la descarga del mes van sus pagos, que son gastos. Lo emitido y aún no pagado no va: la descarga es de lo pagado (pendiente: una lista de facturas recibidas para el registro de compras).

## Alternativas descartadas

- **Un estado «por pagar» dentro del gasto.** Un gasto es dinero que ya salió: cada total (Gastado, Caja, Reportes, Argos, la descarga) tendría que filtrar ese estado.
- **Lo que se repite, usado una sola vez.** Mezclaría una factura en «Lo que se repite» del mes y solo admite un pago por mes.
- **Las compras de Inventario.** Exigen un producto, un almacén y recibir existencias, y caja no crea compras.

## Lo que queda fuera

- **La comisión no resta el laboratorio** (ADR 0151). Dentalink deja elegirlo en el contrato de cada odontólogo; si se quiere, va en el acuerdo de comisión.
- **Retenciones, RRHH y planillas:** el usuario las dejó para después.
- **Argos no lee lo por pagar.** Lo dice como algo que no puede consultar y señala dónde verlo.
