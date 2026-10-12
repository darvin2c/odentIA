# Cobro atómico con ticket numerado por organización

- Fecha: 2026-10-11.
- Estado: aceptada.

## Problema

Cobrar exigía tres formularios (registrar pago, aplicarlo, vincularlo a un turno) y la caja se abría antes de cobrar, lo que bloqueaba el cobro y duplicaba reglas entre pantallas, portal y agente. Las cuotas calendarizaban deuda sin fechas ni avisos reales, y las comisiones tenían reglas por base/servicio/sede difíciles de auditar.

## Decisión y motivo

- Un solo `collectCharge` transaccional: ticket numerado único por organización (contador `ticket_counter` bajo lock, sin saltos por rollback), un pago por medio con snapshot congelado, aplicación automática del saldo a favor y reparto FIFO, todo en la caja de la sede. Idempotente por `requestId`.
- La caja no se abre: se crea sola al primer movimiento y solo se cierra (arqueo de efectivo, retención y entrega). Cobrar nunca se bloquea.
- Cuotas retiradas: el pago parcial ya deja el resto por cobrar sin configuración. La evidencia anterior se archiva en `audit_event` (`installment.archived`), nunca se borra deuda real.
- Comisión: tasa única por profesional sobre lo cobrado de lo que atendió; el pago queda como gasto de Personal y se registra en un paso. Un mes admite varios pagos (cada uno cubre lo pendiente hasta entonces) y un cobro nunca entra en dos. Lo pagado conserva su tasa; un cobro anulado después de pagado se descuenta del siguiente pago.
- El cierre se identifica por la ventana contada: repetirlo devuelve el mismo cierre. Lo que entra o sale por un medio que no es efectivo no cambia el efectivo esperado.
- Anular un ticket revierte lo que sus pagos cubrieron también en otros tickets (un adelanto ya usado): ese concepto vuelve a quedar por cobrar.
- Ninguna moneda se asume: sin perfil regional no se registra dinero, y las tablas clínicas no tienen moneda por defecto.
- Nada se borra: anulaciones y devoluciones revierten efectos con motivo y dejan ticket/gasto marcados.

## Alternativas descartadas

- Numeración por sede: complica traslados y conciliación del reporte mensual; se eligió única por clínica (lámina 8 del plan).
- Conservar cuotas con fechas y recordatorios: exige un programador de vencimientos sin valor probado; volverían como trabajo propio si se piden.
- Reabrir turnos o editar cierres: rompe la inmutabilidad del arqueo; lo posterior corrige como movimiento del día en que se corrige.

## Consecuencias

- El ticket es el documento interno (no fiscal); el módulo fiscal por país se engancha al cobro después (issue 38).
- La compensación post-cierre de una anulación administrativa puede dejar el contado en negativo como corrección visible del día; gastos, retiros y devoluciones normales nunca.
- Revisar si se exige factura electrónica por cobro o multimoneda por sede.

## Referencias

- `packages/services/src/payments.ts` (`collectCharge`, `voidTicket`, `refundCredit`), `packages/services/src/finance.ts` (caja, cierres, comisiones, resultado mensual).
- Migraciones `0047_finanzas_integradas`, `0048_invariantes_financieras`, `0049_precios_promocionales_activos`, `0050_finanzas_correcciones`.
- Permisos: `budgets.*`, `commissions.*`, `finance.close`, `finance.admin`, `catalog.read` en `packages/auth/src/permissions.ts`.
