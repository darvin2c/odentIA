# 0041 · Diagnósticos por lista y demografía con códigos internacionales

Fecha: 2026-10-16 · **Estado:** aceptada (fase 4, tablero 6; decisiones 11, 26 v3, 27 y 28 v2; issues 35 y 42) · Actualiza [0004](0004-identidad-estandar.md) en estado civil, nivel educativo, parentesco, tipo de diagnóstico y catálogo CIE. Actualizada por [0053](0053-la-cie-11-oficial-vive-en-el-repositorio.md) en la carga del catálogo.

## Problema

El catálogo de diagnósticos era una tabla `cie10_code(code)` sin decir de qué lista venía, con 124 códigos de la boca sin fuente. Una fractura (S02.5) no se podía codificar y, como el diagnóstico es obligatorio para cerrar, la atención quedaba bloqueada. La CIE-10 en español tiene derechos de la OPS; la CIE-11 de la OMS es CC BY-ND 3.0 IGO y Colombia ya la adopta por norma. El tipo de diagnóstico era el del HIS del MINSA (presuntivo, definitivo, repetido) y el estado civil, el nivel educativo y el parentesco eran catálogos peruanos o propios, también en los checks de la base.

## Decisión y motivo

- **Cada código guarda su lista.** El catálogo es `diagnosis_code(system_key, code)` con su edición (`diagnosis_code_release`: edición, licencia, fuente, SHA-256 y si es oficial). Las diez columnas que guardan un diagnóstico guardan lista y código con una FK compuesta. Listas: «CIE-10 (OMS)» y «CIE-11 (OMS)»; la CIE-10 MINSA y la CIE-10-ES quedan como listas aparte, preparadas sin cargar.
- **La lista es de la clínica** (`org_profile.diagnosis_system`): al crearla viene la que recomienda su país (`clinicalProfileFor().diagnosis`: CIE-10 en general, CIE-11 en Colombia) y se cambia en «Datos de la clínica» con el aviso de su país. Los diagnósticos nuevos se eligen en ella; lo registrado no se reescribe y se puede volver atrás. **Nunca se calcula un código de una lista a partir de la otra**: la tabla de la OMS no sirve para convertir datos (falló en 8 de 51 casos del piloto de Colombia).
- **Elegir en tres pasos:** lo que propone el hallazgo del odontograma (`findingDiagnosisCode`), los más usados en la clínica y el buscador de toda la lista, sin tildes ni mayúsculas (texto normalizado con índice de trigramas) y con lo odontológico primero. El diagnóstico sigue siendo obligatorio para cerrar; «Presuntivo» basta.
- **Tipo con HL7 FHIR `Condition.verificationStatus`** (provisional, confirmed). «Ya diagnosticado antes» no se elige: lo marca el sistema cuando la persona ya tenía el mismo código en la misma lista; el perfil de Perú lo dice como el HIS (P, D, R).
- **Demografía con estándares abiertos:** estado civil HL7 v3 MaritalStatus (la palabra de un país, como «Conviviente», se guarda con su prefijo `PE:` y se traduce a T solo al exportar), nivel educativo CINE (ISCED) 2011 y parentesco HL7 v3 RoleCode, en los antecedentes familiares y las personas vinculadas. Cada tipo de documento tiene su código HL7 v2-0203.
- **SNOMED CT e ICDAS, no por ahora** (decisión 27): el modelo ya admite un segundo código cuando un país lo pida.

## Alternativas descartadas

- **Solo CIE-10 completa:** exige el permiso escrito de la OPS para un SaaS de pago y no sirve para Colombia.
- **Solo CIE-11:** no cumple el registro oficial de Perú, Chile o México.
- **Guardar la CIE-11 calculada en silencio junto a la CIE-10:** datos derivados que nadie vio y con errores medidos.
- **Lista elegida por cada doctor:** reportes y «más usados» mezclarían listas dentro de la misma clínica.

## Consecuencias

- Beneficio: una atención fuera de la boca se puede codificar en cuanto se cargue el archivo oficial; la clínica puede empezar con la CIE-11 sin permiso; los datos de la persona se exportan a FHIR sin traducir.
- Sacrificio: la CIE-10 completa no se carga hasta tener el permiso de la OPS; la semilla de desarrollo de la CIE-10 no es oficial (la CIE-11 oficial se incluye desde la [0053](0053-la-cie-11-oficial-vive-en-el-repositorio.md)); los reportes que crucen un cambio de lista deben separar las listas.
- Revisar cuando llegue el permiso de la OPS, un país que exija SNOMED o la primera clínica de Colombia.

## Referencias

`packages/clinical/src/diagnoses.ts`, `packages/clinical/src/identity.ts`, `packages/clinical/src/country-profiles.ts`, `packages/services/src/diagnosis-codes.ts`, `packages/db/src/seed-diagnoses.ts`, `packages/db/drizzle/0000_base.sql` y `0001_base_reglas.sql` (la migración 0102 quedó dentro de la base, ADR 0045). Evidencia: informes de la fase 4 (`fase-4-internacional-cie10.md`, `fase-4-estandares.md`, `fase-4-benchmark-codigos.md`).
