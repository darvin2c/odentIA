# 0134 · Cobrar en dos monedas

Fecha: 2026-11-02 · Estado: aceptada · Cambia [0071](0071-metas-descargar-y-el-resumen-del-lunes.md) («lo cobrado nunca se compara con otra moneda») y precisa [0083](0083-el-impuesto-de-lo-que-cobra-la-clinica.md)

## Problema

Muchas clínicas cobran ciertos servicios en dólares porque sus insumos cuestan en dólares: un implante vale USD 1,000 aunque se pague en soles, y si el dólar sube, lo que se debe no pierde valor. odentIA guardaba varias monedas en sus filas, pero no sabía cobrar una con la otra y, en Reportes, lo que no estaba en la moneda de la clínica quedaba aparte. Hacía falta eso sin tocar a la clínica que trabaja con una sola.

## Decisión y motivo

- **Un servicio en dólares se debe en dólares hasta que se paga.** Lo que cambia con el tiempo es cuánto vale, nunca cuánto se debe. Dos monedas como máximo: la del negocio y otra (`org_profile.second_currency`). Sin otra, todo es como antes: ni un control nuevo ni otra cifra.
- **Un «Cambio de hoy», una sola operación que lo escribe** (`setOrgExchangeRate`): la usan quien configura y quien cobra. Es una propuesta: cada cobro guarda el suyo y lo que se cambia en un cobro vale solo para él. Muy distinto, avisa y nunca frena.
- **Cuatro datos en cada pago y cada gasto:** lo que cancela (`amount_cents`, `currency`, los de siempre); lo que entró o salió en otra moneda (`tender_cents`, `tender_currency`, solo si es otra); el cambio usado (`exchange_rate`) y cuánto vale en moneda del negocio (`business_cents`). Vacío es «sin otra moneda»: no hay nada que rellenar en lo viejo.
- **El valor se congela al cobrar.** Lo que ya pasó no se mueve cuando cambia el cambio de hoy: Reportes, comisiones y metas leen ese valor. Lo que aún se debe se dice por moneda, con un total aproximado al cambio de hoy.
- **Una sola cuenta del valor, `money_value`** (SQL), con su espejo en `moneyValue` de `@odentia/clinical`: parte × valor ÷ importe, sin redondear fila por fila. Sin valor ni cambio, el importe en otra moneda es nulo y no entra en las sumas: es lo que ya pasaba al filtrar por moneda. Reportes y Argos usan la misma, y las columnas de dinero de Argos van en moneda del negocio, para que `sum()` no pueda mezclar.
- **Un cobro cancela una moneda y entra en una.** Parte y parte son dos cobros, cada uno con su ticket: así el cambio de cada uno queda a la vista. Lo que está en moneda del negocio es exacto; hay una sola conversión por cobro y lo que queda a una unidad menor o menos de lo que se debe, cancela lo que se debe.
- **El vuelto en la otra moneda es un movimiento propio.** Billete de USD 100 por S/ 300 a 3.75: cancelan USD 80, y además entran USD 20 a la caja de dólares y salen S/ 75 de la de soles. Cada moneda tiene su caja, su arqueo y su cierre. Devolver saca lo que entró, en esa moneda y en proporción, sin cambio nuevo.
- **Un presupuesto, con líneas en cada moneda y un total por moneda.** Sigue siendo una sola respuesta de la persona ([0034](0034-un-plan-una-seccion.md)). Un servicio tiene un solo precio y cambiar su moneda obliga a escribirlo de nuevo.
- **Sofi dice el precio en su moneda y lo aproximado como aproximado:** «USD 1,000 (hoy, unos S/ 3,750)». Nunca promete ese cambio para un pago futuro. En esas clínicas la comprobación antes de enviar mira también la moneda y no suma entre monedas; en una clínica de una moneda mira lo mismo de siempre.
- **El impuesto (precisa 0083):** el de un pago en otra moneda queda en esa moneda y se valora con `money_value`; «Lo que debes» y el pago del impuesto de lo cobrado van solo en moneda del negocio. Las comisiones son sobre el valor; lo ya liquidado no se toca.

## Alternativas descartadas

- **Todo en soles, con el dólar solo como referencia:** es lo que no sirve a estas clínicas. Si el dólar sube mientras se paga, la clínica pierde lo que el servicio le costó en dólares. La rechazó el dueño del producto.
- **Un precio en cada moneda por servicio:** dos números que mantener y que se desalinean, y otra decisión en cada cobro.
- **Una tabla de tipos de cambio por día:** ningún cobro usa exactamente el del día (cada clínica cambia a su precio y ese precio queda en el ticket), y lo que ya pasó no la necesita porque guarda su valor.
- **Mezclar monedas en un cobro:** el cambio de cada parte y su devolución dejarían de leerse.

## Consecuencias

- **Fuera por ahora:** cambiar dólares en caja como una operación (hasta entonces, un retiro y un ingreso); traer el cambio oficial solo; dos cambios (compra y venta); ganancia o pérdida de cambio (Reportes cuenta por caja y la pantalla lo dice); costo real por atención; productos vendidos en dólares; factura electrónica.
- Revisar si las clínicas piden comprar y vender a precios distintos, o si un cambio por cobro resulta más trabajo que un cambio por día.
- **Legal y contable, pendiente:** no se revisó si este registro basta para declarar ni cómo se trata la diferencia de cambio en cada país. Ninguna pantalla dice que la clínica cumple con su autoridad tributaria ni reemplaza al contador; el comprobante sigue siendo un recibo interno ([0083](0083-el-impuesto-de-lo-que-cobra-la-clinica.md)).

## Referencias

- Moneda y cuentas: `packages/clinical/src/money.ts`, `packages/db/drizzle/0042_cobrar_en_dos_monedas_reglas.sql`, `packages/services/src/report-value.ts`.
- Cobro y caja: `collectCharge` (`payments.ts`), `finance.ts`. Sofi: `verify.ts`, `formatOrgMoneyToday` (`locale.ts`).
- Clínica de examen: `packages/services/src/exam-two-currencies.ts`.
