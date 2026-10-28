# 0053 · La CIE-11 oficial vive en el repositorio y se carga en cada despliegue

Fecha: 2026-10-18 · Estado: aceptada · Actualiza [0041](0041-diagnosticos-por-lista-y-demografia-con-codigos-internacionales.md) en la carga del catálogo. Issue darvin2c/odentIA#35.

## Problema

Con la 0041, cada código de diagnóstico guarda su lista (CIE-10 o CIE-11), pero solo había semillas de desarrollo: 124 códigos de la CIE-10 sin fuente y 18 de la CIE-11, uno con el título equivocado. Producción solo ejecutaba las migraciones y no cargaba ninguna lista. Como cerrar una atención exige un diagnóstico, una clínica real no habría podido cerrar ninguna. El issue pedía decidir si el archivo oficial se versiona en el repositorio o se carga como paso de operación, según su licencia y su tamaño.

## Decisión y motivo

- **La CIE-11 en español de la OMS vive en el repositorio**, byte a byte como se descarga: el .zip de la tabulación de la edición 2026-01, de 4,95 MB, en `packages/db/seeds/oficiales/ICD-11/2026-01/`. Su SHA-256 está fijado en el código. Su licencia, CC BY-ND 3.0 IGO, permite redistribuirlo sin cambios, y la cláusula 1.2.2 de los términos de la OMS acepta incorporar la clasificación en un software, entera o en parte, si se conservan el código, el título, la URI y la cita.
- **Se carga en cada despliegue:** el servicio `migrate` ejecuta `seed:diagnoses` después de las migraciones. Escribe solo lo nuevo o cambiado, y sin cambios no escribe nada. Con `NODE_ENV=production` nunca carga las semillas de desarrollo. Una edición posterior cargada a mano no se pisa.
- **Solo los capítulos 01 a 25**, los que se registran solos como diagnóstico (17 255 códigos). Según la guía de referencia de la OMS, quedan fuera las extensiones, porque nunca se usan sin un código principal (§2.9); la medicina tradicional, porque se usa junto con los capítulos 01 a 25 (§2.23.22), y la evaluación del funcionamiento, que no es una afección (§2.11). Dos títulos que la edición en español no traduce se guardan con su título oficial en inglés.
- **La CIE-10 sigue siendo un paso de operación:** en español es de la OPS, con todos los derechos reservados, y no se incluye. El permiso de la OPS (registrado el 2026-10-28) deja cargarla en la base, no guardarla en el repositorio, así que se carga una vez con su archivo y la carga de la CIE-11 en cada despliegue no la toca. Perú usa la del MINSA, que se carga igual (ADR 0100; `docs/deployment.md`, «CIE-10 del MINSA en producción»).
- **El odontograma propone en la CIE-11 lo mismo que en la CIE-10**, con códigos comprobados contra el archivo oficial.

## Alternativas descartadas

- **Descargarla al desplegar:** un despliegue dependería de que el sitio de la OMS responda.
- **Cargarla a mano en cada entorno:** es lo que no se había hecho, y por eso producción quedó sin lista.
- **Un CSV derivado con solo código, título y URI:** pesa menos, pero su hash ya no es el que publica la OMS y no se puede comprobar contra la descarga.
- **Guardar el .txt de la tabulación:** pesa 13,5 MB, y git cambiaría sus finales de línea en Windows, con lo que el SHA-256 dejaría de coincidir.

## Consecuencias

- Beneficio: en cuanto se despliega, toda clínica puede trabajar con la CIE-11 completa sin permisos que tramitar, y el buscador responde en menos de 10 ms con la lista entera.
- Sacrificio: el repositorio crece 5 MB por edición, y una edición nueva se sube a mano (archivo, SHA-256 y edición en `diagnosis-catalog.ts`).
- Revisar si la OMS cambia la licencia o el formato de la tabulación, o cuando llegue el permiso de la OPS para la CIE-10.

## Referencias

`packages/db/src/diagnosis-catalog.ts`, `packages/db/src/diagnosis-import.ts`, `packages/db/src/seed-diagnoses.ts`, `packages/clinical/src/diagnoses.ts`, `compose.prod.yaml`. Términos de la OMS: https://icd.who.int/en/docs/icd11-license.pdf. Guía de referencia: https://icdcdn.who.int/icd11referenceguide/en/html/index.html.
