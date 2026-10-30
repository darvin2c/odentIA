# 0108 · Finanzas: Caja es el día, Cobros guarda todos los tickets y los filtros dicen su nombre

- Fecha: 2026-10-30.
- Estado: aceptada.

## Problema

En Finanzas no se podía ver un ticket que no fuera de hoy: «Movimientos de hoy» era la única lista de tickets, el servidor no tenía una lista de tickets, el buscador rápido llevaba a la cuenta de la persona y la hoja del cierre solo traía totales. Caja repetía la lista de Deudas («Deben de antes») y por eso las dos pestañas se veían iguales. Ninguna lista de Finanzas buscaba, filtraba ni ordenaba, y Deudas traía todas las deudas de la sede de una vez. En el teléfono, la barra común de las listas escondía los filtros detrás de un botón «Filtros».

## Decisión y motivo

- Finanzas en cinco pestañas: Caja · Cobros · Deudas · Gastos · Comisiones. Caja es el día de la sede: el efectivo, lo cobrado por medio, «Por cobrar ahora» (quien salió hoy de su atención) y los movimientos de hoy; lo de antes queda en una línea con «Ver deudas».
- Cobros es la tabla de todos los tickets de la sede, por páginas del servidor, con el ticket entero en la fila (lo que pagó concepto por concepto, el medio, quién cobró y el total) y encima lo que suma lo que se ve, por medio de pago. Tocar una fila abre el ticket al lado, tal como se imprime, con «Anterior / Siguiente». Un número escrito es de un ticket o un documento y se busca en todas las fechas. El ticket tiene su dirección (`?ticket=`) y el buscador rápido lo abre ahí.
- Deudas, Gastos y Cierres usan la misma barra: buscador a la vista, cada filtro con su nombre y lo elegido, y «Ordenar». La hoja de un cierre lista lo que contó en efectivo.
- En el teléfono, la barra común muestra los filtros con su nombre en una fila que se desliza bajo el buscador, con el orden como uno más; el cajón queda solo para «Más filtros» del escritorio. Así se ve qué filtra sin abrir nada, en todas las listas.
- Lo de toda la clínica sigue en Reportes: Finanzas es por sede.

## Alternativas descartadas

- Un selector de día en «Movimientos de hoy»: resolvía «ayer» pero no buscar a una persona, un número ni un medio en un mes.
- Abrir el detalle del ticket dentro de la fila: duplicaba el ticket que ya se imprime y se envía desde su vista.
- «Todas las sedes» y «Descargar» en Finanzas: Reportes ya cubre lo de toda la clínica; se agregan si se piden.
- Conservar el cajón «Filtros» solo en el teléfono: esconde qué se está filtrando y suma un paso para algo frecuente.

## Consecuencias

- La caja ya no carga todas las deudas para mostrar las de hoy; Deudas y Cobros piden páginas.
- Una lista con muchos filtros en el teléfono se desliza de lado en vez de abrir un cajón; si alguna llega a tener tantos que no se lean, conviene agruparlos en ella, no volver al cajón para todas.

## Referencias

- `packages/services/src/finance.ts` (`listTickets`, `listDebts`, `listClosures`, `getClosureSheet`, `getMonthExpenses`) y `payments.ts` (`getTicketReceiptById`).
- `packages/clinic-app/src/routes/_org/finance.tsx` y `components/finance/` (`tickets-tab`, `debts-tab`, `expenses-tab`, `ticket-panel`).
- `packages/ui-patterns/src/list-filtering/filter-bar.tsx`.
