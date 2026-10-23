# 0083 · El impuesto de lo que cobra la clínica

Fecha: 2026-10-23 · Estado: aceptada · Issue #145. Lienzo «Impuestos: ajustes, ticket y Reportes», aprobado el 2026-10-23.

## Problema

odentIA no separaba el impuesto de lo cobrado. En el Perú una limpieza de S/ 118 son S/ 100 más S/ 18 de IGV que se le pagan a SUNAT, pero el ticket no lo decía y Reportes contaba los S/ 118 como ingreso: «Lo que deja» se veía mejor de lo que era. El impuesto no es igual en todos los países ni en todas las clínicas: en Chile y Colombia la atención no lleva IVA y los productos sí; en México la atención está exenta solo si la presta una persona física o una sociedad civil.

## Decisión y motivo

- **Lo propone el país, la clínica lo cambia solo si su contador se lo pide.** Las reglas viven en `@odentia/clinical` (`taxes.ts`), comprobadas en la norma de cada país: Perú IGV 18 % (el Apéndice II del TUO de la Ley del IGV no exonera la salud); Chile, atención exenta (DL 825, art. 12 E n.° 20) y productos 19 %; Colombia, atención excluida (Estatuto Tributario, art. 476) y productos 19 %; México pregunta cómo está constituida la clínica (Ley del IVA, art. 15 fr. XIV). Otro país no tiene impuesto que separar hasta que se cargue su norma.
- **Dos cifras y nada más:** atenciones y productos. Ningún servicio lleva su impuesto: lo que cambia en la región es la atención frente a la venta, y eso ya se sabe del concepto (`product_id`).
- **Precios con el impuesto incluido, siempre.** Así se cobra al público en la región y así lo hacen los programas dentales de la región: ningún precio cambia.
- **Cada concepto congela su impuesto al crearse** (`patient_charge.tax_category`, `tax_bps`): cambiar la tasa nunca toca lo ya cargado. La categoría es la de UN/CEFACT 5305 (`S`, `E`, `O`, `Z`), la de UBL y EN 16931, que usará la facturación del #39.
- **El impuesto de lo que entra hoy queda en cada pago** (`patient_payment.tax_cents`, repartido entre los medios; una devolución saca su parte en proporción, `patient_payment_refund.tax_cents`). Así Reportes lo cuenta con la misma regla de lo cobrado (`collectedNetMany`): pagos que siguen en pie, menos anulaciones y devoluciones. Lo pagado con saldo a favor ya lo llevó cuando entró ese dinero; un adelanto lleva el de las atenciones.
- **El ticket lo separa como una boleta:** subtotal, una línea por tasa (redondeada por línea) y total; lo que no lo lleva se dice en una línea corta. «Recibo interno. No es un documento fiscal.» queda fijo al pie: con el impuesto a la vista, el papel no debe parecer un comprobante. Lo que falta del tratamiento va aparte («Le falta pagar», con lo pagado de lo que cuesta) y solo si falta algo.
- **Reportes:** «Cobrado» sigue con el impuesto (cuadra con la caja) y dice cuánto es; «Lo que deja», sus porcentajes y las cifras oficiales de Argos se calculan sin él; «Lo que debes» suma el impuesto de lo cobrado en el periodo, que se paga el mes siguiente. No se acumula: si nadie registra el pago, sale el aviso de gasto que falta, como hoy.
- **Pagar el impuesto no es un gasto:** un gasto de «Impuestos» marcado como el de lo cobrado (`expense.sales_tax`) sale de la caja pero no resta de lo que deja, porque ese impuesto ya salió de lo cobrado.

## Alternativas descartadas

- **Un impuesto por servicio** (como Doctocliq o Clinic Cloud): una decisión por cada servicio que casi ninguna clínica necesita; la diferencia real es atención o producto.
- **Interruptor de «precios con o sin impuesto»:** al público siempre se le cobra con impuesto incluido.
- **Calcular el impuesto en Reportes desde la tasa de hoy:** reescribiría el pasado al cambiar la tasa.
- **Restar el IGV de las compras (crédito fiscal), retenciones y archivo para el contador:** llegan con la facturación del #39. «IGV por pagar» lo dice: el monto exacto lo da el contador.

## Consecuencias

- Una clínica de un país sin norma cargada ve todo como antes. Cargar un país es agregar su perfil en `taxes.ts`, comprobado en su norma.
- Los conceptos y pagos de antes de esta decisión no tienen impuesto (nulo y cero).
- La comisión se sigue calculando sobre lo cobrado; si debe ser sin impuesto lo decide el #146.
- Ninguna pantalla dice que la clínica cumple con su autoridad tributaria.

## Referencias

- Lienzo: https://claude.ai/artifact/WvXCAGLkPoRXsoYepo7ZpR
- SUNAT, Apéndice II del IGV: https://www.sunat.gob.pe/legislacion/igv/ley/apendiceII.pdf
- SII, Circular 50 de 2022: https://www.sii.cl/normativa_legislacion/circulares/2022/circu50.pdf
- DIAN, Oficio 5421 de 2020: https://normograma.dian.gov.co/dian/compilacion/docs/oficio_dian_5421_2020.htm
- PRODECON, IVA: https://www.gob.mx/cms/uploads/attachment/file/850660/Dato-3_IVA.pdf
- Peppol, UNCL 5305: https://docs.peppol.eu/poacc/billing/3.0/codelist/UNCL5305/
