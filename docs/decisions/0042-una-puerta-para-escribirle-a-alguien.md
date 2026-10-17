# 0042 · Una puerta para escribirle a alguien

Fecha: 2026-10-16 · Estado: aceptada · Precisa [0024](0024-ninguna-conversacion-queda-abierta.md), [0030](0030-lo-del-servicio-no-pide-permiso.md) y [0040](0040-el-agente-no-elige-plantillas-la-categoria-manda-tres-tipos-de-mensaje.md)

## Problema

Antes de escribirle a una persona hay que decidir cuatro cosas: si su permiso lo deja, si la ventana de 24 horas de WhatsApp está abierta, por qué canal sale y a qué hora. Cada una se decidía en varios lugares y ya daban respuestas distintas:

- La ventana se calculaba en cinco sitios (24 horas, 23 horas, solo hilos abiertos). La persona escribía hace 3 horas y se cerró la conversación: el recordatorio salía como respuesta, pero la pantalla del comprobante decía «Fuera de la ventana».
- «Probar línea» del Administrador contaba el permiso con otra regla (`status = granted`): quien nunca dijo nada salía «No pudo» aunque el envío real sí le escribía.
- Había tres horarios para lo mismo: el «Horario de silencio» del Administrador (21:00–08:00), el horario de atención del equipo para insistir y despedirse, y el del agente. La despedida no salía a la hora en que el Administrador sí escribía.
- Presupuesto, «Su enlace», recetas y comprobantes repetían la excepción «si es respuesta, sale» cada uno a su manera.

## Decisión y motivo

Una sola puerta (`message-gate.ts`), con una regla por pregunta:

- **Permiso** (`mayWriteFirst`, que ejecuta su versión SQL `mayWriteFirstSql`): lo que odentIA inicia por su cuenta lo necesita siempre. Lo que manda el equipo (presupuesto, «Su enlace», receta, comprobante) es un aviso: como respuesta a quien escribió en la ventana sale; si no, solo lo frena «No quiero ningún mensaje de la clínica» (`permitsMessage`).
- **Ventana** (`windowOpen`, `message-window.ts`): 24 horas menos un único margen de 15 minutos, abierta o cerrada la conversación (escribir reabre). La usan la vía, la Bandeja, los documentos, «Probar línea» y la despedida.
- **Canal**: el orden fijo de `chooseVia` (WhatsApp como respuesta, el mensaje aprobado, el correo) para lo automático; los papeles mantienen su canal natural (decisión 20 v2) sobre las opciones de `documentChannelsFor`.
- **Hora**: un solo «Horario para escribir» por día, en Agente (`writing-hours.ts`), con la hora de cada sede y sin depender del horario de atención. Viene de lunes a viernes de 8:00 a 20:00 y el sábado de 8:00 a 14:00; el domingo no se escribe. Fuera del horario, sale en el último momento permitido antes o, si no hay, en el primero después con al menos una hora de margen antes de la cita (`sendTimeFor`). Los avisos de lo que pasó y lo que manda el equipo salen al momento. «A qué horas responde» el agente sigue aparte.

«Probar línea» usa las mismas funciones que el envío real: no hay otra regla que pueda decir otra cosa.

## Alternativas descartadas

- *Usar el horario de atención como horario para escribir*: una clínica que atiende de 14:00 a 20:00 no podría recordar una cita por la mañana.
- *Mantener el «Horario de silencio» al revés («no escribe desde las 21:00»)*: no permite un domingo sin mensajes ni un sábado corto, y solo lo respetaba el Administrador.
- *Ventana exacta de 24 horas sin margen*: lo que se decide en un lote o un reintento puede salir minutos después y el proveedor lo rechaza.

## Consecuencias

- Beneficio: la prueba de una línea dice lo mismo que el envío; un solo ajuste de horario para todo lo que sale solo; la pantalla de un documento y la vía de un mensaje ven la misma ventana.
- Sacrificio: un recordatorio que cae en domingo sale el sábado (o el lunes si la cita es tarde); en la Bandeja el texto libre se cierra 15 minutos antes que en WhatsApp.
- El presupuesto (`budget-send.ts`) también pasa por `previewRoute` / `openRoute`.
- Un número que WhatsApp rechazó («Este número no tiene WhatsApp», `contact_identity.no_whatsapp_at`) no es una vía: sale por correo o queda la llamada en «Te espera».
- Revisar si una clínica necesita horarios para escribir distintos por sede.

## Referencias

- `packages/services/src/message-gate.ts`, `message-window.ts`, `message-permission.ts` (`mayWriteFirstSql`, `permitsMessage`), `writing-hours.ts`, `automation-routing.ts` (`chooseVia`), `automation.ts` (`deliverJob`, `syncAppointmentReminders`), `admin-drafts.ts` (`testAdminLine`), `conversation-close.ts`, `financial-documents.ts` (`documentChannelsFor`, `deliverDocumentPdf`), `su-enlace.ts`, `clinic-messages.ts` (`resumeConversationBySystem`); migración `0105_una_puerta_y_una_lista.sql`; lienzo de la fase 4, tablero 2b y decisión 18 v3.
