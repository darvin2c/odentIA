# 0155 · Comisión en la moneda de lo cobrado y con la regla del día de la atención

Fecha: 2026-11-08 · Estado: aceptada · Decisiones del dueño del 7 y 8 nov, después de la segunda ronda de QA de comisiones. Cambia dos puntos de ADR 0151 (la regla del día del cobro y el monto fijo en moneda del negocio) y uno de ADR 0135 (comisiones en la moneda del negocio).

## Problema

- **La moneda.** La comisión se calculaba en soles. Un implante de USD 1,000 al 30 % le daba al médico lo que valían USD 300 el día del cobro, y la cifra cambiaba con el dólar. El dueño: «si se cobra en dólares la comisión es en dólares».
- **La regla.** Con la regla del día del cobro, una corona pagada en dos cuotas, con un cambio de regla entre ambas, se pagaba con una mezcla de las dos: 120 + 300 = 420, cuando el acuerdo era 300 o 500.
- **El monto fijo sin tope.** Un servicio de S/ 80 con un monto fijo de S/ 100 pagaba S/ 100.
- **El cobro adelantado.** Un cargo desde una línea de presupuesto no tiene procedimiento, y su comisión no era de nadie.
- **Dinero que no se veía.** Lo que el médico le debe a la clínica, si no tiene cobros nuevos, y lo cobrado de sesiones que nadie hizo no aparecían en ninguna pantalla.

## Decisión y motivo

- **La comisión va en la moneda del precio del cargo.** Un cobro cancela una sola moneda (la del cargo), así que se calcula sobre lo aplicado, sin convertir. Se mira y se paga cada moneda aparte: su liquidación (`commission_settlement.currency`), su gasto, que guarda su valor en la moneda del negocio con el cambio de hoy, como cualquier gasto, y su caja. Un descuento solo baja lo de su moneda. La clínica de una sola moneda no ve nada nuevo.
- **Reportes y Argos siguen en la moneda del negocio** (ADR 0135: `sum()` no debe mezclar). Lo de otra moneda se valora con el cambio de su pago: `commission` en `commission_live` y lo congelado con `org_money_value`. Las columnas nuevas de la vista (`currency`, `own_value`, `own_commission`) son las de Finanzas.
- **El monto fijo va en la moneda del precio del servicio** (`commission_rate.fixed_currency`; nulo en lo de antes, que era del negocio). Si el servicio cambia de moneda, el monto no se convierte: la línea queda sin regla, no se congela al pagar y la pantalla pide escribirlo de nuevo. Se gana entero aunque haya descuento, en proporción a lo pagado y nunca más de lo cobrado de su línea. Si el servicio se cobra por sesión, cada visita es su cargo y lo gana entero.
- **La regla es la del día de la atención.** Un tratamiento de varias sesiones usa la del día de cada sesión. Todas las cuotas de lo mismo usan la misma regla, y una devolución ya no necesita buscar el cobro original. El mes en que cuenta sigue siendo el del cobro.
- **Lo adelantado es de quien haga cada sesión.** El cargo desde una línea de presupuesto de un tratamiento congela sus sesiones previstas (puede ser 1, por eso `commission_sessions` admite 1). Un servicio que se cobra por sesión no: firmar cada visita genera su propio cargo, que es el que comisiona, y darle comisión también al adelanto la pagaría dos veces. Lo creado antes no tenía sesiones y sigue fuera: no reabre meses ya pagados. (Precisado por ADR 0159: ese cargo de un servicio por sesión ya no se crea, porque firmar la visita lo cargaba otra vez.)
- **Un monto corregido vale hacia atrás solo para lo que se quedó sin regla.** Si el monto que valía el día de la atención está en otra moneda, vale la versión que se escribió después para corregirlo; si no, esa línea quedaría sin poder pagarse nunca.
- **Lo que no tenía lugar, a la vista:**
  - La fila del profesional dice cuánto queda «por descontar del próximo pago» en esa moneda, y se descuenta solo.
  - La lista del mes dice lo cobrado de sesiones que aún nadie hace, y aparte lo de tratamientos cancelados, que no es comisión de nadie (`unassignedCommissionSessions`).
- No se puede quitar la segunda moneda mientras queden comisiones sin pagar en ella. Lo que el profesional debe en esa moneda no lo impide, porque hoy no hay cómo saldarlo a mano (pendiente; desde ADR 0157 se puede cerrar a mano, y pedirlo aquí sigue pendiente).

## Alternativas descartadas

- **Pagar en la moneda en que pagó el paciente:** la comisión dependería de cómo pagó cada uno. El dueño eligió la del precio.
- **Convertir con el cambio del día del pago al médico:** sigue moviendo la cifra con el dólar, que es lo que el dueño no quiere.
- **Un monto fijo general, igual para todo servicio:** no tiene sentido entre servicios de precios muy distintos; el monto va por servicio.
- **Columnas en otra moneda en `argos.comisiones`:** cambia lo que lee Argos y pide medirlo. Queda pendiente.

## Consecuencias

- Las líneas aún sin pagar de atenciones anteriores a un cambio de regla pasan a la regla de su atención. Como las versiones existen desde el 7 de noviembre, es poco.
- Pagar en dólares con el efectivo de la caja de soles no se puede: si no hay dólares en la caja, se paga por transferencia.
- Quedan pendientes:
  - cobrarle al médico lo que debe o darlo por saldado (resuelto en ADR 0157);
  - un ajuste a mano con motivo, para un trabajo rehecho o un bono;
  - decidir si se llama «honorarios»;
  - la retención del 8 %.

## Referencias

- `packages/db/drizzle/0059_comision_en_su_moneda.sql`, `0060_comision_en_su_moneda_reglas.sql`
- `packages/services/src/finance.ts` (`getMonthlyCommissions`, `payMonthCommission`, `setCommissionException`, `unassignedCommissionSessions`), `report-finance.ts` (`commissionLinesSql`, `commissionsOwedByMonth`), `payments.ts` (`createCharge`)
- `packages/services/src/finance-commission-currency.test.ts`
