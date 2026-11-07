# 0150 · Presupuesto con caminos: lo común se responde sin elegir y la revisión pregunta solo lo que cambió

Fecha: 2026-11-07 · **Estado:** aceptada · Precisa [0034](0034-un-plan-una-seccion.md) (opciones, lo propio del odontólogo) y [0144](0144-el-presupuesto-enviado-abre-su-oportunidad.md) (ganar en parte)

## Problema

La QA del 6 nov siguió a una persona con resina y profilaxis, y la 46 con dos caminos (conservar: endodoncia y corona; extraer: exodoncia e implante). Las opciones solo existían en el presupuesto y nacían después, duplicando: al firmar, el cierre sumaba los dos caminos y el plan mostraba la 46 con los cuatro tratamientos a la vez. Para anotar «acepto la resina y la limpieza, lo de la muela lo pienso», recepción tenía que elegir una opción que la persona no eligió: la otra quedaba «No elegida» y la oportunidad «Ganada» con lo de la 46 por decidir, sin nadie que llamara. Subir el precio de la corona volvía a preguntar todo, también lo hecho y cobrado, y dejaba cambiar su precio. Y el odontólogo no veía el presupuesto que había armado una colega del mismo paciente.

## Decisión y motivo

- **Los caminos se marcan donde se deciden, en la atención** (`placeBudgetPath`): al indicar otro tratamiento de la misma pieza, la fila pregunta si es otro camino. No es otro registro: cada camino es una opción del borrador de la persona, como ya las arma Clío al dictar «resina, o si no corona», y lo común va en todas. Un presupuesto lleva un solo grupo de caminos (hasta tres opciones): con dos piezas dudosas saldrían combinaciones que nadie arma. Solo donde lo indicado espera respuesta (odentIA); en latidIA lo indicado nace aceptado y sigue con «Duplicar como otra opción».
- **El plan sabe qué compite sin guardarlo aparte**: cada tratamiento trae su `path`, calculado de las opciones de su presupuesto vigente. Mientras la persona elige, lo de los caminos va fuera de las fases y del avance; el camino que no eligió queda plegado.
- **Lo común se responde sin elegir camino** (`decideBudget` sin `optionId`): lo que está en todas las opciones con las mismas condiciones (precio, cobro, sesiones y promoción; se sabe qué precio vale) se acepta, se deja para después o se rechaza; lo de un solo camino solo se deja para después o se rechaza, porque aceptarlo es elegirlo. Lo que espera (sin respuesta o pensándolo) se completa después, y entonces también se elige el camino. Es la misma operación para la clínica, el portal y Sofi.
- **«Espera respuesta» incluye lo que falta responder de un parcial** (`OPEN_LINE_DECISIONS`: `pendiente` o `pospuesto`), en código y en SQL.
- **La oportunidad se decide al final** (precisa la 0144): mientras el presupuesto espera respuesta en algo, sigue abierta y vale lo que espera; cuando ya no queda nada, se gana con lo aceptado o se pierde.
- **La revisión pregunta solo por lo que cambió**: sin camino elegido lleva todos los caminos; al entregarla, lo aceptado que no cambió de condiciones y lo hecho o cobrado quedan aceptados (`carryRevisionAnswers`), y si nada cambió queda aceptada como la anterior. El precio de lo hecho o cobrado no cambia en un borrador (`BUDGET_LINE_USED`). «Qué cambió» se calcula al leer comparando con la versión anterior (`budgetChanges` en `@odentia/clinical`) y sale en la pantalla y en el PDF. La versión anterior no se toca.
- **El odontólogo lee el presupuesto de su colega** (precisa la 0034): es contexto de su paciente y ya lee la historia. Cambiarlo, enviarlo, anularlo o anotar su respuesta sigue siendo de quien lo preparó (`ownBudgetSql`); cada presupuesto dice `canChange`.
- La decisión sigue guardándose en la línea y en el tratamiento: la línea es la respuesta a esa versión y fija el precio que se cobra; el tratamiento, la decisión vigente, que también escriben caminos sin presupuesto.

## Alternativas descartadas

- **Columnas de grupo y camino en el tratamiento.** Daban al plan su propio registro de lo que compite, pero quedaban otra vez dos lugares que pueden contradecirse (las opciones y las columnas), que era la causa de los errores.
- **Juntar plan y presupuesto en un solo objeto en pantalla y quitar la doble escritura de la decisión.** No cabía en una entrega, tocaba unos veinte lectores y no hay un caso medido de que los dos bloques confundan más que los estados que se contradecían.
- **Medir antes en producción cuántos presupuestos usan opciones.** Clío ya arma caminos al dictar y marcarlos no agrega pasos; se decidió hacerlo y mirar el uso después.
- **Cerrar sola la respuesta de lo vencido.** La 0144 ya cierra la oportunidad a los 30 días; el presupuesto solo dice «Venció el…».

## Consecuencias

- Recepción anota lo que la persona dijo, sin inventar una elección; nadie pierde de vista lo que falta decidir; caja sigue cobrando lo último aceptado mientras una revisión espera.
- Sacrificio: una pieza con caminos por presupuesto; la constancia firmada de la negativa sigue pendiente (va con el consentimiento); «Retomar un presupuesto» de Argos aún mira solo lo enviado.
- Revisar si las clínicas piden caminos en varias piezas a la vez o marcarlos desde el odontograma.

## Referencias

`packages/services/src/budget-paths.ts`, `budgets.ts` (`decideBudget`, `commonPlanItems`, `reviseBudget`, `carryRevisionAnswers`, `usedPlanItems`, `listBudgets`), `budget-awaiting.ts`, `opportunities.ts` (`decideBudgetOpportunity`), `plan.ts` (`pathsOf`), `agent-operations.ts` (`budgetAnswerOf`), `packages/clinical/src/budget-changes.ts`. Pruebas: `budget-paths.test.ts`. Lienzo «presupuesto y plan» de la QA del 6 nov.
