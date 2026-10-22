# 0034 · Un plan, una sección

Fecha: 2026-10-16 · **Estado:** aceptada (fase 3, paso 3; tablero 3 y decisiones 2, 4, 5, 12 y 13 del lienzo) · Ajusta [0029](0029-una-persona-una-pagina.md): las secciones de la página de la persona.

## Problema

Lo que la clínica propone a una persona estaba repartido en cuatro sitios: Plan (planes y presupuestos), Clínica › Tratamientos (el recorrido), Clínica › Controles y Citas › Tratamiento (la coordinación de recepción), más los presupuestos dentro de Cobros para caja. Cada uno decía el estado con otras palabras («Pospuesto», «Lo piensa», «Lo está pensando»). Un mismo plan podía tener varios borradores de presupuesto que nadie enviaba, y «Te espera» no avisaba de ninguno. Las alternativas («resina o corona») se sumaban como si fueran dos tratamientos y la persona nunca las veía. Recepción no podía enviar ni anotar la respuesta, y enviar dependía de quien podía cambiar precios.

## Decisión y motivo

- **Una sola sección «Plan»** para quien lee la clínica, recepción y caja; cada rol ve lo suyo dentro y el servidor autoriza bloque por bloque. De arriba abajo: «Qué sigue» (una frase y un botón que decide el servidor con una sola regla, `getPlanNextStep`, la misma del Resumen y de la atención), los tratamientos por fases con su recorrido al lado, el presupuesto con una acción según su estado, los controles con «Reservar» y, plegados, los planes anteriores. `recorrido`, `controles` y `coordinacion` quedan como secciones retiradas que abren Plan.
- **Un plan abierto implícito:** indicar sin elegir plan va al abierto o lo crea con la atención como origen. Lo propio del odontólogo es lo que él indicó o preparó, no el plan donde quedó.
- **Un solo borrador de presupuesto por persona**, que crece con cada atención y queda armado al firmarla; si el anterior ya salió, lo nuevo abre otro solo con lo nuevo. Lo garantiza la base (índice único parcial). El cierre pregunta «¿Enviárselo ahora?» y, si nadie lo envía, al día siguiente es una fila de «Te espera» para quien envía.
- **Opciones en vez de alternativas:** un presupuesto tiene de una a tres opciones, cada una con su total, una recomendada; nunca se suman. Elegir una deja las otras «No elegida». El valor de la oportunidad es el de la recomendada mientras se decide y el de lo elegido después. Las alternativas del plan (tabla y columnas) se borran: no había datos reales.
- **Enviar es un permiso propio** (`budgets.send`), separado de cambiar precios (`budgets.write`): recepción lee el presupuesto como documento de la persona, lo envía, anota la respuesta y agenda lo aceptado. Sale por la regla de siempre (WhatsApp primero, correo si no) con el mensaje de servicio `presupuesto_listo` (ADR 0030); el botón dice antes por dónde y a quién. Mientras no exista la página «Ver y responder» del enlace personal (paso 6), el botón del mensaje entrega el PDF.
- **Un solo nombre para cada estado** («Por enviar», «Enviado · espera respuesta», «Lo está pensando», «Aceptó todo», «Aceptó N de M», «No aceptó», «Reemplazado», «Anulado»), escrito en `@odentia/clinical`. Sale «histórico».
- **Agendar lo aceptado** une la cita con esos tratamientos (`appointment_plan_item`) y la atención de esa cita los trae. En la atención, «Plan y controles» es un solo bloque.

Se eligió una sección y no una por rol porque el problema era el reparto: el mismo asunto (qué se propuso, qué respondió, qué falta) se buscaba en cuatro lugares. Separar enviar de cambiar precios permite que recepción haga su trabajo sin tocar lo clínico ni lo económico.

## Alternativas descartadas

- **Mantener la coordinación de recepción aparte.** Duplicaba la regla de qué falta y obligaba a recepción a pedir al odontólogo lo que ya estaba armado.
- **Alternativas como tratamientos agrupados.** Sumaban dinero que nadie iba a pagar y no llegaban a la persona; las opciones viven donde la persona elige, en el presupuesto.
- **Varios borradores por plan.** Es lo que dejaba presupuestos olvidados; uno por persona tiene un solo dueño de enviarlo.
- **Que enviar siga en `budgets.write`.** Recepción tendría que poder cambiar precios para enviar, o no enviaría.

## Consecuencias

- Beneficio: un sitio para todo lo propuesto, una regla de «qué sigue», ningún presupuesto armado queda sin enviar sin que alguien lo vea, y recepción completa el envío y la respuesta.
- Sacrificio: la pestaña Plan hace más lecturas al abrir (plan, presupuestos, «Qué sigue», controles); un presupuesto con varias opciones se imprime más largo; recepción ve importes que antes no veía.
- Revisar cuando el paso 6 publique «Ver y responder» en el enlace personal: el botón del mensaje dejará de entregar el PDF.

## Referencias

Lienzo de la fase 3, tablero 3 y decisiones 2, 4, 5, 12 y 13. Migración `packages/db/drizzle/0093_un_plan_una_seccion.sql`. Contratos: `packages/services/src/budgets.ts` (`createBudget`, `assembleEncounterBudget`, opciones, `decideBudget`), `budget-send.ts`, `plan-next.ts`, `plan.ts` (`planForIndication`), `appointments.ts`, `workspace.ts` (`unsentBudget`), `automation-messages.ts` (`presupuesto_listo`), `packages/auth/src/permissions.ts` (`budgets.send`), `packages/clinical/src/budget-words.ts`. Interfaz: `apps/dental-clinic/src/components/patient/plan-tab.tsx` y `plan/`, `encounter-plan-panel.tsx`, `encounter-editor.tsx` (cierre).
