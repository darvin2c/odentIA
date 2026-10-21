# 0070 · Argos responde con las cifras de Reportes

Fecha: 2026-10-20 · Estado: sustituida en parte por [0075](0075-argos-consulta-vistas-del-negocio.md) (el modelo ya no elige de un catálogo cerrado) · Amplía [0015](0015-administrador-lineas-prendidas-o-apagadas.md) sin contradecirla. Lienzo «Reportes odentIA · cómo va el negocio», página «Pregúntale al Administrador», aprobado entero el 2026-10-18 (decisiones 6, 7 y 8; fase 5).

## Problema

Quien dirige la clínica pregunta cosas como «¿qué profesional tiene más inasistencias?» o «¿cuánto me trajo el agente?». La respuesta ya está en Reportes, pero repartida en cinco pestañas. La competencia ofrece «Reportes IA» en los que un modelo escribe la cifra, y en su propio ejemplo los números no cuadran. Argos no puede inventar ni contradecir a la pantalla.

## Decisión y motivo

- **Un catálogo de cifras, declarado una vez** (`REPORT_FIGURES`). Son 32 cifras, y cada una dice:
  - qué pregunta responde, cómo se calcula y cómo se puede agrupar (por mes, sede, profesional, canal, tratamiento, medio de pago, tipo de gasto, cómo nos conocieron o antigüedad);
  - si es de toda la clínica, si se mide al cierre o a hoy, qué lista abre y si pide Facturación.
  - Se calcula con **la misma consulta de su pestaña**. Lo que la cifra no sabe agrupar se responde con la agrupación que sí tiene, y se dice.
- **El modelo de decisión solo elige de listas cerradas.** Es Jev (0047), o el modelo de chat de la clínica si falta la clave, con preguntas cerradas.
  - Elige de qué trata la pregunta, el área, la cifra de esa área (una lista corta por área, por el sesgo hacia la primera opción), cómo agruparla y si pide un filtro que no existe.
  - Al proveedor viaja solo el texto de la pregunta.
  - El periodo, la sede y el canal se leen con reglas.
  - Lo que la pregunta dice con todas las letras («qué tratamiento», «por Instagram») deja solo las cifras que se agrupan así (`insteadFor`).
  - Las palabras clínicas se reconocen sin modelo.
- **Ninguna cifra sale del modelo.** La frase es una plantilla con lo calculado, y la pantalla la dibuja tal cual, con el gráfico y «Así lo calculé».
- **Cuando no es una cifra:**
  - Si duda, pregunta entre dos o tres cifras.
  - Si no la tiene, dice «Todavía no sé», con lo más cercano y «Enviarlo a odentIA como pedido» (la vía de la Ayuda).
  - Lo clínico no le toca.
  - Si le piden hacer algo, dice qué línea prender. Solo lee.
- **Se guarda la pregunta entendida, nunca lo escrito.** `report_question` anota la cifra, la agrupación y cómo terminó. Sirve para sumar las más pedidas y para el tope: 200 preguntas con modelo por clínica en 24 horas. Tocar una opción («¿Y en agosto?», «Por sede») no llama al modelo. El costo lo asume odentIA y se anota con el origen `reportes`.
- **Fijar en el Resumen** (`report_pin`): se guarda la pregunta entendida y se recalcula con el periodo y la sede de la pantalla. Caben cuatro por clínica, las ve todo el que ve Reportes y cualquiera las quita. El tope lo cuida la base.

## Alternativas descartadas

- **Que un modelo escriba la respuesta o la cifra:** puede contradecir a la pantalla y cuesta más por pregunta.
- **Una sola lista con las 32 cifras:** los modelos de decisión se van a la primera opción en listas largas.
- **json-render u otro catálogo de componentes que arma el modelo:** el formato de la respuesta es fijo; costaría varias veces más y no agrega nada.
- **Guardar el texto para aprender:** puede llevar nombres de pacientes. El texto sale solo si la persona lo envía como pedido.

## Consecuencias

- Una cifra nueva de Reportes que Argos deba responder entra en el catálogo con su consulta, en el mismo cambio, y la evaluación se vuelve a correr.
- Medido el 2026-10-20 con `eval:reports` (55 preguntas propias):
  - Jev: 42/43 cifras bien, 1 pregunta entre opciones, ninguna inventada, 4/4 «todavía no sé», 8/8 clínico, acción u otro. Unos 3 600 tokens, USD 0,00012 por pregunta.
  - ChatGPT 6: 43/43 y ninguna inventada. Unos 2 300 tokens, USD 0,00026 por pregunta.
  - Mil preguntas al mes cuestan menos de USD 0,30.
  - Los umbrales (`REPORT_SURE`, `REPORT_MARGIN`, `REPORT_NONE`, `REPORT_UNSUPPORTED`) salen de esa medición. Cambiar una pregunta o una descripción obliga a medir otra vez.
- Qué cobrar por esto se decide en darvin2c/odentIA#148, con estas cifras.
- Revisar si una clínica pregunta mucho algo que no está, o si «Fijar» se queda corto con cuatro.

## Referencias

`packages/services/src/report-figures.ts`, `report-questions.ts`, `report-ask.ts`, `packages/agent/src/decision/eval-reports.ts`, `packages/agent/eval/reportes-preguntas.json`, `apps/api/src/routes/reports.ts`, `apps/platform/src/components/reports/ask-argos.tsx`, `packages/db/drizzle/0045_argos_reportes_metas_y_lunes.sql` y `0046_…_reglas.sql`.
