# 0068 · Anular corrige un error al cobrar; devolver atiende al paciente

Fecha: 2026-10-19 · Estado: aceptada · Lienzo «Anular y devolver un cobro» (8 tableros)

## Problema

En un ticket había una sola acción, «Anular este cobro». Deshacía el pago y dejaba la venta en pie: el producto seguía vendido y el concepto volvía a quedar por cobrar. Servía para un error de la cajera, pero no para el caso común de una caja: el paciente vuelve otro día, devuelve algo o pide su dinero. Para eso había que anular la venta del día del cobro (que sí ocurrió), quitar el concepto y volver a cobrar el resto, y después del cierre de caja solo podía hacerlo administración.

## Decisión y motivo

Son dos operaciones distintas, como en cualquier caja, y ninguna depende de un país:

- **Anular el ticket** corrige un error al cobrar (medio, monto, paciente o producto equivocado). Deshace la venta y el pago: el dinero sale, los productos que pagó ese ticket salen de la cuenta y vuelven a su sede, y los servicios ya hechos vuelven a quedar por cobrar. El ticket queda «anulado» para siempre y no se reutiliza; cobrar bien es un cobro nuevo («Ir a Cobrar»). Hasta el cierre de caja; después, administración. Un ticket con una devolución ya no se anula.
- **Devolver** atiende al paciente cualquier día. La venta del ticket queda en pie y una devolución numerada (`payment_return`, contador propio sin saltos) la rebaja:
  - Cada concepto se anula y lo reemplaza otro con lo que queda (`original_charge_id`, `returned_cents`); su pago pasa al nuevo (`replaces_application_id`) y la aplicación anulada guarda su devolución (`return_id`). Nada se reescribe hacia atrás: los reportes que miran «lo que estaba en pie» siguen viendo el día del cobro.
  - De un producto se devuelve una cantidad. Vuelve a la sede si está en buen estado; si no, no mueve el inventario y la devolución lo dice («no volvió a la venta»).
  - De un servicio se devuelve un importe (un reclamo), sin tocar la historia clínica, y nunca más de lo que pagó ese ticket.
  - Lo devuelto queda a favor. Si se le paga en el mismo paso, sale por el medio elegido (`patient_payment_refund` con su `return_id` y el egreso de la caja de hoy); si no, se usa en su próximo cobro o con «Devolver dinero».
- **Una devolución no deja por cobrar otra vez un tratamiento:** lo cobrado de él es importe + devuelto.
- **Contablemente** la devolución es el documento que rebaja la venta y deja a la clínica debiéndole al paciente; pagarle es un movimiento de caja aparte. Es el modelo de la nota de crédito (UBL 2.1). El ticket y la devolución son documentos internos: el módulo fiscal de cada país, cuando llegue, decide su documento oficial y sus plazos.

## Alternativas descartadas

- *Una sola «Anular» con la pregunta «¿devolvió el producto?»:* mezcla un error de caja con un hecho del paciente y obliga a anular la venta de un día que sí ocurrió.
- *Restar lo devuelto en cada fórmula de saldo:* hay que tocar cada cuenta de deuda y de saldo a favor; reemplazar el concepto y su pago usa las reglas que ya existen.
- *Bajar y volver a subir lo devuelto abierto en el inventario:* si había faltante, lo cubriría con algo que no se puede vender.

## Consecuencias

- «Lo cobrado por tratamiento» cuenta el pago el día que se aplicó y resta lo devuelto el día de la devolución; la parte que pasa al concepto rebajado no vuelve a contar.
- Las comisiones siguen su regla: lo devuelto de un servicio ya pagado se descuenta del próximo pago, y lo que queda cuenta el día de la devolución.
- Queda para el módulo fiscal: la baja o la nota de crédito oficial de cada país.

## Referencias

- `packages/services/src/payments.ts` (`voidTicket`, `getTicketReturnable`, `returnFromTicket`), `inventory-stock.ts` (`returnSold`), `report-finance.ts` (`collectedByTreatment`).
- Migraciones `0041_devolver_un_cobro` y `0042_devolver_un_cobro_reglas`.
- Precisa la venta desde Caja de la ADR 0067.
