# 0179 · La Ayuda pregunta aparte si le piden un dato de la clínica

Fecha: 2026-11-10 · Estado: aceptada · Precisa la [0178](0178-la-ayuda-decide-en-dos-pasos-y-redacta-si-hace-falta.md)

## Problema

Quien escribe en la Ayuda «¿cuánto cobramos este mes?» pide una cifra de su clínica, que responde Argos y no la guía. La 0146 y la 0178 lo dejaban como una opción más («datos») dentro de la pregunta que elige la respuesta o la categoría. Casi nunca ganaba: la pregunta se parece a la pantalla donde está esa cifra, y la probabilidad se repartía entre «datos», Reportes y Cobros. En la confirmación de la 0178 se reconoció el 11 % (4 de 35); el resto terminó en «No estoy segura de qué preguntas» o en «Esto no está en la guía».

## Decisión y motivo

- **Una pregunta de sí o no propia (`help_data`, `help.v3`):** «¿pide una cifra, una lista o un dato de su propia clínica, o pregunta cómo se usa el sistema?». Se hace a la vez que la de la categoría, con el mismo texto y sin sumar demora. Sola, Jev la responde bien: en los bancos de ajuste dio 0,90 o más a 21 de las 27 preguntas de cifras, a 5 de las 459 que la guía responde y a ninguna de las 88 ajenas.
- **Desde 0,90 (`HELP_DATA_CONFIDENT`) va a Argos, salvo que la guía la responda segura.** «¿Quién me espera ahora?» o «¿qué citas faltan confirmar?» también piden un dato, pero la guía dice en qué pantalla verlo y Argos no lo responde: ahí gana la guía. Sin una respuesta segura, no se ofrecen opciones ni se busca en el resto de la guía.
- **Si esa pregunta falla, decide la guía sola,** como antes.
- **La opción «datos» sigue en las otras dos preguntas:** quitarla cambia lo ya medido de ellas y no hacía daño.

## Alternativas descartadas

- **Mandar a Argos todo lo que pase de 0,90, sin mirar la guía:** una llamada menos, pero las preguntas por lo que una pantalla muestra ahora mismo acaban en Argos, que no las responde. En los bancos de ajuste fueron 6 respuestas de la guía perdidas, contra 1.
- **Bajar el umbral a 0,80:** reconoce 2 más de 27 y confunde 17 de la guía en vez de 5.
- **Reescribir la opción «datos» de la categoría:** compite contra 33 categorías que se le parecen; el problema es la forma de la pregunta, no su texto.

## Consecuencias

- **Medido con Jev real el 2026-11-10** (`eval:ayuda-pasos`; registros en `packages/agent/eval/ayuda-mediciones/`, los `v3`), sobre la misma guía y los mismos bancos de la 0178:
  - **Confirmación (ronda, ciego y cifras; n = 297, redactando).** Reconoce el 74,3 % de las preguntas de cifras (26 de 35; antes, 11,4 %) y manda a Argos por error 1 que la guía respondía. Lo demás queda igual: de lo mostrado es correcto el 95,4 %, calla lo que la guía no responde el 98,6 %, resuelve solo o con un toque el 89,7 % (antes 90,1 %), seguro y mal 6. Cumple los cuatro mínimos.
  - **Ajuste (desarrollo, control y final; n = 574).** Reconoce el 74,1 % (20 de 27; antes, 7,4 %) y manda a Argos por error 1. De lo mostrado es correcto el 96,8 % (antes 97,6 %), calla el 96,5 % (igual), resuelve el 92,8 % (antes 93,2 %), seguro y mal 8 (antes 6). Las respuestas seguras no pasan por la pregunta nueva: esa diferencia es lo que Jev cambia de una corrida a otra. Esta corrida se hizo con dos respuestas de Reportes que después se sacaron; la de la guía final no terminó, porque la cuenta de Jev se quedó sin crédito.
  - **Costo y demora.** Tres llamadas lo habitual en vez de dos; la nueva es corta: USD 0,00036 por pregunta (antes 0,00034) y el mismo p95, porque va en paralelo.
- **Los bancos de confirmación ya no confirman nada sobre «datos».** Se corrieron varias veces en este cambio para separar causas, y del banco `cifras` se leyeron dos preguntas. Lo siguiente que se ajuste de «datos» necesita preguntas nuevas.
- **Lo que no se resolvió: explicar una cifra en la guía.** Se escribieron dos respuestas («¿Qué cuenta como paciente activo?», «¿Qué suma "Cobrado"?») y se sacaron: con ellas, preguntas como «¿por qué bajó Cobrado?» recibían esa explicación como respuesta segura, y lo mostrado correcto bajaba a 93,5 %, bajo el mínimo. Qué cuenta cada cifra lo dice hoy la propia pantalla y `report-figures.ts`.
- **Queda una de cada cuatro sin reconocer:** las que preguntan por qué una cita o un dato no aparece, y las de precio de un servicio.
- **Qué invalida lo medido:** cambiar el texto de `help_data` o su umbral. `product-prompts.test.ts` lo atrapa (`__golden__/ayuda-pasos.json`).

## Referencias

- **Servicios:** `packages/services/src/help-decision.ts` (`helpDataQuestion`, `readHelpData`), `help.ts` (`decideHelp`).
- **Agente:** `packages/agent/src/decision/fake.ts`, `eval-ayuda-pasos.ts`.
