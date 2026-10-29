# 0104 · Cargar los datos de una clínica nueva

Fecha: 2026-10-29 · Estado: aceptada · Primera parte de la issue 89 · Relacionada con la issue 88 (WebMCP, pospuesta)

## Problema

Las primeras clínicas (Fundadores) llegan con sus pacientes en un Excel, un cuaderno pasado a hoja o la exportación de otro software. odentIA no tenía cómo traerlos: solo se cargaba el inventario («Pegar mi lista») y los pacientes uno por uno. Sin sus pacientes, la clínica no puede empezar a trabajar ni encender a Sofi.

Cada clínica trae un formato distinto: columnas con otros nombres, fechas en `DD/MM/AA`, DNI sin el cero de adelante (Excel lo quita), varios teléfonos en una celda, la madre en la fila del niño. Construir hoy un importador en la pantalla de la clínica para todos esos casos es caro, y todavía no sabemos qué formatos llegan de verdad.

Lo que no se negocia: la persona es única (0001), nunca se une a dos personas por su teléfono o su nombre, una misma operación de negocio para todas las vías, la administración usa la conexión owner solo después de autorizar al personal con segundo factor (0089, 0090) y una carga no envía mensajes.

## Decisión y motivo

- **Primero personas y pacientes.** Con quién habla por quién (la madre, el apoderado). Las citas, los saldos y la historia anterior quedan para después: las citas necesitan profesionales con cuenta, y los saldos y la historia necesitan representar lo anterior sin fabricar pagos ni firmas (issue 89).
- **La carga va en tres pasos, con un plan revisable entre ellos:**
  1. **Preparar.** La skill de carga (`.agents/skills/odentia-carga`) corre en la máquina de quien acompaña el alta. Lee los archivos tal como los tiene la clínica, su Excel (`.xlsx`) o lo que exporta su sistema, con un mapa de columnas (`import:peek`, `import:prepare`), y arma `plan.json` y un informe. Encuentra solo la fila de encabezados bajo el título de un reporte y toma una vez a la persona que se repite en varias filas. Claude escribe el mapa mirando la forma de cada columna, no sus datos. La transformación es código determinista, no texto del modelo.
  2. **Ensayar.** La administración sube el plan en la ficha de la clínica («Cargar datos») y ve qué pasará con cada fila, sin guardar nada.
  3. **Cargar.** Se carga por tandas de 200, cada una en una transacción corta.
- **Lo dudoso no se adivina.** Una fecha con el año en dos cifras o un sexo que el mapa no nombra deja la fila fuera, con su motivo, hasta que el mapa o una corrección escrita lo resuelvan. Lo parecido (mismo nombre, mismo teléfono, alguien que ya está en la clínica) se avisa y lo decide una persona.
- **Las mismas operaciones de siempre.** Cada persona se crea con `createPatient` o `createPerson`, con sus validaciones y su auditoría, y quien habla por ella se vincula como en el registro. Quien ya está en la clínica con ese documento no se toca.
- **Repetir no duplica.** Cada fila del origen tiene una clave estable (su número de historia o una huella de su identidad), y lo que entró queda en `admin.clinic_import_row`. Una tanda repetida o una carga cortada sigue sin crear otra ficha.
- **Solo administración.** Muestra y escribe datos de pacientes. Va por la API de la administración, con su segundo factor, y queda en la auditoría administrativa con la huella del plan.

## Alternativas descartadas

- **Pedirle a la clínica que llene una plantilla nuestra:** le da trabajo justo al empezar y mete errores al copiar. El mapa se adapta a su archivo.
- **Un script contra la base de producción desde la máquina del equipo:** se salta la autorización con segundo factor y la auditoría, y deja la conexión owner fuera de la API.
- **Que Claude lea el archivo y escriba el plan fila por fila:** no escala a miles de filas, no es repetible y pondría cada dato en el modelo. El mapa más el código dan el mismo plan cada vez.
- **«Pegar mi lista» de pacientes en la clínica, ya:** es el destino si los formatos se repiten, pero hoy se diseñaría sin conocerlos.
- **WebMCP como vía de carga (issue 88):** el estándar todavía cambia y no resuelve leer los archivos de la clínica.

## Consecuencias

- **Beneficio:** una clínica empieza con sus pacientes y sus vínculos, sin duplicados y con cada fila explicada: entró, ya estaba, no entró y por qué, o quedó fuera al preparar.
- **Sacrificio:** depende del equipo de odentIA (no es autoservicio). No lee el Excel antiguo (`.xls`: se guarda como `.xlsx`), PDF ni fotos. Un teléfono fijo sin código no se puede llevar a E.164 y se carga sin él solo si el mapa lo pide. El nombre en una sola columna no se separa: queda en «Faltan datos».
- **Orden de los datos:** primero la clínica (sedes, equipo, servicios) y los pacientes; las citas y los saldos el día de corte; la historia anterior, después. Las etapas y lo que hoy se carga están en la skill.
- **Pendiente legal**, antes de la primera clínica real: el contrato de encargo aceptado por la clínica y Anthropic entre los subencargados.
- **Revisar** cuando se repitan los formatos (pasar a «Pegar mi lista» en la clínica) o cuando haga falta traer citas, saldos o historia.

## Referencias

`packages/services/src/clinic-import-plan.ts`, `clinic-import-prepare.ts`, `clinic-import-cli.ts` y `clinic-import.ts`; el lector de `.xlsx` en `packages/db/src/xlsx.ts`, el mismo de la CIE-10 del MINSA (0103); `packages/db/src/schema/admin-imports.ts` y la migración `0017_carga_de_datos.sql`; `apps/api/src/routes/admin-imports.ts`; `apps/admin/src/components/org-import.tsx`; `.agents/skills/odentia-carga/SKILL.md`.
