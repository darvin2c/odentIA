# 0221 · Termina Fundadores: el alta es libre y su plan queda como plan especial

Fecha: 2026-11-26 · Estado: aceptada · Reemplaza a la [0062](0062-fundadores-alta-por-invitacion-y-precios-de-la-administracion.md) en el alta por invitación, la lista de espera y los lugares; la web sigue leyendo los precios de la administración. Generaliza la [0192](0192-una-clinica-que-ya-existe-pasa-a-fundadores.md). Lienzo «Termina Fundadores: empieza gratis», aprobado el 2026-11-26.

## Problema

Para abrir una clínica había que pedir una invitación y esperar 2 días hábiles. La web vendía con los precios de Fundadores, sin cuota y a mitad de precio, que no son los que paga la mayoría de las clínicas. El programa ya no trae a nadie: la lista de espera estaba vacía y había una sola clínica en Fundadores.

## Decisión y motivo

- **El alta es libre.** Cualquiera crea su cuenta y abre su clínica al momento, con la prueba del plan de lista, por ejemplo 30 días y USD 100 de regalo, sin tarjeta. El servidor ya no lee `saas_signup_policy`. Lo más simple que da valor: la espera solo frenaba a quien quería empezar.
- **La web muestra el plan de lista tal como es.** Por ejemplo, USD 59 al mes que vuelven como crédito, y los precios completos. Se quitan las frases que con una cuota dejan de ser ciertas, como «No pagas por el software» y «El sistema completo USD 0». Las cifras siguen saliendo de la administración. No hay página de «cierre»: decir «por la gran acogida» sería inventar.
- **El plan Fundadores queda como plan especial.** Un plan especial es un plan activo de su producto que no sale en la web y no es el de lista. Ya no se reconoce por tener lugares. La administración lo asigna por negociación con «Cambiar a un plan especial» (`moveClinicToSpecialPlan`), con la misma operación de la invitación: la prueba empieza de nuevo y los meses quedan garantizados. Esto vale solo para una clínica en prueba; a una que ya paga se le negocia con el descuento por clínica con fecha de fin. Las clínicas que ya lo tienen no cambian, y al terminar sus meses pasan solas al plan de lista.
- **La invitación de la venta se queda, solo para la administración.** Cuando el equipo cierra una propuesta con alguien que aún no tiene cuenta, el enlace abre su clínica con lo negociado y la une a su ficha. Ya no hace falta para entrar. Sin plan elegido, la invitación lleva el plan de lista.
- **Se quitan la solicitud pública, el modo de alta y los lugares.** Desaparecen el formulario y `POST /api/public/founders/waitlist`, el interruptor «Alta de clínicas», `seat_limit` en el código y el correo «estás en la lista». La dirección `/api/public/founders/*` conserva su nombre porque la web ya publicada la usa.
- **vistIA todavía no tiene plan de lista.** Su web dice «Escríbenos» en vez de «Empieza gratis». El servidor no la frena: los entornos sin planes también abren clínicas en prueba.

## Alternativas descartadas

- *Dejar el alta por invitación con el interruptor en «Abierta».* Mantiene un concepto, una tabla y una pantalla que nadie usa.
- *Que la web siga mostrando los precios de Fundadores.* Serían precios que ninguna clínica nueva puede tener.
- *Quitar también la invitación de la venta.* El equipo tendría que asignar a mano el plan y unir la clínica a su ficha después de que se registre.
- *Frenar en el servidor a un producto sin plan de lista.* Dejaría sin abrir clínicas a todo entorno sin planes cargados, como las pruebas o un desarrollo nuevo.

## Consecuencias

- Cada clínica nueva recibe su regalo de prueba sin que nadie la revise. Por ahora no hay tope por persona; las clínicas nuevas se ven en Hoy de la administración.
- La migración `0161` apaga «Mostrar en la web» en los planes que tenían lugares. También deja abierta el alta de odentIA y latidIA, para que la API anterior no pida invitación mientras se publica la nueva.
- Pendiente, en un cambio aparte cuando este ya esté en producción: borrar `saas_signup_policy`, `saas_plan.seat_limit`, `saas_commercial_terms.waitlist_answer_days` y los nombres internos de Fundadores (`saas-founders.ts`, la dirección `/founders`). También decidir el buzón `fundadores@`, que sigue recibiendo por si alguien responde a un correo viejo. Las solicitudes (`saas_waitlist_request`) se quedan: son las del ARM.

## Referencias

`packages/services/src/saas-founders.ts` (`getSpecialPlanMove`, `moveClinicToSpecialPlan`, `getPublicPricing`, `inviteFromWaitlist`), `apps/api/src/routes/saas-billing.ts` (`createSaasPreAuthGuard`), `apps/api/src/routes/public-founders.ts`, `apps/web/src/lib/offer.ts` y `pricing.ts`, `packages/db/drizzle/0161_termina_fundadores.sql`.
