# 0092 · Una lista de precios por producto

Fecha: 2026-10-26 · Estado: aceptada · Sigue a [0085](0085-cobro-por-tipo-de-accion.md) y [0087](0087-dos-dominios-y-el-producto-de-la-clinica.md). Lienzo «Planes por producto», aprobado el 2026-10-26.

## Problema

odentIA y latidIA usaban una sola lista: «Plan odentIA» era el único plan por defecto y «Fundadores» el único plan por invitación. Las dos webs publicaban los mismos precios, un consultorio de latidIA nacía y se contaba con el plan de odentIA, y las solicitudes de las dos webs gastaban los mismos 20 lugares. Cambiar un precio de un producto cambiaba el del otro.

## Decisión y motivo

- **Cada plan es de un producto** (`saas_plan.product`, `dental` o `medical`). Se elige al crearlo y no cambia (`updateSaasPlan` lo rechaza): sus clínicas, sus Fundadores y su web son de ese producto. Para un producto nuevo se crea un plan «empezando con los precios de» otro.
- **Un plan por defecto por producto** (`saas_plan_default_uidx` sobre `product`). Todo lo que buscaba «el plan por defecto» busca el del producto de la clínica (`defaultPlanOf`): la prueba, el precio por acción, las condiciones de la clínica, Plan y pagos, el descuento de Fundadores y el plan al que pasa una clínica al terminar sus 12 meses. Una clínica solo elige o recibe planes de su producto.
- **Fundadores por producto.** La solicitud guarda su producto y se invita con el plan por invitación de ese producto, con sus propios lugares.
- **El alta, por producto** (`saas_signup_policy.mode` para odentIA y `medical_mode` para latidIA). Las dos empiezan como estaban.
- **La web pide su lista** (`/api/public/founders/pricing?product=`), porque llama a la API por la red interna y su dominio no llega. Sin decirlo, vale el dominio de la petición.
- **La prueba de un consultorio nuevo.** El disparador `saas_trial_on_org_create` corre al crear la organización, antes de saberse el producto, y usa la prueba del plan de odentIA. `startSaasTrial` la corrige con la del plan de latidIA cuando la clínica es de latidIA.
- **Lo que sigue siendo uno solo:** las condiciones comerciales, los medios de pago, las comisiones y el presupuesto de cada clínica. Las clínicas que ya tienen plan lo conservan.

## Alternativas descartadas

- **Una lista con precios por producto dentro de cada plan.** Duplica cada campo y obliga a comparar dos columnas en cada pantalla; un plan por producto se edita y se publica solo.
- **Cambiar el producto de un plan.** Movería de golpe las clínicas y la web de un producto al otro.
- **Que el disparador sepa el producto.** El perfil de la clínica se crea después de la organización; leerlo en el disparador obligaría a cambiar el orden del alta en todos los caminos.

## Referencias

`packages/db/src/schema/saas-billing.ts` y `packages/db/drizzle/0004_planes_por_producto.sql`, `packages/services/src/saas-plan-product.ts` (`defaultPlanOf`), `saas-billing.ts`, `saas-founders.ts`, `saas-terms.ts`, `saas-actions.ts`, `apps/admin/src/routes/_app/billing.tsx` y `components/plan-drawer.tsx`, `apps/web/src/lib/pricing.ts`.
