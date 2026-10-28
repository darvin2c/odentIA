# 0099 · Registrar por el chat con un solo sí

**Fecha:** 2026-10-28 · **Estado:** aceptada (lienzo «Registrar por el chat», aprobado el 28 oct). Sustituye la alternativa descartada de ADR 0097 («registrar a la persona nueva por el chat»).

## Problema

A quien aún no es paciente, Sofi le mandaba un enlace para que volviera a elegir la hora y llenara sus datos. En 80 conversaciones aleatorias de la auditoría hubo 56 personas nuevas: 28 recibieron el enlace en vez de su cita y 16 quedaron sin resolver. Una recepcionista anota el nombre y reserva. Registrar exige informar el aviso de privacidad, y el enlace lo hace con una casilla («Acepto el aviso de privacidad»); en el chat no hay casilla.

## Decisión y motivo

- **Un solo sí reserva, registra y acepta el aviso.** La pregunta de la cita termina con «Al confirmar, aceptas nuestro aviso de privacidad: <enlace>. ¿Te la reservo?». Ese sí reemplaza a la casilla. Queda en `patient_data_consent` con canal `chat`, el mensaje del sí (`source_message_id`), la versión y el texto del aviso. Lo eligió la clínica dueña del producto (decisión 9 del lienzo).
- **Lo mínimo, como recepción al reservar:** nombres y apellidos; el documento solo si la clínica lo marca obligatorio, y si no lo tiene a la mano la cita sigue. Es la misma operación (`registerPatient`, `essentials`, sin autor). Nada de salud por el chat.
- **Si no hay cita, no hay registro:** la cita propuesta (`reservar_cita`) lleva `newPatient` en vez del paciente, y el registro ocurre al ejecutarla, en el mismo punto de restauración. El sí tiene que ser posterior a la pregunta: lo que eligió antes («resérvame mañana a las 2») no vale, porque no vio el aviso.
- **Para otra persona** (su hijo): el paciente es esa persona y quien escribe queda como su responsable y como quien aceptó.
- **El enlace se manda siempre con la cita**, para completar todos sus datos y su salud y llegar con la ficha completa; si la víspera aún falta algo, el recordatorio lleva «Completar mis datos».
- **Sin aviso escrito no se registra por el chat:** la clínica que no tiene aviso en Configuración › Registro de pacientes sigue con el enlace. El aviso se publica en `/aviso` de la clínica.
- Un documento que ya es de otra persona no une fichas: se registra sin él y queda dicho en el caso. Una prueba (Probar) no registra a nadie nuevo.

## Alternativas descartadas

- **Seguir con el enlace:** es lo que fallaba en la auditoría.
- **Pedir siempre el DNI:** frena a quien no lo tiene a la mano; el documento se completa en el enlace.
- **Esperar la revisión de un abogado antes de activarlo:** la clínica decidió que el sí alcanza; en Perú, para dar una cita la ley pide informar (Ley 29733, art. 18), no consentimiento (art. 14).

## Consecuencias

Más citas resueltas en la conversación. El sí del chat es la prueba de la aceptación: si una autoridad exigiera otra forma, se revisa la frase y el canal. Pendiente (fase 2): «¿Es la misma persona?» en la Bandeja.

## Referencias

`packages/services/src/patient-registration.ts` (`registerFromConversation`), `agent-operations.ts` (`newPatientOf`, ejecución de `reservar_cita`), `su-enlace.ts` (`bookedDataLink`); `packages/agent/src/tools.ts` (`reservar_paciente_nuevo`), `graph.ts` (`newPersonLine`); `apps/api/src/routes/public-patient-registration.ts` (`/:slug/aviso`); `packages/clinic-app/src/routes/public/aviso.tsx`; migración `0011_sofi_registra_por_el_chat`.
