# 0172 · «Tus lentes están listos»: el aviso, Sofi y el portal

Fecha: 2026-11-08 · Estado: aceptada · Sigue a [0171](0171-el-pedido-y-los-roles-ventas-y-taller.md). Entrega 5 del plan «vistIA: plan para ópticas».

## Problema

Con el pedido en marcha (ADR 0171), la persona espera sus lentes y pregunta: «¿ya están?», «¿cuánto me falta?». Hasta ahora alguien de la óptica tenía que acordarse de llamarla, Sofi decía que lo confirmaba con el equipo y el portal no mostraba nada del pedido.

## Decisión y motivo

- **El aviso «Pedido listo» sale al marcar «Listo».** Es un aviso de lo que pasó (ADR 0040): solo lo frena «No quiero ningún mensaje» y sale a quien recibe los avisos de la persona (`serviceRecipient`), por la vía que haya:
  - la plantilla aprobada, con el texto de su producto (vistIA: «Tus lentes ya están listos para recoger en …»);
  - la respuesta, si escribió en las últimas 24 horas;
  - o el correo.

  No dice cuánto falta pagar: eso lo responde Sofi o el equipo si pregunta. Es un mensaje del catálogo común, pero solo lo piden y lo listan los productos que trabajan con pedidos (`worksWithOrders`); odentIA y latidIA no lo ven.
- **El pedido guarda su mensaje.** La pantalla dice:
  - «Saliendo», «Enviado», «Entregado» o «Leído»;
  - si falló, por qué;
  - si no se sabe si llegó.

  Uno que no salió (sin a quién, sin plantilla ni ventana, o pidió no recibir mensajes) deja dicho por qué, para que lo llamen. Reenviar es explícito: el que falló o no salió se reenvía con un toque; el dudoso, solo después de confirmarlo con la persona, para no mandarlo dos veces. Nunca se reenvía solo.
- **Sofi responde con `ver_pedidos`.** Dice en qué paso está cada pedido y la fecha prometida. Lo que falta pagar lo dice solo a quien puede oírlo: la persona, su representante legal o quien paga por ella, la misma regla que el saldo de su resumen. Nunca la receta.

  La herramienta existe solo donde el producto trabaja con pedidos (`ProductAgentTexts.orders`). Entra en los caminos de información, citas y el caso derivado solo si el turno la tiene. Así lo que lee el modelo en odentIA y latidIA no cambia: sus referencias (`__golden__`) siguen iguales.
- **«Tus pedidos» en el portal va con «Tu cuenta».** Es lo que compró y lo que le falta pagar, así que la clínica que oculta la cuenta oculta también los pedidos, sin otra opción que configurar. Muestra lo que se trabaja y el último entregado: si ya está listo para recoger, para cuándo y lo que falta. Sin la receta.
- **El control anual ya existe** («Invitar a volver» de vistIA, a los 12 meses, y «Control anual de la vista» al firmar). Esta entrega no lo cambia.

## Alternativas descartadas

- **Un aviso que arma el agente.** Lo que sale porque algo pasó lo envía el sistema, nunca un modelo (ADR 0040).
- **Reenviar solo un aviso que no se confirmó.** Mandaría dos veces el mismo mensaje cuando el proveedor no responde.
- **Una opción nueva del portal para los pedidos.** Sumaría una decisión a la clínica sin que nadie la haya pedido; si hace falta, se agrega después.
- **Meter los pedidos en el resumen del paciente de Sofi.** Cambiaría lo que lee el modelo en todos los productos.

## Consecuencias

- Al conectar WhatsApp, cada óptica pide y espera la aprobación de `vistia_lentes_listos_v1` (como `vistia_invitar_a_volver_v1`). Mientras tanto el aviso sale escrito o por correo, o el pedido dice que no salió.
- Medir a Sofi con el modelo real en una óptica queda como paso aparte (cuesta), con casos propios de «¿ya están mis lentes?».

## Referencias

`packages/services/src/job-order-notice.ts`, `packages/services/src/automation-messages.ts` (`ORDER_READY_MESSAGE`), `packages/services/src/clinic-messages.ts`, `packages/services/src/agent-operations.ts` (`listAgentPatientOrders`), `packages/agent/src/tools.ts` (`ver_pedidos`), `packages/agent/src/decision/route.ts`, `packages/services/src/portal.ts` (`listPortalOrders`), `packages/db/drizzle/0080_pedido_listo.sql`.
