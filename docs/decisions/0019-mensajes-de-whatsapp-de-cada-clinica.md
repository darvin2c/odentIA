# 0019 · Los mensajes de WhatsApp son de cada clínica: vienen escritos, se pueden cambiar y se piden todos al conectar

Fecha: 2026-10-13 · Estado: aceptada · Ajusta a [0015](0015-administrador-lineas-prendidas-o-apagadas.md) en cómo se declaran y se piden los mensajes

## Problema

Pasadas 24 horas desde que una persona escribió, WhatsApp solo deja enviarle un texto que ya aprobó. odentIA resolvía eso con cinco textos fijos en el código (uno por línea del Administrador), iguales para todas las clínicas, que se pedían a WhatsApp recién al prender cada línea. Tres cosas quedaban sin salida:

- Una clínica no podía decir lo mismo con sus palabras (tratar de «usted», por ejemplo): cambiar un texto era cambiar el código.
- Recepción no tenía con qué escribirle a quien nadie respondió a tiempo: solo existían los mensajes del agente, que piden los datos de una cita o de un presupuesto.
- Al prender una línea su mensaje recién entraba a revisión, así que durante un día no salía.

La restricción que no cambia: fuera de las 24 horas solo sale lo aprobado, y WhatsApp revisa cada texto y cada cambio.

## Decisión y motivo

- **Los mensajes viven en la cuenta de cada clínica y cada una les cambia el texto.** odentIA los trae escritos (`AUTOMATION_MESSAGES` y «Retomar la conversación»); la clínica edita el texto, no los datos ni los botones: los datos los pone el sistema al enviar y de los botones depende que una cita se confirme sola o que la persona deje de recibir mensajes.
- **Un texto nuevo es otra plantilla, con otro nombre.** Nunca se edita una ya pedida. Mientras WhatsApp revisa el texto nuevo, o si lo rechaza, sigue saliendo el anterior aprobado: un cambio nunca deja a la clínica sin mensaje. Volver al texto de odentIA no pide otra revisión si su plantilla ya estaba aprobada.
- **El texto vigente es uno solo para las tres vías** (plantilla, respuesta dentro de las 24 horas y correo). Sin WhatsApp, o sin ninguna versión aprobada todavía, vale el último texto guardado.
- **Un sexto mensaje, «Retomar la conversación», lo envía una persona desde la Bandeja.** No es automático ni responde a un permiso de mensajes: continúa una consulta que la persona inició, y por eso solo se ofrece donde ella ya escribió. No se envía un segundo mensaje aprobado mientras no responda y no haya pasado un día.
- **La clínica puede crear mensajes propios para la Bandeja**, con dos datos posibles (el nombre de la persona y el de la clínica) y un botón de respuesta opcional. Los mensajes del agente no se envían a mano: piden datos que solo el sistema tiene.
- **Todo se pide a WhatsApp al conectar**, no al prender cada línea, para que ya esté aprobado cuando haga falta. El ciclo del worker pide lo que haya faltado.
- **Las reglas del texto se validan en un solo sitio del servidor** y cada falla tiene su frase: la pantalla las muestra tal cual, igual al escribir que al guardar.

## Alternativas descartadas

- *Seguir con textos solo en el código*: cada cambio de tono de una clínica sería un despliegue, y todas dirían lo mismo.
- *Editar la plantilla existente en WhatsApp*: Meta la vuelve a revisar y, entretanto, la clínica se queda sin el mensaje que tenía aprobado.
- *Dejar que la clínica cambie también datos y botones*: un recordatorio sin fecha no dice nada, y sin «Confirmar» o «No enviar más» se pierde lo que el sistema resuelve solo.
- *Reusar un mensaje del agente para retomar una conversación*: obliga a recepción a escribir «parámetros» de una cita que no existe.
- *Pedir cada mensaje al prender su línea*: la línea queda un día sin escribir justo cuando alguien acaba de decidir usarla.
- *Que el texto vigente dependa de cada vía*: la misma persona leería dos textos distintos según por dónde le llegue.

## Consecuencias

- Beneficio: cada clínica habla con sus palabras, recepción puede retomar una conversación y las líneas escriben desde que se prenden.
- Sacrificio: el estado de un mensaje ya no se deduce del código. Hay versiones por organización (`clinic_message`, `clinic_message_version`) y el texto vigente se resuelve al enviar; los textos reemplazados quedan en la cuenta de WhatsApp de la clínica.
- WhatsApp decide la categoría (utilidad o marketing) de cada texto y cobra según eso: un cambio de la clínica puede moverla.
- Nada de esto acredita que WhatsApp apruebe un texto: sin proveedor (pruebas, desarrollo) una solicitud queda «en revisión» y no cambia sola.
- Se revisa si las clínicas necesitan mensajes propios con más datos que el nombre de la persona y el de la clínica, o si la cuenta se llena de textos reemplazados y hay que retirarlos.

## Referencias

- `packages/services/src/clinic-messages.ts`, `automation-messages.ts`, `channel-templates.ts`, `automation-routing.ts`, `connections.ts`; `packages/channels/src/whatsapp-cloud-api.ts`.
- `apps/api/src/routes/connections.ts`, `conversations.ts`.
- Migración `0069_mensajes_de_la_clinica`.
