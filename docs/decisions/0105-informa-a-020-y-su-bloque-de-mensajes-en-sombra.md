# 0105 · Informa a USD 0,20 y su bloque de mensajes, primero en sombra

Fecha: 2026-10-29 · Estado: aceptada; implementados el precio de los planes de ejemplo, el peor costo medido, el tope por plan y la sombra en «Costo y margen»; cobrar el bloque queda para cuando se mida con clínicas reales · Precisa [0085](0085-cobro-por-tipo-de-accion.md) (el precio de Informa y lo que cubre).

## Problema

La conversación «Informa» de Sofi se cobra una vez por persona en la ventana de las condiciones comerciales (24 horas), escriba lo que escriba: USD 0,10 y, con el 50 % de Fundadores, 0,05.

La auditoría de Sofi (issue darvin2c/odentIA#328) midió, en más de 1.100 conversaciones simuladas, lo que cuesta en modelos cada mensaje de la persona: unos USD 0,0011 en la conversación típica, 0,0014 en el 10 % más caro y 0,0023 en el peor caso. La conversación más cara costó USD 0,041 (28 mensajes de la persona), casi el triple del peor costo con que se comprobaba cada plan (USD 0,015, «unas 20 respuestas»). Con 0,05, Fundadores valía 1,2 veces esa conversación, lejos del doble que pide la 0085, y nada acotaba lo que cuesta quien escribe mucho en un día. La 0085 no admite topes que callen al agente: el límite no puede ser dejar de responder.

La conversación típica tiene 7 mensajes de la persona; 1 de cada 10, 17 o más; el 1,3 %, 25 o más, y la más larga, 31.

## Decisión y motivo

- **Informa pasa a USD 0,20; Fundadores, a 0,10.** Se mantiene «Fundadores, 50 % menos en todo» y sigue sin descuento negociado. Los precios de producción los pone la administración; el código cambia los planes de ejemplo y pone al día los de la semilla que nadie cambió.
- **Su peor costo pasa a USD 0,041** (`SAAS_WORST_COST_MICROS`), la conversación más cara medida, como pide `eval:month` cuando una lo pasa. Informa vale 4,9 veces su peor costo y Fundadores 2,4; el 0,05 de antes quedaría «Atento».
- **Cada Informa cubre hasta N mensajes de la persona en su ventana** (`saas_plan.inform_message_limit`, 25 en los planes de ejemplo; nulo = sin tope). Pasado N contaría otro Informa al mismo precio, y así por cada bloque. El peor bloque de 25 cuesta unos USD 0,056: Fundadores lo cubre 1,8 veces y el precio normal, 3,6. Solo Informa: Gestiona y Agenda cubren cientos de mensajes con su precio.
- **Se cuentan los mensajes de la persona que atendió Sofi**, uno por mensaje, con la misma constancia del libro de corridas que usa Sofi para no responder dos veces: los que respondió o derivó y los que leyó en la ráfaga de otro (`attendedMessagesByWindow`). No cuentan las respuestas de Sofi —si repite o responde a pedazos, que son fallas nuestras, la clínica no paga más—, ni lo que escribe el equipo, ni lo que no llega al agente (botones, «BAJA», correos automáticos, spam, bloqueados), ni las pruebas.
- **Primero en sombra.** La administración ve en «Costo y margen» de cada clínica cuántas conversaciones Informa pasarían el tope, cuántos Informa de más se contarían, lo que costarían y la conversación más larga. Nadie lo paga. Con datos de clínicas reales se confirma N y se decide cobrarlo.

## Alternativas descartadas

- **Subir Informa a 0,20 sin tope.** Cubre lo medido, pero no protege de la conversación excepcionalmente larga.
- **Pasar a «Gestiona» la conversación que supera N mensajes.** Gestiona dice que Sofi movió, canceló o reservó una cita; usarlo para «escribió mucho» confunde a la clínica y salta de 0,20 a 0,50 en un mensaje.
- **Contar las respuestas de Sofi o los mensajes de ida y vuelta.** Siguen un poco mejor el costo (R² 0,78 frente a 0,73), pero la clínica pagaría más cuando Sofi repite y cada mejora de fluidez bajaría lo cobrado.
- **Un tope que deja de responder.** Lo descartó la 0085: el único límite es el presupuesto de la clínica.

## Consecuencias

- La clínica paga el doble por la conversación que solo informa; sigue muy por debajo de los agentes de atención internacionales (USD 0,50 a 2 por conversación, ADR 0031).
- Un plan que deja negociar Informa ya no se guarda si, al descuento máximo, queda bajo USD 0,082.
- La sombra no toca lo cobrado: ni filas nuevas en `saas_action`, ni el presupuesto, ni la factura.
- Cobrar el bloque exige, en el mismo cambio: una fila Informa por bloque (revisando lo que hoy supone una sola fila por ventana: `hasOpenConversationAction`, `refreshConversationTier`, `sofiActionOf`), cambiar los textos que dicen «aunque escriba diez mensajes» (`saas-actions.ts`, `saas-commercial-terms.ts`, la web, Plan y pagos), decirlo en una línea de las condiciones y de la factura («2 × Informa (52 mensajes)») y publicar las condiciones nuevas.
- Revisar N si la sombra muestra que muchas conversaciones lo pasan, o si cambia el costo por mensaje (más contexto o más caché).

## Referencias

`packages/db/src/schema/saas-billing.ts` (`informMessageLimit`), migración `0018_informa_por_bloques.sql`; `packages/services/src/saas-actions.ts` (`attendedMessagesByWindow`, `getActionPricing`, `SAAS_WORST_COST_MICROS`), `saas-cost.ts` (`informBlocksShadow`), `saas-billing.ts` (validación del plan), `seed-saas-billing.ts`; `apps/admin/src/components/plan-drawer.tsx` y `org-spending.tsx` (`InformBlocksNote`); pruebas en `saas-inform-blocks.test.ts`.
