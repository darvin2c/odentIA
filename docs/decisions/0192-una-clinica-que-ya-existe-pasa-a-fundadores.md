# 0192 · Una clínica que ya existe pasa a Fundadores desde la administración

Fecha: 2026-11-15 · Estado: aceptada · Extiende la [0062](0062-fundadores-alta-por-invitacion-y-precios-de-la-administracion.md) (la invitación Fundadores) y sigue a la [0185](0185-el-arm-de-la-administracion.md) (el ARM)

## Problema

A Fundadores solo se entraba con la invitación de la lista de espera, y esa invitación abre una clínica nueva. La primera clínica real entró por el alta asistida, sin invitación: quedó en la prueba del plan de lista, sin los meses garantizados ni su lugar, aunque se le había ofrecido Fundadores. No había cómo corregirlo. Desde su panel, el plan sale «solo por invitación». «Asignar plan» de la administración es para clínicas sin suscripción. Cambiar el plan a mano no pone los meses (la clínica quedaría en Fundadores para siempre) ni ocupa su lugar.

## Decisión y motivo

- **«Pasar a Fundadores» en Plan y pagos de la ficha** (`moveClinicToFounders`), solo para el rol Administración. Deja la suscripción como al entrar con la invitación, con la misma operación (`enterInvitationPlan`, la de `completeFounderInvitation`): el plan por invitación de su producto, su prueba desde ese día y sus meses garantizados. Un descuento negociado en el plan de lista se quita: Fundadores trae sus precios, y al terminar sus meses vuelve al precio de lista, como una Fundadora invitada. El presupuesto del mes no cambia. La confirmación dice antes todo eso.
- **Solo una clínica en prueba, que no es una demo y que nunca fue Fundadora**: ni entró con la invitación ni se la pasó antes, aunque sus condiciones ya terminaran. A una clínica que ya paga no se le reinicia la prueba ni el mes.
- **Su lugar queda en la auditoría** (`saas.founders_entered` en `admin_audit`, con el plan) y `founderSeats` lo suma a las entradas e invitaciones vigentes de la lista de espera. El plan se bloquea como al invitar: dos a la vez no toman el mismo lugar.

## Alternativas descartadas

- *Crear una solicitud «entró» en la lista de espera:* pide celular, ciudad, cuántos atienden y qué usan, datos que la clínica nunca dio. Habría que inventarlos.
- *Cambiar el plan con «Asignar plan» o a mano en la base:* sin meses garantizados ni lugar, y sin constancia de quién lo hizo.
- *Invitarla con la lista de espera:* la invitación abre otra clínica.

## Consecuencias

- Una clínica del alta asistida puede tener las mismas condiciones que una que entró con la invitación, y el tope de lugares cuenta a las dos.
- Su prueba empieza de nuevo ese día, como al entrar con la invitación.
- Revisar si el alta asistida debe poder abrir la clínica ya en Fundadores, si vuelve a pasar.

## Referencias

`packages/services/src/saas-founders.ts` (`moveClinicToFounders`, `getFoundersMove`, `founderSeats`), `apps/api/src/routes/admin-organizations.ts` (`POST /:id/billing/founders`), `apps/admin/src/components/org-billing.tsx`; pruebas en `packages/services/src/saas-founders.test.ts`.
