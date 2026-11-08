# 0157 · Lo que debe el profesional se cierra: devuelto o saldado

Fecha: 2026-11-08 · Estado: aceptada · Decisión del dueño del 8 nov, después de la tercera vuelta de QA de comisiones. Resuelve el pendiente «cobrarle al médico lo que debe o darlo por saldado» de ADR 0155.

## Problema

Si un cobro se anula o se devuelve después de pagada su comisión, el profesional le debe esa parte a la clínica. Hasta aquí solo se descontaba de su próximo pago en esa moneda. Si ya no trabaja en la clínica o no tiene cobros nuevos, la deuda quedaba para siempre en Finanzas, en «Mis comisiones» y en Reportes, aunque la hubiera devuelto en mano.

## Decisión y motivo

- **Dos salidas, por moneda, en el detalle del profesional:** «Registrar que lo devolvió» (con su medio: efectivo, transferencia o tarjeta, UN/CEFACT 4461 `10`, `30`, `48`) y «Darlo por saldado» (la clínica lo perdona, con un motivo corto obligatorio, sin mover dinero). Las dos cierran toda la deuda de esa moneda; no hay devolución parcial: lo parcial ya lo hace el descuento.
- **Es una liquidación de su tipo** (`commission_settlement.kind`: `pago`, `devuelto`, `saldado`) con una línea `ajuste` por cobro anulado. Todas las cuentas ya restaban los ajustes (`monthView`, `pendingCommissionAdjustments`, `pendingAdjustmentsValued`, `commissionsOwedMany`), así que la deuda queda en cero en Finanzas, «Mis comisiones» y Reportes a la vez, sin otra cuenta. Se anula como un pago, con su motivo, y la deuda vuelve.
- **En efectivo entra a la caja** de la sede como un `gasto` de entrada, «Devolución de comisiones», sin el nombre del profesional (caja no ve a quién se le paga cada comisión, como el pago desde la caja). El cierre lo resta de los gastos, como la compensación de un gasto anulado, y no se anula en Caja: se anula desde Comisiones, que lo saca de la caja (o compensa en la de hoy si ya cerró). Por transferencia o tarjeta no toca la caja, como pagar la comisión por transferencia.
- **Quién y cuándo** quedan en la liquidación (`settled_by`, `settled_at`), el motivo en `notes` y la acción en la auditoría (`finance.commission_debt_returned`, `finance.commission_debt_forgiven`). La base exige el medio solo en lo devuelto, la caja solo en efectivo, el motivo en lo saldado y ningún gasto en los dos.
- **Permiso:** el de administrar comisiones (`commissions.write`), en el servidor; que entre a la caja pide además `finance.write`, como sacar de ella el pago.

## Alternativas descartadas

- **Una tabla aparte para la deuda:** cada cuenta tendría que restar también esa tabla; olvidar una dejaría la deuda viva en algún lado.
- **Un ingreso suelto de caja (`aporte`):** caja podría anularlo sin tocar la deuda, y el arqueo lo contaría como un fondo.
- **Un gasto negativo:** los gastos no admiten importes negativos y Gastos lo mostraría como un pago.

## Consecuencias

- «Ya pagado» y lo pagado de Reportes siguen siendo el dinero que salió en pagos: lo devuelto entra a la caja, pero no baja lo pagado del mes en que se pagó.
- Lo perdonado no resta de «Lo que deja»: esa cifra usa la comisión generada, y la deuda no lo era. Queda pendiente decidir si debe contar como un gasto de la clínica.
- Quitar la segunda moneda sigue sin pedir que la deuda en esa moneda esté cerrada (ADR 0155); ahora se podría pedir.

## Referencias

- `packages/db/drizzle/0063_deuda_del_profesional.sql`
- `packages/services/src/finance.ts` (`settleCommissionDebt`, `voidCommissionSettlement`, `monthView`)
- `packages/services/src/finance-commission-debt.test.ts`
