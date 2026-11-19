# 0207 · gestorIA: el precio de un pedido sale de un solo margen, y el link de pago se cree al proveedor, no al aviso

Fecha: 2026-11-19 · Estado: aceptada · Paso B4 del lienzo B (gestorIA)

## Problema

B4 arma los pedidos: su precio negociado, su cobro y su stock (tableros 2, 5, 10 y 14). Tres
cosas tienen alternativas reales y tocan dinero: cómo se mide lo que se cede para no bajar del
mínimo, cuándo baja el stock si el pago llega y no alcanza, y cómo se confía en un pago por link
que confirma una máquina y no una persona.

## Decisión y motivo

- **Lo que se cede sale de un solo margen**, el que hay entre el precio sin negociar y el mínimo
  de cada línea (`apps/api/src/precio.ts`). El descuento, el envío que pone la tienda y un regalo
  (valorado a su mínimo) se suman y no pueden pasar ese margen; ningún precio baja del mínimo.
  El precio sin negociar es la promoción o el precio por cantidad, el mejor para el cliente, sin
  sumarlos. El envío gratis «desde un monto» es regla de la tienda y no gasta margen. Se guarda
  todo en el pedido (lista, sin negociar, mínimo y acordado por línea; descuento, envío, regalo,
  margen y lo usado), y el precio negociado vence a las 24 horas. Es la misma regla para el
  equipo y para Sofi (B5): una sola operación, `createOrderIn`.
- **El stock baja al confirmar el pago** (o al salir, si se paga al recibir), como dice la
  decisión 3, con `recordSale` del kardex (ADR 0206). Si al pagar no alcanza, el pago se confirma
  igual —el dinero ya llegó— y el pedido muestra «falta stock»: no puede salir hasta que entre.
- **El link de pago es un adaptador** (`apps/api/src/link-de-pago.ts`); el primero es Mercado Pago
  Checkout Pro, con las credenciales de cada tienda cifradas con AES-256-GCM y una llave fuera de
  la base (`GESTORIA_SECRETS_KEY`, ligada a la tienda). El aviso del proveedor solo dice qué pago
  mirar: el estado, el monto, la moneda y el pedido se leen de Mercado Pago con el token de la
  tienda. Si la tienda puso su clave, además se comprueba la firma. Pagado, por el total y en su
  moneda: el pedido pasa solo a pagado. Si algo no coincide (monto, pedido anulado o ya pagado),
  el pago se anota «por confirmar» para que lo vea una persona; nunca se descarta. Un mismo pago
  no se anota dos veces (índice único por proveedor y número de pago). Crear el link usa una
  clave de idempotencia por pedido y no se reintenta solo.

## Alternativas descartadas

- Un tope por línea y otro para el envío: deja ceder más que el margen sumando por partes.
- Reservar stock al anotar el pedido: un pedido que nunca se paga deja la talla bloqueada; la
  decisión 3 ya eligió bajar al pagar.
- Creer el cuerpo del aviso firmado: la firma de Mercado Pago depende de cómo configuró la tienda
  sus avisos; leer el pago con su token es la fuente cierta y hace inútil un aviso falso.
- Guardar el token en claro, protegido solo por las reglas de la base: un respaldo filtrado
  bastaría para cobrar a nombre de la tienda.

## Consecuencias

- Sin `GESTORIA_SECRETS_KEY` y `GESTORIA_API_URL`, el link de pago no se ofrece; lo demás funciona.
- Las pruebas usan el adaptador real contra un Mercado Pago controlado: no prueban que Mercado Pago
  responda así en producción. Falta un pago real de punta a punta.
- Los avisos al cliente quedan escritos en la historia del pedido y no salen hasta B2 (WhatsApp).
- Devoluciones y contracargos del proveedor no se leen todavía.

## Referencias

- `gestoria/apps/api/src/precio.ts`, `pedidos.ts`, `link-de-pago.ts`, `secretos.ts` y sus pruebas.
- `gestoria/packages/db/drizzle/0004_pedidos.sql` y `0005_reglas_pedidos.sql`.
- ADR 0203 (gestorIA aparte) y 0206 (stock por kardex).
