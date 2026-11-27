# 0223 · La clienta única de gestorIA: una persona dice si dos fichas son la misma

Fecha: 2026-11-26 · Estado: aceptada · Entrega 4 del lienzo «gestorIA como odentIA» (tableros 2, 8
y 12)

## Problema

gestorIA se armó alrededor del pedido: cada uno copiaba un nombre y un teléfono escritos a mano,
y Mariela por Instagram y por WhatsApp eran dos desconocidas. Hacía falta la clienta, como la
persona única de las clínicas (ADR 0001), sin decidir la identidad porque coincide el teléfono
(ADR 0027) y sin frenar ninguna venta.

## Decisión y motivo

- **Una ficha por clienta** (`customer`), con su nombre, su teléfono y «Lo que sabemos». Cada
  pedido lleva la suya desde la misma operación del equipo y de Sofi (`createOrderIn`): la
  elegida al anotarlo, la de los pedidos anteriores del mismo chat o una nueva. Nunca se busca
  por el teléfono. Los de «Probar a Sofi» no tienen ficha.
- **Unir es dejar una dentro de otra** (`merged_into`): la más nueva queda dentro de la más
  antigua, con lo que ya estaba dentro de ella; nada se mueve ni se borra, y los pedidos siguen
  con la ficha con que se anotaron. «Separar» la deja sola otra vez, con sus pedidos y con las
  fichas que una persona le había unido antes (se sabe por la historia). La base no deja que una
  ficha quede dentro de otra que a su vez está dentro de una tercera.
- **Lo decide una persona del equipo que atiende** (`ventas.atender`): el mismo teléfono (sus
  últimos 8 dígitos) o el mismo nombre solo lo sugieren. Lo decidido queda en `customer_event`
  (unida, separada, distintas), que solo se agrega, y lo contestado no se vuelve a preguntar.
  Sofi abre fichas, pero no decide quién es quién.
- **Los pedidos de antes no se unen solos**: quedan sin ficha y siguen en Pedidos. La ficha nace
  con lo que llega desde ahora.

## Alternativas descartadas

- **Mover los pedidos y los teléfonos a la ficha que queda:** separar tendría que adivinar qué
  era de cada una; un error de una persona no se podría deshacer.
- **Unir sola por el teléfono:** un mismo número puede ser de la hija, de la mamá o de una
  vendedora que compra para otras; un error mezcla compras y direcciones de dos personas.
- **Crear fichas para los pedidos de antes, una por pedido:** serían fichas paralelas de la misma
  clienta, justo lo que se quiere evitar.

## Consecuencias

- **Beneficio:** la clienta que vuelve por otro canal es la misma ficha, con «Repetir pedido», y
  cualquier error se deshace desde su historia.
- **Sacrificio:** las compras de antes no aparecen en la ficha. Las sugerencias se calculan con
  todas las fichas de la tienda en cada vista: si una tienda pasa de unos miles de clientas, se
  pasan a la base.
- **Cuándo revisarlo:** con la Bandeja, cuando la conversación lleve su ficha; o si una tienda
  real necesita traer sus compras de antes.

## Referencias

`gestoria/apps/api/src/clientes.ts`, `gestoria/packages/db/drizzle/0018_las_clientas.sql` y
`0019_reglas_clientas.sql`, `gestoria/apps/web/src/clientes.tsx`.
