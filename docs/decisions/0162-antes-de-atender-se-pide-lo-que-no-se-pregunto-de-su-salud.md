# 0162 · Antes de atender se pide lo que no se preguntó de su salud

Fecha: 2026-11-08 · Estado: aceptada · Amplía el aviso de alergias de la atención (ADR 0072)

## Problema

La QA del 2026-11-08 (A2) operó a una paciente nueva con anestesia (el cierre descontaba un cartucho de lidocaína) sin que nada pidiera sus enfermedades, su medicación ni su ASA: la atención solo pedía las alergias. El panel «Antecedentes y última atención» decía «Sin enfermedades registradas», que se lee como «no tiene», aunque nunca se preguntó. La ASA estaba bajo «Grupo sanguíneo» y no salía en la atención. Un problema del corazón, la presión alta, un anticoagulante o un embarazo cambian la anestesia y lo que se receta. La anamnesis con los antecedentes personales es parte de la historia (NTS 139-MINSA/2018/DGAIN).

La regla de la UX es avisar donde se decide sin frenar: nada puede trabar la firma.

## Decisión y motivo

- **Un solo aviso «Pregúntale a…» al abrir la atención**, para quien la lleva: una fila por lo que falta (alergias sin revisar o de hace 6 meses, enfermedades y medicación nunca preguntadas), cada una con su respuesta a un toque. Un grupo falta si sigue «no preguntado» y no tiene filas vigentes. Sale siempre que falte, no solo con anestesia: lo que se pregunta al inicio llega antes de anestesiar.
- **«Niega enfermedades» y «No toma medicación» por separado** (`markHealthDenied`): marcan solo ese grupo, bajo bloqueo, con quién y cuándo, sin rearmar el agregado. Con una fila vigente no se puede negar. Lo que sí tiene se escribe en Antecedentes, que se abre encima de la atención.
- **La ASA no se elige en el aviso.** Es un juicio del profesional que sale de lo demás; elegirla a un toque daría un dato que parece cierto. Se ve en el panel («ASA sin clasificar») y se elige en Antecedentes, en su propia tarjeta «Riesgo anestésico (ASA)».
- **Con anestesia, el cierre lo dice junto a los materiales.** El servidor devuelve en el cierre lo que falta (`health.gaps`) y los anestésicos locales que descontará (`health.anesthetics`, reconocidos por el nombre del producto: DCI de la lista ATC N01B, marcas comunes o «anestesia»). Si hay anestesia y algo falta, una línea lo dice; si no, lo que falta va en «Sin registrar». La firma guarda en su auditoría lo que faltaba y si hubo anestesia: la constancia de que se vio.
- **latidIA:** el aviso, el panel y el cierre son comunes. La ASA no se pide en la consulta médica: el panel y la línea de anestesia la nombran solo en odentIA (`productUi().health.showsAsa`), y en latidIA el panel la muestra si alguien la clasificó.

## Alternativas descartadas

- *Avisar solo cuando se detecta anestesia:* el inventario no guarda el código ATC y cada clínica nombra sus productos; un aviso que a veces sale enseña que su ausencia significa «está bien». La detección queda como refuerzo al firmar, no como disparador.
- *Leer «anestesia» en la evolución:* texto libre con negaciones («sin anestesia»); da falsos positivos y negativos.
- *Un botón «No tiene enfermedades ni medicación»:* junta dos hechos; el paciente que toma una pastilla sin enfermedades no tendría qué apretar.
- *Una segunda franja aparte de la de alergias:* dos avisos iguales seguidos se leen como uno y empujan la atención fuera de la pantalla en el teléfono.
- *Exigir los antecedentes para firmar:* frena el trabajo y lleva a llenar «niega» sin preguntar.

## Consecuencias

- Lo que nunca se preguntó se pide en la primera atención, con la respuesta más común a un toque, y el panel ya no afirma lo que nadie preguntó.
- Sacrificio: pacientes cargados sin antecedentes verán el aviso hasta que se responda. El embarazo no tiene fila propia (va en la entrevista de Antecedentes) y la medicación no se vuelve a preguntar a los 6 meses como las alergias; revisarlo si una clínica real lo pide.
- Un anestésico con un nombre que no se reconoce no refuerza el cierre, pero el aviso de arriba sale igual.

## Referencias

- `packages/services/src/clinical.ts` (`healthGapsOf`, `markHealthDenied`), `packages/services/src/encounters.ts` (`checkEncounterClosing`, auditoría de `finalizeEncounter`), `packages/clinical/src/medications.ts` (`isLocalAnestheticName`).
- `packages/clinic-app/src/components/patient/health-review-notice.tsx`, `encounter-context.tsx`, `encounter-closing.tsx` (`AnesthesiaHealthLine`), `antecedentes-tab.tsx`.
- Pruebas: `service-materials.test.ts`, `apps/api/src/routes/patients.test.ts`, `e2e/antecedentes-antes-de-anestesia.spec.ts`.
