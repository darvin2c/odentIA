# 0150 · Gastos que se repiten

Fecha: 2026-11-07 · Estado: aceptada · Ronda de QA de comisiones y gastos fijos, entrega 8 (lienzo aprobado el 7 nov).

## Problema

El alquiler, los sueldos y los servicios se anotaban a mano cada mes, desde cero. Lo único que ayudaba era el aviso «Puede faltar un gasto» de Reportes, que caja no ve, mira el tipo y no cada gasto (con dos sueldos, anotar uno apaga el aviso del otro) y nunca avisa de lo semestral, como la gratificación. Ninguna pantalla decía cuánto cuesta mantener la clínica al mes.

## Decisión y motivo

- **Una plantilla, no un gasto que se registra solo.** `expense_recurring` guarda lo que se repite (sede, tipo, concepto, importe, cada 1, 6 o 12 meses, el día, la persona si es un sueldo). Lo por pagar de cada mes se calcula al leer, sin trabajo de fondo; pagar es crear el gasto con `recurring_id` y `recurring_month`. Así nunca se registra dinero que nadie pagó.
- **Un mes se paga una sola vez.** Un índice único parcial (plantilla y mes, gasto vigente) y el bloqueo de la plantilla frenan el doble toque o dos cajas a la vez; el segundo recibe quién y cuándo lo pagó. Anular ese gasto lo deja otra vez por pagar. «No hubo este mes» es una fila propia (`expense_recurring_skip`) que se puede deshacer.
- **Se guarda el día, no la fecha:** el 31 vence el último día de un mes más corto sin correrse para siempre.
- **El importe que se propone es el último que se pagó.** «Pagar» abre el cajón del gasto ya lleno con ese importe y el medio de siempre, y ahí se cambia lo que cambió (ADR 0167, que sustituye «pagar es un toque» y «Pagar otro importe»). Lo que se repite se anota en su sección, no al registrar un gasto.
- **Lo fijo del mes cuenta lo que sale ese mes:** lo de cada 6 meses o cada año pesa entero en su mes, no se reparte (decidido por el usuario).
- **El sueldo es un gasto que se repite con la persona.** Se paga en Gastos y se ve junto a su comisión en el detalle de Comisiones y en «Mis comisiones» (solo el propio). Cuenta el mes de la ocurrencia: el sueldo de octubre pagado el 2 de noviembre es de octubre. Lo ve con detalle y lo paga quien administra comisiones; los demás ven «Sueldos» sin nombres (ADR 0166, que sustituye «Caja lo ve con el nombre, porque lo paga»).
- **El aviso «Puede faltar un gasto» queda de respaldo** para la sede y el tipo sin plantilla; lo vencido sin pagar entra en «Lo que debes» de Reportes.
- **Dejar de repetir vale desde el mes que viene** (QA de Gastos del 8 nov, G3): lo vencido y lo de este mes siguen por pagar; si este mes no hubo, se marca «No hubo este mes».

## Alternativas descartadas

- **Registrar el gasto solo en su día** (la «programada» de QuickBooks): registraría dinero que nadie pagó.
- **Repartir lo semestral en cada mes:** no cuadra con lo que sale de la caja.
- **Planilla con descuentos de ley, recordatorios por correo, otros intervalos:** fuera; la planilla legal es del contador.

## Consecuencias

- Las tablas nacen cerradas (ADR 0063), con RLS y sin GRANT a Argos: ninguna vista las lee todavía.
- Cambiar cada cuánto, la moneda, el tipo o la sede es dejar de repetir una plantilla y crear otra; lo demás se cambia y vale desde el próximo pago.

## Referencias

- `packages/services/src/expense-recurring.ts`, `expense-recurring-occurrences.ts`; migraciones `0054_gastos_que_se_repiten`, `0055_gastos_que_se_repiten_reglas`.
- Lienzo: https://claude.ai/artifact/UE3Bq7iviTyeEprJDsR9BF
