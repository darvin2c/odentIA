# 0151 · Comisión por servicio, desde el cambio y por sesión

Fecha: 2026-11-07 · Estado: aceptada · Ronda de QA de comisiones y gastos fijos, entrega 7 (decisiones aprobadas el 6 y 7 nov). Cambia la «tasa única por profesional» de ADR 0018.

## Problema

Cada profesional tenía un solo porcentaje, y cambiarlo reescribía todo lo aún no pagado. Muchas clínicas pagan distinto por servicio (otro porcentaje o un monto fijo por cada corona). En un tratamiento de varias sesiones con dos profesionales, toda la comisión iba a quien hizo la primera sesión, porque el cargo es de todo el tratamiento. Y la misma cuenta estaba escrita tres veces (Finanzas, Reportes y la vista de Argos), que ya se habían separado.

## Decisión y motivo

- **La base sigue siendo lo cobrado, con el impuesto incluido** (decidido por el usuario: «para no tener líos»). El costo de laboratorio queda fuera por ahora.
- **Versiones, no ediciones.** `commission_rate` guarda cada cambio como una fila que vale para lo cobrado desde ese momento. Cada cobro usa la regla vigente el día en que se cobró: lo cobrado antes conserva la suya y anular un pago devuelve sus cobros con su regla, no con la de hoy. La primera versión de alguien vale desde siempre, para que fijarla tarde no deje en cero lo ya cobrado. La auditoría guarda antes y después, y se le avisa al profesional.
- **Excepción por servicio:** otro porcentaje, o un monto fijo por cada procedimiento (en moneda del negocio, por la cantidad), que se gana en proporción a lo cobrado del cargo. Quitarla es una versión sin ninguno de los dos.
- **Por sesión, partes iguales.** El cargo de un tratamiento congela en `commission_sessions` sus sesiones previstas. Cada cobro se reparte en esas partes; la parte k es de quien hizo la sesión k y cuenta el día en que existen el cobro y la sesión. Mientras la sesión no se hace, su parte no es de nadie; si el tratamiento queda realizado con menos sesiones, lo que sobra es de la última. Congelar N evita que editar las sesiones previstas reescriba lo pagado.
- **Una sola cuenta:** la vista `commission_live` da lo aún sin pagar a Finanzas, Reportes y `argos.comisiones`. Es de `argos_dueno` (sin BYPASSRLS), así que ve solo la clínica de la sesión; con `security_invoker` las llaves de Argos no podrían leerla.
- **Lo pagado se congela por parte** (`slice`, `sessions`, el monto fijo y si fue una excepción). Una línea pagada sin parte, de antes, cubre el cobro entero: nunca se paga dos veces.

## Alternativas descartadas

- **Base sin IGV y restando laboratorio:** aprobada al principio y retirada por el usuario; complica la explicación de cada línea.
- **Peso distinto por sesión:** no hay dato y obligaría a pedirlo en cada tratamiento.
- **Cambios con fecha futura o hacia atrás, botón «Recalcular»:** con cambios solo hacia adelante nada se reescribe.
- **Una función SQL en vez de vista:** las llaves de Argos solo leen vistas.

## Consecuencias

- `commission_rule` deja de leerse y escribirse; se borra en una entrega aparte, ya desplegada esta.
- «Lo cobrado por profesional» de Reportes sigue dando el cobro a quien abrió el tratamiento; solo la comisión se reparte por sesión.
- La retención del 8 % (recibo por honorarios) sigue pendiente como asunto legal.

## Referencias

- `packages/db/drizzle/0056_comision_por_servicio.sql`, `0057_comision_por_servicio_reglas.sql`
- `packages/services/src/finance.ts` (`setCommissionRate`, `setCommissionException`, `getMonthlyCommissions`), `report-finance.ts` (`commissionLinesSql`)
- `packages/services/src/finance-commission-rules.test.ts`
