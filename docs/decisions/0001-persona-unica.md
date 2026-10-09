# 0001 · Persona única: el contacto es la persona y el paciente su historia clínica

Fecha: 2026-10-07 · **Estado:** aceptada

## Problema

Una misma persona existía dos veces sin garantía de coherencia: como `patient` (ficha clínica) y como `contact` (quien escribe, paga o representa). El vínculo «es la misma persona» era opcional, el nombre, teléfono y correo se guardaban en ambos y podían divergir, el contacto no tenía documento —un representante legal no quedaba identificado— y cada módulo colgaba de una clave distinta. A la vez, quien escribe, quien paga y quien se atiende no siempre coinciden (tutor de un menor, teléfono compartido, interesado que aún no se atiende), así que fusionar ambas entidades tampoco era correcto.

## Decisión y motivo

- `contact` es **la persona**; `patient` es **su historia clínica**. Todo paciente es exactamente una persona: su vínculo `self` en `patient_contact`. No toda persona es paciente.
- La identidad (nombre, documento, nacimiento, sexo, teléfono, correo) es una sola. Se conserva físicamente en ambas tablas y **la base garantiza que sean iguales**: triggers de sincronización en los dos sentidos y conciliación al crear el vínculo (manda la ficha; lo que solo el contacto conocía se completa; un teléfono o correo distinto queda anotado en el contacto).
- Si al confirmar la transacción un paciente no tiene persona, la base adopta la que ya tiene su mismo documento o la crea desde la filiación. El teléfono nunca identifica.
- Una persona creada solo para la ficha es **provisional** mientras nada más la referencie; identificar al paciente con un contacto real la sustituye. Con actividad propia, no se fusiona en silencio.
- La propia persona no se desvincula ni cambia de relación. El agente no modifica la identidad de quien ya es paciente.

Se eligió garantizarlo en la base porque así vale para cualquier escritor (servicios, registro público, semilla, importaciones) y no rompe a los lectores existentes, que siguen consultando `patient`.

## Alternativas descartadas

- **Solo componer en la vista.** No corrige la divergencia de datos ni identifica a representantes.
- **Tabla `person` nueva por encima de ambas.** Obliga a migrar agenda, caja, bandeja y oportunidades sin aportar nada que el vínculo `self` no dé.
- **Quitar ya las columnas de identidad de `patient`.** Es el estado final deseable, pero exige reescribir todas las consultas que leen el nombre o el documento del paciente; se deja como paso mecánico posterior, sin cambio de comportamiento.

## Consecuencias

- Beneficio: un solo lugar lógico para la identidad, representantes con documento, «registrar como paciente» sin volver a escribir datos y una base común para la actividad unificada de la persona.
- Sacrificio: la identidad sigue duplicada físicamente y depende de triggers; quien inserte un paciente y vincule su persona en transacciones separadas verá primero una persona provisional.
- La lista de contactos incluye a todas las personas, también a pacientes sin canal.
- Revisar si se decide retirar las columnas de `patient` o si aparece un caso de identidad distinta legítima entre ficha y persona.

## Referencias

`packages/db/drizzle/0034_person_identity.sql`, `packages/db/src/person-identity-migration.test.ts`, `packages/services/src/patients.ts` (`setPatientContact`, `removePatientContact`), `packages/services/src/contacts.ts` (`updateContact`).
