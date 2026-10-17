# 0040 · El agente no elige plantillas; la categoría manda; tres tipos de mensaje

Fecha: 2026-10-16 · Estado: aceptada · Precisa [0030](0030-lo-del-servicio-no-pide-permiso.md), [0027](0027-escribirle-y-avisar-la-cita.md) y [0026](0026-recordar-la-cita-viene-prendida.md)

## Problema

- Fuera de las 24 horas de WhatsApp el agente tenía `send_template`: el modelo escribía el nombre, el idioma y los datos de una plantilla sin ninguna lista. Podía mandar un recordatorio con una fecha inventada. Contradice «ningún dato lo pone un modelo».
- La regla de envío de una plantilla no miraba su categoría. Si Meta pasaba un aviso de servicio a marketing, seguía saliendo a todos como servicio. «Retomar un presupuesto» y «Retomar una oportunidad» ya se pedían como marketing y salían sin el sí de novedades, contra la política de WhatsApp.
- El botón «No enviar más» de un recordatorio apagaba también los avisos de cita reservada, movida o cancelada, porque compartían el tipo `recordatorio`; la respuesta solo decía «recordatorios». Lo que la persona escribía («ya no me manden recordatorios») no se anotaba, y revocar el consentimiento de datos dejaba salir lo del servicio.

## Decisión y motivo

- **El agente no elige plantillas.** Se retira `send_template`. Si el agente tiene que responder pasadas las 24 horas, el sistema envía «Retomar la conversación» con el nombre de la persona y el de la clínica, y el turno termina (`resumeConversationBySystem`, la misma regla de la Bandeja). Si «Retomar» no está aprobada no sale nada y el caso queda para una persona en «Te espera» con qué hacer. Los avisos con datos siguen saliendo desde las automatizaciones.
- **La categoría manda.** `assertTemplateSendable` recibe la categoría con la que se pidió el mensaje: lo que WhatsApp cuenta como promoción solo sale a quien aceptó novedades. La ruta de cada mensaje lo sabe antes de enviar: sin el sí, va por correo si lo hay o queda con la causa `promocion`. Se escucha `template_category_update` y una revisión diaria de cada conexión pone al día estados y categorías. Quien administra ve el aviso en «Te espera» y la marca «Meta lo considera promoción» en la lista.
- **Tres tipos que se apagan y los avisos de lo que pasó.** Recordatorios de sus citas; controles y seguimiento (control, no asistió, otra fecha); novedades y promociones (también retomar un presupuesto o una oportunidad), apagadas hasta su sí. Los avisos de lo que pasó (cita reservada, movida o cancelada, presupuesto listo, «Su enlace», receta y comprobante) salen siempre y no tienen botón de baja; solo los frena «No quiero ningún mensaje de la clínica» (`avisos` revocado), que apaga los cuatro. Es una sola operación (`setMessageChoice`) para la página «Tus mensajes» de su enlace, recepción, el agente (`elegir_mensajes`), el botón y «BAJA» o «STOP», que se resuelven sin modelo; «cancelar» nunca es una baja. Revocar el consentimiento de datos apaga los cuatro.
- **Los papeles por su canal.** El comprobante sale solo por correo al cobrar y queda 30 días en «Tus papeles»; por WhatsApp, solo si lo pide en el chat. La receta pasadas las 24 horas sale con «Su enlace», ya aprobado, y se descarga ahí. Una plantilla de la cuenta con encabezado o con datos por nombre se muestra, pero no se ofrece.

Lo que obliga a dejar apagar los recordatorios es la política de WhatsApp (respetar toda baja) y la calidad del número, no la ley: las normas revisadas exigen la baja para la publicidad. No es un dictamen jurídico.

## Alternativas descartadas

- *Darle al agente la lista de plantillas aprobadas*: sigue eligiendo nombre y datos un modelo; basta un mensaje fijo que retome.
- *Detener un aviso que Meta pasó a promoción*: deja sin aviso a quien sí aceptó novedades.
- *Una sola baja «Sin recordatorios» para recordatorios y seguimiento*: la persona no podría quedarse con uno solo; los tres interruptores son lo que ve en su página.
- *Que los avisos de la cita no se puedan apagar nunca*: WhatsApp pide respetar toda baja y un bloqueo baja la calidad del número de toda la clínica.

## Consecuencias

- Beneficio: ningún modelo toca una plantilla; la baja de la persona se respeta por cualquier vía y no le quita el aviso de que su cita cambió; quien no recibe recordatorios aparece en «Te espera» para llamarla el día antes.
- Sacrificio: un retomar llega a menos personas (solo con su sí). Las plantillas del catálogo cambiaron de versión (`_v2`) y se vuelven a pedir. Microsoft 365 no admite la cabecera `List-Unsubscribe` (Graph solo deja cabeceras `X-`): ahí queda solo el enlace del pie.
- Revisar con la prueba contra una cuenta real de WhatsApp, o si una autoridad pide otro criterio para los avisos de servicio.

## Referencias

- `packages/services/src/automation-messages.ts` (`MESSAGE_KIND_WORDS`, `isStopWord`, `NOTICE_PURPOSE`), `automation.ts` (`setMessageChoice`, `handleAutomationReply`, `chooseMessagesInConversation`), `message-permission.ts` (`mayWriteFirst`), `channel-templates.ts` (`assertTemplateSendable`, `applyTemplateCategories`, `reviewConnectionTemplates`), `automation-routing.ts`, `clinic-messages.ts` (`resumeConversationBySystem`, `listRecategorizedMessages`), `su-enlace.ts` («Tus mensajes», «Tus papeles»), `financial-documents.ts` (`sendTicketReceiptByEmail`), `data-consents.ts`; `packages/agent/src/tools.ts` (`elegir_mensajes`, `enviar_comprobante`); migración `0101_tus_mensajes_y_plantillas.sql`; lienzo de la fase 4, tablero 4 v2 y decisiones 7, 8, 9, 14 v3 y 20 v2.
