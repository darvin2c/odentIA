---
name: odentia-carga
description: Cargar todo lo de una clínica nueva desde lo que ya tiene, sin plantilla nuestra: su configuración (empresa, marca, hoja membretada, sedes, servicios de la biblioteca con su código, caja, inventario, asistente, formatos y equipo) y sus pacientes (su Excel o lo que exporta su sistema). Pedirle los datos con la carta de bienvenida en PDF, estudiarlos, presentar el plan de carga en PDF para aprobarlo, dejar los planes listos para «Cargar datos» en la administración y, después de cargar, el informe a la clínica en PDF, que se envía desde la administración con aprobación. Usar cuando el equipo trae los datos de una clínica que empieza o pide la carta, el documento o el mensaje para pedírselos a una clínica nueva.
---

# Cargar los datos de una clínica nueva

El motivo y los límites están en `docs/decisions/0104-cargar-los-datos-de-una-clinica-nueva.md`. Esta skill prepara los planes y no escribe en ninguna base: la carga la hace una persona de administración en la ficha de la clínica.

## El proceso, cada vez que la clínica envía algo

1. **Se estudia todo lo que envió**: el correo entero, cada adjunto y los demás correos del hilo. Con eso se trabaja: no se le pregunta a quien acompaña lo que ya está ahí.
2. **Se presenta el plan de carga en PDF** (`import:clinica` para la configuración, el informe de `import:prepare` para los pacientes): lo que llegó, lo que se carga y dónde, lo que no y por qué, y lo que hay que decidir, con una recomendación. Nada se carga sin aprobación.
3. **Aprobado, se carga** en la administración: ficha de la clínica › «Cargar datos».
4. **Se presenta el informe a la clínica en PDF** (`import:informe`): lo que recibimos, lo que usamos, lo que hicimos, dónde lo ve y lo que sigue. Es informativo: no habla del contrato ni de la ley, no promete nada y no pide respuesta. El comando rechaza un texto que lo haga.
5. **Aprobado, se envía** desde la administración, «Cargar datos» › «Informe a la clínica»: sale por el correo de producción con el PDF adjunto, una sola vez por número de informe.

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
| 1 · La clínica | Todo lo que se configura, por área: empresa (razón social, RUC, dirección fiscal, logo, teléfono de urgencias, monedas); sedes y unidades dentales o consultorios; equipo (rol, título, especialidad, colegiatura) y horarios y ausencias de cada profesional; servicios y precios, especialidades y promociones; inventario y proveedores; caja (medios de pago, gastos fijos, comisiones, ticket y vigencia del presupuesto); lo que el asistente responde a los pacientes y sus formatos propios; canales | Semana del alta, en la carta | Con esta skill (`import:clinica`, abajo) y «Cargar datos» › «Configuración de la clínica». Lo de cada profesional (perfil, horario, comisión) se carga con el mismo plan cuando esa persona ya es parte de la clínica. Los canales se conectan con ella, nunca con contraseñas por correo |
| 2 · Pacientes | La lista de pacientes tal como la tienen, con los apoderados de los menores | Semana del alta, en la carta | Con esta skill |
| 3 · Día de corte | Citas de las próximas 2 a 4 semanas (fecha, hora, paciente, profesional, sede y motivo); saldos y deudas a esa fecha | La víspera de empezar a agendar en odentIA | Todavía no: las citas se registran a mano la primera semana |
| 4 · Después | Historia anterior en PDF o fotos, con el número de historia o el DNI en el nombre o en una lista; alergias y antecedentes; radiografías y documentos; tratamientos en curso y presupuestos | Sin apuro | Todavía no |

Mientras las etapas 3 y 4 no tengan carga, solo se pregunta si se pueden exportar; no se piden los archivos.

## La carta de bienvenida

Los datos de las etapas 1 y 2 se piden con una carta en PDF con la marca del producto de la clínica (odentIA o latidIA) y su titular, SALLCA GROUP E.I.R.L. La idea es cargar todo lo que se pueda. Es una carta formal, que trata de usted a quien la recibe.
- **La primera hoja:** fecha, destinatario, asunto y «De nuestra consideración:». Después, los próximos pasos: entrar y aceptar el contrato de encargo, enviar a soporte en un solo correo los datos de la clínica y la lista de pacientes, y la reunión de implementación. Luego, el tratamiento de su información, incluido que el correo se borra, como máximo, a los 30 días. Cierra con la despedida y la firma de quien acompaña.
- **Desde la segunda hoja:** el anexo con todo lo que se puede cargar, por área (empresa, sedes, equipo y horarios, servicios, inventario y proveedores, caja y gastos, atención a sus pacientes, canales) y, al final, la lista de pacientes, para que lo reúnan.
- **El pie de cada hoja** es del remitente (la marca, su web y su titular), nunca de la clínica. El texto vive en `packages/services/src/clinic-import-letter.ts`; no se escribe otro a mano.

La carta es para clínicas de Perú: pide el RUC y la colegiatura. Le pide aceptar la invitación que le llegó al correo: se entrega cuando la clínica ya está creada en la administración (alta asistida) y su invitación salió. Si todavía no, dilo al entregarla.

Cuando la pidan, pregunta en un solo mensaje lo que falte de esto (lo que ya se dijo en la conversación no se vuelve a preguntar):

- **La clínica:** su nombre, como lo conocen sus pacientes. El producto se deduce de si es dental o médica y se dice, sin preguntarlo; sin saberlo, odentIA.
- **A quién va:** su nombre, como lo escribe ella, y su cargo si lo dicen («Dra. Ana Pérez, directora»). El cargo no se inventa: sin él, solo el nombre.
- **Quién acompaña el alta**, que firma la carta: nombre, cargo, correo de odentia32.com (o latidia72.com) y, si quiere, celular. Es el contacto para dudas, nunca para recibir la lista. Sin cargo, la firma lleva solo el nombre y la marca.
- **Hasta cuándo** enviar los datos y la lista. Sugiere una fecha: unos días hábiles después de la carta.
- **Si ya se sabe qué usa la clínica** para sus pacientes. Si no, la carta se lo pregunta (`askCurrentSystem`).

Escribe `carta.json` en la carpeta privada de la clínica, fuera del repositorio (`~/odentia-cargas/<clinica>/`, con el nombre de la clínica en minúsculas y guiones), y genera el PDF, que queda junto a él. `date` se pone solo para fechar la carta otro día que hoy:

```bash
pnpm --filter @odentia/services import:carta -- <carpeta>/carta.json
```

```jsonc
{
  "product": "dental",                   // o "medical" (latidIA)
  "clinic": "Clínica Dental Sonrisa",
  "to": "Dra. Ana Pérez, directora",
  "companion": { "name": "Carlos Ruiz", "role": "Implementación", "email": "carlos@odentia32.com", "phone": "987 654 321" },
  "deadline": "2026-11-13",              // AAAA-MM-DD
  "askCurrentSystem": true,              // false si ya se sabe qué usa
  "date": "2026-11-09"                   // opcional: sin él, hoy en Lima
}
```

El buzón es `soporte@odentia32.com` o, en latidIA, `soporte@latidia72.com`; otro, solo con `inbox`. Antes de la primera carta de latidIA, comprueba que `soporte@latidia72.com` recibe correo.

El comando dice cuántas páginas salió: tres como máximo, y si pasan, falla. `hojasDeLaCarta` tiene que ser 1: la carta con su firma en la primera hoja y el anexo desde la segunda. Mira el PDF antes de entregarlo y da su ruta a quien acompaña el alta: lo envía la persona, no Claude. Si la clínica igual manda sus datos a quien la acompaña o por WhatsApp, se reenvía a soporte, se borra de ahí ese mismo día y sigue el mismo plazo.

## Antes de empezar

- La clínica ya existe (alta asistida) y tiene su país. El plan se prepara con ese país.
- La lista llega por correo a soporte. Antes de abrir el adjunto, la clínica tiene que haber aceptado el contrato de encargo vigente, desde la versión 2026-11-12, la que nombra a los proveedores de la carga: odentIA se lo pide a la propietaria al entrar y no la deja seguir sin él. Que haya aceptado la invitación no basta, y la administración todavía no muestra el contrato: confírmalo con ella. Si no lo aceptó, no se abre: se le recuerda entrar.
- Anota el día en que llegó el correo: desde ese día corren los 30 días que promete la carta.
- Los archivos van en una carpeta privada fuera del repositorio (por ejemplo `~/odentia-cargas/<clinica>/`). Nunca se suben al repositorio ni se pegan en el chat.
- El mapa se escribe con `import:peek` (las hojas y la forma de cada columna): no hace falta leer filas de personas. Lo dudoso se revisa con la persona sobre el `informe.md`.
- Lo que promete el contrato de encargo (cláusula 3) se cumple aquí: los archivos se usan solo para la carga y se eliminan, con el correo y sus copias, al terminar o, a más tardar, a los 30 días de recibidos. Claude trabaja con los comandos, que no muestran nombres ni números; no hace falta pegarle la lista. Si `import:peek` dice `headerFound: false`, la persona mira el archivo y da la fila con `--header`. Los proveedores de la carga (el correo de soporte y Claude) están en `packages/auth/src/data-processors.ts`; uno nuevo se suma ahí y se avisa a las clínicas con la antelación del contrato.

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
     - `set` corrige un dato ya en su forma final: fecha `AAAA-MM-DD`, tipo de documento en código y teléfono con `+`; con `null` lo quita (`"phone": null` carga la fila sin ese teléfono);
     - `guardian` dice quién habla por ella; con `null`, que nadie habla por ella aunque el archivo traiga a alguien.
   - **Lo parecido lo decide la persona, nunca la skill.** Mismo nombre, mismo teléfono o la madre repetida sin documento: pregunta. Si son la misma persona, una queda fuera con `skip` o el niño apunta a la misma madre con `guardian`.
   - Un fijo sin código de país no se puede usar. Pregunta si se carga sin ese teléfono (`invalidPhones: "omitir"`).
5. **Repetir los pasos 3 y 4** hasta que lo que queda fuera y los errores sean solo lo que la clínica acepta dejar fuera.
6. **La carga la hace la persona en la administración:** la ficha de la clínica › «Cargar datos» › «Elegir el plan» (`plan.json`).
   - Primero ve el ensayo: además de lo del plan, dice quién ya estaba en la clínica.
   - Después pulsa «Cargar». Si se corta, «Seguir desde donde quedó» no duplica nada.
7. **Comprobar la carga**, antes de borrar nada:
   - **Las cifras cuadran**, con el informe y el ensayo:
     - creadas + ya estaban + no entraron = las personas del plan, que son los pacientes más quienes hablan por ellos (una madre que no es paciente también se crea);
     - pacientes del plan + lo que quedó fuera al preparar (incluida la persona repetida que se tomó una vez) = las filas del archivo.

     El contador de la pantalla se pierde si se recarga a mitad de la carga: lo que vale es «Volver a ensayar». Si no cuadra, no se borra nada hasta saber por qué.
   - **«Volver a ensayar»** con el mismo plan: todo sale como ya cargado y nada como nuevo. Lo que sale como nuevo no entró.
   - **Lo que no entró** aparece en la pantalla con su motivo. Se resuelve con la clínica o queda anotado como fuera.
   - **Una muestra a mano**, comparada con el archivo: unas diez fichas elegidas a propósito. Entre ellas, un menor con quien habla por él, un DNI al que se le devolvió el cero, una celda con dos teléfonos, una persona repetida en el archivo y la última fila. Se revisan con la propietaria en la reunión de alta, mirando su pantalla: ni la administración ni el acceso de soporte abren pacientes.
   - **«Faltan datos»** en Personas: los que entraron incompletos, para completarlos con la clínica.
   - **Los datos de la clínica** (sedes, unidades dentales, equipo, servicios y precios) se repasan pantalla por pantalla en la reunión de alta, contra lo que envió.
8. **Al terminar**, borra los archivos de la clínica, `mapa.json` (sus `overrides` llevan datos de personas), `plan.json` e `informe.md`, la conversación de Claude Code de esa carga (su archivo en `projects/` de la carpeta de configuración de Claude Code), y en el buzón de soporte el correo con su adjunto, también de la papelera. Si la carga se demora, se borra igual a los 30 días de recibido y se vuelve a pedir la lista: lo promete el contrato de encargo. Informa las cifras: cuántas personas se crearon, cuántas ya estaban, cuántas no entraron y por qué.

## La configuración de la clínica

Se escribe `clinica.fuente.json` en la carpeta privada de la clínica con lo que envió, y el comando arma el plan y su PDF:

```bash
pnpm --filter @odentia/services import:clinica -- <carpeta>/clinica.fuente.json --numero 1
```

Deja `clinica.json` (el plan, con el logo y la hoja dentro) y `plan-de-carga-<n>.pdf`. Falla si un servicio no está en la biblioteca o no tiene el código del país que es obligatorio. El formato es `clinicSetupPlanSchema` (`packages/services/src/clinic-setup-plan.ts`); en la fuente, el logo y la hoja van como `{ "path": "mejoradas/logo.png" }` y se agrega `review` (lo que llegó, las imágenes, lo que no se carga y lo que hay que decidir), que solo va al PDF.

- **Servicios: de la biblioteca** (`template`, la clave de `packages/db/seeds/biblioteca*.csv`), con el nombre que usa la clínica en `name`. Su código oficial sale de la biblioteca y va en el plan. Un servicio que la biblioteca no tiene es una **excepción**: lleva `name`, `specialty` (una de la clínica), `scope` y `officialCode`, y el plan lo dice. «Desde $700» es `priceDisclosure: "desde"` con el mínimo, no el nombre. Una moneda que no es la de la clínica necesita `identity.secondCurrency`.
- **Imágenes: se revisan y se mejoran si hace falta**, y el plan dice qué se hizo con cada una. El logo en JPG con fondo blanco pasa a PNG transparente. La hoja membretada va como imagen A4 sin el bloque de contacto (razón social, RUC, dirección, teléfono, nombre y colegiatura de una persona): cada papel los pone desde Configuración y lleva la firma de quien lo emite. Al cargar, el servidor la mide como el navegador.
- **Medios de pago** con su tipo: `10` efectivo, `48` tarjeta, `30` transferencia, `68` billetera (Yape, Plin). Los del país ya existen: no se duplican.
- **Gastos fijos** con su `key`: volver a cargar no los anota dos veces. Sin día de pago en lo que envió, se propone en «Para decidir».
- **Asistente**: las de «Lo que solo tú sabes» por su `basicKey` (`KNOWLEDGE_BASICS`); se cargan publicadas.
- **Equipo**: la propietaria ya está invitada desde el alta; a los demás la carga los invita (les llega un correo). Horarios con `weekday` 0 domingo … 6 sábado.
- **Formatos propios** (consentimientos y formularios): se cargan en borrador; la clínica los revisa y los publica.
- **`slug`**: la dirección de la clínica en odentIA («dra-marialicia-calderon»). La administración no carga el plan en otra clínica.

En la administración: ficha de la clínica › «Cargar datos» › «Configuración de la clínica» › «Elegir el plan». El ensayo dice, área por área, qué se crea, qué se actualiza, qué ya está, qué espera a una persona y qué no entra y por qué. «Cargar» lo guarda y envía las invitaciones. Con la primera sede, la clínica se enciende como en su alta. Cuando una persona del equipo acepta su invitación, se vuelve a ensayar y a cargar el mismo plan.

## El informe a la clínica

Se escribe `informe-<n>.json` (formato `progressReportSchema`, `packages/services/src/clinic-progress-report.ts`) solo con lo hecho y comprobado, y se arma el PDF para revisarlo:

```bash
pnpm --filter @odentia/services import:informe -- <carpeta>/informe-1.json
```

Va a alguien del equipo de la clínica o con su invitación, y responde a quien acompaña, con su correo de odentia32.com (o del producto). Sin datos de pacientes (solo cifras), sin documentos ni teléfonos, sin promesas. Aprobado, se envía en «Cargar datos» › «Informe a la clínica»: se ve el PDF, se pulsa «Enviar» y queda registrado; el mismo número no sale dos veces. Desde la máquina de quien acompaña, el correo de producción no conecta: el informe sale siempre de la administración.

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
      "guardianName": "Apoderado",     // o guardianGivenNames y guardianFamilyName, si vienen aparte
      "guardianDocType": "Tipo doc. apoderado", "guardianDocNumber": "DNI apoderado",
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
    "1051": { "guardian": { "key": "1043" } },
    "1052": { "set": { "phone": null }, "guardian": null }
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
