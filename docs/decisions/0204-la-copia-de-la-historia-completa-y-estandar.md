# 0204 · La copia de la historia, completa, estándar y para la persona

Fecha: 2026-11-18 · Estado: aceptada · Precisa [0080](0080-pedidos-sobre-sus-datos-y-copia-de-la-historia.md) (quién descarga y cómo le llega la copia) y [0156](0156-cada-envio-manda-el-pdf-y-el-portal-muestra-todo-lo-suyo.md) (la copia también sale con «Documento listo»)

## Problema

La copia no traía toda la historia: faltaban el odontograma firmado, los periodontogramas, las recetas, órdenes y descansos en su papel, lo que quedaba por hacer y lo retirado, y el FHIR no traía ni el odontograma ni el plan. En algunos casos decía algo distinto de la ficha («Sin registros» de alergias a quien nunca se le preguntó). A la persona que no venía solo le llegaba el PDF: sus imágenes, su tomografía y el archivo para la otra clínica eran «para entregarlo en mano». El odontólogo no podía descargarla para derivar, y nada decía qué traía ni con qué estándares estaba hecha.

## Decisión y motivo

- **La copia es la historia entera, dicha como la ficha.** Cada papel emitido va en su PDF (el mismo que se imprimió o se envió, con su sello si se anuló); el odontograma firmado es ahora un papel emitido, guardado una vez con su huella y dibujado también en el servidor desde una sola geometría (`@odentia/dental/odontogram-sheet`); el de hoy va marcado «sin firmar». El PDF abre con «Antes de atenderla» y «Lo que sigue». Lo retirado se nombra con su motivo, sin el archivo: puede ser de otra persona. Lo oculto del portal sí va: es su historia. El presupuesto y los cobros no: no son historia clínica.
- **Solo los estándares que se cumplen, y se dicen.** HL7 FHIR R4 (validado contra el esquema JSON oficial y con toda referencia resuelta dentro del paquete), CIE-10/CIE-11, FDI ISO 3950 en odentIA y DICOM en las tomografías. La pantalla y un «LÉEME» en el ZIP los nombran y dicen cómo se carga en otro sistema. PDF/A y DICOMDIR no se nombran mientras nada los produzca.
- **La descarga es de quien lee la historia clínica** (`clinical.read`): propietario, administración y odontólogo, en Datos › Privacidad y pedidos y desde el menú «…» de la ficha. Recepción sigue enviándola sin abrirla.
- **A la persona le llega el PDF con el enlace a la copia completa dentro**, no en el texto: la conversación la ve recepción, el PDF no. Es «Su enlace» con destino `abre=copia`; abrir no descarga; bajarla pide su documento, como firmar a distancia. Vale 7 días desde el último envío, con un tope de descargas, y cada descarga queda en `patient_record_download` y en «Consultas a la historia clínica». Pasadas las 24 horas de WhatsApp sale con «Documento listo», como los demás papeles.

## Alternativas descartadas

- *Un enlace en el texto del mensaje:* recepción lo vería en la conversación y bajaría la historia clínica; tampoco viaja en la plantilla de texto fijo.
- *Enviar el ZIP:* WhatsApp no lo acepta y una tomografía no cabe en un correo.
- *Dibujar el odontograma dos veces (pantalla y servidor):* dos hojas que se separan con el tiempo.
- *Prometer PDF/A o DICOM con índice:* nada los produce ni los comprueba hoy.

## Consecuencias

- La otra clínica puede seguir atendiendo con la copia sola; el FHIR pasó el esquema oficial, no el validador completo de HL7 (`validator_cli`), que falta sumar al CI.
- El enlace con documento suma un paso a la persona a cambio de que un enlace reenviado o abierto por un lector de correos no entregue su historia.
- Revisar si una copia supera 4 GiB (ZIP64) o si una clínica pide PDF/A.

## Referencias

`packages/services/src/patient-record.ts`, `patient-record-copy.ts`, `record-copy-link.ts`, `record-copy-public.ts`, `dental/odontogram-pdf.ts`, `dental/record-sections.ts`; `packages/dental/src/odontogram-sheet.ts`; `apps/api/src/routes/patient-data-requests.ts`, `public-booking.ts`; `packages/clinic-app/src/components/patient/record-copy-block.tsx`; migración `0148_copia_completa_y_odontograma_firmado`.
