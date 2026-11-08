# 0164 · Cada servicio trae sus sesiones habituales

Fecha: 2026-11-08 · Estado: aceptada · Completa ADR 0161 (lo que llega a sus sesiones previstas se termina al firmar)

## Problema

Desde ADR 0161, al firmar, lo que llega a sus sesiones previstas viene en «Sí, terminar» y firmar lo termina. Pero todo tratamiento nacía con 1 sesión prevista, porque ni la biblioteca ni el servicio de la clínica guardaban con cuántas suele hacerse: una prótesis o una corona indicadas sin tocar nada se terminaban en su primera firma. Un tratamiento realizado tampoco tenía salida si le faltaba otra sesión: anular solo se puede con la atención en borrador, y volver a indicarlo cobra otra vez lo que se cobra por tratamiento. El dueño pidió que cada servicio traiga sus sesiones habituales, que el plan las herede y que se puedan sumar más.

## Decisión y motivo

- **La biblioteca sugiere el mínimo.** `catalog.treatment_template.usual_sessions` (1 a 60) lo carga `seed:procedures` desde `seeds/biblioteca_sesiones.csv` y `seeds/biblioteca_medica_sesiones.csv`, que nombran solo lo que suele llevar más de una; lo demás vale 1. Lo fijó la voz clínica de la mesa: lo que físicamente no se hace en una cita (indirectas de laboratorio, coronas y puentes, prótesis removibles, coronas sobre implante, placas y aparatos a medida, blanqueamiento interno), la ortodoncia como un tratamiento con sus controles (integral 18, limitada e interceptiva 6) y, en latidIA, los paquetes prenatales (6 y 8). La endodoncia, la cirugía y la periodoncia quedan en 1: una sesión de más deja un pendiente falso en «Por agendar», y una de menos cuesta un toque. Ninguna pasa del máximo de visitas que la explicación sugerida le dice al paciente (`procedure-seeds.test.ts`).
- **El servicio guarda las suyas; nulo es «las de la biblioteca».** `service_catalog.usual_sessions` es nula hasta que la clínica pone otras, y se lee con `usualSessionsSql` (las suyas, si no las de su tratamiento, y un servicio propio, 1). Así los servicios que ya existen toman lo sugerido sin reescribir nada de la clínica, aunque la migración corre antes de que `seed:procedures` cargue los valores. Al desligarse de su tratamiento se queda con las que tenía.
- **El plan nace con ellas.** `addPlanItem` (y el lote por piezas, el dictado y el panel de la pieza, que pasan por ahí) usa las del servicio si no se indican otras; al indicar, la pantalla las muestra y se cambian ahí mismo. Cambiar de servicio lo que aún no empieza toma las del nuevo. Cambiar el servicio no toca lo ya indicado.
- **El tratamiento directo de varias sesiones queda en curso**, como lo aceptado al hacerlo: hoy fue la primera. El de una sesión nace realizado, como antes.
- **«Falta otra sesión» desde el Plan**, solo en un realizado que llegó a sus sesiones previstas: vuelve a en curso con las hechas más una y sale en «Por agendar». No hay cargo nuevo, lo firmado no cambia (el odontograma ya dibujó lo tratado, una vez por tratamiento) y, si se cobra por sesión, la de más no se cobra si pasa el tope del presupuesto aceptado, como con «Falta otra sesión» al firmar. Uno que se terminó antes con «Completar» se terminó a propósito: reabrirlo devolvería a «por asignar» la comisión que ya se dio a su última sesión.
- **«Sí, terminar» sigue elegido** también en lo largo (ortodoncia): una sola regla. Terminar antes de lo previsto sigue siendo «Completar» en «Hecho hoy», y el cierre lo recuerda.

Vale igual en odentIA y latidIA: el catálogo, el plan y el cierre son comunes.

## Alternativas descartadas

- *Columna no nula con relleno en la migración:* la migración corre antes de `seed:procedures`, así que congelaría 1 en todas las clínicas y lo sugerido nunca les llegaría.
- *Sugerir lo típico (endodoncia en 2):* una endodoncia hecha en una cita quedaría «en curso», en «Por agendar» y con la mitad de la comisión sin asignar hasta que alguien la complete; es el error de ADR 0161 al revés.
- *Reabrir cualquier realizado:* mueve comisiones de meses ya pagados.
- *Avisar «Lo habitual: N sesiones» en el cierre:* más texto en la firma; lo cubre «Falta otra sesión».

## Consecuencias

- Una corona o una prótesis ya no se terminan en su primera firma; lo indicado antes sigue con lo que tenía y, si se terminó de más, se reabre desde el Plan.
- Dinero, con las reglas de siempre: en lo que se cobra por sesión, el presupuesto suma precio × sesiones previstas y cobra hasta ese tope; en lo que se cobra por tratamiento, la comisión se reparte entre más sesiones (ADR 0151) y la de las que faltan espera a quien las haga.
- Sacrificio: cambiar la biblioteca cambia con cuántas nace lo nuevo en las clínicas que no pusieron las suyas. Lo indicado no cambia.
- El dictado no toma «en dos sesiones»: el plan usa las habituales. Medir y cambiar Clío es otra entrega.

## Referencias

- `packages/db/src/procedure-codes.ts` (`librarySessions`), `packages/db/seeds/biblioteca_sesiones.csv`, `biblioteca_medica_sesiones.csv`, `packages/db/drizzle/0067_sesiones_habituales.sql`.
- `packages/services/src/service-catalog.ts` (`usualSessionsSql`), `plan.ts` (`addPlanItem`, `reopenPlanItemForSession`), `encounters.ts` (tratamiento directo).
- Pruebas: `usual-sessions.test.ts`, `procedure-seeds.test.ts`, `e2e/sesiones-habituales.spec.ts`.
