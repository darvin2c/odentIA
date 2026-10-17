# 0004 · Identidad estándar del paciente, número de historia y catálogos oficiales

Fecha: 2026-10-08 · **Estado:** aceptada (implementación en la fase 3 de la propuesta UX) · Actualizada por [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md): los documentos, el seguro y la dirección dependen del país de la clínica (documento con su país emisor y único con él, seguro con tipo general y régimen del país, dirección HL7 FHIR); sale el ubigeo, salen `identity_legacy` e `insurance_detail`, y los datos censales solo pueden ser opcionales. Actualizada por [0041](0041-diagnosticos-por-lista-y-demografia-con-codigos-internacionales.md): estado civil HL7 MaritalStatus, nivel educativo CINE 2011, parentesco HL7 RoleCode, tipo de diagnóstico FHIR y diagnósticos por lista (CIE-10 o CIE-11), en lugar de los catálogos de HIS/INEI.

## Problema

La filiación guarda un solo `display_name`, sexo solo M/F, documento sin país emisor ni tipos para recién nacidos o extranjeros, y estado civil, grado de instrucción, ocupación, dirección y procedencia como texto libre. No hay ubigeo, nacionalidad, lugar de nacimiento ni número de afiliación del seguro. El teléfono no se normaliza en el servidor. El representante de un menor dado de alta no se persiste como persona vinculada. El consentimiento de datos se escribe una vez, sin versión del aviso ni revocación. Las alergias no tienen criticidad ni verificación, los antecedentes familiares son un texto y los hábitos una lista separada por comas. El número de historia es un correlativo por organización y no hay decisión registrada sobre si debería ser el DNI.

## Decisión y motivo

- **Nombre separado:** apellido paterno, apellido materno y nombres, con `display_name` derivado por la base. La migración separa el nombre existente por heurística y marca la ficha «identidad por revisar» hasta que recepción confirme; nunca borra datos.
- **Catálogos en vez de texto libre:** sexo con masculino, femenino, indeterminado y desconocido (correspondencia con ISO 5218 documentada en el check); documento DNI, carné de extranjería, pasaporte, CNV, DIE y otro, con país emisor ISO 3166 cuando no es peruano; estado civil y grado de instrucción según el catálogo de HIS/INEI; seguro con tipo, aseguradora y número de afiliación; domicilio y lugar de nacimiento con ubigeo INEI más dirección y referencia. Las validaciones de formato (DNI de ocho dígitos, CE y pasaporte alfanuméricos, teléfono E.164, fechas en la zona de la organización) viven en el servidor y aplican también a la edición desde Contactos.
- **Número de historia:** se conserva el correlativo por organización (`patient_number`) como identificador de la historia y el documento se muestra siempre a su lado. Motivo: no todo paciente tiene DNI (extranjeros, recién nacidos) y el número debe ser estable aunque cambie el documento; la norma usa el DNI en establecimientos públicos, y una clínica privada cumple con un número único y trazable. Se documenta en el código como desviación justificada.
- **Representante del menor:** el alta de un menor crea la persona del representante, su vínculo y la responsabilidad `representante_legal` en la misma transacción; el propio paciente nunca puede ser su representante.
- **Consentimiento de datos** (Ley 29733): registro por versión del aviso, finalidades separadas, quién lo otorga y revocación; recepción puede registrarlo.
- **Antecedentes estructurados:** alergias con tipo (alergia o intolerancia), categoría, reacción, gravedad sin valor por defecto, criticidad y verificación; antecedentes patológicos con CIE-10 completo; antecedentes familiares por parentesco y condición; hábitos y cuestionario por aparatos como campos con respuesta explícita (sí, no, no sabe, sin responder); clasificación ASA. «No preguntado» se distingue de «niega».
- **Fuentes:** ubigeo del INEI, CIE-10 completo de la fuente oficial y grupos farmacológicos ATC para la alerta de alergias cruzadas; cada catálogo se carga con verificación de hash y procedencia, como CPMS.

Se eligió fijar los catálogos en la base porque el valor de la filiación está en poder buscar, cruzar y exportar; un texto libre no permite ninguna de las tres cosas.

## Alternativas descartadas

- **Usar el DNI como número de historia.** Deja sin número a quien no lo tiene y obliga a renumerar si cambia el documento.
- **Campos personalizados por organización** para la filiación. Ya existen para contactos y no resuelven la estandarización: cada clínica inventaría su catálogo.
- **Una sola columna «nombre completo» con parseo en la vista.** No permite ordenar, buscar ni imprimir formatos oficiales.

## Consecuencias

- Beneficio: filiación completa y comparable, identidad de menores y representantes verificable, consentimiento de datos defendible, antecedentes que alimentan alertas clínicas reales.
- Sacrificio: migración con revisión manual de nombres; carga y mantenimiento de catálogos externos (licencia y actualización); el trigger de sincronía persona-paciente se extiende a las columnas nuevas.
- Revisar si una norma exige otro identificador de historia o si el formato de alta pública necesita campos distintos de la interna.

## Referencias

Propuesta UX (lienzo, filas 3 y 7). ADR 0001 (persona única). Contratos actuales: `packages/db/src/schema/clinical.ts` (`patient`, `patientAllergy`, `patientCondition`, `patientAnamnesis`), `packages/clinical/src/patient-registration.ts`, `packages/services/src/patient-registration.ts`, `packages/services/src/patients.ts`, `packages/db/drizzle/0034_person_identity.sql`.
