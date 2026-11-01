# 0129 · Se guarda lo que se sabe del nombre

Fecha: 2026-11-01 · Estado: aceptada · Precisa [0058](0058-nombres-y-apellidos-en-dos-campos.md).

## Problema

La regla de la ficha exige nombres y apellidos juntos. Desde el 28 de octubre, Sofi y su instrucción cuentan con guardar «Soy Carla» y pedir los apellidos cuando hagan falta, pero la ficha lo rechazaba: el nombre no quedaba guardado y Sofi recibía un error. En una auditoría de 120 conversaciones pasó en 19 de 96 llamadas.

## Decisión y motivo

- **Quien aún no es paciente puede tener solo sus nombres o solo sus apellidos, venga de Sofi o del equipo.** Lo que se sabe se guarda; no se pierde por no estar completo.
- **Registrarse como paciente sigue pidiendo los dos.** Ahí se completa lo que falta, con lo guardado ya escrito en el enlace y en el cajón de registro.
- **Vale para cualquier edición, no solo para Sofi.** La regla mira lo guardado más lo que cambia: si solo la relajara Sofi, editar el teléfono de Carla le pediría a recepción unos apellidos que nadie conoce.

## Alternativas descartadas

- *Que Sofi pida los apellidos antes de guardar*: la persona repite lo que ya dijo o el dato se pierde, para exigir algo que aún no hace falta.
- *Guardar solo el nombre visible*: Sofi lee los nombres guardados para saber con quién habla, así que volvería a preguntarlo.

## Consecuencias

- Con solo apellidos, el nombre visible pasa a ser esos apellidos, porque la base lo deriva de lo guardado. Se pierde el nombre de perfil que había. No apareció en esas 120 conversaciones.
- Un paciente sigue con los dos: su ficha y su registro usan la regla completa.

## Referencias

`validateDemographics` (`partialName`), `updatePersonIdentity`, `update_contact` en `packages/agent/src/tools.ts`.
