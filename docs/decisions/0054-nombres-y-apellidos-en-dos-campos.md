# 0054 · Nombres y Apellidos, dos campos

Fecha: 2026-10-18 · Estado: aceptada · Actualiza [0004](0004-identidad-estandar.md) (nombre separado) y [0014](0014-reservar-desde-un-enlace-personal.md) (apellidos de los datos esenciales). Decisión 11 del lienzo de pacientes (issues 98, 99, 103 y 43).

## Problema

La 0004 separó el nombre en nombres, apellido paterno y apellido materno para ordenar, buscar e imprimir formatos oficiales. En la práctica nada usaba los dos apellidos por separado: la lista, la ficha y los avisos mostraban el nombre completo y la lista se ordenaba por el nombre visible. Pero cada formulario pedía tres campos, el registro de pacientes y la reserva repartían los apellidos escritos en uno solo «sin certeza» (dos palabras: paterno y materno; si no, todo al primero) y por eso marcaban la ficha «identidad por revisar», y un apellido compuesto como «De la Cruz» no tenía lugar claro. Fuera de Perú y España un segundo apellido no existe o va en otro orden (Brasil).

## Decisión y motivo

- **Dos campos en todos los países: «Nombres» y «Apellidos».** En la base, `contact.given_names` y `contact.family_name`; la base sigue derivando `display_name` de ellos. Es el `family` de HL7 FHIR HumanName y el campo de apellidos del pasaporte (OACI 9303): «Quispe Mamani», «De la Cruz Ríos».
- La migración `0017_apellidos_en_un_campo` renombra el apellido paterno a `family_name`, le suma el materno detrás y borra la columna materna. El nombre visible no cambia.
- **Nada se reparte ni se adivina:** el registro y la reserva guardan los apellidos tal como se escriben, así que ya no marcan la ficha «identidad por revisar» por ese motivo. La marca sigue para lo que ya la tenía y para el nombre visible editado a mano.
- «Faltan datos para atenderla» pide «Apellidos» en lugar de «Primer apellido».

## Alternativas descartadas

- **Tres campos, como hasta ahora.** Un campo más en cada formulario para algo que nada usaba, y el reparto incierto con su revisión manual.
- **Según el país (dos apellidos en Perú o México, uno en Brasil).** Una regla por país para ganar algo que hoy no se usa.
- **Una sola columna para todo el nombre** (descartada ya en la 0004): no permite ordenar por apellido ni separar los nombres.

## Consecuencias

- Beneficio: un campo menos en el registro, la reserva, la Agenda, la Bandeja y la ficha; nadie duda dónde va cada apellido; sirve igual en todos los países.
- Sacrificio: no se sabe con certeza cuál es el primer apellido. Las iniciales y el nombre en pantalla siguen saliendo del nombre completo, como antes.
- Revisar si una integración exige el primer apellido solo (la CURP de México, validar con RENIEC): se pediría entonces, solo en ese país.

## Referencias

`packages/db/drizzle/0017_apellidos_en_un_campo.sql`, `packages/db/src/schema/crm.ts` (`contact.familyName`), `packages/clinical/src/identity.ts` (`composeDisplayName`), `packages/clinical/src/patient-registration.ts` (`demographicsSchema`, `missingPersonData`). Lienzo de pacientes, tablero 4b.
