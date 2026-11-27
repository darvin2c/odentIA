# 0224 · gestorIA: Sofi ofrece una sola vez, del mismo margen y a cambio de pagar en un plazo exacto

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA como odentIA», tablero 21 (sobre ADR 0207
y 0209)

## Problema

Sofi tenía una regla de negociación fija: primero el valor, después el envío y el descuento al
final, de a poco. Así cede cada vez más a quien insiste, ofrece envío gratis a quien ya lo tiene y
dice «vale 24 horas» sin la hora: la clienta no sabe hasta cuándo, y la tienda deja de ser creíble
cuando la rebaja vuelve a aparecer al día siguiente.

## Decisión y motivo

- **La oferta es una sola por conversación** desde su última compra, y queda escrita en la
  respuesta de Sofi (`detail.oferta`: lo más que cedió y su plazo). Si la clienta insiste, cotizar
  no deja ceder más (`offerProblem` en `sofi/herramientas.ts`); puede repetir la misma o dar a
  elegir otra que ceda lo mismo o menos. La regla vive en las herramientas, no solo en las
  instrucciones: el modelo no la puede saltar.
- **Siempre a cambio de pagar dentro del plazo, con la hora exacta** en la hora de la tienda
  (`momentWords` en `hora.ts`). El pedido vence a esa misma hora, nunca más tarde que las 24 horas
  de ADR 0207 (`negotiatedUntil` en `precio.ts`), y si el plazo ya pasó no se renueva solo.
- **Con pago al recibir no hay rebaja**: es a cambio de pagar ya y baja el riesgo del contra
  entrega. Es regla de Sofi al vender; el equipo sigue negociando como siempre.
- **Lo que ofrece sale del mismo margen** (ADR 0207) y lo elige con lo que sabe de la clienta en
  esa conversación: primera compra, compra seguido o siempre pide rebaja (`customerStory`). No une
  conversaciones por el teléfono.
- **No dice lo que no hizo**: «hablé con la tienda», «el dueño me autorizó» o «te lo separo» no
  salen (`claimsInvented` en la comprobación). Separar el producto todavía no existe.

## Alternativas descartadas

- Dejarlo solo en las instrucciones: el modelo podría mejorar la oferta al tercer «porfa».
- Guardar la oferta en una tabla: la respuesta de Sofi ya guarda lo que hizo, y una tabla más no
  resuelve nada que esto no resuelva.
- Un plazo propio de la oferta, distinto del del precio: la clienta vería dos horas.

## Consecuencias

- La clienta que vuelve con otro teléfono es otra conversación: hasta que la ficha de la clienta
  esté en Sofi, la historia es solo la de esa conversación.
- Faltan el mensaje único cuando se queda callada, el aviso unas 3 horas antes de que venza, la
  venta antes de que salga el pedido y separar el producto: necesitan programar mensajes, Despachos
  y la reserva de stock.
- Las pruebas usan un modelo controlado; cómo vende el modelo real se mide con `eval:sofi`.

## Referencias

- `gestoria/apps/api/src/sofi/sofi.ts`, `sofi/herramientas.ts`, `sofi/revisar.ts`, `precio.ts`,
  `hora.ts` y sus pruebas (`sofi/vender.test.ts`, `sofi/sofi.test.ts`).
- `gestoria/apps/api/eval/sofi.json` y `sofi/eval-sofi.ts`: los casos de las cinco clientas.
