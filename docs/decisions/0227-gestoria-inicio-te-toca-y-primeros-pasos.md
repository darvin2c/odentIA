# 0227 · gestorIA abre en Inicio: «Te toca» por rol y los primeros pasos de una tienda nueva

Fecha: 2026-11-27 · Estado: aceptada · Entrega 3 (Inicio) y 6 (Primeros pasos) del lienzo «gestorIA
como odentIA» (tableros 4, 5, 12, 16 y 24; usa el saldo único del ADR 0222 y los permisos del ADR
0225)

## Problema

gestorIA abría en Pedidos, una lista con siete filtros. Lo que había que hacer (pagos por
confirmar, lo que volvió sin entregar, pedidos pagados sin stock) lo calculaba Argos, pero vivía en
Reportes, que Ventas no ve: quien más atiende no sabía qué le tocaba. Cuánto entró hoy pedía ir a
Reportes y elegir el periodo. Una tienda recién creada abría en «No hay pedidos aquí», sin decirle
que sin catálogo Sofi no tiene qué ofrecer ni que faltan los medios de pago y las entregas.

## Decisión y motivo

- **Inicio es la primera pantalla y la primera entrada del menú** para todo el equipo que atiende
  (`ventas.atender`). Soporte, que solo mira, sigue entrando por el catálogo.
- **Las cuatro cifras salen de la misma cuenta que Reportes** (`collectedSinceIn` y
  `pendingNowIn`, sobre `order_balance`), en la hora de la tienda: «Falta cobrar» no incluye lo que
  está por confirmar y «Sale hoy» cuenta aparte lo que no se entregó. Los totales de dinero son de
  quien ve Reportes (`reportes.ver`); Ventas ve cuántos pagos esperan y cuánto sale, sin montos. No
  se crea ningún permiso.
- **«Te toca» se muda de Reportes a Inicio**, con las mismas consultas fijas (sin modelo), en tres
  tiempos (ahora, hoy, sin apuro), y cada línea solo para quien puede resolverla, con su único
  botón: «Ver y confirmar» abre el pedido con su captura (nunca se confirma a ciegas), «Pasar a…»,
  «Comparar» y «Ver pedido» reusan las operaciones de Pedidos y Clientes. Reportes se queda con
  las cifras y con lo que hizo Argos.
- **Lo que depende de pantallas que no existen no se dibuja**: los chats que esperan a una
  persona van en la respuesta (`waiting.chats`) para la Bandeja, y Caja y Despachos suman su parte
  cuando lleguen. Una línea sin su botón sería un aviso que no se puede resolver.
- **Los primeros pasos se marcan solos con lo guardado** en cada apartado (país, productos con
  stock, medios y formas de entrega encendidos, una prueba de Sofi, alguien más en el equipo o una
  invitación). Solo se guarda lo que no está en otra tabla (`store_setup`): lo saltado y cuándo
  quedó lista, para que no vuelva. Se salta solo lo que no aplica a toda tienda (Sofi y el equipo);
  los chats dicen «Muy pronto» y no cuentan mientras falte la app de Meta. Las tiendas que ya
  vendían quedan como listas en la migración.

## Alternativas descartadas

- Dejar «Te toca» en Reportes y abrir Ventas en Pedidos: Ventas no ve lo que le toca.
- Calcular las cifras de Inicio aparte: dos cuentas que se separan con el primer cambio.
- Un permiso nuevo para «ver los totales del día»: lo cubre `reportes.ver` sin otra fila en la
  matriz.
- Marcar los pasos a mano o guardar cada paso en una tabla: se desincroniza con lo que de verdad
  está configurado.
- Dibujar la línea de los chats sin botón: avisa algo que no se puede resolver hoy.

## Consecuencias

- Inicio y Reportes leen las mismas funciones; un cambio en una cifra cambia las dos.
- Quitar un medio de pago después de terminar no hace volver la lista: lo dice Configuración.
- Al llegar la Bandeja, `CHATS_READY` y el paso «Conectar los chats» cuentan, y la línea de los
  chats se dibuja con «Abrir Bandeja».
