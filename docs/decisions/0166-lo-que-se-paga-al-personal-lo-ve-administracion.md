# 0166 · Lo que se le paga al personal lo ve quien administra comisiones

Fecha: 2026-11-09 · Estado: aceptada · QA de Gastos del 8 nov (S1). Sustituye en el ADR 0150 la frase «Caja lo ve con el nombre, porque lo paga».

## Problema

El ADR 0150 dejó que caja viera cada sueldo con el nombre de la persona «porque lo paga». En la demo, los nueve sueldos se pagan fuera de la caja, así que ese motivo no se cumple. Además, el PR 486 ya había decidido que lo que cobra de comisión cada profesional solo lo ve quien administra comisiones, y al día siguiente caja veía el sueldo de esa misma persona. En el Perú, los ingresos son un dato sensible (Ley 29733, art. 2, num. 5), y el principio de proporcionalidad (art. 7) pide mostrar solo lo necesario. El nombre tampoco va siempre en la persona de la plantilla: puede ir en el concepto («Sueldo de Rosa»).

## Decisión y motivo

- **El tipo «Personal» entero** (con persona o sin ella, plantilla o gasto suelto) lo ven con detalle, lo anotan, lo pagan, lo cambian y lo anulan solo quienes tienen `commissions.write`. Es la misma regla de las comisiones, y el tipo es lo único que no depende de cómo se escribió el concepto.
- **Los demás ven el total, sin a quién.** En «Por pagar» y «Lo que se repite» ven una fila «Sueldos» por mes y moneda, sin botón. En la lista del mes ven «Pago de sueldos» por sede y moneda, y en Caja el movimiento se lee «Pago de sueldo». Todo sigue sumando en «Gastado» y en «Lo fijo».
- **Lo frena el servidor**, no solo la pantalla: la lectura agrupa y cada escritura responde 403.

## Alternativas descartadas

- **Ocultar solo las plantillas con persona:** deja a la vista «Sueldo de Rosa» anotado sin persona.
- **Que caja pague el sueldo que sale del efectivo, con el nombre ese día:** devuelve el dato a quien no administra los pagos, por un caso que administración resuelve registrándolo desde la caja abierta.
- **Ocultar también el total:** «Gastado» y «Lo fijo» dejarían de cuadrar para caja. Con una sola persona en planilla, el total es su sueldo; es el mismo límite que ya tiene «Pago de comisiones».

## Consecuencias

- Caja ya no paga sueldos: lo hace propietaria o administración, aunque salga del efectivo de la caja.
- Una clínica con un solo sueldo deja ver ese importe en el total. Si una clínica real lo pide, se revisa junto con las comisiones.

## Referencias

- `packages/services/src/expense-recurring.ts` (`PayViewer`, `groupSalaries`), `finance.ts` (`salaryPaymentsOf`, `withoutCommissionNames`), `apps/api/src/routes/finance.ts`.
- Pruebas: `packages/services/src/gastos-qa.test.ts`, `apps/api/src/routes/finance-access.test.ts`.
