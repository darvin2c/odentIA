# 0226 · En gestorIA, un pedido se corrige sin anularlo

Fecha: 2026-11-27 · Estado: aceptada · Entrega 2 del lienzo «gestorIA como odentIA» (tableros 6, 7
y 12; cambia la regla «lo acordado no se cambia» del ADR 0207, sobre el saldo del ADR 0222)

## Problema

Lo acordado en un pedido no se podía cambiar: para pasar a Andrea de la talla 37 a la 38 había que
anular el 0147, anotar otro desde cero (número nuevo, que la clienta no conoce) y volver a cargar
su Plin, que salía «Pago doble». Unos 19 toques y una cifra falsa al final. Un pedido que volvía
sin entregar no se podía anotar ni pasar a otro día: el atajo era el mismo. Y el kardex no
aguantaba un segundo cambio: la venta de cada variante se miraba por la referencia del pedido, así
que volver a la 37 se habría saltado sin avisar. Una captura confirmada por error tampoco se podía
deshacer.

## Decisión y motivo

- **«Cambiar» es el mismo pedido**: su número, sus pagos y su historia. Cambia los productos
  (talla, color, cantidad, otro producto), la forma de entrega, la dirección y el día; el cliente,
  el canal y el medio de pago no. El precio se vuelve a calcular con las reglas de siempre (nunca
  bajo el mínimo, lo cedido escrito, lo negociado vale 24 horas desde el cambio) y el saldo sale de
  `order_balance` con el total nuevo: lo pagado no se pierde y lo que falta o sobra queda en el
  saldo. Se cambia mientras no sale. Una sola operación (`changeOrderIn`) para el equipo y, más
  adelante, para Sofi; su vista previa es la misma operación dentro de un paso que se deshace.
- **El kardex mueve la diferencia, con la referencia de cada paso**: lo que un pedido tiene fuera
  del stock es lo vendido menos lo que volvió en todas sus referencias («Pedido 0147», «Pedido 0147
  · cambio 1», …). Cada paso que mueve stock (cambiar, deshacer un pago, volver a venderlo) compara
  con sus líneas y mueve solo la diferencia, con su propia referencia: el índice único sigue
  diciendo que un paso no se repite, y cambiar dos veces deja el stock igual a lo que salió. Si lo
  nuevo no alcanza, se guarda igual, vuelve lo que ya no va y queda «falta stock»: solo frena al
  salir.
- **«No se entregó» y «Pasar a…»** solo mueven el día: el pedido vuelve a «Por salir» (con su
  motivo en la historia) o cambia de día, sin anular nada y sin mover el stock.
- **Cualquier paso completa los anteriores**: «Entregado» sin «Salió» deja las dos, con la misma
  hora.
- **Deshacer la confirmación de una captura**, con motivo escrito, por quien confirma pagos: el
  pago vuelve a esperar a una persona. Si era lo único confirmado de un pedido que no sale, el
  pedido vuelve a «Pago por confirmar» y su stock vuelve. En la base, un pago solo da los pasos de
  su revisión (`order_payment_step`).

## Alternativas descartadas

- Anular y anotar otro (lo de antes): número nuevo, pago duplicado y la historia partida en dos.
- Un pedido nuevo enlazado para cada corrección: es el modelo de los cambios después de entregar
  (tablero 17), que llega en la entrega 8; antes de salir agrega pedidos sin necesidad.
- Editar las líneas en su lugar: perdería qué se acordó en cada una; se reemplazan enteras y cada
  una vuelve a pasar sus reglas de precio.
- Un contador de cambios en el pedido: la referencia del paso sale del kardex mismo, sin otra
  columna que se pueda desincronizar.

## Consecuencias

- Las líneas de un pedido ahora se reemplazan (`DELETE` concedido a la aplicación, nunca al
  agente) y el pedido actualiza las columnas de su total. El total sigue siendo su suma por la
  regla de la base.
- «Falta stock» se calcula comparando las líneas con lo que el pedido tiene fuera, en el pedido y
  en Argos.
- Un precio acordado que venció se vuelve a acordar con «Cambiar».
- Fuera de esta decisión: la franja y el repartidor (Despachos, entrega 3), «¿ya te pagó?» al
  despachar con un pago por confirmar (entrega 3), abrir WhatsApp con el aviso del cambio (sin
  canal, el aviso queda escrito y sin enviar) y que Sofi cambie un pedido antes de pagar.
