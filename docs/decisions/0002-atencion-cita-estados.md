# 0002 · La atención nace de la cita y tiene tres estados: borrador, finalizada y anulada

Fecha: 2026-10-08 · **Estado:** aceptada (implementación en la fase 1 de la propuesta UX)

## Problema

La atención clínica (`encounter`) no conoce la cita que la motivó: la agenda no inicia atenciones, la cita pasa a «atendida» solo a mano y una atención puede abrirse sin sede ni hora declarables. Solo existen los estados `borrador` y `finalizada`: un borrador abierto por error no se puede descartar, bloquea abrir otro y obliga a cerrarlo inventando un motivo. Dentro del borrador, un diagnóstico o un procedimiento registrados por error tampoco se pueden anular; al cerrar, el procedimiento genera su cargo. Un hallazgo del odontograma nunca pasa a «tratado» y, si quedó ligado a una atención cerrada, ni siquiera se anula. Por último, cualquier usuario con `clinical.write` edita o cierra el borrador de otro profesional, y el perfil no tiene colegiatura, así que el cierre no puede firmar.

## Decisión y motivo

- **Una atención por cita.** `encounter.appointment_id` referencia la cita del mismo paciente y organización (clave compuesta) con unicidad por cita activa. Atender desde la agenda hereda paciente, profesional, sede y hora de inicio; sin cita, «Nueva atención» pide motivo y profesional y registra la hora de inicio; la hora de fin se declara al firmar. Al finalizar, la cita pasa a «atendida»; al anular, vuelve a su estado previo. Es la misma operación de negocio para agenda y ficha.
- **Tres estados.** `borrador` → `finalizada` o `anulada`. Anular exige motivo, solo en borrador, nunca genera cargos ni controles, y anula con el mismo motivo los procedimientos, diagnósticos y hallazgos ligados. Finalizada y anulada son inmutables (trigger); lo finalizado se corrige con adendas tipificadas.
- **Correcciones en borrador.** Diagnóstico, procedimiento, hallazgo y receta se anulan con motivo mientras la atención está abierta. El diagnóstico pasa a entidad propia (`encounter_diagnosis`: CIE-10, tipo presuntivo/definitivo/repetido, pieza, superficies, estado) para poder anularlo y consolidarlo; `clinical_note` queda para evolución y adendas.
- **Hallazgo tratado.** Un hallazgo del odontograma se resuelve al vincularlo con el procedimiento que lo trata (`resolved_by_procedure_id`), registrando el hallazgo de tratamiento según la NTS 188. Resolver no es anular: sigue permitido aunque el hallazgo provenga de una atención cerrada.
- **Autoría y firma.** Una sola atención abierta por paciente: es la historia clínica única y dos borradores paralelos se contradirían. Solo quien la lleva la edita y la firma; otro profesional la lee y, si continúa, «toma el relevo», que cambia el responsable y queda registrado. El cierre exige la colegiatura del perfil profesional (`professional_profile`, por organización y usuario) y guarda nombre, título y colegiatura como instantánea; también la usarán el acta de odontograma y los consentimientos.

Se eligió modelar estados y vínculos en la base, no solo en la interfaz, porque la regla debe valer para recepción, portal y agente, y porque la inmutabilidad y la unicidad no pueden depender de una comprobación previa del servicio.

## Alternativas descartadas

- **Borrar borradores en vez de anularlos.** Pierde la traza de quién abrió qué y por qué; el borrado de atenciones está revocado a propósito.
- **Marcar la cita «atendida» desde la agenda sin vínculo.** Mantiene dos verdades (cita y atención) que ya divergen hoy.
- **Permitir varias atenciones por cita.** Complica cargos y controles sin un caso real; una segunda visita es otra cita.
- **Diagnóstico como nota con columnas de anulación.** Mantiene cuatro sitios con CIE-10 sin lista consolidada del paciente.

## Consecuencias

- Beneficio: ciclo cerrado cita → atención → cierre, errores corregibles sin inventar datos, odontograma que refleja lo tratado, firma con colegiatura.
- Sacrificio: migración de las notas con diagnóstico a la tabla nueva; las atenciones históricas quedan sin cita (`appointment_id` nulo) y se muestran como tales.
- Revisar si aparece un caso legítimo de dos profesionales atendiendo a la vez al mismo paciente o de una atención que abarque varias citas.

## Referencias

Propuesta UX (lienzo «UX ficha y atención clínica», filas 2, 6 y 7). Contratos actuales: `packages/db/src/schema/clinical.ts` (`encounter`, `encounterProcedure`, `odontogramEntry`, `clinicalNote`), `packages/services/src/encounters.ts`, `packages/services/src/clinical.ts`, `apps/dental-clinic/src/routes/_org/agenda.tsx`. Al implementar cada punto, la regla vigente se añade a `packages/services/AGENTS.md`.
