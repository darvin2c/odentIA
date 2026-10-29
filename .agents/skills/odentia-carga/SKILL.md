---
name: odentia-carga
description: Cargar los pacientes de una clínica nueva desde los archivos que ya tiene (su Excel o lo que exporta su sistema), sin plantilla nuestra. Pedir los datos, leerlos con un mapa de columnas, revisar lo dudoso con quien acompaña el alta y dejar el plan listo para «Cargar datos» en la administración. Usar cuando el equipo trae los datos de una clínica que empieza.
---

# Cargar los datos de una clínica nueva

El motivo y los límites están en `docs/decisions/0104-cargar-los-datos-de-una-clinica-nueva.md`. Esta skill prepara el plan y no escribe en ninguna base: la carga la hace una persona de administración en la ficha de la clínica.

## No hace falta una plantilla nuestra

Se usa lo que la clínica ya tiene: su Excel o la exportación de su sistema. El mapa de columnas se adapta al archivo, no al revés. Pedirle que copie sus datos a otro formato le da trabajo y mete errores.

| Sirve tal cual | Hay que hacer algo antes | Todavía no se puede |
|---|---|---|
| Excel `.xlsx`, aunque tenga varias hojas, un título o la fecha arriba de los encabezados | Excel antiguo `.xls`: abrirlo y guardarlo como `.xlsx` | PDF, fotos, fichas en papel o un reporte impreso |
| CSV de Excel o de otro sistema (`,` `;` o tabulador; UTF-8 o Windows-1252) | Una hoja con varios bloques o tablas: copiar la tabla de pacientes a una hoja sola | Un archivo que no tiene una fila por persona (fichas una debajo de otra) |
| Reportes con la misma persona en varias filas (una por cita o tratamiento): se toma una vez | Nombre, documento y teléfono en hojas separadas: pedir la lista que los junta | Citas, saldos e historia anterior: por ahora no se cargan |

Lo mínimo para cargar a alguien es su nombre. Lo demás se carga si viene y, si falta, queda en «Faltan datos».

## Qué pedir y en qué orden

Primero va lo que otra cosa necesita: una cita necesita al profesional y la sede. Lo que cambia cada día (citas, saldos) se pide al final, el día de corte, para que no llegue viejo. En la primera llamada se hace un inventario corto: qué sistema usan (o Excel, o cuaderno) y si pueden exportar pacientes, citas y saldos. Con eso se sabe qué pedir, sin que manden todo por si acaso.

| Etapa | Qué se pide | Cuándo | Cómo se carga |
|---|---|---|---|
| 1 · La clínica | Razón social, RUC, nombre comercial y logo; sedes con dirección y horario; unidades dentales; equipo (nombre, correo, rol, especialidad y, de los odontólogos, su colegiatura); servicios y precios | Semana del alta | A mano en el alta, con la dueña: Equipo invita a cada persona y Servicios parte de la biblioteca del país |
| 2 · Pacientes | La lista de pacientes tal como la tienen, con los apoderados de los menores | Semana del alta | Con esta skill |
| 3 · Día de corte | Citas de las próximas 2 a 4 semanas (fecha, hora, paciente, profesional, sede y motivo); saldos y deudas a esa fecha | La víspera de empezar a agendar en odentIA | Todavía no: las citas se registran a mano la primera semana |
| 4 · Después | Historia anterior en PDF o fotos, con el número de historia o el DNI en el nombre o en una lista; alergias y antecedentes; radiografías y documentos; tratamientos en curso y presupuestos | Sin apuro | Todavía no |

Mientras las etapas 3 y 4 no tengan carga, solo se pregunta si se pueden exportar; no se piden los archivos.

El mensaje para pedir la lista de pacientes, que puede enviar quien acompaña el alta:

> Para cargar a sus pacientes en odentIA, envíenos la lista de pacientes tal como la tienen: su Excel o lo que descarga su sistema actual. No hace falta ordenarla ni cambiar columnas. Si la tienen, que traiga el número de historia, nombres y apellidos, documento, fecha de nacimiento, sexo, celular, correo y dirección y, de los menores, quién es su apoderado (nombre, documento, parentesco y celular). Si su sistema tiene varias exportaciones, la que necesitamos es la de pacientes, no la de citas ni la de pagos.

Si solo puede sacar un reporte de citas, también sirve: cada paciente aparece en varias filas y se toma una vez.

## Antes de empezar

- La clínica ya existe (alta asistida) y tiene su país. El plan se prepara con ese país.
- Los archivos van en una carpeta privada fuera del repositorio (por ejemplo `~/odentia-cargas/<clinica>/`). Nunca se suben al repositorio ni se pegan en el chat.
- El mapa se escribe con `import:peek` (las hojas y la forma de cada columna): no hace falta leer filas de personas. Lo dudoso se revisa con la persona sobre el `informe.md`.
- Pendiente legal antes de cargar la primera clínica real: que la clínica acepte el contrato de encargo y que Anthropic figure en `packages/auth/src/data-processors.ts`.

## Pasos

Los comandos se escriben desde la raíz del repositorio, con el archivo primero; las rutas pueden ser relativas a esa carpeta o absolutas.

1. **Ver el archivo:**
   ```bash
   pnpm --filter @odentia/services import:peek -- <carpeta>/pacientes.xlsx
   ```
   - De un Excel dice sus hojas. Para ver otra hoja que no sea la primera, agrega `--sheet "<hoja>"`.
   - Dice en qué fila encontró los encabezados. Si se equivoca, indica la correcta con `--header <fila>`.
   - De cada columna dice cuántas celdas tienen algo, cuántos valores distintos hay y sus formas (`99/99/9999`, `Aa Aa`). Los valores solo aparecen cuando se repiten mucho (sexo, tipo de documento).
2. **Escribir `mapa.json`** junto al archivo. Hay un ejemplo en `ejemplo/mapa.json` y la referencia está más abajo.
   - Elige `dateFormat` por la forma de las fechas. Si el primer número pasa de 12 en alguna fila, es `DD/MM/YYYY`. Si no se puede saber, pregunta.
   - Una fecha con forma `99999` es una fecha de Excel y se lee sola.
3. **Preparar el plan:**
   ```bash
   pnpm --filter @odentia/services import:prepare -- <carpeta>/mapa.json --today AAAA-MM-DD
   ```
   Escribe `plan.json` e `informe.md` junto al mapa y resume en pantalla lo que entra, lo que queda fuera y lo que hay que revisar, sin datos de personas. Si el mapa nombra una columna que el archivo no tiene, lo dice antes de leer nada.
4. **Revisar con la persona**, motivo por motivo:
   - Un motivo que se repite en muchas filas casi siempre es del mapa: un valor de sexo o de tipo de documento sin nombrar, o el formato de fecha. Corrige el mapa, no las filas.
   - Lo de una fila se decide en `overrides`, por clave:
     - `skip` la deja fuera, con un motivo;
     - `set` corrige un dato ya en su forma final: fecha `AAAA-MM-DD`, tipo de documento en código y teléfono con `+`;
     - `guardian` dice quién habla por ella.
   - **Lo parecido lo decide la persona, nunca la skill.** Mismo nombre, mismo teléfono o la madre repetida sin documento: pregunta. Si son la misma persona, una queda fuera con `skip` o el niño apunta a la misma madre con `guardian`.
   - Un fijo sin código de país no se puede usar. Pregunta si se carga sin ese teléfono (`invalidPhones: "omitir"`).
5. **Repetir los pasos 3 y 4** hasta que lo que queda fuera y los errores sean solo lo que la clínica acepta dejar fuera.
6. **La carga la hace la persona en la administración:** la ficha de la clínica › «Cargar datos» › «Elegir el plan» (`plan.json`).
   - Primero ve el ensayo: además de lo del plan, dice quién ya estaba en la clínica.
   - Después pulsa «Cargar». Si se corta, «Seguir desde donde quedó» no duplica nada.
7. **Al terminar**, borra los archivos de la clínica, `plan.json` e `informe.md`. Informa las cifras: cuántas personas se crearon, cuántas ya estaban, cuántas no entraron y por qué.

## El mapa

```jsonc
{
  "countryCode": "PE",                 // el país de la clínica
  "files": [{
    "path": "pacientes.xlsx",          // .xlsx o .csv, relativo al mapa
    "sheet": "Pacientes",              // la hoja de un Excel; sin ella, la primera
    "headerRow": 4,                    // opcional: sin ella, la primera fila que trae todas las columnas del mapa
    "key": "N° HC",                    // clave estable; sin ella, una huella de nombre, nacimiento y documento
    "keyPrefix": "sede2-",             // solo si dos archivos repiten números de historia
    "delimiter": ";",                  // solo CSV, opcional: se deduce
    "columns": {
      "givenNames": "Nombres", "familyName": ["Apellido paterno", "Apellido materno"],
      "fullName": "Paciente",          // solo si no hay nombres y apellidos aparte: no se separa
      "docType": "Tipo", "docNumber": "DNI", "birthDate": "F. Nac", "sex": "Sexo",
      "phone": "Celular", "email": "Correo", "address": "Dirección",
      "guardianName": "Apoderado", "guardianDocNumber": "DNI apoderado",
      "guardianKinship": "Parentesco", "guardianPhone": "Cel. apoderado"
    },
    "defaults": { "docType": "DNI", "guardianDocType": "DNI" },
    "dateFormat": "DD/MM/YYYY",        // o MM/DD/YYYY, YYYY-MM-DD
    "sexValues": { "M": ["Varón"], "F": ["Dama"] },      // además de M, F, Masculino, Femenino…
    "docTypeValues": { "CE": ["Carnet Ext."] },          // además de DNI, CE, C.E., Pasaporte…
    "invalidPhones": "error"           // o "omitir": carga la fila sin ese teléfono
  }],
  "overrides": {
    "1043": { "set": { "birthDate": "1985-12-12" } },
    "1050": { "skip": "Es paciente de otra clínica" },
    "1051": { "guardian": { "key": "1043" } }
  }
}
```

Lo que el preparador hace solo y deja dicho en el informe:
- Los nombres escritos todo en mayúsculas pasan a mayúscula inicial.
- Al DNI de 7 cifras le devuelve el cero de adelante que quita Excel.
- De una celda con varios teléfonos toma el primero que se puede usar.
- Si quien habla por un niño tiene el documento de un paciente del archivo, usa esa misma ficha.
- A la misma persona repetida en varias filas (misma clave, mismo nombre y nada que se contradiga) la toma una vez y completa lo vacío con las demás filas.
- Cada fila se nombra con su número en el archivo, para encontrarla en el Excel.

## Lo que no hace

No carga citas, saldos ni historia anterior. No toca a quien ya está en la clínica con su documento. No envía mensajes ni enciende agentes. No une personas por su teléfono o su nombre.
