# 0170 · Venta de mostrador, sin ficha

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0168](0168-el-pedido-y-los-roles-ventas-y-taller.md) y precisa [0067](0067-inventario-por-sede-unidades-materiales-y-venta.md) y [0068](0068-anular-corrige-un-error-devolver-atiende-al-paciente.md). Entrega 6 del plan «vistIA: plan para ópticas», común a los tres productos.

## Problema

Todo cobro exigía una ficha: el ticket, el pago y el cargo apuntaban a un paciente. Quien entra a una óptica por unos lentes de sol, a un consultorio por unas gotas o a una clínica dental por un cepillo no es paciente, y cobrarle abría una historia clínica que no corresponde (persona única: la ficha es la historia, ADR 0001). Lo que se hacía era no registrarlo o crear fichas que no son de nadie.

## Decisión y motivo

- **El paciente es opcional solo en la venta de mostrador.** `patient_id` admite nulo en el cargo, el pago, lo aplicado, la devolución de dinero, el ticket y la devolución, y la base dice qué puede ser cada fila sin paciente: un cargo sin ficha es solo un producto (nada del plan, del presupuesto ni de una atención, ni promoción ni comisión); un ticket sin ficha no usa saldo a favor ni tiene quien pague por otro; una devolución sin ficha siempre se paga (`pagado`), nunca queda a favor; y un disparador no deja unir lo que no tiene ficha con lo que sí (un pago, lo aplicado o una devolución del mostrador con la cuenta de un paciente).
- **Quien compra es un contacto, un nombre o nadie.** El ticket guarda `buyer_contact_id` (cualquier persona, sea o no paciente, con su clave compuesta) o `buyer_name` (lo escrito, que no crea a nadie), nunca los dos, y congela en su `snapshot.buyer` el nombre de ese día. Sin nadie, se dice «Venta de mostrador»; con alguien, el ticket y el PDF dicen «Cliente: …» en lugar de «Paciente: …». Aunque la persona sea paciente, la venta no entra en su cuenta: es otra operación, y la pantalla lo informa sin frenar.
- **No tiene reglas de dinero propias.** `sellAtCounter` usa las piezas de `createCharge` y `collectCharge`: precio de venta × cantidad, impuesto de productos congelado, salida del almacén por el lote que vence primero (con faltante si no alcanza), medios, moneda en que entra, cambio, vuelto, ticket en la misma serie sin saltos y la caja de la sede. Lo único distinto: se paga entera en el momento, así nunca deja deuda ni saldo a favor; lo que sobra del efectivo es el vuelto. Un reintento con la misma clave devuelve el mismo ticket y otro contenido con ella es un conflicto dicho en palabras; sin cuenta que bloquear, anular y devolver bloquean el ticket.
- **Después, el ticket de siempre.** Se abre en Cobros por su id, se imprime, se anula (vuelve el producto, sale el dinero de la caja) y se devuelve (vuelve lo que está bien y se le paga), por rutas de Finanzas sin ficha. La historia bloqueada de quien compró se guarda como la de un paciente (ADR 0080).
- **Nada lo pierde al leer.** Cobros, lo que suma, la caja y su arqueo, el buscador y las vistas de Argos (`cobros`, `tickets`, `ventas`, `pagos_por_venta`, con «Venta de mostrador» y sin `paciente_id`; el nombre escrito no entra, Argos no lee texto libre) ya no se unen a la ficha con un `JOIN` que la dejaba fuera. Las deudas siguen leyendo solo fichas: una venta de mostrador nunca debe.

## Alternativas descartadas

- **Una ficha «Mostrador» por clínica.** Sería una historia clínica falsa que acumula compras de desconocidos, con su saldo a favor y su deuda mezclados.
- **Crear la persona y su ficha al vender.** Abre una historia a quien solo compró unas gotas y obliga a pedir datos que no hacen falta.
- **Tablas aparte para el mostrador.** Duplicaría el ticket, la numeración, la caja, el arqueo, anular y devolver, y cada lectura de dinero tendría que sumar dos lugares.

## Consecuencias

- Enviar el ticket por WhatsApp o correo sigue siendo de una ficha (se envía a sus personas): el de una venta de mostrador se imprime.
- Por ahora la pantalla vende en la moneda de la clínica; el servicio ya acepta otra moneda y el cambio, como un cobro.
- Lo que una persona compró en el mostrador aún no se lista en su página.

## Referencias

`packages/db/src/schema/clinical.ts`, `packages/db/drizzle/0074_venta_de_mostrador.sql`, `packages/services/src/counter-sale.ts`, `packages/services/src/ticket-party.ts`, `packages/services/src/payments.ts` (`productSaleOf`, `collectMethodsOf`, `recordTicketCash`, `voidTicket`, `returnFromTicket`), `apps/api/src/routes/finance.ts` (`/counter-sales`), `packages/clinic-app/src/components/finance/counter-sale-drawer.tsx`.
