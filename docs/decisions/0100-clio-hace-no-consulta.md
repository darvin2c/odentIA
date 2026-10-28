# 0100 · Clío hace, no consulta: la alergia dicha y lo hecho hoy quedan registrados, y no responde preguntas

Fecha: 2026-10-28 · Estado: aceptada · Lienzo «Clío: alergias y lo hecho hoy» (5 tableros, aprobado) · Precisa la 0012 y la 0099

## Problema

El issue 109 pedía que Clío respondiera preguntas sobre el paciente durante la atención («¿alergias?», «¿qué le hicimos la última vez?», «¿cuánto debe?»). Eso la vuelve una consultora: qué puede ver, con qué permiso, qué queda en la bitácora y respuestas habladas en las que hay que confiar con el paciente en la unidad. Mientras tanto, lo que más se dice en una atención no quedaba registrado: «es alérgica a la penicilina» no llegaba a sus antecedentes, y «le hice la profilaxis» no era un procedimiento.

## Decisión y motivo

- **Clío hace, no conversa.** Registra y ejecuta lo que se dice, para confirmar. Solo muestra lo que va entendiendo, lo que falta (aviso, 0099), avisos sobre lo que se está haciendo y lo que se le pidió abrir. Lo que hay que saber del paciente lo muestra la pantalla de la atención sin pedirlo (sus alergias ya están en la franja de alertas); preguntarle al sistema es de Argos. La deuda no la ve un rol clínico, y Clío tampoco.
- **La alergia dicha entra como cualquier alergia** (`addPatientAllergy`, ADR 0072): la sustancia con su código si es de la lista, o como se dijo. Qué tan fuerte fue no se deduce de la reacción: es un aviso que se toca o se dice, y sin él entra «No se sabe». «Niega alergias» responde la revisión (`markAllergiesReviewed`). La ya registrada no se propone otra vez: se avisa. La dictada sin confirmar ya avisa al recetar, en el mismo tramo.
- **Lo hecho hoy sale de donde corresponde, sin elegirlo**: del tratamiento abierto del plan que lo indicaba (con su precio y la pieza o la cara que le faltaban), de los servicios, o como acto libre que no se cobra. Lo que no queda claro si ya se hizo es una indicación: indicar de más se descarta con un toque; registrar de más cobra.
- **Hacerlo es aceptarlo.** Un tratamiento que esperaba respuesta queda aceptado y hecho al hacerlo, como el servicio directo de «Registrar procedimiento» (`acceptWhenDone` en `addEncounterProcedure`), y sale de su presupuesto en borrador. Uno de un presupuesto ya enviado espera su respuesta en el presupuesto.
- **Lo hecho sí necesita su sitio.** Es la excepción a «avisar, no bloquear»: la pieza se pide con un toque (las piezas nombradas) o dicha; no frena el dictado.

## Alternativas descartadas

- *Responder preguntas en la atención:* permisos y bitácora nuevos para algo que la pantalla ya muestra, y respuestas habladas difíciles de verificar.
- *Exigir el presupuesto aceptado antes de registrar lo hecho:* obliga a salir de la atención para algo que el paciente ya aceptó al hacérselo.
- *Deducir la gravedad de la reacción («se le hinchó la cara» = severa):* sería un juicio clínico del modelo.

## Consecuencias

- Dos clases nuevas de sugerencia, comunes a odentIA y latidIA: `alergia` y `procedimiento` (migración 0011).
- Se mide con `eval:dictado` (banco de siempre y `eval/dictado-caotico.json`, con alergias y lo hecho entre charla) y `eval:dictado-medico`.

## Referencias

- `packages/services/src/encounter-dictation.ts` (`prepareAllergy`, `settleDone`, `confirmDone`, `refreshRecipes`), `encounters.ts` (`acceptWhenDone`), `operation-fields.ts` (`alergia.dictada`, `atencion.procedimiento`).
- `packages/agent/src/dictation.ts` (`allergyAndDonePrompt`).
- `packages/clinic-app/src/components/patient/encounter-editor.tsx`, `dictation-suggestions.tsx`.
