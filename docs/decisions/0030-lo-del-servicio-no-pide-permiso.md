# 0030 · Lo que es parte del servicio no pide permiso; novedades y promociones, sí

Fecha: 2026-10-15 · Estado: aceptada · Precisa [0027](0027-escribirle-y-avisar-la-cita.md) y [0026](0026-recordar-la-cita-viene-prendida.md) (el permiso de recordatorios)

## Problema

Todo lo que el agente escribía sin que la persona escribiera primero pedía su permiso de mensajes: el aviso de su propia reserva, el recordatorio y la confirmación de su cita, el control por agendar, el presupuesto que quedó pendiente. Casi nadie llegaba a tener ese permiso, porque quien escribe por WhatsApp no pasa por el formulario de registro, y «Recordar la cita» quedaba prendida sin escribirle a nadie. A la vez, la clínica sí necesita el sí de la persona antes de mandarle promociones.

## Decisión y motivo

- **Lo necesario para dar el servicio que la persona pidió no pide permiso previo.** Sale sin preguntar: lo de su cita (aviso de reserva, cambio o cancelación, recordatorio y confirmación), el enlace de registro, el control por agendar, retomar un presupuesto o una oportunidad, la inasistencia, ofrecer otra fecha tras una cancelación y, en general, toda línea del Administrador que escribe sobre la atención de esa persona (tipos `recordatorio` y `seguimiento`).
- **Solo «novedades y promociones» pide su consentimiento** (tipo `novedades`). Hoy ninguna línea las envía: el permiso queda listo para cuando exista una.
- **La baja se respeta siempre.** Si la persona pide no recibir un tipo de mensaje (botón «No enviar más», el enlace de baja o lo dice), ese tipo no se le envía. Un «no» guardado antes cuenta como baja. Una sola regla decide (`mayWriteFirst`).
- **Cómo se pide el de novedades:** el agente lo pregunta una sola vez por persona, tras reservar en la conversación («¿Te podemos escribir para enviarte novedades y promociones de la clínica?», con «Sí» y «No, gracias», que resuelve el sistema sin modelo; por escrito, con su herramienta). En «Nueva cita» recepción puede anotarlo, opcional, como dicho por teléfono; el registro de pacientes lo pregunta. Sin respuesta no se vuelve a preguntar.

Es el criterio del usuario y de la clínica, que lo entienden así de la Ley 29733 de datos personales: el tratamiento necesario para prestar el servicio que la persona pidió no exige un consentimiento aparte; la publicidad, sí. No es un dictamen jurídico.

## Alternativas descartadas

- *Pedir permiso para todo, como antes*: «Recordar la cita» prendida no escribía a casi nadie y las inasistencias no bajaban.
- *Solo la cita sin permiso y lo demás con permiso general*: el control, el presupuesto y la inasistencia también son de la atención que pidió; pedir permiso ahí deja a la clínica sin poder seguirla.
- *Preguntar en cada reserva*: insiste; con una vez basta y su respuesta (o su silencio) se respeta.

## Consecuencias

- «Prendida, pero casi no escribe» (`permissionGaps`) solo mira las líneas de novedades: hoy no hay ninguna, así que no aparece.
- La pregunta de recordatorios del registro (`askReminders`) ya no se muestra; la columna queda sin uso.
- La categoría de cada plantilla de WhatsApp la pide Meta según su contenido y no cambia por esto.
- Sacrificio: una persona puede recibir un mensaje de su atención sin haberlo aceptado expresamente; por eso todo mensaje lleva su baja y la ficha muestra lo que pidió no recibir.
- Revisar si una autoridad o una clínica real pide otro criterio, o si aparece una línea de novedades.

## Referencias

- `packages/services/src/automation.ts` (`mayWriteFirst`, `askGeneralPermissionAfterBooking`, `answerGeneralPermission`, `handleAutomationReply`), `automation-messages.ts` (`GENERAL_PERMISSION_QUESTION`, `generalPermissionButtons`), `data-consents.ts`, `patient-registration.ts`, `agent-admin.ts` (`permissionGaps`).
- `packages/agent/src/run.ts` y la herramienta `responder_permiso_mensajes` (`tools.ts`).
- `apps/dental-clinic/src/components/patient/message-permissions-section.tsx`, `components/agenda/booking-drawer.tsx`.
