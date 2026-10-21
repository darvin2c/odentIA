# 0076 · Argos por pasos, con cifras oficiales y viendo el resultado sin personas

Fecha: 2026-10-21 · Estado: aceptada · Sustituye en parte a [0075](0075-argos-consulta-vistas-del-negocio.md): las vistas, las llaves por rol, el revisor y el periodo siguen igual; cambia cómo trabaja el modelo. Issue darvin2c/odentIA#192; lienzo «Argos por pasos» (tableros 13 a 19, decisiones D17 a D26), aprobado el 2026-10-21.

## Problema

Con 0075 el modelo escribía la consulta y la frase de una vez y sin ver lo que salía. Sumar reglas al texto que lee subió lo que ya había visto (90 %), pero no las preguntas nuevas (65–67 %). En 142 preguntas que no había visto, los 50 errores fueron: una definición propia distinta de la de Reportes (21), un dato que no veía y decía «no se registra» (11), un nombre adivinado que daba cero («Ortodoncia» por «Ortodoncia y Ortopedia Maxilar») (7), frases rotas (6) y otros (5). La regla de cada cifra vivía dos veces: en el código de Reportes y en el texto del modelo, que la volvía a programar en cada pregunta.

## Decisión y motivo

- **Por pasos, con herramientas (D17).** Hasta cuatro turnos: `buscar_nombres` (cómo se llama en la clínica lo que nombra la pregunta, o si es un paciente), `calcular` (una cifra oficial o una consulta propia) y `responder` (el cálculo que responde y la frase con huecos). Trabaja como quien analiza datos: busca, calcula, mira y responde.
- **Cifras oficiales escritas una vez (D18, D19).** `argos-figures.ts` declara unas 40 cifras sobre las vistas, cada una con su «Así lo calculé», sus cortes y sus filtros; el modelo pide la cifra y odentIA arma la consulta con los mismos huecos de periodo y sede, así que cambiar el periodo, fijar y descargar no cambian. Las que también están en Reportes se comparan con él (`eval:argos-cifras`). Si una cifra oficial responde, se usa; la consulta propia es para lo que ninguna cubre. Un filtro por nombre se compara con los de la clínica antes de calcular.
- **Ve el resultado, sin personas (D20).** Para revisar su cuenta, el modelo recibe las cifras, las fechas y los nombres de la clínica; las personas llegan como «Paciente 1» y otros textos como «texto 1» (`argos-observe.ts`). Las cifras de la frase siguen saliendo de los huecos: el modelo las lee, no las escribe.
- **La respuesta dice de dónde sale (D21)**, los pasos se ven mientras trabaja (D22), dos pacientes con el mismo nombre se eligen con botones sin volver al modelo (D23) y lo que viene tiene su periodo (D26).

## Alternativas descartadas

- **Seguir sumando reglas al texto del modelo (0075):** lo ya visto mejora y lo nuevo no.
- **Un catálogo cerrado (0070):** lo que no está declarado no se pregunta. Aquí la consulta propia sigue para lo demás.
- **Que Reportes y Argos usen el mismo código TypeScript de cada cifra:** las funciones de Reportes no admiten la mayoría de los cortes y filtros, y la respuesta guardada se vuelve a correr como consulta. Quedan dos escrituras de la misma cuenta atadas por una prueba; que Reportes use estas cifras deja una sola.
- **Que el modelo vea el resultado entero, con nombres:** mandaría nombres de pacientes al proveedor sin necesidad para revisar una cuenta.

## Consecuencias

- Más espera y más costo por pregunta: dos o tres llamadas al modelo en vez de una. Se mide con las preguntas del dueño antes de dar la fase por buena.
- La agenda va por día: con un periodo que llega a hoy, Argos cuenta hoy entero y Reportes hasta este minuto; «Así lo calculé» lo dice.
- Una cifra nueva se agrega en `argos-figures.ts` con su «Así lo calculé» y, si está en Reportes, entra en `eval:argos-cifras`.
- Revisar si una pregunta frecuente cae siempre en la consulta propia: es una cifra oficial que falta.

## Referencias

`packages/services/src/argos-figures.ts`, `argos-observe.ts`, `argos-period.ts` (D26), `packages/agent/src/argos.ts` (`askArgos`), `packages/agent/src/decision/eval-argos-cifras.ts`, `apps/platform/src/components/argos/argos-panel.tsx`, migración `0057_argos_equipo_ausencias_y_primera_sede.sql`.
