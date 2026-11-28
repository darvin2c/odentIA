# 0234 · En gestorIA, a Sofi se la configura eligiendo, y lo que sabe son preguntas y respuestas

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «gestorIA · Configuración, de nuevo», tablero 8 y
decisiones 7 y 8 (sobre la oferta del ADR 0224 y las reglas de Sofi de `0007_reglas_sofi.sql`)

## Problema

La tienda configuraba a Sofi con dos campos: cómo se presenta y un texto largo, «Lo que debe
saber», que iba tal cual al mensaje de sistema. No podía decir cómo habla Sofi, qué puede ofrecer,
cuándo le pasa el chat ni su horario; el texto libre era a la vez información e instrucciones sin
control, y la prueba no decía por qué respondió así. Lo que Sofi no supo responder no le llegaba a
nadie.

## Decisión y motivo

- **Todo lo que decide la tienda tiene su opción** (`store_agent`): tono (cercana, amable y
  formal, directa), trato (tú o usted), emojis (ninguno o pocos), lo que puede ofrecer para cerrar
  (envío, descuento, regalo, rebaja si lleva dos o más), si pasa el chat cuando la clienta está
  molesta o cuando el pedido pasa de un monto, el horario del equipo (días ISO 8601 y horas en la
  zona de la tienda) y si fuera de él sigue vendiendo. Cada opción tiene su frase fija en
  `sofi/opciones.ts`: el modelo recibe esa frase, nunca un texto de la tienda.
- **Lo que no se elige queda igual**: ofrece una sola vez, a cambio de pagar en 24 horas, nunca
  baja del mínimo y con pago al recibir no hay oferta (`precio.ts`, `offerProblem`, ADR 0224).
  Pasar a una persona cuando lo pide, en un reclamo, un cambio o una devolución, o cuando no sabe,
  tampoco se apaga.
- **Lo que puede ofrecer lo frena el servidor, no solo el texto**: cotizar y armar_pedido no
  dejan una cotización que ceda algo que la tienda apagó (`offerKindsOf`, `offerNotAllowed`), y
  armar_pedido no anota un pedido que pasa del monto elegido.
- **«Lo que sabe» son preguntas y respuestas** (`store_agent_answer`). Sofi ve solo las preguntas,
  como JSON dentro de los datos de la tienda, y lee la respuesta con su herramienta
  (`leer_lo_que_sabe`), que la marca como información. Así lo escrito por la tienda nunca se lee
  como una orden, y se sabe qué respuesta usó.
- **«Lo que aprendió» solo propone** (`agent_gap`): al pasar el chat porque no sabe, Sofi anota la
  pregunta (solo en una conversación de verdad, nunca en «Probar a Sofi»). La tienda la responde
  (pasa a «Lo que sabe») o la quita. Se juntan por su clave (sin tildes ni signos). La base deja
  que solo Sofi la anote, abierta y a su nombre, y que solo una persona la cierre
  (`0040_reglas_lo_que_sabe.sql`); Sofi nunca escribe «Lo que sabe» ni lo que eligió la tienda.
- **«Por qué» en la prueba sale de lo que quedó anotado en su respuesta**: cómo habló, qué leyó de
  «Lo que sabe», qué ofreció de la lista, qué intentó y la tienda no dejó, la pregunta que no supo
  y si el equipo no estaba. No se le pregunta al modelo por qué: no se inventan razones.
- **Fuera del horario**, los avisos fijos dicen cuándo responde una persona («mañana desde las
  9 a. m.») en vez de «en un momento».

## Alternativas descartadas

- Dejar el texto libre con una advertencia: es lo que el usuario rechazó y mezcla datos con
  instrucciones.
- Poner las respuestas de «Lo que sabe» enteras en el mensaje de sistema: «Por qué» no podría decir
  cuál usó, y crece con cada respuesta.
- Listar en lo que lee Sofi las preguntas que ya anotó, para que repita el mismo texto: es texto
  que viene de clientas y llegaría al mensaje de sistema de otras conversaciones.
- Agregar solo a «Lo que sabe» lo que Sofi aprendió: la tienda pierde el control de lo que Sofi
  dice (decisión 8).

## Consecuencias

- La columna `store_agent.knowledge` ya no se lee: su texto pasó a una respuesta («Lo que le
  escribiste antes a Sofi») al migrar; se borra en un cambio siguiente.
- Cambia lo que lee Sofi: se mide con `eval:sofi` (el banco ya lee «Lo que sabe» y espera
  `leer_lo_que_sabe`) con el modelo real al final de la serie.
- Queda fuera: «Sumar algo al mismo envío» después del pago (Sofi no cambia un pedido pagado, ver
  ADR 0226), elegir el producto de regalo, las palabras propias de la tienda y las cifras de qué
  oferta cerró más ventas.
