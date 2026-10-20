# 0070 · Alergias de una lista: ATC y una lista propia, quitar sin borrar y revisarlas cada 6 meses

Fecha: 2026-10-20 · Estado: aceptada · Lienzo «Pacientes odentIA», tablero 7 (versión 4) y decisiones 9 y 10 · Issue 43

## Problema

El aviso al recetar comparaba textos: una alergia escrita «amoxi», con otra ortografía o con el nombre del grupo podía no avisar. La receta ya usa la DCI y el código ATC; la alergia no. Además, cada alergia pedía siete datos (tipo de alérgeno, tipo, criticidad, verificación, gravedad…) que se confundían entre sí, y la «verificación» dejaba alergias «declaradas, por confirmar» que en una clínica dental nadie confirma con pruebas: se revisan con el paciente.

## Decisión y motivo

- **La sustancia se elige de una lista.** Los medicamentos y sus grupos llevan su código ATC de la OMS, el mismo de la receta (`J01C` penicilinas, `J01CA04` amoxicilina). Lo que no es medicamento (látex, níquel, metacrilato, eugenol, yodo y alimentos frecuentes) va en una **lista corta propia** (`odentia`), anotada aquí como desviación de SNOMED CT, que necesita licencia nacional y no comprobamos que Perú la tenga. Lo que no está se guarda como texto, «sin codificar», y se elige de la lista después. El catálogo vive en `@odentia/clinical` (`allergens.ts`): el tipo de alérgeno sale de ahí.
- **El aviso compara códigos:** el mismo medicamento, el mismo grupo (el código de la receta empieza por el del grupo) o un grupo con reacción cruzada conocida (betalactámicos; inhibición de la COX). Sin código, el texto, como antes. Lo que no es medicamento no choca con una receta.
- **Tres datos al registrar:** la sustancia, qué tan fuerte fue la reacción (leve, moderada, severa, no se sabe) y, opcional, qué le pasó. El origen se anota solo: el equipo que la registró o el paciente en su formulario (`source`, el `asserter` de FHIR). Tipo (alergia o intolerancia) y criticidad quedan con su valor por defecto («alergia», sin evaluar).
- **Todas avisan igual.** No hay «Confirmar» ni «por confirmar»: la declarada por el paciente avisa como la registrada por la odontóloga.
- **Quitar no borra.** Solo quien escribe en la historia, con su motivo: «ya no es alérgica» (FHIR `clinicalStatus` resolved), «era otra cosa» (refuted) o «se registró por error» (entered-in-error). Queda en «Alergias quitadas» con quién, cuándo y por qué, y se vuelve a poner.
- **Revisarlas con el paciente es un hecho con fecha** (`allergies_reviewed_at/by`): «Sin cambios» en la atención, agregar o quitar una. Si nunca se revisaron o pasaron 6 meses, la atención pide preguntarle por alergias nuevas (`allergyReviewDue`).
- **Recetar igual pese al aviso pide un motivo escrito**, que queda en la receta (`allergy_override_reason`); la auditoría solo anota que se hizo.
- **La medicación habitual** se escribe igual que la receta: DCI con su ATC (una lista de lo que más toman los pacientes y cambia lo que se hace en la boca), dosis con número y unidad UCUM y frecuencia de una lista; el texto escrito antes queda como respaldo.

## Alternativas descartadas

- *SNOMED CT para todo:* exige licencia por país y una terminología enorme para una lista que en la consulta dental es corta. Si un país la tiene, se agrega como perfil de país sin cambiar la pantalla.
- *Seguir comparando textos con más sinónimos:* nunca cubre todas las formas de escribirlo y no dice por qué avisa.
- *«Confirmar» una por una:* en una consulta dental la alergia no se comprueba; obligaba a un paso que nadie hacía y dejaba avisos «a medias».
- *Borrar la alergia equivocada:* se pierde por qué dejó de avisar y no se puede deshacer.

## Consecuencias

- Lo ya guardado se codificó cuando el texto era exactamente una sustancia de la lista, sin cambiar lo escrito (migración `0046`); lo descartado antes quedó como quitada porque «era otra cosa». Lo demás queda «sin codificar» y la tarjeta lo ofrece para elegir de la lista.
- Las alergias ya no se editan dentro del formulario conjunto de Antecedentes: se agregan y quitan una por una, y cada operación avanza la revisión del agregado.
- Revisar si la lista propia se queda corta (nuevos materiales, alimentos) o si un país pide SNOMED CT.

## Referencias

- `packages/clinical/src/allergens.ts` (`ALLERGENS`, `codeAllergySubstance`, `allergyWarnings`, `HABITUAL_MEDICATIONS`).
- `packages/services/src/allergies.ts`, `clinical.ts` (`persistPatientHealth`), `prescriptions.ts`.
- `apps/platform/src/components/patient/allergies-card.tsx`, `clinical-panels.tsx` (receta).
- Migraciones `0045_alergias_y_medicacion_codificadas` y `0046_alergias_y_medicacion_codificadas_datos`.
