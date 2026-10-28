# 0103 · Perú trabaja con la CIE-10 del MINSA

Fecha: 2026-10-28 · Estado: aceptada · Precisa [0041](0041-diagnosticos-por-lista-y-demografia-con-codigos-internacionales.md) y [0053](0053-la-cie-11-oficial-vive-en-el-repositorio.md) · Issue 141

## Problema

Cerrar una atención exige un diagnóstico de la lista de la clínica. En Perú se proponía la CIE-10 de la OMS, pero producción no tenía ninguna CIE-10 cargada: una clínica de Perú no encontraba ningún código y no cerraba ninguna atención. Por eso no se abrían clínicas reales en Perú.

El permiso de la OPS para la CIE-10 en español llegó, pero su archivo electrónico todavía no. El registro HIS no usa la CIE-10 de la OMS tal cual, sino la del MINSA, que el MINSA publica como hoja de cálculo («CIE10_MINSA_OFICIAL.xlsx», en REUNIS › Manuales y Códigos). Esa hoja trae 23 códigos propios de planificación familiar con un sexto carácter («Z30051», «Z33X21»), que la CIE-10 de la OMS no tiene.

## Decisión y motivo

- **En Perú se propone la CIE-10 del MINSA** (`ICD-10-PE`, «CIE-10 MINSA»). Es la lista que pide el HIS, y su hoja oficial se puede descargar. La CIE-10 de la OMS y la CIE-11 siguen disponibles, con un aviso por el HIS.
- **Es otra lista, no la CIE-10 de la OMS con otro nombre** (0041). Un código guarda su lista, y un diagnóstico del MINSA nunca se presenta como de la OMS. La lista nacional solo se ofrece en su país.
- **Se carga la hoja tal como se descarga.** El cargador lee el .xlsx (`readXlsxRows`) y la forma «CÓDIGO - TÍTULO» de una columna (`parseCodeDashTitle`). Toma solo los códigos, sin capítulos ni agrupaciones, y se detiene ante una fila que no reconoce. Su SHA-256 es el del archivo tal como lo publica el MINSA.
- **Vive en el repositorio y se carga en cada despliegue, como la CIE-11** (0053). Está byte a byte como la publica el MINSA, en `packages/db/seeds/oficiales/ICD-10-PE/2024-07/`, con su SHA-256 fijado en el código. La administración autorizó guardarla el 2026-10-28: es la publicación del MINSA, y su contenido es la CIE-10 en español de la OPS, que odentIA usa con su permiso escrito. El servicio `migrate` la carga sola; sin cambios, no escribe nada. Nadie tiene que cargarla a mano.
- **El odontograma propone en la del MINSA los mismos códigos que en la CIE-10 de la OMS.** La hoja los trae iguales.
- **La X del MINSA se respeta.** El MINSA escribe con X la categoría sin subdivisiones («I10X», «A33X»), que es lo que pide el HIS. Pedir «I10» registra «I10.X» cuando ese es su único subcódigo. Una categoría con subdivisiones («K02») sigue pidiendo el subcódigo.
- **Sus títulos se leen como frase, sin perder el oficial.** El MINSA los escribe en mayúsculas y sin tildes. Se muestran como frase: «Caries de la dentina», «Sindrome de Down», «Enfermedad por VIH» (`minsaTitleForDisplay`). Conservan su forma las siglas, los números romanos, los códigos y 227 nombres propios y géneros de microorganismos, tomados de la CIE-10 de Chile y revisados a mano. El título del MINSA se guarda sin cambios en `official_title`. Las tildes no se agregan, porque no hay de dónde saber dónde van.
- **Una CIE-10 oficial entra completa o no entra** (`assertCompleteIcd10`). Tiene que traer códigos en cada letra de la A a la Z (sin la U) y más de 10 000 códigos. Una hoja cortada o guardada a medias no se carga.
- **Desarrollo y las pruebas E2E cargan la misma hoja oficial.** La del MINSA no tiene semilla de desarrollo.

## Alternativas descartadas

- **Cargar la hoja del MINSA como CIE-10 de la OMS:** sus códigos propios quedarían como de la OMS, y el sexto carácter no cabe en esa lista.
- **Proponer la CIE-11 en Perú hasta tener la CIE-10:** el HIS no se podría llenar.
- **Convertir el .xlsx a CSV antes de cargarlo:** su huella ya no sería la del archivo publicado.
- **Cargarla a mano en producción, o descargarla al desplegar:** a mano depende de que alguien lo haga, y es lo que dejó a producción sin lista. Descargarla al desplegar no funciona: el sitio del MINSA rechaza las descargas que no vienen de un navegador.

## Consecuencias

- **Beneficio:** desde el primer despliegue, una clínica de Perú cierra atenciones con la lista del HIS.
- **Completitud, comprobada el 2026-10-28 contra la CIE-10 de Chile (MINSAL/DEIS 2018):**
  - la hoja del MINSA trae los 22 capítulos y 210 agrupaciones, sin agrupaciones vacías ni subcódigos sin su categoría;
  - trae casi todas las categorías y códigos de 4 caracteres de la de Chile, y además 74 códigos de 4 caracteres de actualizaciones posteriores de la OMS (zika A92.5, dengue A97, hemorroides en K64);
  - sus diferencias tienen motivo:
    - quitó el dengue A90 y A91, y las hemorroides I84.x, como la actualización de la OMS;
    - no trae el grupo F64 ni F65.1 y F66.1 (identidad de género), retirados por el MINSA;
    - no trae K35.2 (apendicitis aguda con peritonitis generalizada);
    - no trae los códigos de emergencia COVID-19 posteriores a U07 (U08.9, U09.9, U10.9, U12.9).

  Esos huecos son del MINSA, no de la carga. Un diagnóstico así se registra con la CIE-10 de la OMS o la CIE-11.
- **Sacrificio:** los títulos se leen sin tildes («Colera», «Sindrome»). Un nombre propio que no esté en la lista se ve en minúscula. El repositorio crece 400 KB por edición, y una edición nueva se sube a mano: el archivo, su SHA-256 y su edición en `diagnosis-catalog.ts`. Una prueba fija su cantidad de códigos.
- **Revisar** si el MINSA publica otra edición o cambia el formato de la hoja, o si cambian las condiciones del permiso de la OPS.

## Referencias

`packages/clinical/src/diagnoses.ts` y `country-profiles.ts`, `packages/db/src/diagnosis-import.ts` y `diagnosis-catalog.ts`, la migración `0015_cie10_minsa.sql` y `packages/clinic-app/src/components/settings/diagnosis-list.tsx`. Hoja del MINSA: https://www.minsa.gob.pe/reunis/?op=3&niv=1 («CIE-10 (MINSA – Excel)»).
