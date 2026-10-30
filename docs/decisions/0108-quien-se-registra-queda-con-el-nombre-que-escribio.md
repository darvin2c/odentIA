# 0108 · Quien se registra desde su conversación queda con el nombre que escribió

Fecha: 2026-10-29 · Estado: aceptada · Completa [0001](0001-persona-unica.md) y [0044](0044-la-identidad-vive-en-la-persona.md)

## Problema

Quien se registra desde fuera con el enlace de su propia conversación («Su enlace» de reserva, el registro en línea con enlace) o en el chat con Sofi (0101) crea su ficha sobre el contacto de esa conversación. Ese alta solo completaba lo vacío del contacto (`adoptIdentity` con `onlyFill`), y el nombre visible solo cambiaba si el contacto no tenía nombres ni documento. Pero los nombres de un contacto que aún no es paciente casi nunca son una identidad registrada: los guarda Sofi con lo que la persona dijo en el chat (`update_contact`) o el equipo al escribirle. En producción una persona se registró con su nombre real y su ficha, la Bandeja y los avisos siguieron con el que tenía antes («Paciente Prueba WhatsApp»); lo escrito quedó solo en una nota.

## Decisión y motivo

- Al registrarse para sí misma desde su conversación, **la ficha nace con el nombre que escribió**: nombres, apellidos y nombre visible se reemplazan enteros, en el momento, sin un paso de confirmación. Es la persona de esa conversación (el enlace está ligado al hilo, no a un teléfono que coincide) declarando su nombre para su historia clínica, lo mismo que dijo antes en el chat pero escrito con cuidado.
- El nombre de antes, si alguien lo había guardado (Sofi o el equipo), queda en sus notas: «Se registró como …; antes figuraba como …». El nombre del canal se reemplaza sin nota, como siempre.
- **Un documento guardado que no es el que escribió conserva el nombre**: ahí sí hubo una identidad registrada y lo escrito no la prueba. El nombre escrito queda en sus notas con lo demás distinto.
- Lo demás no cambia: teléfono, correo, documento, nacimiento y sexo solo se completan si estaban vacíos; lo distinto queda en sus notas. Quien ya tiene ese documento en otra persona sigue en «Te espera» (`RegistrationHeld`).

## Alternativas descartadas

- **Esperar a que recepción confirme el nombre.** Deja la ficha, la Bandeja, los recordatorios y el «Pegar su enlace» con un nombre que la persona ya corrigió, y suma una tarea para algo que casi siempre es correcto.
- **Distinguir quién guardó el nombre (Sofi o el equipo).** No hay un dato fiable de quién lo escribió por última vez, y el nombre que el equipo pone al escribirle tampoco está verificado.

## Consecuencias

- La Bandeja, su ficha y los mensajes dicen el nombre con que se registró apenas termina el registro.
- Si alguien usa el enlace de otra persona y se registra a sí mismo, el contacto toma ese nombre; el de antes queda en sus notas para revisarlo. Revisar si eso ocurre en la práctica.

## Referencias

`packages/services/src/patients.ts` (`adoptIdentity`), `packages/services/src/agent-person-memory.test.ts` y `packages/services/src/patient-registration.test.ts`.
