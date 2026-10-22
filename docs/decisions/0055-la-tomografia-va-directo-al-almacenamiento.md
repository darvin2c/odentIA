# 0055. La tomografía va directo al almacenamiento

- **Fecha:** 2026-10-18
- **Estado:** aceptada (fase 2 del lienzo del visor de tomografía, issue 34)

## Problema

Una tomografía de haz cónico (CBCT) pesa entre 100 y 500 MB y llega como cientos de archivos DICOM, a veces dentro de la carpeta de un CD junto con el visor del centro de imágenes. La subida de documentos pasa entera por la API, la guarda en memoria y se corta en 10 MB (`PATIENT_DOC_MAX_BYTES`). Además, toda petición atraviesa el túnel de Cloudflare, que corta en 100 MB por petición (`docs/deployment.md`). La clínica necesita guardar la tomografía en la ficha y retomar la subida si se corta internet. Recepción, que recibe el CD, no tiene acceso clínico.

## Decisión y motivo

- **Un documento, muchos archivos.** La tomografía es un `patient_document` (radiografía, tipo `tomografia`, `application/dicom`) con un `imaging_study`, que guarda el estudio (`StudyInstanceUID`), el tamaño y cuándo terminó la subida, y una fila de `imaging_study_file` por archivo DICOM. En la ficha sigue siendo un solo papel. Su informe, su retiro y su contexto funcionan como en cualquier imagen. `storage_key` apunta a la carpeta del estudio.
- **El navegador sube cada archivo directo al bucket** con una URL firmada de pocos minutos (PUT). La API no recibe los bytes. Después, la API comprueba cada archivo antes de darlo por recibido: que exista, que tenga el tamaño anunciado y la marca `DICM` de PS3.10. Solo con todos recibidos el estudio queda completo. Retomar es volver a elegir la carpeta: solo se suben los archivos que faltan, reconocidos por su `SOPInstanceUID`.
- **Tope de 1 GB y 5000 archivos por tomografía** (decisión 4 del lienzo). El mismo estudio no se guarda dos veces en la ficha mientras no se retire.
- **Recepción recibe sin ver** (decisión 5): el permiso `clinical.receive` deja empezar, continuar, cancelar y ver el avance de una subida. No deja abrir ni descargar la tomografía, que siguen con `clinical.read`.
- **La descarga para el programa del equipo** es un ZIP que arma la API mientras lo envía, sin compresión y sin guardarlo.
- **El nombre que trae el archivo solo sirve para avisar** (decisión 6). Nunca identifica a la persona.

## Alternativas descartadas

- **Subir por la API en trozos de menos de 100 MB.** Evita configurar CORS en el bucket, pero toda la tomografía pasa por el servidor compartido y cada trozo ocupa su memoria. El lienzo aprobado pide que no pase por nuestro servidor.
- **Un ZIP como un solo objeto.** Obliga a descomprimirlo para verlo y no deja retomar a medias.
- **Columnas de estado en `patient_document`.** La tabla solo admite actualizar el informe y el retiro. Abrirla a más cambios debilita su inmutabilidad.

## Consecuencias

- El bucket de adjuntos debe aceptar CORS para `PUT`, `GET` y `HEAD` desde la plataforma. Está documentado en `docs/deployment.md`; sin eso, la subida falla con un aviso y no queda nada a medias.
- Un archivo grande y único (un CT de varios cuadros) se retoma desde su inicio, no desde la mitad. Se revisaría con subidas multiparte si llegan estudios de un solo archivo cercanos a 1 GB.
- Un estudio cancelado o abandonado se retira con su motivo y sus archivos se conservan, como cualquier documento retirado.

## Referencias

- `packages/services/src/imaging-studies.ts`, `apps/api/src/routes/imaging-studies.ts`
- `apps/dental-clinic/src/lib/imaging-upload.ts` (lectura de la carpeta y cola de subida)
- Lienzo «Visor de tomografía», tableros 3, 4, 9, 10 y decisiones 4 a 6
