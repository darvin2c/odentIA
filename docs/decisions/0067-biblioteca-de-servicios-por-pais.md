# 0067 · Una biblioteca de consultorio y el código de la lista de cada país

Fecha: 2026-10-19 · **Estado:** aceptada (fase 1: núcleo y Perú; lienzo del issue 40, versión 3, nueve decisiones aprobadas) · Actualiza [0039](0039-un-solo-catalogo-de-especialidades.md) (con qué especialidades nace la clínica), [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md) (lo que deja un tratamiento en la pieza) y [0003](0003-nota-clinica-normativa.md) (procedimientos con CPMS). Issue 40.

## Problema

La biblioteca de servicios era la CPMS del Perú copiada uno a uno: 505 plantillas con el nombre de la norma, para clínicas de cualquier país. Una clínica de Bogotá veía códigos peruanos; una del Perú, «Cultivo viral» o «Examen dental post morten»; y un servicio propio quedaba «sin código oficial», aunque la RM 550-2023-MINSA obliga a codificar también a las IPRESS privadas. Lo que dejaba un tratamiento en la pieza se buscaba por el código CPMS, y las especialidades con que nacía la clínica eran tipos de tratamiento («Diagnóstico», «Prevención»), no las que reconoce cada país.

## Decisión y motivo

- **Una biblioteca nuestra, de consultorio.** `catalog.treatment_template` son unos 400 tratamientos escritos por odentIA con un nombre corto («Resina fotocurable, 1 superficie, posterior»), su ámbito, lo que dejan en la pieza (`leaves_finding`) y si van en «Más usados» (`is_common`). El núcleo no lleva código. Se carga de `seeds/biblioteca.csv`; lo que sale de la biblioteca queda inactivo.
- **Cada tratamiento lleva el código de la lista de su país que lo incluye** (`treatment_template_code`, uno por lista y edición): el exacto si la lista es fina, el que usa la norma si es gruesa (en Colombia, una sola resina). Nunca uno inventado ni de otro país. Se carga de `seeds/biblioteca_codigos.csv` y se reemplaza entero en cada edición.
- **El perfil del país declara su lista** (`ClinicalCountryProfile.services`: lista, si es obligatoria y su norma). Obligatoria (Perú; después Colombia y México): la biblioteca solo ofrece lo que tiene código y un servicio propio elige el suyo con un buscador; sin él no se crea. De referencia (Chile, Costa Rica, El Salvador): el código es opcional. Sin lista: no hay campo ni código.
- **El código se exige al crear y editar, no al indicar.** Si una edición nueva retira el código de un servicio ya creado, la consulta no se detiene: se indica sin código y Servicios pide elegir otro. Lo indicado guarda su código congelado, como antes.
- **El tipo de tratamiento es interno** (`TREATMENT_KINDS`; la columna sigue llamándose `specialty`): agrupa la biblioteca, propone la fase del plan, guarda las palabras de la calle del agente y dice qué especialidad del país recibe cada tratamiento. Un servicio propio toma el tipo de su especialidad; con una que creó la clínica, queda sin tipo.
- **La clínica nace con las especialidades de su país** (`ClinicalCountryProfile.specialties`): en el Perú, las 12 del DS 023-2020-SA que atienden pacientes y Odontología general; sin perfil, la lista corta del núcleo. Lo demás de 0039 sigue igual.
- **Sin ruido técnico.** El código del país es un dato más del detalle («Código CPMS · D0140»); salen la edición, la denominación oficial, el pie «505 de 505» y el estado «Heredada». «Normas de tu país», en Datos de la clínica, dice de solo lectura qué exige el país elegido.

## Alternativas descartadas

- *Seguir con la CPMS como biblioteca de todos*: nombres de norma, servicios de hospital y códigos peruanos fuera del Perú.
- *La ICHI de la OMS como núcleo*: es gratis, pero no existe en español, sigue en desarrollo, es gruesa (17 códigos de dientes) y su licencia no deja traducirla ni ligarla con otra lista sin acuerdo escrito.
- *Guardar el código solo si es exacto*: en Colombia la norma obliga a usar el código grueso.
- *Bloquear la indicación de un servicio sin código vigente*: detiene al odontólogo en plena consulta por algo que se arregla en Servicios.

## Consecuencias

- Beneficio: cada clínica ve nombres de consultorio y solo el código de su país; en el Perú todo servicio queda codificado; agregar un país es cargar su lista y ligar la biblioteca, sin tocar pantallas.
- Sacrificio: la biblioteca es nuestra y hay que mantenerla; sus correcciones clínicas (lo que deja cada tratamiento, el ámbito) las confirma un odontólogo antes de cargarlas.
- Revisar antes de vender: los códigos dentales de la CPMS usan la numeración de la CDT de la ADA, y la traducción española de la CIE-9-MC (México y El Salvador) tiene sus propios derechos.

## Referencias

- `packages/clinical/src/country-profiles.ts` (`services`, `specialties`, `specialtyForKind`, `kindOfSpecialty`), `treatment-templates.ts` (`TREATMENT_KINDS`, `phaseForKind`).
- `packages/db/src/procedure-codes.ts` (`seedProcedureCodes`), `seeds/biblioteca.csv`, `seeds/biblioteca_codigos.csv`; migraciones `0036_biblioteca_por_pais.sql` y `0037_biblioteca_por_pais_reglas.sql`.
- `packages/services/src/service-catalog.ts` (`listTemplates`, `searchOfficialCodes`, `assertOwnCode`), `procedure-codings.ts` (`serviceCoding`, `resolveServiceCodings`), `specialties.ts` (`ensureClinicSpecialties`, `librarySpecialtyIds`, `serviceKindOf`).
- Lienzo «Servicios por país» (issue 40, versión 3), tableros 2 a 7b y decisiones 1 a 9.
