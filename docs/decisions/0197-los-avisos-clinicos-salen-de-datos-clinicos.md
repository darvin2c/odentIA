# 0197 · Los avisos clínicos salen de datos clínicos

Fecha: 2026-11-16 · Estado: aceptada · Revisa el ADR 0163 en la ASA y en lo que dispara la línea de anestesia

## Problema

El estudio de la atención del 16 nov encontró dos avisos de seguridad que no salían de lo clínico:

- **La presión.** Una paciente de 62 años llegó a una exodoncia con 185/115 y nada lo dijo: ni el campo, ni el cierre, en odentIA ni en latidIA. Los rangos de los signos vitales eran solo de digitación (`vitals.ts`).
- **La anestesia.** La línea del cierre dependía de que el servicio tuviera un anestésico entre sus materiales del inventario (ADR 0163: «la detección queda como refuerzo»). Una pulpectomía a un niño de 22 kg se firmó sin ASA y sin dosis máxima, porque la demo local no cargaba materiales en la endodoncia. La ficha de odontopediatría pedía el peso «para la dosis máxima» y nada la calculaba. Además, la línea salía al firmar, cuando ya se anestesió.

La regla de la UX sigue: avisar donde se decide, sin frenar. Lo clínico lo decide el profesional.

## Decisión y motivo

- **Umbrales comunes en `@odentia/clinical`.** `bloodPressureAlert`: sistólica de 180 o más, o diastólica de 110 o más, desde los 13 años (AAP 2017); por debajo no hay un corte que se pueda afirmar y no se avisa. Dice «Repite la toma», que lo electivo se suele diferir y que con síntomas es una urgencia (Little y Falace, 9.ª ed.; ACC/AHA 2017; AHA 2019). Sale bajo los signos vitales, en el diálogo de firmar y junto a la presión en la atención firmada, en odentIA y latidIA, desde la pantalla común.
- **«Usa anestesia local» es un dato del servicio**, como las sesiones habituales (ADR 0164): `treatment_template.local_anesthesia` lo carga `seed:procedures` desde `biblioteca_anestesia.csv` (y su par médico) solo para lo que casi siempre se anestesia; `service_catalog.local_anesthesia` es nula hasta que la clínica lo cambia, y se lee con `localAnesthesiaSql`. Los anestésicos de los materiales siguen contando.
- **La línea de anestesia va antes de anestesiar.** En cuanto algo de hoy la usa («Hacerla hoy», «Continuar» o lo registrado), «Realizado hoy» la muestra; el cierre la repite. Dice sus alergias, su medicación y lo que dijo del corazón.
- **La ASA se elige con un toque en esa línea** (chips I a IV, con el nombre largo de la ASA 2020 debajo), solo donde el producto la pide (odentIA). Queda en la ficha con quién y cuándo (`patient.asa_class_set_at` y `_by`) y la de antes en la auditoría (`patient.asa_classified`). Esto revisa el ADR 0163, que la dejaba solo en Antecedentes: ahí estaba lejos del momento en que se decide, y nadie la ponía.
- **El máximo por peso sale del anestésico elegido y de `vitals.peso`**, su único dueño: lidocaína y mepivacaína 4,4 mg/kg (tope 300 mg), articaína 7 mg/kg (500 mg; aviso en menores de 4 años), prilocaína 6 mg/kg (400 mg), cartucho de 1,8 mL, y el tope de epinefrina (0,04 mg) con una cardiopatía registrada o ASA III o más (Malamed, 7.ª ed.; AAPD, por verificar la tabla). Sin peso no se inventa nada: pide anotarlo.
- **La atención firmada guarda la foto** (`encounter.anesthesia_at_signing`): lo que la usó, la ASA con quién la puso y la de antes si cambió en ella, el peso, el anestésico del cálculo, el máximo y sus avisos. La guarda de lo firmado la protege.

## Alternativas descartadas

- *Seguir disparando la anestesia por el inventario:* cada clínica nombra sus productos y una sin inventario nunca vería la línea; un aviso que a veces sale enseña que su ausencia es «está bien».
- *Ligar el consentimiento de anestesia a la marca del servicio:* pediría un consentimiento más en cada resina marcada. La anestesia va en el texto del consentimiento de cada procedimiento.
- *Un máximo fijo con lidocaína:* con mepivacaína al 3 %, «2,7 cartuchos» en 22 kg es una sobredosis. Por eso se elige el anestésico.
- *Registrar anestésico, cartuchos y técnica:* un dato clínico nuevo con su lugar en la historia, el PDF y FHIR. Ningún caso lo pidió; sigue en la evolución.
- *El umbral de la presión desde los 18 años:* deja sin aviso a un adolescente con 185/115.
- *Frenar la firma:* lo clínico lo decide el profesional.

## Consecuencias

- La seguridad sale de lo que es clínico (el servicio, los signos vitales, la ficha), igual en odentIA y latidIA; vistIA no anestesia ni toma signos vitales.
- Sacrificio: lo que la biblioteca no marca (una resina) no muestra la línea hasta que la clínica lo marca. Los niños menores de 13 no tienen aviso de presión. Revisar con una tabla por percentiles si una clínica pediátrica lo pide, y la fuente de la AAPD cuando se verifique.

## Referencias

- `packages/clinical/src/vitals.ts` (`bloodPressureAlert`), `local-anesthesia.ts`.
- `packages/db/seeds/biblioteca_anestesia.csv`, `biblioteca_medica_anestesia.csv`, `src/procedure-codes.ts` (`libraryAnesthesia`), migración `0139_anestesia_del_servicio.sql`.
- `packages/services/src/service-catalog.ts` (`localAnesthesiaSql`), `anesthesia-at-signing.ts`, `encounters.ts` (`checkEncounterClosing`, `finalizeEncounter`), `clinical.ts` (`setPatientAsa`).
- `packages/clinic-app/src/components/patient/encounter-anesthesia.tsx`, `vitals-alert.tsx`.
