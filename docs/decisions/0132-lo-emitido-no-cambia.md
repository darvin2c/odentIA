# 0132 · Lo emitido no cambia y el QR reconoce su archivo

Fecha: 2026-11-02 · Estado: aceptada · Ajusta [0115](0115-documentos-del-paciente-con-un-solo-kit.md) · La hoja de atención de [0133](0133-los-papeles-para-el-seguro.md) sigue estas mismas reglas

## Problema

La firma de la clínica sigue siendo electrónica simple, sin certificado, y el dueño del producto pidió asegurar lo que ella no da: que el documento emitido no se pueda modificar y que el QR sirva de verdad. El código contradecía esa promesa de tres maneras:

- Receta, orden y descanso se generaban de nuevo cada vez que se abrían, con el nombre, el documento, las alergias, el apoderado y el membrete de ese momento. Solo el consentimiento quedaba guardado con su huella.
- La base dejaba reescribir esas tres tablas: la aplicación tenía `UPDATE` sobre todas sus columnas.
- El QR decía si el documento seguía vigente, no si lo que se tenía en la mano era lo emitido. Un papel alterado respondía «vigente».

## Decisión y motivo

- **El PDF se guarda una sola vez, con su huella** (`issued_paper`, que el rol de la aplicación solo agrega y lee), justo después de emitir. Verlo, enviarlo y descargarlo sirve ese archivo, comprobado contra su huella. Lo emitido antes se guarda la primera vez que se abre: es lo más cercano que queda al original.
- **La base no deja reescribir lo que dice un documento emitido** (`issued_document_immutable`): solo cambian el estado y lo que anota la operación que lo mueve, y lo anulado ya no cambia. Protege también de un error nuestro o de una ruta futura.
- **Anular no toca el original:** «ANULADA» se dibuja encima del archivo guardado al mostrarlo. La orden completada sigue siendo el mismo papel, porque no imprime su resultado.
- **La orden guarda quién la firmó**, como la receta y el descanso. Antes lo leía del perfil de hoy.
- **El odontograma firmado guarda su encabezado** (membrete y documento de la persona): su hoja se imprime desde el navegador, no tiene archivo. El logo sigue siendo el de hoy: el anterior se borra al cambiarlo y la hoja saldría con la imagen rota.
- **El QR reconoce el archivo:** la respuesta pública lleva la huella de lo guardado y la página compara en el navegador el PDF que la persona elige, sin subirlo. Una huella no dice nada del contenido, así que respeta lo que 0115 prohíbe mostrar.
- **La foto de un consentimiento en papel no se retira mientras siga firmado**, ni su PDF, en el servicio y en la base: seguiría diciendo «firmado» sin su prueba. Revocado sí se retira: si se cargó la foto de otra persona, es la única forma de sacarla de esta ficha, y retirar conserva el archivo y la traza.
- **La página del QR dice las iniciales del papel**, no las de hoy: si después se corrige el nombre, un papel verdadero seguiría coincidiendo.
- **Toda orden lleva QR**, también la de quien aún no tiene colegiatura, con una línea de «Firma y sello». El QR de comprobar crece de 19 a 23 mm: con unos 135 caracteres, el módulo pasa de 0,39 a 0,47 mm. El de la hoja del odontograma, con la corrección más alta y el isotipo al centro, crece de 21 a 30 mm.

Sin dirección pública o sin clave, el papel no lleva QR y no se guarda, porque quedaría sin él para siempre. Si falla al guardar, verlo no se traba: se genera al vuelo y sin QR, porque ese archivo no coincidiría con el que se guarde después. Enviarlo sí falla, porque debe salir el archivo fijo. Si no se puede leer lo ya guardado, se dice y se reintenta: otro archivo no se hace pasar por el emitido. Emitir nunca se deshace por el almacenamiento, ni lo espera más de unos segundos.

## Alternativas descartadas

- *Guardar solo una copia de los datos en cada fila.* Sigue generando un PDF distinto si cambia el kit, la letra o el logo, y no da un archivo que comparar.
- *Registrarlo como documento del paciente, como el consentimiento.* Llenaría la galería con una fila por receta y se podría retirar.
- *Guardar una segunda copia al anular.* Dos archivos para algo que ya no sale de la clínica; enviar un anulado sigue prohibido.
- *Generar de nuevo el anulado con su recuadro.* Mostraría los datos de hoy, no los emitidos.
- *Mostrar el contenido en la página del QR.* Es lo único que delataría un papel impreso alterado, pero 0115 lo prohíbe: el QR se copia y se fotografía. Si el dueño del producto lo quiere, se decide aparte.

## Consecuencias

- Un PDF alterado se reconoce, y lo que se envía o se descarga es siempre lo emitido.
- El QR se comprueba con un lector de imágenes sobre el PDF real, en una prueba permanente (`e2e/read-pdf.ts`), no con teléfonos ni papel impreso.
- El consentimiento no guarda de quién era el nombre al firmar: su página dice las iniciales de hoy. Basta corregir un nombre para que no coincidan; es raro y la página remite a llamar a la clínica.
- **Un papel impreso alterado no se detecta:** una foto o un escaneo nunca coinciden con la huella. La página lo dice para no hacer dudar de un papel verdadero y remite a llamar a la clínica.
- Esto da integridad, no el valor legal de la firma digital ni una fecha cierta: quien administra la base y el almacenamiento podría cambiar ambos a la vez. La foto del papel firmado no tiene huella.
- Un error en un papel ya emitido se corrige anulando y emitiendo otro. Corregir el nombre de la persona no cambia lo emitido.
- Presupuesto y comprobante siguen generándose al abrirlos: los protegen sus propias guardas y sus copias, pero no tienen archivo fijo. Se revisa si hace falta probar qué versión se entregó.
- Estos archivos no cuentan en el almacenamiento de la clínica.

## Referencias

`packages/services/src/issued-papers.ts`, `health-documents.ts` (`renderHealthDocumentPdf`, `keepIssuedPaper`), `document-check.ts`, `document-kit.ts` (`stampVoidedPdf`, `CHECK_QR_SIZE`), `packages/db/drizzle/0043_lo_emitido_no_cambia_reglas.sql`, `packages/clinic-app/src/components/public/document-check.tsx`, `e2e/documento-emitido.spec.ts`.
