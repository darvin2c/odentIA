# Procesos clínicos de latidIA

El catálogo que supervisa la voz clínica en latidIA. Cada proceso trae dónde vive, qué se comprueba, los huecos ya conocidos y sus fuentes. Al final están los casos para recorrerlos. La demo es Pediatría Los Olivos, así que los casos pediátricos van primero, pero latidIA también atiende adultos: los dos se revisan.

**Cómo se usa:**

- **Comprobaciones:** cada una se marca como cumple, no cumple o no se pudo ver.
- **Huecos conocidos:** lo que faltaba la última vez que se leyó el código. La voz mira si sigue faltando y si importa en la consulta: un hueco no es un hallazgo por estar en esta lista, sino por lo que le cuesta al médico o al paciente.
- **Rutas abreviadas:** `M` = `packages/medical/src/`, `SM` = `packages/services/src/medical/`, `AM` = `apps/medical-clinic/src/product/medical/`, `CA` = `packages/clinic-app/src/components/patient/`, `CL` = `packages/clinical/src/`, `DB` = `packages/db/src/schema/`.
- **La lista crece:** se suma lo que la ronda encuentre y no esté aquí («Para el catálogo» en `voces.md`). Los números de línea cambian, así que se buscan por el nombre.

La atención, la ficha y los documentos son comunes con odentIA (ADR 0079). latidIA se engancha en `medicalUi` (`AM index.tsx`) y `medicalHooks` (`SM hooks.ts`). Lo común se revisa también en `odontologia.md`.

---

## El recorrido del paciente en el tiempo

Los procesos de abajo se revisan uno por uno. Este apartado los junta como los vive un paciente a lo largo de meses o años. En latidIA hay tres recorridos típicos, y cada ronda que toque la atención, el plan o la ficha recorre al menos uno entero (casos RM1 a RM3):

- **Una enfermedad aguda:** consulta, tratamiento, control y alta.
- **Una enfermedad crónica:** diagnóstico, metas, controles repetidos y ajustes por años.
- **Un niño sano:** controles por edad desde que nace.

En el código, lo indicado nace aceptado y el presupuesto es opcional (`AM index.tsx`). Cada tratamiento pasa por `pendiente → programado → en_curso → realizado`, con `suspendido` y `cancelado`, y su siguiente acción la calcula `deriveNextAction` (`packages/services/src/treatment-journey.ts`). Los controles viven en `clinical_follow_up` y se cumplen con la visita (ADR 0152).

### Etapa 1 · La primera consulta

- [ ] Antecedentes completos antes de recetar (alergias, medicación, embarazo y, en un niño, los perinatales y las vacunas).
- [ ] Signos vitales con lo que es normal para su edad, examen por sistemas y diagnóstico presuntivo o definitivo.
- [ ] Lo que se pide para confirmar (laboratorio o imagen) queda como orden pendiente.
- [ ] La persona se va sabiendo qué tomar, qué signos de alarma vigilar y cuándo volver (P-COM-15).

### Etapa 2 · El tratamiento y sus controles

- [ ] La receta, las órdenes y el control quedan ligados al diagnóstico.
- [ ] El resultado que llega después vuelve a su orden y el médico lo ve antes del control, no recién en la consulta.
- [ ] El diagnóstico presuntivo pasa a definitivo, o se cambia, con rastro.
- [ ] En el control se compara con la vez anterior: la fiebre, la presión, el peso o el resultado.

### Etapa 3 · Alta o seguimiento a largo plazo

- [ ] Una enfermedad aguda se marca resuelta y deja de proponerse. La lista de problemas queda al día.
- [ ] Una enfermedad crónica queda con sus controles repetidos, sus metas y la medicación habitual al día. Cada control parte de lo anterior, sin rehacerlo.
- [ ] El niño sano tiene su próximo control por edad y sus vacunas pendientes.

### Etapa 4 · Vuelve tiempo después

- [ ] La ficha cuenta sus problemas activos, su medicación y sus alergias de un vistazo.
- [ ] Lo que quedó pendiente (un resultado que nunca llegó, un control que no hizo) aparece.
- [ ] La curva de crecimiento o la serie de presión sigue desde el último dato.

### Cómo recorrerlo en una ronda

Igual que en odentIA (`odontologia.md`, «Cómo recorrerlo en una ronda»): una persona `QA` nueva para la primera consulta y el tratamiento, y los pacientes de Pediatría Los Olivos que ya están en cada etapa (un niño con controles por edad, un crónico con presión cada 3 meses) para el resto. Si falta alguien en una etapa, es un error de la demo.

---

## P-MED-01 Registro del paciente y su responsable

**Dónde:** el formulario de `CL patient-registration.ts`, la pestaña «Responsables» (`CA responsables-tab.tsx`) y el enlace público de registro.

- [ ] Un menor de 18 años no se registra sin un responsable con relación, contacto y documento. En el enlace, quien registra es el responsable.
- [ ] Paciente ≠ interlocutor ≠ responsable: la mamá que escribe por WhatsApp no se vuelve la paciente, y su teléfono no identifica al niño.
- [ ] La edad se muestra como se usa en pediatría: días en el recién nacido, meses hasta los 2 años y años y meses después. Hoy un lactante sale con «0 años».
- [ ] Hay un lugar para el peso al nacer, la edad gestacional y si fue prematuro, y la edad corregida se usa donde importa.
- [ ] Lo que se pregunta depende del sexo y la edad (embarazo y lactancia solo de 12 a 55 años), sin pedir lo que no corresponde.
- [ ] Dos registros de la misma persona no crean dos historias (persona única, ADR 0001).
- [ ] El representante declarado por el chat («es mi hijo», ADR 0101) no se vuelve representante pleno sin comprobarlo. Hoy el documento de prueba no se exige.
- [ ] El adolescente: lo que ve su representante respeta la confidencialidad que le da la norma (planificación familiar, salud mental).

**Huecos conocidos:** edad solo en años (`packages/clinic-app/src/lib/patients.ts`, `ageFrom`); sin datos perinatales.
**Fuentes:** NTS 139-MINSA (historia clínica); Ley 29414 (derechos del usuario de salud).

## P-MED-02 Triaje y signos vitales

**Dónde:** el bloque «Examen físico» de la atención (`AM examination.tsx`) y la sección «Signos vitales» de la ficha (`AM vitals-section.tsx`). Los códigos en `CL vitals.ts` y `M vitals.ts`.

- [ ] Los signos van con su unidad: temperatura en °C, frecuencia cardiaca y respiratoria por minuto, presión en mmHg, SpO₂ en %, peso en kg, talla en cm, perímetro cefálico en cm y glucosa capilar en mg/dL (LOINC y UCUM).
- [ ] El IMC se calcula bien y coincide con el peso y la talla.
- [ ] Un valor fuera de lo normal para la edad se nota: fiebre, taquipnea, hipoxemia, hipertensión. Los rangos cambian con la edad (un lactante respira más rápido que un adulto). Hoy solo hay rangos de lo posible, no de lo normal.
- [ ] La presión de un niño se juzga por percentil para edad, sexo y talla, no con los cortes del adulto.
- [ ] Los valores anteriores se ven al lado para comparar.
- [ ] El gráfico de la ficha muestra lo mismo que se escribió en la atención.
- [ ] Una escala de dolor (EVA o caritas en niños) está donde la consulta lo pide.
- [ ] Si la clínica toma los signos antes de la consulta (triaje), alguien que no es el médico puede registrarlos. Hoy no hay rol de enfermería ni triaje.

**Huecos conocidos:** sin triaje ni rol que lo haga; sin rangos por edad ni alertas; sin escala de dolor ni Glasgow.
**Fuentes:** LOINC; UCUM; signos vitales por edad de PALS (AHA); presión arterial en niños de la AAP 2017 (Flynn y colaboradores); en adultos, ACC/AHA 2017 o ESC/ESH 2023.

## P-MED-03 Antecedentes, alergias y medicación

**Dónde:** la pestaña «Antecedentes» (`CA antecedentes-tab.tsx`) con `MedicalInterviewSections` (`AM health.tsx`); los datos en `M history.ts` y las tablas de alergia y medicación en `DB clinical.ts`.

- [ ] Cada alergia tiene sustancia (ATC o propia), reacción, gravedad y si está confirmada. «No tiene alergias» se distingue de «no se preguntó».
- [ ] La medicación habitual tiene dosis con unidad y frecuencia, y aparece al recetar.
- [ ] Los antecedentes gineco-obstétricos (fecha de última regla, gestas, partos y cesáreas) se piden solo cuando corresponde y cuadran entre sí (partos más cesáreas no superan las gestas).
- [ ] El embarazo lleva semanas y fecha. Si por las semanas ya habría terminado, lo pide actualizar.
- [ ] Los antecedentes familiares llevan parentesco. Los hábitos llevan cantidad (cigarrillos al día).
- [ ] Lo que declaró el paciente por el enlace se distingue de lo que confirmó el médico, y el aviso «por revisar» sale solo cuando hay algo de verdad (ADR 0163).
- [ ] La alergia y el embarazo están a la vista en la atención y al recetar, sin abrir otra pestaña.
- [ ] En pediatría: antecedentes perinatales y desarrollo psicomotor (hitos). Hoy no existen.

**Huecos conocidos:** sin antecedentes perinatales ni del desarrollo; el método anticonceptivo «otro» no tiene detalle.
**Fuentes:** HL7 FHIR AllergyIntolerance y FamilyMemberHistory; ATC (OMS); ADR 0072 y 0163.

## P-MED-04 Vacunas

**Dónde:** la lista `{vacuna, fecha}` de antecedentes (`M history.ts`).

- [ ] Las vacunas se eligen de una lista, no se escriben a mano, con dosis (1.ª, 2.ª, refuerzo), fecha y, si se puede, lote.
- [ ] Se ve qué le toca según la edad y el esquema nacional de vacunación del MINSA, y qué está atrasado.
- [ ] El control del niño sano recuerda las vacunas que faltan.
- [ ] Las vacunas que trae la demo coinciden con el esquema para la edad de cada niño.

**Huecos conocidos:** texto libre, sin códigos, calendario, dosis ni lote (el propio `history.ts` lo dice); sin consentimiento de vacunación.
**Fuentes:** esquema nacional de vacunación vigente del MINSA; CVX (CDC) o SNOMED CT como código.

## P-MED-05 Motivo de consulta y enfermedad actual

**Dónde:** el bloque «Consulta» de la atención (`CA encounter-editor.tsx`); los campos `reason`, `presentIllness` e `illnessDuration`.

- [ ] Motivo, tiempo de enfermedad y relato, como pide la NTS 139. El motivo es obligatorio para cerrar.
- [ ] «Hoy viene a…» trae lo de la cita, el control o lo que sigue (ADR 0165).
- [ ] Hay una revisión por sistemas, aunque sea breve, cuando la consulta la pide. Hoy no existe.
- [ ] En un niño, queda claro quién da la información (la mamá, el papá o quien lo cuida).

**Fuentes:** NTS 139-MINSA; ADR 0003 y 0165.

## P-MED-06 Examen físico por sistemas

**Dónde:** `AM examination.tsx` y `M examination.ts`.

- [ ] Los 10 sistemas: «Sin alteraciones», «Con hallazgos» (con el texto) o «No examinado». Lo no marcado nunca queda como normal.
- [ ] «Marcar el resto sin alteraciones» no pisa lo que ya tiene hallazgos.
- [ ] Lo dictado se suma a lo escrito y no lo borra.
- [ ] En pediatría está lo que se mira siempre: fontanela, otoscopia, hidratación y, por edad, reflejos y Tanner. Hoy va todo como texto.
- [ ] El examen sale igual en la Historia, en el PDF y en FHIR (`not-performed` y la interpretación N o A).

**Fuentes:** NTS 139-MINSA.

## P-MED-07 Crecimiento

**Dónde:** los gráficos de talla y perímetro cefálico de `AM vitals-section.tsx`.

- [ ] Peso para la edad, talla para la edad, peso para la talla o IMC para la edad, y perímetro cefálico, con percentil o puntaje z sobre las curvas de la OMS.
- [ ] Se ve la tendencia: un niño que cruza percentiles hacia abajo se nota.
- [ ] Desnutrición, talla baja, sobrepeso y obesidad se pueden ver sin calcular a mano.
- [ ] Las curvas usan el sexo del niño y la edad corregida si fue prematuro.

**Huecos conocidos:** el código dice «sin percentiles todavía» (`vitals-section.tsx`); sin curvas OMS ni puntaje z.
**Fuentes:** patrones de crecimiento infantil de la OMS (0 a 5 años) y referencia de crecimiento de la OMS (5 a 19 años).

## P-MED-08 Diagnóstico

**Dónde:** el bloque «Diagnóstico» (`CA encounter-diagnoses.tsx`, `diagnosis-search.tsx`); el catálogo en `CL diagnoses.ts` y `M diagnoses.ts`; la lista de problemas en `AM problems-card.tsx`.

- [ ] El código sale de CIE-10 o CIE-11 (según la clínica) y el buscador encuentra lo de atención primaria con las palabras del médico («otitis», «bronquiolitis», «anemia»).
- [ ] Presuntivo o definitivo, y en el Perú el tipo HIS (P, D o R).
- [ ] Un código que no corresponde al sexo o la edad (un O en un hombre, uno perinatal en un adulto) se avisa. Hoy no se valida.
- [ ] La lista de problemas muestra los activos, desde cuándo y quién, y deja marcar resuelto.
- [ ] El diagnóstico tiene el mismo nombre y código en la atención, la receta, la orden, el descanso, la Historia y el PDF.
- [ ] Clío marca «parece» o «probable» como presuntivo.

**Fuentes:** CIE-10 y CIE-11 (OMS); HIS-MINSA; ADR 0041, 0053 y 0103.

## P-MED-09 Plan, indicaciones y controles

**Dónde:** «Plan y controles» y «Evolución, pronóstico e indicaciones» del editor; `SM hooks.ts` para el control anual.

- [ ] Lo indicado nace aceptado y el presupuesto es opcional (`AM index.tsx`): no se le pide al médico un paso de venta.
- [ ] Las indicaciones para la casa son claras para quien cuida: qué dar, cuánto, hasta cuándo y los signos de alarma para volver o ir a emergencia.
- [ ] El control se pide al firmar y se cumple al volver (ADR 0152). Los controles repetidos (la presión cada 3 meses) se generan bien.
- [ ] El niño sano tiene sus controles por edad. Hoy no están ligados a la edad.
- [ ] Las sesiones previstas (control prenatal) cuentan bien y se terminan al firmar (ADR 0161 y 0164).

**Huecos conocidos:** indicaciones solo en texto; sin controles por edad ni recordatorio de vacunas.
**Fuentes:** AIEPI (OPS/OMS) para los signos de alarma en niños; control de crecimiento y desarrollo (CRED) del MINSA.

## P-MED-10 Receta

**Dónde:** `RecetasPanel` (`CA clinical-panels.tsx`), con las reglas en `M prescribing.ts` (las mismas en `AM` y `SM prescribing.ts`), y la lista de fármacos en `M medications.ts`.

- [ ] Cada ítem tiene DCI, concentración, forma, dosis, vía, frecuencia, duración y cantidad total, y la cantidad cuadra con la dosis, la frecuencia y los días.
- [ ] En un niño, el peso es obligatorio (menos de 12 años) y se propone el último. La dosis por peso se calcula por toma y por día, se compara con la dosis máxima y se traduce a ml según la concentración del jarabe o la suspensión. Hoy solo calcula los mg por toma si se escribe «N mg/kg».
- [ ] Alergia y reactividad cruzada (penicilina y cefalosporina) se avisan y piden un motivo para seguir.
- [ ] El embarazo avisa con los fármacos contraindicados (IECA, ARA II, estatinas, warfarina, tetraciclinas, retinoides, misoprostol, valproato, metotrexato) sin frenar la receta; la lactancia, con un recordatorio.
- [ ] Un controlado (opioides, benzodiazepinas) remite a la receta oficial.
- [ ] Un fármaco repetido (mismo ATC) se avisa.
- [ ] Las formas y vías son las de medicina general (supositorio, inhalador, nebulización, gotas óticas, oftálmicas y nasales), no las dentales («cartucho dental», «infiltrativa»).
- [ ] El PDF de la receta es legible para la farmacia y el cuidador, con firma, CMP y fecha de vencimiento.

**Huecos conocidos:** sin mg/kg/día, dosis máxima ni volumen en ml; sin interacciones (excluidas a propósito); sin ajuste renal; formas y vías con sesgo dental (`CL medications.ts`).
**Fuentes:** Manual de Buenas Prácticas de Prescripción (DIGEMID-MINSA); DCI (OMS); ATC (OMS); ADR 0131, 0132 y 0143.

## P-MED-11 Órdenes de laboratorio e imágenes, y sus resultados

**Dónde:** `CA ordenes-tab.tsx` y la tabla de órdenes en `DB clinical-forms.ts`.

- [ ] La orden dice qué se pide, para qué diagnóstico y a quién, y pasa por solicitado → en proceso → completado o cancelado.
- [ ] El resultado se sube como texto o archivo y queda ligado a su orden.
- [ ] Un valor numérico (hemoglobina, glucosa) se puede leer con su unidad, su rango y su evolución. Hoy no hay valores ni rangos.
- [ ] Un resultado crítico (hemoglobina muy baja) se nota.
- [ ] Una orden pendiente sin resultado se ve en la ficha y no se olvida.

**Huecos conocidos:** sin LOINC, valores, rangos, tendencia ni aviso de crítico; Clío manda «un hemograma» a las indicaciones, no crea la orden.
**Fuentes:** LOINC; UCUM.

## P-MED-12 Imágenes y tomografía

**Dónde:** Documentos de la ficha → «Ver» (`CA tomography-viewer.tsx`); los tipos en `M imaging.ts` y las ventanas en `packages/clinic-app/src/lib/ct-windows.ts`.

- [ ] La TC se ve en cortes, con su serie, y las ventanas en HU (pulmón, partes blandas, hueso y cerebro) aparecen solo si el estudio trae HU válidas.
- [ ] Medir pide escala, y dice que el diagnóstico es el informe del radiólogo.
- [ ] Una ecografía o una RM se sube y se ve, aunque no tenga visor.
- [ ] El informe del radiólogo queda ligado a su estudio y a su orden.

**Fuentes:** DICOM; ADR 0055, 0056, 0147 y 0154.

## P-MED-13 Interconsulta y referencia

**Dónde:** la orden de tipo `interconsulta` (`CA ordenes-tab.tsx`).

- [ ] La interconsulta a un colega de la clínica le llega como tarea, con el motivo y el resumen.
- [ ] La referencia a otro establecimiento (una emergencia, un hospital) lleva lo que pide la norma de referencia y contrarreferencia del MINSA.
- [ ] La respuesta (la contrarreferencia) vuelve a la historia. Hoy no existe.

**Fuentes:** norma técnica de referencia y contrarreferencia del MINSA.

## P-MED-14 Descanso médico y certificados

**Dónde:** `CA medical-leave.tsx`, con las reglas en `CL medical-leave.ts`.

- [ ] Desde qué día, cuántos días (de 1 a 365) y el diagnóstico solo si la persona lo autoriza.
- [ ] Se emite firmado y numerado. No se corrige: se anula con motivo y se emite otro.
- [ ] Un descanso dictado por Clío no se emite solo: se emite con su botón.
- [ ] Hay certificados que una consulta pide a menudo: de salud, escolar y de aptitud. Hoy no existen. El CITT de EsSalud se excluye a propósito.

**Fuentes:** CITT (EsSalud), para saber qué no reemplaza.

## P-MED-15 Procedimientos de hoy

Nebulización, inyectable, sutura o curación, con sus insumos (ADR 0106).

- [ ] Se registra qué se hizo, con dosis o medida, y los insumos salen del inventario de la sede.
- [ ] Si el procedimiento pide consentimiento (inyectables, procedimiento menor), se pide antes.
- [ ] Una nebulización repetida en la misma consulta (crisis de asma) se registra sin rehacer todo.

## P-MED-16 Consentimiento

**Dónde:** las plantillas de `M consents.ts` y la firma en `CA consent-signing.tsx` (comunes con odentIA).

- [ ] Las plantillas médicas (procedimiento menor, inyectables y toma de muestras) se ofrecen cuando corresponden.
- [ ] Un menor firma por su representante legal vigente; sin él, se ofrece firmar en papel.
- [ ] Lo que se firma en la tablet, en el enlace y en el PDF es lo mismo (ver P-ODO-09 en `odontologia.md`).
- [ ] Faltan plantillas de vacunación y de procedimientos ginecológicos (DIU, Papanicolaou).

**Fuentes:** Ley 29414; Ley 26842 (Ley General de Salud); ADR 0117 y 0148.

## P-MED-17 Evolución, firma, cierre y adenda

**Dónde:** el editor de la atención, `CA encounter-addendum-drawer.tsx` y la «Hoja de atención» (ADR 0133).

- [ ] Para cerrar se piden motivo, diagnóstico, evolución y colegiatura. Nada más se vuelve obligatorio.
- [ ] La firma guarda el nombre, el título («Médico cirujano») y el CMP de quien firma.
- [ ] Después de firmar solo se agrega una adenda; no se edita. Anular pide motivo y deja rastro.
- [ ] La Hoja de atención para el seguro tiene lo que el seguro pide.

**Fuentes:** NTS 139-MINSA; ADR 0003, 0099, 0131, 0132 y 0165.

## P-MED-18 Historia clínica y documentos

**Dónde:** la ficha (Antecedentes, Signos vitales, Historia y Documentos; `SM help.ts`), la copia en PDF y FHIR (`packages/services/src/patient-record.ts`).

- [ ] La Historia se lee por atención, en orden, con lo que se hizo en cada una.
- [ ] La copia en PDF y FHIR R4 trae todo, también los antecedentes médicos, y lo emitido no cambia (ADR 0132 y 0156).
- [ ] Los pedidos de la persona sobre sus datos se atienden (ADR 0080).
- [ ] El acceso queda registrado (`clinical_access_log`).

**Fuentes:** NTS 139-MINSA; HL7 FHIR R4; ADR 0035, 0057 y 0080.

## P-MED-19 Clío: el dictado

**Dónde:** `packages/services/src/encounter-dictation.ts`, `SM dictation.ts` y `packages/agent/src/medical/dictation.ts`.

- [ ] Lo dictado entra como propuesta y el médico lo confirma; nada se guarda sin confirmar.
- [ ] No diagnostica por su cuenta y usa los códigos de la lista de la clínica.
- [ ] La receta dictada pasa por las mismas reglas que la escrita (alergia, embarazo, peso).
- [ ] Deshacer una corrección por voz no borra un aviso de alergia que ya se había dictado.
- [ ] Lo que Clío no puede hacer (una orden de laboratorio) se dice, en vez de meterlo en otro lado sin avisar.
- [ ] Al reservar (ADR 0102) distingue una cita de un control; la hora sale de la agenda, no del modelo, y nada se envía por voz sin confirmar.

**Fuentes:** ADR 0012, 0099 y 0100.

## P-MED-20 Señales de alarma en los mensajes

**Dónde:** `SM agent-texts.ts` y `CL emergency.ts`.

- [ ] Un mensaje con una señal de alarma (embarazo con sangrado, bebé que no lacta, cianosis, intoxicación) recibe el número de emergencias del país y le llega al equipo.
- [ ] Sofi no da indicaciones médicas en esos casos.
- [ ] Están todas las señales generales de peligro de AIEPI: no puede beber o lactar, vomita todo, convulsiones, letargia, tiraje («se le hunden las costillas»), fiebre en un menor de 2 meses y deshidratación. Hoy faltan «vomita todo», el tiraje, la fiebre en el menor de 2 meses y la deshidratación (`SM agent-texts.ts`; las convulsiones están en `packages/agent/src/alarm.ts`).

**Fuentes:** AIEPI (OPS/OMS).

## P-MED-21 Quién ve lo clínico

**Dónde:** `packages/auth/src/permissions.ts`.

- [ ] Lee y escribe lo clínico quien tiene `clinical.write` (el médico; propietario y administrador tienen todo).
- [ ] Recepción no ve lo clínico: solo las alertas, y puede subir una tomografía sin abrirla.
- [ ] Caja ve lo que necesita para cobrar y nada clínico.
- [ ] El servidor lo rechaza, no basta con que falte el botón.

---

## Lo que hace una consulta y la app todavía no tiene

Flujos que un médico hace a menudo y que no tienen un camino propio en el código. La voz los recorre con lo que hay hoy y dice cuánto cuesta hacerlos, si se pueden hacer y si se pierde algo. Antes de proponer construir uno, aplica la pregunta del `AGENTS.md` raíz.

### P-MED-22 Control del niño sano (CRED) y tamizajes

- [ ] Los controles por edad, con crecimiento, desarrollo psicomotor, vacunas y los tamizajes que tocan (hemoglobina, visión, audición y desarrollo).
- [ ] Lo que falta en cada control se ve de un vistazo.

**Fuentes:** norma técnica de control de crecimiento y desarrollo del MINSA; norma técnica de anemia del MINSA vigente.

### P-MED-23 Enfermedades crónicas

- [ ] Hipertensión, diabetes y asma con sus metas (presión, HbA1c), la tendencia, la medicación y los controles repetidos, sin rehacer todo en cada visita.

**Fuentes:** guías ADA (diabetes) y GINA (asma).

### P-MED-24 Notificación obligatoria

- [ ] Una enfermedad de notificación obligatoria (dengue, tuberculosis, sarampión) avisa al médico que debe notificarla al MINSA.

**Fuentes:** lista de enfermedades de notificación obligatoria del MINSA (CDC Perú).

### P-MED-25 Salud mental en la consulta

- [ ] Un tamizaje breve (PHQ-9 o similar) se puede registrar cuando la consulta lo pide, y el riesgo se nota.

### P-MED-26 Control prenatal y planificación familiar

La biblioteca médica ofrece el control prenatal, el DIU, el implante anticonceptivo, el Papanicolaou y la ecografía obstétrica (`packages/db/seeds/biblioteca_medica.csv`). El catálogo solo contaba las sesiones (P-MED-09).

- [ ] Control prenatal: fecha de última regla, edad gestacional y fecha probable de parto calculadas, altura uterina, latidos fetales, presión, suplementos y las señales de alarma del embarazo.
- [ ] Planificación familiar: el método con la fecha de inicio y de cambio o retiro, y su control.
- [ ] El resultado del Papanicolaou queda con su seguimiento y no se pierde si es anormal.
- [ ] Su consentimiento propio (DIU, implante).

**Fuentes:** normas técnicas de salud materna y de planificación familiar del MINSA (verificar los números vigentes).

### P-MED-27 Teleconsulta

- [ ] Evaluar primero el valor: ¿las clínicas atienden por videollamada? Si lo hacen, ¿la atención dice que fue a distancia? Solo se propone si una clínica real lo pide.

**Fuentes:** Ley 30421 (Ley Marco de Telesalud) y su reglamento.

---

## Casos

Cada caso va de punta a punta, con datos coherentes, y dice qué procesos recorre. Se crean pacientes con el prefijo `QA` y teléfonos `+44 7700 900xxx`.

| Caso | Paciente y situación | Recorre | Lo que tiene que pasar |
|---|---|---|---|
| CM1 | Lactante de 9 meses (8,5 kg) con fiebre de 39 °C hace 2 días y tirándose de la oreja. Lo trae la mamá. | 01, 02, 05, 06, 08, 09, 10, 17 | Registro con la mamá como responsable; edad en meses; temperatura alta que se nota; otoscopia como hallazgo; otitis media aguda; amoxicilina a 80–90 mg/kg/día en dos tomas, traducida a ml de la suspensión, y paracetamol por peso; signos de alarma para la mamá; control en 48–72 horas. |
| CM2 | La misma niña a los 18 meses, control del niño sano. | 02, 04, 07, 09 | Peso, talla y perímetro cefálico con percentil OMS; vacunas que le tocan según el esquema y cuáles faltan; desarrollo; próximo control por edad. |
| CM3 | Lactante de 4 meses con tos, respira rápido y SpO₂ de 89 %. | 02, 06, 08, 09, 13, 15 | Taquipnea e hipoxemia que se notan; bronquiolitis sin broncodilatador de rutina; referencia a emergencia con su resumen; signos de alarma. |
| CM4 | Niño de 6 años alérgico a la penicilina, con faringitis bacteriana. | 03, 08, 10 | La alergia se ve al recetar; amoxicilina o una cefalosporina avisan reactividad cruzada y piden motivo; la alternativa queda bien dosificada por peso. |
| CM5 | Adolescente de 16 años que necesita un descanso de 3 días para el colegio, sin que se vea el diagnóstico. | 01, 14 | La firma de su responsable donde corresponde; el descanso numerado y firmado sin diagnóstico; anularlo con motivo y emitir otro. |
| CM6 | Adulto de 58 años hipertenso, control cada 3 meses, con enalapril. | 02, 03, 08, 09, 10, 11 | Presión con su serie anterior; la medicación habitual a la vista; orden de laboratorio (creatinina, potasio) y su resultado al volver; control repetido. |
| CM7 | Mujer de 30 años con 10 semanas de embarazo, a la que se le iba a recetar un IECA. | 03, 09, 10 | El embarazo a la vista; el IECA avisa sin frenar; las sesiones del control prenatal cuentan bien. |
| CM8 | Niña de 3 años con anemia: llega el resultado con hemoglobina de 7,5 g/dL. | 08, 10, 11 | Se sube el resultado a su orden; el valor bajo se nota; hierro por peso; control. |
| CM9 | Equivocarse: diagnóstico en el paciente equivocado, y una nota que hay que corregir después de firmar. | 08, 17, 18 | Anular la atención con motivo y rastro; agregar una adenda a la firmada; la Historia muestra todo sin confusión. |
| CM10 | Toda una consulta dictada a Clío (CM1 hablado). | 19 y los que toque | Cada propuesta se confirma; la receta dictada pasa por las mismas reglas; nada se guarda solo. |
| CM11 | Tomografía de tórax que trae el paciente. | 12 | La sube recepción sin verla; el médico la ve por cortes con la ventana de pulmón; el informe queda ligado. |
| CM12 | La mamá escribe por WhatsApp: «mi bebé no quiere lactar y está muy dormido». | 20 | Respuesta con el número de emergencias y aviso al equipo, sin indicación médica. |

### Los recorridos largos

| Caso | Paciente | Etapas | Lo que tiene que pasar |
|---|---|---|---|
| RM1 | El lactante de CM1: otitis, control a las 48–72 horas y alta. | 1 a 3 | En el control se compara la fiebre y la otoscopia; si no mejora, se cambia el antibiótico con rastro; si mejora, la otitis queda resuelta y deja de proponerse. |
| RM2 | Adulto que debuta con hipertensión: confirmación, laboratorio, tratamiento y controles por años. | 1 a 4 | Diagnóstico presuntivo que pasa a definitivo; laboratorio pedido y su resultado ligado; enalapril como medicación habitual; controles cada 3 meses con la serie de presión; al volver al año, la ficha muestra todo. |
| RM3 | Niña de la demo desde los 2 meses hasta los 2 años, en sus controles del niño sano. | 1 a 4 | Cada control parte del anterior: la curva de crecimiento sigue, las vacunas que faltan se ven y el próximo control es el que toca por edad. |
