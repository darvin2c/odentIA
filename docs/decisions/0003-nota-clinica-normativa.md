# 0003 · La nota de la atención sigue la estructura de la historia clínica peruana

Fecha: 2026-10-08 · **Estado:** aceptada (implementación en la fase 2 de la propuesta UX) · Ajustada por [0033](0033-documentos-de-la-atencion-en-un-solo-lugar.md): los exámenes auxiliares se piden como órdenes y la receta vive en el bloque Documentos. Actualizada por [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md): la estructura normativa peruana (NTS 139, NTS 188) es del perfil de Perú; el odontograma firmado sale solo en clínicas de Perú al cerrar la atención y se firma con el perfil profesional, sin trazo.

## Problema

La atención se compone de bloques opcionales (consulta, examen, odontograma, servicios, plan, recetas, controles, documentos, evolución) y la interfaz declara que «nada es obligatorio». Para cerrar basta el motivo: una atención puede finalizar sin diagnóstico. Faltan campos que la historia clínica exige o espera: enfermedad actual y tiempo de enfermedad (se retiraron de la anamnesis «para capturarse en la atención» y nunca se añadieron), funciones vitales, exámenes auxiliares, pronóstico y firma. El CIE-10 vive en cuatro tablas sin lista consolidada y el catálogo cargado solo cubre K00–K14. La receta guarda todo el medicamento en un texto y no tiene formato normativo.

## Decisión y motivo

- **Secciones en el orden de la NTS 139-MINSA** (historia clínica): consulta (motivo, enfermedad actual, tiempo de enfermedad), funciones vitales, examen clínico (general, extraoral, intraoral), diagnóstico, procedimientos, plan de trabajo, receta, exámenes auxiliares, controles, documentos, evolución y pronóstico. Las secciones vacías no se guardan; la interfaz las presenta en ese orden y las agrega cuando ocurren.
- **Mínimo para cerrar:** motivo, al menos un diagnóstico con CIE-10 y tipo (presuntivo, definitivo o repetido), evolución, y firma con nombre y colegiatura. Funciones vitales, exámenes auxiliares y pronóstico son opcionales: documentar una consulta no obliga a inventar datos.
- **Terminología única.** Las etiquetas de interfaz, API y base usan el glosario de la propuesta (anamnesis, antecedentes patológicos, medicación actual, diagnóstico, procedimiento, tratamiento, plan de trabajo, evolución, pronóstico, control). Un módulo de etiquetas por dominio evita enums crudos en pantalla.
- **Catálogos oficiales.** CIE-10 completo (no solo el capítulo odontológico) cargado con verificación de hash como CPMS; procedimientos con la lista de servicios de cada país (CPMS en el Perú, [0067](0067-biblioteca-de-servicios-por-pais.md)); pieza y superficie con FDI y, en clínicas de Perú, la simbología de la NTS 188 (0036).
- **Receta con campos separados:** denominación común internacional, nombre comercial opcional, concentración, forma farmacéutica, vía por catálogo, dosis, frecuencia, duración, cantidad (número y letras al imprimir), indicaciones; cabecera con diagnóstico, vigencia y prescriptor con colegiatura; hoja de impresión propia. El formato final se contrasta con la norma de receta vigente antes de fijar obligatorios.

Se eligió la estructura normativa porque es la que auditores, aseguradoras y otros profesionales reconocen, y porque un mínimo pequeño y explícito respeta «menos es más» sin perder la validez del registro.

## Alternativas descartadas

- **SOAP.** Reconocible, pero no es el formato que exige la norma local ni el que usan los formatos oficiales de historia odontológica.
- **Todo obligatorio.** Produce datos inventados para poder cerrar; contradice la regla de no simular.
- **Mantener la receta en texto libre.** Impide la alerta de alergias cruzadas, la impresión normativa y cualquier interoperabilidad.

## Consecuencias

- Beneficio: atenciones cerradas con diagnóstico codificado, lectura uniforme de la historia, receta imprimible y verificable, alerta de alergias posible.
- Sacrificio: migración de recetas antiguas (el texto se conserva en `medication_name` y los campos nuevos quedan vacíos hasta edición); las atenciones históricas sin diagnóstico se muestran como «sin codificar», no se completan.
- Revisar cuando se publique una nueva edición de la NTS 139 o cambie el formato de receta.

## Referencias

Propuesta UX (lienzo, filas 2 y 7). Contratos actuales: `packages/services/src/encounters.ts` (`finalizeEncounter`, `assertExamination`), `packages/services/src/prescriptions.ts`, `packages/db/src/seed-cie10.ts`, `packages/db/seeds/cie10.csv`. Fuentes a verificar al implementar: NTS 139-MINSA/2018/DGAIN (historia clínica), norma vigente de receta (DIGEMID), NTS 188-MINSA/DGIESP-2022 (odontograma).
