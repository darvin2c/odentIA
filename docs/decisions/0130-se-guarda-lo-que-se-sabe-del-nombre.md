# 0130 · Se guarda lo que se sabe del nombre

Fecha: 2026-11-01 · Estado: aceptada · Precisa [0058](0058-nombres-y-apellidos-en-dos-campos.md).

## Problema

La regla de la ficha exige nombres y apellidos juntos. Desde el 28 de octubre, Sofi y su instrucción cuentan con guardar «Soy Carla» y pedir los apellidos cuando hagan falta, pero la ficha lo rechazaba: el nombre no quedaba guardado y Sofi recibía un error. En una auditoría de 120 conversaciones pasó en 19 de 96 llamadas.

## Decisión y motivo

- **Quien aún no es paciente puede quedar con solo sus nombres o solo sus apellidos.** Lo que se sabe se guarda; no se pierde por no estar completo. Lo guarda Sofi o el equipo al editar; «Nuevo contacto» sigue pidiendo los dos, porque ahí se escribe un alta y no un dato suelto.
- **Registrarse como paciente sigue pidiendo los dos.** Ahí se completa lo que falta, con lo guardado ya escrito en el enlace y en el cajón de registro.
- **Editar otro dato nunca pide lo que falta.** La regla mira lo guardado más lo que cambia: si solo la relajara Sofi, editar el teléfono de Carla le pediría a recepción unos apellidos que nadie conoce. Vale también para un paciente que quedó con una parte: al escribir sus nombres lleva los dos.
- **El equipo puede quitar lo que quedó mal.** Vaciar «Apellidos» de quien aún no es paciente se guarda: es una acción a la vista, y la alternativa es obligarlo a inventar uno.
- **Nada se reparte.** Si Sofi manda «Carla» y aparte «Carla Quispe», queda «Carla» y la herramienta le dice qué no quedó, para que ella mande los apellidos. Solo ella sabe si «María José» trae un apellido (ADR 0058). Si ya envió su respuesta en ese mismo paso no lo lee, y los apellidos se piden después.
- **Completar no es cambiar de nombre.** Pasar de «carla» a «Carla Quispe» al registrarse no deja nota; registrarse con otro nombre sí. Un nombre a medias no se mezcla con otro: si recepción dice que es la misma persona, va entero el que escribió, salvo que elija los apellidos guardados.

## Alternativas descartadas

- *Que Sofi pida los apellidos antes de guardar*: la persona repite lo que ya dijo o el dato se pierde, para exigir algo que aún no hace falta.
- *Guardar solo el nombre visible*: Sofi lee los nombres guardados para saber con quién habla, así que volvería a preguntarlo.

## Consecuencias

- Con solo apellidos, el nombre visible pasa a ser esos apellidos, porque la base lo deriva de lo guardado, y se pierde el nombre de perfil que había. Sofi sigue sin saber cómo se llama y puede preguntarlo, y los avisos saludan por ese apellido. Es un caso raro: no apareció en esas 120 conversaciones.
- El registro de un paciente sigue pidiendo los dos. Si una vía interna deja a un paciente con una parte, «Faltan datos» lo dice y no le impide editar lo demás.
- Si Sofi manda solo el nombre visible de alguien con una parte guardada, ese visible queda por revisar y los apellidos siguen sin guardarse, así que puede volver a preguntarlos. Es raro: de 96 llamadas, 2 traían solo el nombre visible.

## Referencias

`validateDemographics` (`partialName`), `updatePersonIdentity`, `update_contact` en `packages/agent/src/tools.ts`.
