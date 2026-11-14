# 0163 · Antes de atender se pide lo que no se preguntó de su salud

Fecha: 2026-11-08 · Estado: aceptada · Amplía el aviso de alergias de la atención (ADR 0072) · Actualizada el 2026-11-13: el embarazo declarado sale arriba de la ficha y de la atención, con su fecha

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

## Actualización del 2026-11-13: el embarazo declarado sale arriba, con su fecha

«El embarazo no tiene fila propia (va en la entrevista de Antecedentes)… revisarlo si una clínica real lo pide» era un límite de alcance. La mesa del 13 nov sobre lo que la clínica le pide al paciente mostró el riesgo: una paciente que declaró 30 semanas en su registro no lo tenía a la vista en la franja, en «Lo que declaró» ni en el panel de la atención, que es donde se decide una radiografía o una receta. Se revisa esa consecuencia; lo demás de la decisión sigue igual.

- **El embarazo sale arriba de la ficha y de la atención**, junto a las alergias, y en el aviso «Revisa con… lo que dijo de su salud». Sigue sin fila propia en «Pregúntale a…»: no se pregunta a un toque, se muestra lo que ya se dijo.
- **Se guarda con el día en que se dijo**, en la forma que ya usaba latidIA (`embarazoLactancia.embarazo = { estado, fecha, semanas? }`), ahora común a los tres productos. La pantalla dice la semana de hoy («32 semanas hoy (30 el 13 nov)») y, pasada la semana 42, deja de mostrarlo como alerta y pide confirmarlo. La fecha es parte del dato: solo cambia cuando alguien responde de nuevo el embarazo o sus semanas, nunca por guardar otro dato de la entrevista.
- **Lo guardado antes en odentIA y vistIA** (`antecedentesPersonales.embarazo`, un sí o no sin fecha) no se reescribe. Al leerlo, su fecha es la del día en que se anotó ese «sí»: el de la primera versión de la entrevista que ya lo decía con las mismas semanas (`legacyPregnancySaidOn`). Así una gestante anotada ayer no pierde su alerta. Solo queda «por confirmar · anotado sin fecha» lo que de verdad no la tiene, y pasa a la forma nueva cuando alguien lo responde otra vez.
- **Una sola regla para los tres productos** (`pregnancyToday` de `@odentia/clinical`): la franja, Antecedentes y la receta de latidIA deciden igual si el embarazo sigue en pie; sin las semanas dichas, se cuentan desde la última regla si está anotada. Antes la receta de latidIA daba por vigente para siempre un embarazo sin semanas.
- **La receta nunca deja de avisar en silencio.** Con el embarazo «por confirmar», la receta de latidIA sigue avisando lo contraindicado, con esas palabras, hasta que alguien actualice sus antecedentes: callar sería dar por terminado un embarazo que nadie confirmó.
- **Avisa, no frena.** No pide ningún paso ni impide abrir, recetar ni firmar. La receta y la orden de odentIA siguen sin avisar por embarazo (latidIA sí, ADR 0143): queda fuera de este cambio.

Alternativas descartadas: *tomar la fecha de la versión de la entrevista* (cambia cada vez que alguien edita otro dato, y el embarazo parecería recién dicho); *mostrar las semanas que se dijeron, sin fecha* (un «30 semanas» congelado es falso al mes y queda para siempre); *una tabla propia para el embarazo* (la entrevista versionada ya lo guarda y latidIA ya lo lee de ahí).

Referencias de la actualización: `packages/clinical/src/pregnancy.ts` (`pregnancyToday`, `legacyPregnancySaidOn`, `checkInterviewPregnancy`, `declaredPregnancy`), `packages/medical/src/prescribing.ts` (`checkPrescription`), `packages/services/src/product-hooks.ts` (`COMMON_INTERVIEW`), `packages/services/src/clinical.ts` (`getPatientHealth`: `pregnancy` y `declared`), `packages/clinic-app/src/lib/declared-health.ts`, `patient-header.tsx` (`PatientClinicalStrip`); pruebas `pregnancy.test.ts` y `lo-que-dijo-el-paciente.test.ts`.

## Referencias

- `packages/services/src/clinical.ts` (`healthGapsOf`, `markHealthDenied`), `packages/services/src/encounters.ts` (`checkEncounterClosing`, auditoría de `finalizeEncounter`), `packages/clinical/src/medications.ts` (`isLocalAnestheticName`).
- `packages/clinic-app/src/components/patient/health-review-notice.tsx`, `encounter-context.tsx`, `encounter-closing.tsx` (`AnesthesiaHealthLine`), `antecedentes-tab.tsx`.
- Pruebas: `service-materials.test.ts`, `apps/api/src/routes/patients.test.ts`, `e2e/antecedentes-antes-de-anestesia.spec.ts`.
