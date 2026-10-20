# 0067 · Inventario por sede, con unidades de compra y de uso, materiales por servicio y venta desde Caja

Fecha: 2026-10-19 · Estado: aceptada · Lienzo «Inventario odentIA» (22 tableros), issues 144 y 44 (primera parte)

## Problema

Inventario era una isla que nadie podía usar a diario:

- Lo que había era de toda la clínica: una sede sin resina no se veía.
- La unidad era texto libre («caja x 100») sin conversión. No se podía descontar «2 guantes» de una caja.
- El consumo se registraba a mano, pegando el identificador del paciente.
- El saldo de un lote no podía bajar de cero: un descuento automático habría bloqueado la atención o perdido el consumo.
- Lo que se vendía (cepillos, enjuagues) se cobraba como texto libre y no salía del inventario.

## Decisión y motivo

- **Por sede.** Cada sede nace con su almacén principal (un disparador de la base lo crea). Lo que hay se lee por sede, y el mínimo es de cada sede (`product_minimum`). Las atenciones y las ventas salen del almacén principal de su sede.
- **Dos unidades.** `product.unit` es la unidad de uso: todo lo que hay, los mínimos, los descuentos y las ventas se cuentan en ella, en enteros. La compra se escribe en su unidad de compra (`purchase_unit`, `purchase_factor`). La línea copia el factor, así cambiar el producto no reescribe lo pedido. El código internacional va detrás (UN/CEFACT Rec 20 para lo que se cuenta, UCUM para lo que se mide). Lo que no tiene código queda como unidad con su nombre.
- **Faltante en vez de saldo negativo.** El lote sigue sin bajar de cero. Lo que se usó o se vendió sin haber queda en `stock_shortage`, por producto y almacén, y lo que hay es lotes menos faltante. Lo que entra cubre primero el faltante, con dos filas `cobertura`. Así el ingreso queda entero en su lote, con su compra y su costo.
- **Una sola puerta para mover saldos.** `inventory-stock.ts` hace todos los movimientos: lote que vence primero, faltante, devolución, conteo e ingreso. La usan Inventario, el cierre de la atención y «Cobrar». Lo que sale solo (uso, traslado, atención y venta) no toma lotes vencidos según el día de la clínica: si solo queda lo vencido, queda faltante y lo vencido se da de baja aparte.
- **Materiales por servicio.** Se descuentan solos al cerrar la atención (`service_material` × cantidad del acto) en la sede de la atención, enlazados a la atención y al paciente. La atención nunca se bloquea. Se corrige con un ajuste enlazado; lo firmado no cambia.
- **Se usa, se vende o las dos.** Dos casillas en lugar de un tipo excluyente. Lo que se vende tiene precio de venta.
  - En «Cobrar», «Agregar producto» crea el concepto con su producto y descuenta de la sede al crearlo.
  - Anular el concepto lo devuelve. Anular el ticket que lo pagó también: deshace la venta (ADR 0068). Si el paciente lo devuelve otro día, se usa «Devolver».
  - Cada «Agregar producto» lleva su clave (`patient_charge.request_key`): si se corta la red y se reintenta, no se vende dos veces.
- **Recepción entra sin precios.** Tiene `inventory.stock` (ver sin precios) e `inventory.receive` (registrar lo que llegó y el uso fuera de una atención). Pedir, contar, ajustar y fijar precios siguen siendo de quien tiene `inventory.write`. A quien no ve precios, la API no los entrega.

## Alternativas descartadas

- *Permitir lotes negativos:* la base perdería su protección y el costo de lo usado quedaría sin dueño.
- *Descontar en la unidad de compra:* «0.02 cajas» no es entero ni se entiende.
- *Elegir el lote en cada atención:* nadie lo haría; el que vence primero es la regla de la clínica.
- *Una lista sugerida de materiales por servicio:* cada clínica usa marcas y cantidades distintas. Se empieza por los servicios más hechos y con «Copiar de otro servicio».

## Consecuencias

- La rentabilidad (#143) y las comisiones con materiales (#146) pueden leer el costo de lo usado: el lote o la cobertura dicen de qué compra salió.
- La campana deja de avisar stock bajo. Lo que hace falta y lo vencido es una fila de «Te espera» por sede.
- Quedan fuera: código de barras (GTIN), UDI de implantes, vender a quien no es paciente y costo por lote para la rentabilidad.

## Referencias

- `packages/services/src/inventory-stock.ts`, `inventory.ts`, `service-materials.ts`; `packages/clinical/src/inventory-units.ts`.
- Migraciones `0037_inventario_por_sede_unidades_materiales_y_venta`, `0038_inventario_por_sede_reglas`, `0039_producto_sin_tipo_ni_minimo_unico` y `0040_venta_sin_duplicar`.
