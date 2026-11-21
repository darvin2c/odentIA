# 0209 · Lo que se dijo en la atención se guarda con ella

Fecha: 2026-11-20 · Estado: aceptada · Sustituye en parte a [0012](0012-asistente-clinico-sugiere-y-el-odontologo-confirma.md) (lo que se guarda del dictado)

## Problema

La 0012 decidió no guardar el dictado completo: de cada sugerencia quedaba solo su frase, y «Lo dictado» vivía en la pestaña. En una consulta conversada eso falla (mesa del 20 nov 2026, «Clío en una consulta conversada»):

- Al recargar, lo dicho se perdía y la pausa siguiente iba sin contexto: «sí, también en la treinta y siete» movió la caries de la 36 a la 37 y dejó la pulpitis en la 36.
- La identidad del tramo vivía en las sugerencias que dejó: un tramo de charla, sin sugerencias, se volvía a mandar al modelo (y a cobrar) al reintentarlo.
- Dos pestañas tenían cada una su propio texto, y lo que Clío no usó se borraba al salir.

## Decisión y motivo

- **Cada tramo se guarda con la atención antes de que Clío lo ordene** (`encounter_dictation_segment`): tal cual llegó, con su hora y quién lo dijo. Es lo que se dijo, no lo que Clío entendió.
- **El tramo es único por atención y su identidad dice si ya se ordenó** (`organized_at`). Uno ya ordenado no vuelve al modelo, aunque no haya dejado nada; uno guardado que falló se puede reintentar, con el contexto de cuando se dijo.
- **El contexto de la pausa sale de lo guardado**, no de la pestaña: los últimos 600 caracteres, en palabras enteras. Sirve igual tras recargar u otro día. Lo guardado puede pasar los 12 000 caracteres de una pausa: el contexto toma lo último.
- **Cada tramo guarda lo que no se usó y por qué** (`unused`): Clío no supo dónde va, quiso cambiar lo ya confirmado o el servidor no lo dejó pasar.
- **No es historia clínica.** No se firma, no va en la copia de la historia ni en FHIR y no se corrige: lo clínico sigue entrando solo al confirmar una sugerencia (0012). Lo ven los roles con permiso clínico, como la atención (`clinical.read`), también firmada o anulada.
- **Solo se agrega.** La aplicación no reescribe lo dicho ni lo borra; anota al ordenarlo y, en el repaso al terminar, los turnos (`turns`, nulo hasta entonces). Se escribe con la atención en borrador y se borra con ella si se descarta vacía.

- **El repaso al terminar** (P4 de la misma mesa): una lectura de toda la conversación guardada, con lo pendiente, lo confirmado y lo descartado, que completa lo que las pausas dejaron y parte cada tramo en turnos con quién habló (`turns`). Corre solo si hay tramos que ningún repaso leyó (`reviewed_at`) y lee como mucho los últimos 30 000 caracteres, en tramos enteros. Los turnos se guardan solo si juntos son el tramo tal cual; quién habló lo cambia una persona y otro repaso no lo pisa.

## Alternativas descartadas

- *Seguir sin guardarlo* (0012): es lo que falló al recargar y al reintentar.
- *Una columna en la atención con todo el texto*: se reescribiría en cada pausa y dos envíos se pisarían. Un tramo por fila solo se agrega y lleva su identidad.
- *Releer toda la conversación en cada pausa*: los «quita» y las correcciones por número se aplicarían otra vez y el costo crece con el cuadrado de la duración. La conversación entera se lee una vez, en el repaso.
- *Que entre en la copia de la historia*: duplica en un documento que se entrega lo que nadie firmó.

## Consecuencias

- Beneficio: lo dicho sobrevive a recargar y a volver otro día, la pausa siguiente se entiende con lo anterior y un tramo repetido no se cobra.
- Sacrificio: se guarda texto de salud fuera de la historia (unos 15–35 KB por consulta larga) y quien ve la atención ve también lo conversado, charla incluida.
- Revisar si se decide grabar la consulta o si una clínica necesita que lo conversado no se guarde.

## Referencias

- `packages/db/src/schema/clinical.ts` (`encounterDictationSegment`), migraciones `0152_lo_que_se_dijo.sql` y `0154_el_repaso_al_terminar.sql`; el repaso en `packages/services/src/dictation-review.ts` y `packages/agent/src/dictation.ts` (`askDictationReview`), `POST …/dictation/review`.
- `packages/services/src/dictation-said.ts`, `dictationSegmentSeen` en `encounter-dictation.ts`, `apps/api/src/routes/encounter-dictation.ts` (`GET …/dictation/said`).
- Pruebas: `apps/api/src/routes/encounter-dictation.test.ts`, `packages/services/src/dictation-said.test.ts`.
