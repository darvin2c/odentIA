# 0129 · Se guarda lo que se sabe del nombre

Fecha: 2026-11-01 · Estado: aceptada · Precisa [0058](0058-nombres-y-apellidos-en-dos-campos.md).

## Problema

La regla de la ficha exige nombres y apellidos juntos. Desde el 28 de octubre, Sofi y su instrucción cuentan con guardar «Soy Carla» y pedir los apellidos cuando hagan falta, pero la ficha lo rechazaba: el nombre no quedaba guardado y Sofi recibía un error. En una auditoría de 120 conversaciones pasó en 19 de 96 llamadas.

## Decisión y motivo

- **Quien aún no es paciente puede quedar con solo sus nombres o solo sus apellidos.** Lo que se sabe se guarda; no se pierde por no estar completo. Lo guarda Sofi o el equipo al editar; «Nuevo contacto» sigue pidiendo los dos, porque ahí se escribe un alta y no un dato suelto.
- **Registrarse como paciente sigue pidiendo los dos.** Ahí se completa lo que falta, con lo guardado ya escrito en el enlace y en el cajón de registro.
- **Editar otro dato nunca pide lo que falta.** La regla mira lo guardado más lo que cambia: si solo la relajara Sofi, editar el teléfono de Carla le pediría a recepción unos apellidos que nadie conoce. Vale también para un paciente que quedó con una parte: al escribir sus nombres lleva los dos.
- **Se puede no saber una parte, no borrar la que ya se sabe.** Vaciar «Apellidos» por error sigue dando error.
- **Lo que Sofi escribió entero no se pierde.** Si manda «Carla» y aparte «Carla Quispe», lo demás son los apellidos. No se adivina: es el resto de lo que ella misma dio como nombre entero, y un nombre visible solo sigue sin repartirse (ADR 0058).
- **Completar no es cambiar de nombre.** Pasar de «Carla» a «Carla Quispe» al registrarse no deja nota; registrarse con otro nombre sí.

## Alternativas descartadas

- *Que Sofi pida los apellidos antes de guardar*: la persona repite lo que ya dijo o el dato se pierde, para exigir algo que aún no hace falta.
- *Guardar solo el nombre visible*: Sofi lee los nombres guardados para saber con quién habla, así que volvería a preguntarlo.

## Consecuencias

- Con solo apellidos, el nombre visible pasa a ser esos apellidos, porque la base lo deriva de lo guardado, y se pierde el nombre de perfil que había. Sofi sigue sin saber cómo se llama y puede preguntarlo, y los avisos saludan por ese apellido. Es un caso raro: no apareció en esas 120 conversaciones.
- El registro de un paciente sigue pidiendo los dos. Si una vía interna deja a un paciente con una parte, «Faltan datos» lo dice y no le impide editar lo demás.

## Referencias

`validateDemographics` (`partialName`), `updatePersonIdentity`, `update_contact` en `packages/agent/src/tools.ts`.
