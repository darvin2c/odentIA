# 0208 · gestorIA: Sofi vende con las operaciones del equipo y la base le niega lo que nunca hace

Fecha: 2026-11-19 · Estado: aceptada · Paso B5 del lienzo B (gestorIA)

## Problema

B5 suma a Sofi, la vendedora que cierra la venta sola (tableros 8 y 14), y a Argos, que vigila
la tienda y le encarga lo de rutina (tablero 13). Sofi toca dinero: negocia dentro del margen
del dueño, arma pedidos y anota capturas. Había que decidir con qué identidad entra a la base,
cómo se garantiza que nunca baje del mínimo ni dé un pago por confirmado aunque el modelo se
equivoque o el cliente lo empuje, cómo se la prueba sin WhatsApp (B2) y con qué modelo, si
gestorIA no puede importar el agente de las clínicas (ADR 0203).

## Decisión y motivo

- **Las mismas operaciones que el equipo.** Cada herramienta de Sofi llama a `pedidos.ts`
  (`quoteOrderIn`, `createOrderIn`, `addReceiptIn`, `createPaymentLinkWith`, `cancelOrderIn`):
  el precio, el mínimo, el margen único, el stock y los estados no se repiten en el agente.
- **Un remitente propio con el rol de la aplicación**, nunca el dueño de la base:
  `agente:sofi` y `agente:argos` en `app.user_id`. Pasan por las reglas de cada tienda como una
  persona, y además reglas restrictivas les niegan revisar un pago, anotar un pago que no sea una
  captura por confirmar, tocar un pedido que no esté por pagar, dejarlo en otro estado que por
  confirmar o anulado, mover el stock y escribir la configuración, el catálogo o el equipo. Solo
  el agente escribe como Sofi. Si el código o el modelo se equivocan, la base dice que no.
- **Lo que dice pasa una comprobación antes de salir** (`revisar.ts`): cada importe y porcentaje
  tiene que haber salido de sus herramientas, de la tienda o de la conversación, y nunca dice que
  un pago está confirmado si ningún pedido tiene dinero confirmado. Una corrección; si vuelve a
  fallar, sale un aviso fijo y la conversación pasa a una persona. Arma un pedido solo con una
  cotización que el cliente ya vio y respondió.
- **El núcleo conoce conversaciones y mensajes**, sin canal. Mientras no hay WhatsApp, «Probar a
  Sofi» abre una conversación de prueba: el equipo escribe como cliente y Sofi responde con la
  tienda de verdad. Sus pedidos son de verdad, marcados de prueba (`sale_order.test`): no mueven
  el stock, no crean un link real y no cuentan en Reportes ni en Argos. Así se ve el recorrido
  entero, también la captura que confirma una persona.
- **El modelo**, el mismo proveedor y modelo de las clínicas (OpenAI, `gpt-6-luna`), con una
  llamada a Chat Completions por `fetch` (`sofi/modelo.ts`): sin SDK ni LangChain, por la
  separación de ADR 0203. Clave propia `GESTORIA_OPENAI_API_KEY`. Las pruebas usan un modelo
  controlado; el de desarrollo (`fake`) no arranca en producción.
- **Argos sin modelo.** Reportes y «Te toca» son cálculos fijos. Los seguimientos (recordar el
  pago, agradecer y preguntar si llegó, avisar que volvió una talla, invitar a volver) son textos
  fijos que escribe a nombre de Sofi, uno por cliente, motivo y pedido (índice único), con su
  interruptor. Quedan sin enviar hasta B2 y, pasadas 24 horas del último mensaje del cliente,
  marcados para salir con plantilla aprobada.

## Alternativas descartadas

- Sofi con el dueño de la base y el aislamiento solo en el código: un error dejaría ver o tocar
  otra tienda o confirmar un pago.
- Herramientas propias de Sofi con su regla de precio: dos reglas que se separan con el tiempo.
- Importar `packages/agent` o moverlo a `shared/` en este PR: lo prohíbe la separación; si algo
  sirve a todos, se mueve en su propio cambio.
- Una prueba que no guarda nada (todo simulado): no se vería el pedido ni la captura por
  confirmar, y lo simulado no prueba el recorrido.
- Que el modelo escriba los seguimientos: más costo y otra medición para textos que no cambian.

## Consecuencias

- Antes de encenderla para una tienda real se mide con el banco `eval/sofi.json`
  (`pnpm --filter @gestoria/api eval:sofi`): que venda, que no pase los límites, que no invente,
  que no dé por pagado y cuánto cuesta cada conversación.
- B2 solo tiene que traer y llevar mensajes: llamar a `answer` al llegar uno del cliente y
  enviar los de Sofi y Argos (con plantilla si `needs_template`).
- Revisar si el razonamiento del modelo (por /v1/responses, como Recepción en las clínicas)
  mejora la venta frente a su costo, con el mismo banco.

## Referencias

- `gestoria/apps/api/src/sofi/` (`sofi.ts`, `herramientas.ts`, `revisar.ts`, `argos.ts`,
  `reportes.ts`, `modelo.ts`, `eval-sofi.ts`), `gestoria/apps/api/src/agente.ts`.
- `gestoria/packages/db/drizzle/0006_sofi.sql` y `0007_reglas_sofi.sql`.
- ADR 0203 (gestorIA aparte), 0206 (stock por kardex) y 0207 (precio de un solo margen).
