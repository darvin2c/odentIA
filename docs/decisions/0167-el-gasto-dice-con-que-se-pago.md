# 0167 · El gasto dice con qué se pagó, y se paga, corrige y anota sin atajos

Fecha: 2026-11-09 · Estado: aceptada · QA de Gastos del 8 nov, decisiones 1 a 5 (aprobadas por el usuario). Sustituye en el ADR 0150 «pagar es un toque» y «Pagar otro importe».

## Problema

El gasto no guardaba con qué se pagó: solo si salió de la caja (`shift_id`). Para cubrir eso, «Registrar gasto» tenía una casilla de caja marcada para todo. Los sueldos, el alquiler o la luz, que no salen del cajón, chocaban con la caja, y cada ronda de QA agregó un texto para explicarlo, hasta tres avisos con consejos opuestos. Además:

- «Pagar» registraba al instante, con el importe y el medio de siempre, sin mostrarlos.
- Un error de importe obligaba a anular y escribir todo otra vez.
- «Se repite» metía seis decisiones dentro del cajón de un gasto ya pagado.
- El comprobante era texto libre, sin tipo ni RUC: el contador no podía usar el crédito fiscal del IGV.

## Decisión y motivo

- **Con qué se pagó:** el gasto guarda el medio de la clínica (los mismos de Cobrar), con su nombre y su tipo UN/CEFACT 4461 congelados y el n.º de operación. Solo el efectivo (10) sale de la caja. La caja va en una línea: cuánto queda o cuánto falta, con «Ingresar». El freno del servidor no cambia.
- **«Pagar» abre el cajón ya lleno:** el importe de siempre (editable), el medio de siempre y el comprobante. Es un toque más, pero se ve qué se paga antes de mover dinero. «Pagar otro importe» ya no existe.
- **Corregir:** en una sola transacción, `correctExpense` anula el original con un motivo que escribe el sistema («Corregido: S/ 24.00 → S/ 42.00») y registra el nuevo, enlazado (`replaces_expense_id`, único). Nada se borra (ADR 0018), y la caja devuelve lo que salió y saca lo nuevo. Sigue la regla de la caja cerrada de anular. El pago de una compra o de una comisión se corrige en su lugar.
- **«Anotar lo que se repite»** tiene su sección y su operación (`noteRecurringExpense`). Anotar no paga: queda por pagar desde el primer mes cuyo día aún no pasó.
- **Comprobante del país:** en el Perú, la tabla 10 de SUNAT (01, 02, 03, 12 y 14), más «Sin comprobante». Va en `receipt_type`, y `receipt_kind` guarda su nombre. Otro país sin su tabla cargada usa los papeles de siempre, sin código inventado. **Proveedor:** uno de Inventario (`supplier_id`) o uno escrito, con su nombre y su documento congelados. Caja los lee por Finanzas, sin ver Inventario.

## Alternativas descartadas

- **Pago mixto en líneas, como un cobro:** pide otra tabla y cambiar anular, corregir, compras y comisiones por un caso que nadie mostró. Se anotan dos gastos con el mismo comprobante.
- **Que corregir mueva la caja solo por la diferencia:** rompe «un gasto, un movimiento», y anular después devolvería solo la diferencia. Anular y registrar ya deja en la caja la diferencia.
- **Editar el gasto en su lugar:** la base lo impide (`expense_immutable`), y un contador necesita ver el original.
- **Unir un gasto suelto a una compra al pagarla:** otra operación de dinero, con falsos positivos. Queda el aviso (QA, G4).

## Consecuencias

- Lo registrado antes no tiene medio: dice «Efectivo de la caja» u «Otro medio». No se rellena.
- El pago de comisiones sigue con su casilla. Pasará por el medio cuando se rehaga su cajón, porque otro trabajo lo está cambiando.
- `from_cash` de la plantilla sigue escrito, de acuerdo con el medio, para lo que aún lo lee.

## Referencias

- `packages/services/src/finance.ts` (`createExpense`, `correctExpense`, `listExpenseSuppliers`), `expense-recurring.ts` (`noteRecurringExpense`), `packages/clinical/src/expense-receipts.ts`.
- Migraciones `0073_gasto_con_medio_y_comprobante` y `0074_gasto_con_medio_reglas`.
- Pruebas: `packages/services/src/gastos-rediseno.test.ts`.
- Lienzo de la QA: https://claude.ai/artifact/UdxEE5j3zqnH2F86igQ9sN
