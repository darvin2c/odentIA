# 0155 · Cada envío manda el PDF y el portal muestra todo lo suyo

Fecha: 2026-11-07 · Estado: aceptada · Precisa [0037](0037-su-enlace-y-portal-en-un-paso.md) y [0040](0040-el-agente-no-elige-plantillas-la-categoria-manda-tres-tipos-de-mensaje.md) (su decisión 8, «Tus papeles», queda sustituida)

## Problema

«Enviar» una receta pasadas las 24 horas de WhatsApp no mandaba la receta: mandaba «Su enlace», y la persona tenía que abrirlo y buscarla en «Tus papeles», que vencía a los 30 días. El comprobante, igual. El portal, a su vez, solo mostraba lo que quien daba el acceso elegía documento por documento («Qué verá») y lo recortaba con sus permisos: recepción, sin historia ni caja, no podía compartir los papeles de salud ni la cuenta. Las recetas, órdenes, descansos y comprobantes no aparecían nunca. El dueño del producto lo resumió así: cada envío entrega lo que dice, y el portal muestra todo lo suyo sin elegir.

## Decisión y motivo

- **Un papel manda el PDF; el portal manda el portal.** Receta, orden, descanso, hoja de atención, consentimiento firmado y comprobante salen en PDF por WhatsApp o por correo, por el camino común (`documentChannelsFor`, `deliverDocumentPdf`). Pasadas las 24 horas, con «Documento listo» (`documento_listo`, `odentia_documento_listo_v1`), un mensaje del catálogo de utilidad con el PDF en su encabezado. Se pide como los demás, con el PDF de muestra que Meta exige (subido con la app de odentIA en «Conectar con Facebook»; con la app propia de la clínica, la que dice su clave). Mientras no esté aprobado, el cajón lo dice y deja el correo o imprimir.
- **«Su enlace» ya no lleva papeles.** Se quitan «Tus papeles», su ruta y su descarga; el enlace sigue con lo pendiente.
- **El portal muestra todo lo suyo, con el límite de la clínica.** Lo que ve un acceso es lo que deja ver Configuración (`allowedScope`), no lo que elige quien lo da. Lo que protege es la identidad comprobada en persona y la regla de lo terminado. Los accesos ya dados pasan a ver todo.
- **El acceso lo da quien puede ver la historia** (`clinical.read`: dueña, administrador, odontólogo o médico), porque el portal entrega su historia documental: quien da el acceso tiene en la mano el QR y el código, y con ellos podría leer lo que su rol no ve. Dar el acceso, mostrar el QR, decir el código y quitarlo son suyos. Recepción solo envía el enlace de un acceso ya dado por el WhatsApp de la persona, con el código en otro mensaje a ella: ni el enlace ni el código llegan a su pantalla (decisión del usuario tras la revisión de seguridad).
- «Enviar nuevo enlace» deja sin efecto los enlaces pendientes y las sesiones abiertas; las llaves guardadas siguen hasta «Quitar acceso».
- **Una regla por papel, en el servidor** (`portal-papers.ts`): receta, orden y descanso desde que se emiten; hoja de atención emitida; consentimiento firmado (revocado, marcado); comprobante; archivos sin retirar (también el resultado de una orden); imágenes con su informe o que no lo requieren. Lo anulado se ve marcado y se descarga con su sello; la receta vencida dice «Vencida». Cada papel sale una vez. La tomografía y el DICOM no van (no se abren en el teléfono), ni lo que es de otra persona o de un pago (la prueba de una representación, un voucher). La historia (las notas de cada atención), nunca. La ficha dice si cada archivo se ve con la misma regla (`documentPortalState`).
- **«No mostrar en su portal»** es del archivo, no del acceso: vale para todo acceso de hoy y de mañana, lo cambia quien escribe en la historia y queda su traza.
- **Nombres de archivo y texto neutros** («Receta-12.pdf», «Orden-2026-11-07.pdf»; el pie de WhatsApp y el asunto del correo dicen «Orden» o «Consentimiento», no el título): se ven en la notificación del teléfono.
- **«Documento listo» es solo para los papeles decididos:** receta, orden, descanso, hoja de atención, consentimiento firmado y comprobante. El presupuesto, la devolución y la copia de la historia siguen como antes (el presupuesto, con «Presupuesto listo»).

## Alternativas descartadas

- *Mantener la receta en «Su enlace» hasta que se apruebe la plantilla.* Dos caminos para lo mismo, y la persona seguiría sin recibir lo que dice el botón. Sin aprobación, el correo e imprimir cubren el hueco.
- *Elegir lo que verá cada acceso.* Es lo que se quitó: obliga a recepción a decidir documento por documento y no puede compartir lo que no ve.
- *Ocultar desde el acceso.* Habría que repetirlo en cada acceso nuevo; en el archivo vale para todos.

## Consecuencias

- El cajón «Enviar» es uno solo para todos los papeles.
- La plantilla con documento no se pudo probar contra Meta: solo el armado de las peticiones. Cada clínica tiene que aprobarla en su cuenta.
- Quedan fuera: las marcas de «entregado» o «visto» del PDF, la tomografía en el portal, una hoja por cada atención firmada y qué ve el apoderado de un adolescente en latidIA (pendiente legal).

## Referencias

`packages/services/src/portal-papers.ts`, `financial-documents.ts` (`documentTemplateState`), `automation-messages.ts` (`DOCUMENT_READY_MESSAGE`), `packages/channels/src/whatsapp-cloud-api.ts` (`uploadTemplateSample`), migraciones `0054_oculto_en_su_portal` y `0055_plantilla_con_documento`.
