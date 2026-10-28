# 0099 · Clío avisa, no bloquea: lo que falta se completa con un toque o dicho, y firmar confirma lo marcado

Fecha: 2026-10-28 · Estado: aceptada · Lienzo «Clío: avisar, no bloquear» (5 tableros, aprobado) · Precisa la 0012

## Problema

Dictar con el paciente en la unidad dental se volvía una lista de cosas por revisar: una resina sin cara, una corona sin pieza o una elección de caminos quedaban «por revisar» y no se podían confirmar; un «quita la endodoncia» sobre algo ya confirmado se perdía («No pude usar esto… Dilo de nuevo»); y al firmar, el aviso solo ofrecía revisar una por una o descartarlo todo. El odontólogo tenía que parar a completar lo que el sistema podía preguntar o dejar para después.

## Decisión y motivo

- **Indicar no es hacer.** Un tratamiento del plan puede indicarse con la pieza o la cara por definir (`SiteRules.pending` al indicar; `ProductSite.pending` dice qué falta). Lo que sí se dijo se valida igual. Se exige completo al hacerlo: registrar el procedimiento pide lo que falta y lo deja también en el tratamiento; lo ya definido no cambia. El precio es de la prestación, no de la cara.
- **Lo que falta es un aviso, no un freno.** La sugerencia queda lista, con la pregunta a la vista («¿Qué cara de la 36?») y las opciones para tocar. También se dice: Clío ve lo que le falta a cada pendiente («· falta: la cara») y una respuesta suelta («oclusal») corrige esa. Solo frena lo que no se puede indicar tal cual (una prestación que no está en los servicios, un código que no está en la lista) y la receta, que es un documento firmado con la colegiatura.
- **Firmar confirma lo marcado.** El aviso de firma trae lo dictado marcado; desmarcar es dejarlo fuera. Lo que falta se completa en la misma fila. Firmar viendo la lista es la confirmación del profesional que pide la 0012, no una escritura del modelo.
- **Lo confirmado nunca se quita solo.** Clío recibe también lo confirmado en la atención (solo lo que salió del dictado, «· ya confirmada»). Un «quita…» sobre eso queda propuesto en su tarjeta, con «Quitar del plan» y «Dejarla», y lo hace la operación de siempre con el motivo de lo dicho (cancelar el tratamiento y sacarlo del presupuesto en borrador, anular el diagnóstico, cancelar el control). Corregir lo confirmado no se hace por voz: se avisa.

## Alternativas descartadas

- *Seguir exigiendo pieza y cara al indicar:* obliga a decidir en la consulta lo que se define al hacerlo y frena el dictado.
- *Completar lo que falta adivinando (la cara más común):* inventa un dato clínico.
- *Quitar por voz lo confirmado sin preguntar:* un error del modelo borraría un tratamiento ya decidido.

## Consecuencias

- Un tratamiento con la pieza por definir dice «Pieza por definir» en el plan, el recorrido, la historia y lo hecho hoy; el presupuesto y lo que lee el agente lo nombran sin pieza.
- Se mide con `eval:dictado` y `--file=eval/dictado-caotico.json` (avisos respondidos sueltos, quitar lo confirmado).

## Referencias

- `packages/services/src/dental/site.ts` (`columns` con `pending`, `pending`), `plan.ts` (`addPlanItem`, `updatePlanItem`), `encounters.ts` (`addEncounterProcedure`).
- `packages/services/src/encounter-dictation.ts` (`fitToScope` de `dental/dictation.ts`, `listConfirmedDictation`, `undoConfirmedDictation`, `keepConfirmedDictation`).
- `packages/clinic-app/src/components/patient/dictation-sign-dialog.tsx`, `dictation-suggestions.tsx`, `encounter-procedures.tsx`; `apps/dental-clinic/src/components/dental/dictation-finding-choices.tsx` (`PlanSiteChoices`).
