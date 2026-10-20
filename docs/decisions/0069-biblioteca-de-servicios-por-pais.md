# 0069 · Una biblioteca de consultorio y el código de la lista de cada país

Fecha: 2026-10-19 · **Estado:** aceptada (fases 1 a 3: núcleo, Perú, Colombia, México, Chile, Costa Rica y El Salvador; lienzo del issue 40, versión 3, nueve decisiones aprobadas) · Actualiza [0039](0039-un-solo-catalogo-de-especialidades.md) (con qué especialidades nace la clínica), [0036](0036-nucleo-internacional-y-lo-que-solo-es-de-peru.md) (lo que deja un tratamiento en la pieza) y [0003](0003-nota-clinica-normativa.md) (procedimientos con CPMS). Issue 40.

## Problema

La biblioteca de servicios era la CPMS del Perú copiada uno a uno: 505 plantillas con el nombre de la norma, para clínicas de cualquier país. Una clínica de Bogotá veía códigos peruanos; una del Perú, «Cultivo viral» o «Examen dental post morten»; y un servicio propio quedaba «sin código oficial», aunque la RM 550-2023-MINSA obliga a codificar también a las IPRESS privadas. Lo que dejaba un tratamiento en la pieza se buscaba por el código CPMS, y las especialidades con que nacía la clínica eran tipos de tratamiento («Diagnóstico», «Prevención»), no las que reconoce cada país.

## Decisión y motivo

- **Una biblioteca nuestra, de consultorio.** `catalog.treatment_template` son unos 400 tratamientos escritos por odentIA con un nombre corto («Resina fotocurable, 1 superficie, posterior»), su ámbito, lo que dejan en la pieza (`leaves_finding`) y si van en «Más usados» (`is_common`). El núcleo no lleva código. Se carga de `seeds/biblioteca.csv`; lo que sale de la biblioteca queda inactivo.
- **Cada tratamiento lleva el código de la lista de su país que lo incluye** (`treatment_template_code`, uno por lista y edición): el exacto si la lista es fina, el que usa la norma si es gruesa (en Colombia, una sola resina). Nunca uno inventado ni de otro país. Se carga de `seeds/biblioteca_codigos.csv` y se reemplaza entero en cada edición.
- **El perfil del país declara su lista** (`ClinicalCountryProfile.services`: lista, si es obligatoria y su norma). Obligatoria (Perú; después Colombia y México): la biblioteca solo ofrece lo que tiene código y un servicio propio elige el suyo con un buscador; sin él no se crea. De referencia (Chile, Costa Rica, El Salvador): el código es opcional. Sin lista: no hay campo ni código.
- **El código se exige al crear y al editar (en el servidor), no al indicar.** Si una edición nueva retira el código de un servicio ya creado, la consulta no se detiene: se indica sin código y Servicios pide elegir otro. Lo indicado guarda su código congelado, como antes.
- **El tipo de tratamiento es interno** (`TREATMENT_KINDS`; la columna sigue llamándose `specialty`): agrupa la biblioteca, propone la fase del plan, guarda las palabras de la calle del agente y dice qué especialidad del país recibe cada tratamiento. Un servicio propio toma el tipo de su especialidad; con una que creó la clínica, queda sin tipo.
- **La clínica nace con las especialidades de su país** (`ClinicalCountryProfile.specialties`): en el Perú, las 12 del DS 023-2020-SA que atienden pacientes y Odontología general; sin perfil, la lista corta del núcleo. Lo demás de 0039 sigue igual.
- **Seis listas, cada una con su archivo oficial y su huella** (`procedure_catalog_release.csv`, una edición vigente por lista; `procedure_codes_<lista>.csv`):

  | País | Lista | Para la clínica |
  |---|---|---|
  | Perú | CPMS, RM 550-2023-MINSA | Obligatoria |
  | Colombia | CUPS, Res. 2706 de 2025 | Obligatoria |
  | México | Catálogo de procedimientos CIE-9-MC de la DGIS (NOM-024-SSA3-2012), edición de febrero de 2024 | Obligatoria |
  | Chile | Arancel FONASA, Modalidad Libre Elección 2026 | De referencia |
  | Costa Rica | Tarifas mínimas del Colegio de Cirujanos Dentistas (La Gaceta 19 de 2025), solo códigos | De referencia |
  | El Salvador | CIE-9-MC 2024 del MINSAL (adaptación propia) | De referencia |

  Colombia y Chile nacen además con sus especialidades (las nueve de los códigos de consulta de la CUPS; las del Decreto 8 de 2013 que certifica CONACEO). México, Costa Rica y El Salvador usan las del núcleo.
- **Una variante solo donde una norma la separa** (`treatment_template.coded_only`): la CUPS divide la exodoncia por número de raíces y por dentición, la periapical por zona y la endodoncia de bicúspide por raíces. Esas variantes son tratamientos de la biblioteca con nombre neutral, pero se ofrecen solo donde la lista del país les da un código: en Bogotá se ve «Exodoncia de diente permanente unirradicular» y no «Exodoncia simple», y en Lima al revés, sin duplicados.
- **Un código adivinado no se guarda.** Donde la lista no dice cómo elegir (resina «simple» o «compleja» del tarifario de Costa Rica, el paquete PAD de FONASA que incluye diagnóstico y primer diente), el tratamiento queda sin código: en un país de referencia se ofrece igual, y la clínica puede poner el suyo.
- **Sin ruido técnico.** El código del país es un dato más del detalle («Código CPMS · D0140»); salen la edición, la denominación oficial, el pie «505 de 505» y el estado «Heredada». «Normas de tu país», en Datos de la clínica, dice de solo lectura qué exige el país elegido.

## Alternativas descartadas

- *Seguir con la CPMS como biblioteca de todos*: nombres de norma, servicios de hospital y códigos peruanos fuera del Perú.
- *La ICHI de la OMS como núcleo*: es gratis, pero no existe en español, sigue en desarrollo, es gruesa (17 códigos de dientes) y su licencia no deja traducirla ni ligarla con otra lista sin acuerdo escrito.
- *Guardar el código solo si es exacto*: en Colombia la norma obliga a usar el código grueso.
- *Bloquear la indicación de un servicio sin código vigente*: detiene al odontólogo en plena consulta por algo que se arregla en Servicios.
- *Elegir el código de la CUPS según la pieza al registrar* (raíces, dentición, zona): el número de raíces es un hecho del paciente, no de la pieza; las variantes lo dejan a quien atiende.
- *Cargar también el arancel MAI de FONASA*: es la red pública; una clínica privada no lo factura y confundiría.

## Consecuencias

- Beneficio: cada clínica ve nombres de consultorio y solo el código de su país; en el Perú todo servicio queda codificado; agregar un país es cargar su lista y ligar la biblioteca, sin tocar pantallas.
- Sacrificio: la biblioteca es nuestra y hay que mantenerla; sus correcciones clínicas (lo que deja cada tratamiento, el ámbito) las confirma un odontólogo antes de cargarlas.
- Revisar antes de vender: los códigos dentales de la CPMS usan la numeración de la CDT de la ADA, y la traducción española de la CIE-9-MC (México y El Salvador) tiene sus propios derechos; ninguna de las seis fuentes declara licencia (`no-declarada`).
- Solo la CPMS tiene importador en el repositorio (`import:cpms`, con su procedencia). Las otras cinco salieron de su archivo oficial con la huella que guarda su edición, pero sus CSV no se regeneran desde el repositorio: una edición nueva de esas listas pide su importador. Una lista que sale del CSV no se retira sola: la siembra se detiene y hay que retirarla a mano.
- Las correspondencias de cada país las armé con su texto oficial; las discutibles están anotadas en el informe de cada país y conviene que las vea un odontólogo de ese país. Cada lista se actualiza con su norma (la CUPS cada año; el catálogo de la DGIS cada diciembre).

## Referencias

- `packages/clinical/src/country-profiles.ts` (`services`, `specialties`, `specialtyForKind`, `kindOfSpecialty`), `treatment-templates.ts` (`TREATMENT_KINDS`, `phaseForKind`).
- `packages/db/src/procedure-codes.ts` (`seedProcedureCodes`), `seeds/biblioteca.csv`, `seeds/biblioteca_codigos.csv`; migraciones `0043_biblioteca_por_pais.sql` y `0044_biblioteca_por_pais_reglas.sql`.
- `packages/services/src/service-catalog.ts` (`listTemplates`, `searchOfficialCodes`, `assertOwnCode`), `procedure-codings.ts` (`serviceCoding`, `resolveServiceCodings`), `specialties.ts` (`ensureClinicSpecialties`, `librarySpecialtyIds`, `serviceKindOf`).
- Lienzo «Servicios por país» (issue 40, versión 3), tableros 2 a 7b y decisiones 1 a 9.
