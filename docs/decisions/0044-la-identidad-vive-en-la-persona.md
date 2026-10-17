# 0044 · La identidad vive en la persona

Fecha: 2026-10-16 · Estado: aceptada · Cierra lo pendiente de [0001](0001-persona-unica.md)

## Problema

El ADR 0001 dejó la identidad (nombre y nombre separado, documento con su país, nacimiento, sexo, teléfono, correo y si está archivada) guardada dos veces, en `contact` y en `patient`, igualada por disparadores que copiaban cada cambio de un lado al otro y conciliaban al vincular. Ya decía que lo deseable era quitarla de la ficha. Era frágil: un dato nuevo de identidad había que agregarlo en dos tablas y en los disparadores; si ficha y persona traían un teléfono distinto, mandaba la ficha; había dos índices únicos de documento y dos indicadores de archivo que se leían «archivada si cualquiera lo está».

## Decisión y motivo

- **La persona guarda quién es.** `patient` deja de tener esas columnas (y la marca «nombre por revisar» pasa a la persona); guarda lo clínico y administrativo: número de historia, grupo sanguíneo, seguro, ASA, dirección, nacionalidad, lugar de nacimiento, datos censales, salud y avatar.
- **`patient.person_id`**, no nulo, único por organización y con clave compuesta hacia `contact`: leer la identidad es un join directo (`joinPatientPerson`, `patientRowColumns` en `patient-identity.ts`), la base garantiza sin disparadores que toda ficha tenga exactamente una persona de su misma organización, y una persona tiene a lo sumo una ficha. Se eligió frente a llegar por `patient_contact` porque esa vía son dos joins en cada lectura y su «exactamente una» dependía de un disparador diferido.
- **El vínculo `self` sigue en `patient_contact`**, porque la lista de personas de una ficha (preferente, a quién se le escribe, el portal) la incluye. Sale de `person_id`: la base lo crea al insertar la ficha y lo mueve cuando cambia su persona; un disparador diferido comprueba que el único `self` sea el de `person_id`. Nadie lo escribe aparte.
- **Archivar es un solo indicador**, `contact.is_active`: archivar la ficha era siempre archivar a la persona (`setPersonArchived`), no un concepto distinto.
- **Un solo índice de documento**, `contact_org_doc_uidx` (documento con su país, `NULLS NOT DISTINCT`).
- **Escribir la identidad de un paciente es escribirla en su persona**: `createPatient` la pone en la persona que se indica como propia, en la que ya tiene ese documento o en una nueva (`createPerson`); `updatePatient` reparte el cambio entre persona y ficha. Lo que hacía la conciliación al vincular («manda la ficha, se completa con lo que solo sabía la persona, un teléfono distinto queda en sus notas») lo hace el servicio, de forma explícita, solo al adoptar una persona existente o al sustituir a la provisional. El agente sigue sin cambiar la identidad de quien ya es paciente (`updatePersonIdentity`).

## Alternativas descartadas

- **Mantener las columnas y los disparadores.** Es lo que 0001 dejó como provisional; cada dato nuevo exigía tres cambios.
- **Llegar a la persona solo por el vínculo `self`.** Dos joins en cada lectura y la garantía en un disparador diferido.
- **Quitar el vínculo `self` de `patient_contact`.** Obliga a rehacer la lista de vínculos, el portal y el agente sin aportar nada a la identidad.
- **Una vista `patient_with_identity`.** Otro nombre para lo mismo y otra superficie para RLS.

## Consecuencias

- Beneficio: un solo lugar físico; sin copias que puedan divergir ni disparadores de sincronía; un dato nuevo de identidad se agrega una vez.
- Sacrificio: toda lectura del nombre o el documento de un paciente lleva un join con su persona, y el SQL escrito a mano también (`join contact pp on pp.id = p.person_id`).
- Revisar si aparece un caso legítimo de identidad distinta entre ficha y persona.

## Referencias

`packages/db/drizzle/0107_la_identidad_en_la_persona.sql`, `packages/db/src/identity-in-person-migration.test.ts`, `packages/services/src/patient-identity.ts`, `packages/services/src/patients.ts` (`createPatient`, `updatePatient`, `setPatientContact`), `packages/services/src/people.ts` (`updatePersonIdentity`, `setPersonArchived`), `packages/services/src/identity-in-person.test.ts`.
