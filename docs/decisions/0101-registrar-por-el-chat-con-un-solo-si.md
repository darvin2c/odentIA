# 0101 · Registrar por el chat con un solo sí

**Fecha:** 2026-10-28 · **Estado:** aceptada (lienzo «Registrar por el chat», aprobado el 28 oct). Sustituye la alternativa descartada de ADR 0097 («registrar a la persona nueva por el chat»). Precisada por [0109](0109-un-solo-formulario-con-lo-que-ya-sabemos.md): la cita reservada con su sí nace confirmada y cierra la reserva de su enlace.

## Problema

A quien aún no es paciente, Sofi le mandaba un enlace para que volviera a elegir la hora y llenara sus datos. En 80 conversaciones aleatorias de la auditoría hubo 56 personas nuevas: 28 recibieron el enlace en vez de su cita y 16 quedaron sin resolver. Una recepcionista anota el nombre y reserva. Registrar exige informar el aviso de privacidad, y el enlace lo hace con una casilla («Acepto el aviso de privacidad»); en el chat no hay casilla.

## Decisión y motivo

- **Un solo sí reserva, registra y acepta el aviso.** La pregunta de la cita termina con «Al confirmar, aceptas nuestro aviso de privacidad: <enlace>. ¿Te la reservo?». Ese sí reemplaza a la casilla. El aviso queda congelado en la propuesta y el sí solo cuenta si es posterior a un mensaje que llevó el enlace `/aviso`: un «sí» anterior, o una pregunta que no lo llevó, no registran a nadie. Queda en `patient_data_consent` con canal `chat`, el mensaje del sí (`source_message_id`, sin clave foránea: una conversación de prueba se borra con su persona), la versión y el texto del aviso que se le mostró. Lo eligió la clínica dueña del producto (decisión 9 del lienzo).
- **Lo mínimo, como recepción al reservar:** nombres y apellidos; el documento solo si la clínica lo marca obligatorio, y si no lo tiene a la mano la cita sigue. Es la misma operación (`registerPatient`, `essentials`, sin autor). Nada de salud por el chat.
- **Si no hay cita, no hay registro:** la cita propuesta (`reservar_cita`) lleva `newPatient` en vez del paciente, y el registro ocurre al ejecutarla, en el mismo punto de restauración. El sí tiene que ser posterior a la pregunta: lo que eligió antes («resérvame mañana a las 2») no vale, porque no vio el aviso.
- **Para otra persona:** si es su hijo o hija menor, quien escribe queda como su representante legal (la misma responsabilidad que crea el enlace) y es quien acepta. Si es una persona adulta (su mamá), quien escribe queda como familiar y el consentimiento queda pendiente: lo da ella.
- **Solo en el chat:** una persona nueva no se registra al «confirmar por teléfono» ni con una propuesta desde la API: no hubo su sí al aviso. El documento se valida al proponer, no después del sí.
- **El enlace se manda siempre con la cita**, para completar todos sus datos y su salud y llegar con la ficha completa; si la víspera aún falta algo, el recordatorio lleva «Completar mis datos».
- **Sin registro encendido o sin aviso escrito no se registra por el chat:** la clínica que apagó su registro de pacientes, o no escribió su aviso, sigue con el enlace o con recepción. El aviso se publica en `/aviso` de la clínica, con el mismo límite de pedidos que el registro.
- Un documento que ya es de otra persona no une fichas: se registra sin él y queda la tarea «Posible ficha repetida» para recepción; la nota del caso, que lee el agente, no dice de quién es. Una prueba (Probar) no registra a nadie nuevo.

## Alternativas descartadas

- **Seguir con el enlace:** es lo que fallaba en la auditoría.
- **Pedir siempre el DNI:** frena a quien no lo tiene a la mano; el documento se completa en el enlace.
- **Esperar la revisión de un abogado antes de activarlo:** la clínica decidió que el sí alcanza; en Perú, para dar una cita la ley pide informar (Ley 29733, art. 18), no consentimiento (art. 14).

## Consecuencias

Más citas resueltas en la conversación. El sí del chat es la prueba de la aceptación: si una autoridad exigiera otra forma, se revisa la frase y el canal. Pendiente (fase 2): «¿Es la misma persona?» en la Bandeja.

## Referencias

`packages/services/src/patient-registration.ts` (`registerFromConversation`), `agent-operations.ts` (`newPatientOf`, ejecución de `reservar_cita`), `su-enlace.ts` (`bookedDataLink`); `packages/agent/src/tools.ts` (`reservar_paciente_nuevo`), `graph.ts` (`newPersonLine`); `apps/api/src/routes/public-patient-registration.ts` (`/:slug/aviso`); `packages/clinic-app/src/routes/public/aviso.tsx`; migración `0011_sofi_registra_por_el_chat`.
