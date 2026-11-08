# 0160 · Un gasto anulado baja el mes del gasto

Fecha: 2026-11-08 · Estado: aceptada · Decisión del dueño del 8 nov, en la tercera vuelta de QA de comisiones y gastos (A10).

## Problema

Un gasto de octubre que se anula en noviembre daba dos cifras para octubre:

- Finanzas › Gastos (`getMonthExpenses`) no lo suma: octubre baja.
- Reportes › Finanzas (`expensesMany`) lo dejaba en octubre y lo restaba en noviembre, como una anulación del tramo, aunque su comentario decía seguir la regla de Finanzas. El detalle de la barra lo explicaba: «se anularon más gastos de periodos anteriores de los que se registraron: suma a lo que deja».

Lo mismo pasaba con «Lo que deja», con la cifra «Lo gastado» que responde Argos y con el pago de comisiones o de compras anulado después.

## Decisión y motivo

- **Anular un gasto es decir que no ocurrió.** Cuenta en el mes de su fecha mientras no esté anulado. Si se anula, deja de contar en ese mes, aunque se anule meses después, en Gastos y en Reportes por igual.
- Reportes usa la regla de Gastos y no al revés: la persona registra y anula en Gastos, y ahí ve lo que hizo. Un reporte de un mes cerrado puede cambiar si después se anula un gasto suyo. Es el dato corregido, no un error.
- La caja no cambia. Si se anula un gasto pagado de una caja ya cerrada, el efectivo vuelve a la caja del día en que se anula (ADR 0018), porque el dinero de verdad volvió ese día. Lo que cambia es el resultado del mes, no el movimiento de efectivo.
- Lo cobrado no cambia: sigue su propia regla, la de Finanzas › Caja, y no se toca aquí.

## Alternativas descartadas

- **Que Gastos siga a Reportes** (descontar en el mes de la anulación): la lista de octubre seguiría marcando el gasto como anulado y el total del mes no diría lo que la persona ve.
- **Mostrar las dos cifras:** dos «gastos de octubre» distintos obligan a explicar una regla que nadie pidió.

## Consecuencias

- Reportes › Finanzas, «Lo que deja», la cifra «Lo gastado» de Argos y sus listas dicen lo mismo que Gastos. Un tipo de gasto ya no puede quedar en negativo.
- La vista `argos.gastos` sigue la misma regla desde la migración 0068: un gasto anulado no está en ninguna fila, y su descripción en `argos-catalog.ts` lo dice.

## Referencias

- `packages/services/src/report-finance.ts` (`expensesMany`), `finance.ts` (`getMonthExpenses`)
- `packages/services/src/report-finance.test.ts`
