# 0237. gestorIA: «Probar como clienta» por la misma Sofi, la vitrina del producto y «Sofi no supo»

- **Fecha:** 2026-11-27
- **Estado:** aceptada

## Problema

La ficha del producto (lienzo «La ficha del producto», tableros 11 a 13 y 15) pide que la tienda
vea lo que vive la clienta con un producto (el chat de WhatsApp y la vitrina por link, con el mismo
carrito, la única oferta con plazo, «Pagar ahora» y la oferta después del pago), que Sofi use lo
nuevo de la ficha (datos del rubro, estado, preguntas respondidas, la foto del color, el video, lo
que puede ofrecer) sin inventar, y que lo que no sabe llegue a la tienda sin soltar la venta.

Restricciones: Sofi no confirma pagos ni cambia un pedido pagado (ADR 0207, 0224 y 0226); lo que
escribe la clienta nunca va como instrucción; nada sale sin `checkReply`; lo de prueba no mueve
stock, no cobra y no cuenta en Reportes, Argos ni el uso; el cobro de verdad por la vitrina y el
catálogo por link son de otra entrega.

## Decisión y motivo

1. **La prueba es la conversación de verdad, de prueba.** «Probar como clienta» usa la conversación
   del canal «prueba» y la misma `answer` de Sofi, con sus herramientas, `precio.ts` y `checkReply`.
   Nunca es un panel de preguntas aparte: lo que se ve es lo que haría con una clienta.
2. **El carrito es el pedido.** El carrito de la vitrina y la tarjeta del chat son el pedido «por
   pagar» de la conversación (el que anotó Sofi con lo acordado y su plazo, o el que arma la vitrina
   con lo que eligió la clienta, con `createOrderIn`). Lo elegido en la vitrina antes de pagar viaja
   en el mensaje de la clienta como dato (`detail.carrito`), igual que el producto desde el que
   llega (`detail.desde`): Sofi lo lee con los nombres de la tienda, nunca como orden.
3. **El pago de la prueba se simula** (`payTestOrderIn`): solo un pedido `test`, sin link real ni
   stock, y la pantalla dice «Pago de prueba: no se cobra». El checkout de verdad llega con el
   catálogo por link.
4. **Lo que la tienda le pide decir a Sofi va como aviso de sistema** (`StoreNotice`): que la
   clienta pagó (una vez, con lo que combina como pedido aparte: el pagado no se cambia) o la
   respuesta a lo que no supo («Que Sofi se lo diga»). Es texto del servidor y de la tienda, nunca
   de la clienta, y su respuesta pasa por `checkReply` como cualquier otra.
5. **«Sofi no supo» es una herramienta** (`anotar_pregunta`): la base solo le deja anotar la
   pregunta (`0035`). Va a «Te toca» (iguales del mismo producto, una línea) y al celular (tipo
   `preguntas`), salvo las de la prueba, que quedan solo en la ficha. Ventas responde y propone;
   quien cambia la ficha la guarda.
6. **La página del producto en la vitrina es una pieza** (`apps/api/src/vitrina.ts` y
   `apps/web/src/vitrina/`): la ruta pública (`GET /vitrina/:link/:producto`) da solo lo vendible
   de un producto que se ve en la web; la vista previa de la ficha da lo mismo al equipo aunque no
   se vea todavía. Nunca el costo, el mínimo, lo que Sofi puede ofrecer, los códigos ni el stock
   exacto (solo «quedan pocas», hasta 3).
7. **El modelo de desarrollo** (`modelo-de-desarrollo.ts`, `GESTORIA_LLM_MODEL=fake`) usa las
   herramientas de verdad por reglas fijas, para ver la prueba en local y en los recorridos. No es
   medición: la de Sofi sigue siendo `eval:sofi`.

## Consecuencias

- Una sola tubería: lo que se arregla en Sofi se ve en la prueba y en los chats de verdad.
- «Qué usó Sofi» sale de lo que leyó y está en lo que escribió (`usedIn`), no de preguntarle al
  modelo: puede no nombrar algo que usó con otras palabras.
- La oferta después del pago es un pedido aparte, con su propia entrega: Sofi no dice que va en el
  mismo envío. Juntarlo en Despachos queda para otra entrega.
- Responder con «Que Sofi se lo diga» llama al modelo por cada clienta, después de responder; si
  falla, la respuesta ya quedó guardada.
