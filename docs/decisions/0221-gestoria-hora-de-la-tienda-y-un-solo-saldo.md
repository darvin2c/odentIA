# 0221 · gestorIA cuenta el día con la hora de la tienda, y cada pedido tiene un solo saldo

Fecha: 2026-11-26 · Estado: aceptada · Entrega 1 del lienzo «gestorIA como odentIA» (tableros 3,
5 y 7; sobre ADR 0207)

## Problema

En producción, gestorIA decidía qué es «hoy» con la hora del servidor (UTC): desde las 19:00 de
Lima ya contaba el día siguiente. «Para entregar hoy» traía los pedidos de mañana, Reportes «Hoy»
volvía a cero y una promoción «desde el miércoles» empezaba el martes a las 7 de la noche. El
navegador mandaba su fecha, pero Sofi y Argos no tienen navegador, y cada persona del equipo puede
estar en otra zona.

Además, «cuánto falta cobrar» se calculaba distinto en cada pantalla, y un pedido aceptaba un
solo pago: el adelanto de Diana (S/ 80 de S/ 117) dejaba el pedido como pagado, el segundo pago
salía «Pago doble», al entregar no pedía los S/ 37 y Reportes decía que no faltaba nada. Inicio,
Despachos y Caja (entrega 3) se apoyan en las dos cifras: si se dibujaban antes, nacían con el
mismo error.

## Decisión y motivo

- **Cada tienda guarda su zona horaria** de la base de IANA (`store.time_zone`, «America/Lima» por
  omisión), y el servidor cuenta todo día con ella (`apps/api/src/hora.ts`): «Para entregar hoy» y
  los filtros de Pedidos, los periodos de Reportes (desde las 00:00 de la tienda), las promociones
  (de un día a otro de su calendario), Argos y el «hoy» que lee Sofi. Lo que diga el navegador ya
  no cuenta. La cambia quien tiene `configuracion`, y queda en el registro de la tienda.
- **Un solo saldo por pedido, calculado en un solo lugar**: la vista `order_balance` (con
  `security_invoker`, así valen las reglas de cada tienda). Falta cobrar = total − confirmado − por
  confirmar, nunca menos de 0 y 0 si se anuló; «Pagado» es no deber nada con todo confirmado; lo
  confirmado que pasa del total es un pago doble. La leen el pedido, las listas, Reportes, Argos,
  la conversación y Sofi (`apps/api/src/saldo.ts`); ninguna pantalla lo recalcula.
- **El pago en partes, sin estados nuevos**: un pedido acepta varios pagos mientras falte cobrar,
  cada uno con su medio copiado del de la tienda (nombre y tipo de UN/CEFACT 4461, como el pedido
  copia el suyo) y su estado. El primer pago confirmado lo deja listo para salir y baja el stock,
  como uno completo; al entregar se cobra lo que falta, con su medio. «Pago doble» solo si lo
  confirmado pasa del total.

## Alternativas descartadas

- La fecha del navegador: distinta para cada persona, inexistente para Sofi y Argos, y elegible
  por quien llama (una promoción de otro día).
- Una diferencia fija con UTC: no sigue los cambios de hora ni las reglas de IANA.
- Un estado nuevo «pago parcial»: suma filtros y transiciones a todo; el saldo ya dice cuánto falta
  en cualquier estado.
- Calcular el saldo en cada pantalla (lo que causó el error) o en el servidor pedido por pedido:
  Reportes tendría que leer cada pedido entregado para hallar los que deben.
- Guardar lo pagado en una columna del pedido que actualiza la aplicación: se desincroniza de los
  pagos con cualquier camino que lo olvide.

## Consecuencias

- Las tiendas de antes quedan en la hora de Lima. Hasta que llegue Configuración (entrega 3), la
  hora se cambia al pie de «Pagos y entregas».
- La vista suma los pagos en cada lectura: con los pedidos de una tienda basta; si una tienda
  crece mucho, se revisa con un índice o una vista materializada.
- «Pago por confirmar» es todo pedido con un pago que espera a una persona, también el segundo de
  uno que ya sale.
- Lo que lee Sofi cambia («falta pagar» en un pedido pagado en partes y el «hoy» de la tienda): se
  mide con el banco al final de la serie, mientras gestorIA está apagado.
- Fuera de esta decisión: deshacer una confirmación con motivo (entrega 2), quién cobró en la
  puerta y «¿ya te pagó?» al despachar (entrega 3).

## Referencias

- `gestoria/apps/api/src/hora.ts`, `saldo.ts`, `pedidos.ts`, `sofi/reportes.ts` y sus pruebas.
- `gestoria/packages/db/drizzle/0014_la_hora_de_la_tienda.sql`, `0015_reglas_hora_de_la_tienda.sql`,
  `0016_el_saldo_y_el_pago_en_partes.sql` y `0017_reglas_saldo.sql`.
- ADR 0207 (los pedidos y el link de pago) y 0206 (stock por kardex).
