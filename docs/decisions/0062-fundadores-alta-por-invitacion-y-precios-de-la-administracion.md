# 0062 · Fundadores: abrir una clínica pide invitación y la web muestra los precios de la administración

Fecha: 2026-10-18 · Estado: aceptada · Actualiza [0046](0046-web-de-marketing-en-astro.md) (la web se genera por adelantado y no llama a la API) y [0031](0031-cobro-por-accion-con-un-plan-que-vuelve-en-credito.md) (precio negociado). Lienzo «Fundadores y lista de espera», aprobado entero el 2026-10-18; issues 165 y 168.

## Problema

Mientras odentIA esté en su programa Fundadores (pocos lugares, entrada gratis, regalo para los agentes y acciones con descuento), cualquiera podía crear su cuenta, abrir una clínica y empezar la prueba sin que nadie lo viera. Además, los precios de la web estaban escritos en el código: si se cambiaban en la administración, la clínica pagaba el precio nuevo y la web seguía mostrando el viejo. Y un descuento negociado con una clínica no vencía nunca.

## Decisión y motivo

- **Se cierra abrir la clínica, no crear la cuenta.** Crear la cuenta sigue libre: la necesitan el equipo que invita una clínica y quien entra con Google, cuya cuenta se crea sola. Con «Alta de clínicas: solo con invitación» (`saas_signup_policy`, una fila que cambia la administración), `organization/create` exige la invitación Fundadores vigente de quien abre la clínica, en la cabecera `x-odentia-invitation`. Lo revisa el servidor (`createSaasPreAuthGuard`), no la pantalla. «Abierta» vuelve al alta libre sin programar nada.
- **La invitación nace de la lista de espera** (`saas_waitlist_request`): la web deja la solicitud, la administración invita y el enlace abre una sola clínica, solo con el correo invitado, y vence a los 14 días. Del token solo se guarda su huella. Al usarlo se reserva (`claimed_at`) mientras se crea la clínica, para que dos pestañas no abran dos. La clínica entra con el plan de la invitación, su prueba y sus meses de condiciones garantizadas (`guaranteed_until`). Al terminar esos meses pasa al plan por defecto, con aviso 30 días antes.
- **Un plan con lugares (`seat_limit`) es un plan por invitación:** la clínica no lo elige y la web no muestra cuántos lugares quedan.
- **La web arma cada página al servirla** (adaptador de Node de Astro) con los planes que tienen «Mostrar en la web» (`GET /api/public/founders/pricing`), guardados 30 segundos. Los buscadores siguen leyendo el HTML entero, y un cambio en la administración se ve en menos de un minuto sin desplegar. Si la API nunca respondió, la página responde 503: mejor eso que una cifra inventada.
- **Se negocia con el descuento por clínica, no con un plan por cliente.** El descuento sigue siendo un porcentaje para las tres acciones (si sube el precio de lista, la clínica conserva su porcentaje). Ahora tiene un vencimiento opcional (`discount_ends_at`): pasado ese momento, se cuenta a precio de lista (`activeDiscountBps`), y se avisa 15 días antes a la clínica y a la administración.

## Alternativas descartadas

- **Cerrar también la cuenta:** obliga a bloquear Google y a distinguir dos invitaciones (la de la clínica y la de Fundadores), con riesgo de dejar fuera a alguien del equipo. Una cuenta sin clínica no recibe nada ni cuesta.
- **Volver a publicar la web al guardar un plan:** la web se compila dentro de la imagen; publicarla desde la administración despliega admin, panel, platform y API.
- **Reemplazar cifras en el HTML ya generado:** la página cambia de forma, no solo de cifras (la tarjeta Fundadores, el destino del botón), y las islas calculan con números.
- **Leer los precios en el navegador:** el cambio sería inmediato, pero los buscadores podrían leer la página de Precios sin precios.
- **Un plan por cliente para negociar:** con el tiempo serían muchos planes casi iguales, y una subida de precio obligaría a revisarlos uno por uno.

## Consecuencias

- Beneficio: la administración decide quién entra y con qué condiciones, y cada cifra que se ve (web, registro, correo, panel) sale de un solo lugar.
- Sacrificio: la web ya no es HTML estático. Necesita la API para la primera visita de cada proceso, y el mapa del sitio lista las páginas desde `src/pages`. Las condiciones de la revisión de cobros (10 % y 2 días hábiles) siguen fijas hasta el issue 167.
- Revisar cuando termine Fundadores: si el alta queda abierta para siempre, la lista de espera y la política pueden retirarse.

## Referencias

`packages/services/src/saas-founders.ts`, `apps/api/src/routes/saas-billing.ts` (`createSaasPreAuthGuard`), `apps/api/src/routes/public-founders.ts`, `apps/web/src/lib/pricing.ts` y `src/middleware.ts`, `packages/services/src/saas-actions.ts` (`activeDiscountBps`), migraciones `0031` y `0032`.
