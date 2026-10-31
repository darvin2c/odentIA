# 0113. Un solo nombre: corregirlo desde su enlace y avisar si dice otro

- **Fecha:** 2026-10-30
- **Estado:** aceptada. Precisa la 0109: deja de descartar del todo «editar desde el enlace los datos ya guardados» (solo el nombre) y que la pregunta de novedades se responda una sola vez.

## Problema

Una persona escribió «te saluda Darvin», Sofi la saludó por su nombre y su enlace le mostró «Tus datos: Paciente Prueba WhatsApp». Al verlo, lo primero que pensó fue que esa no era su ficha. El nombre venía de antes de la 0108 (un registro que no lo reemplazó). Con la 0109, la página no dejaba corregirlo: había que pedírselo al equipo, y nada en la pantalla lo decía. Además, a quien alguna vez dijo que no a novedades y promociones no se le volvía a ofrecer nunca, ni siquiera sin insistir.

## Decisión y motivo

1. **«Corregir» junto a su nombre**, en «Revisa y reserva». Pide nombres y apellidos, ya escritos, y se guarda con la cita.
2. **Con su documento entero si la ficha lo tiene.** El enlace prueba que tiene su chat, no quién es; la página muestra el documento abreviado («DNI ••••4243») y pide el número completo. Si no coincide, no se guarda nada ni se reserva. Sin documento guardado manda el nombre que escribe, como al registrarse (0108).
3. **Solo el nombre.** El documento, la fecha y lo demás ya guardado siguen siendo del equipo.
4. **El nombre de antes queda en sus notas**: «Corrigió su nombre desde su enlace: antes figuraba como…».
5. **Si en el chat dice otro nombre, Sofi avisa.** Le habla por el nombre que dijo y lo guarda con `update_contact`; siendo paciente, su ficha no cambia y recepción recibe la tarea «Revisar su nombre», una por nombre dicho. Antes, Sofi la llamaba por el nombre del chat y los mensajes automáticos por el de su ficha, sin que nadie lo notara. Un apodo o un diminutivo no cuentan, y lo que ya está en su ficha (sin tildes ni mayúsculas) no avisa.
6. **A quien dijo que no a novedades se le ofrece una casilla sin marcar** al reservar. No es una pregunta obligatoria: si no la marca, su «no» sigue igual. A quien no quiere ningún mensaje no se le ofrece.

## Alternativas descartadas

- *Pedírselo al equipo* (la 0109). La persona no sabe que puede, cree que reservó con la ficha de otro y el equipo recibe una tarea más.
- *Corregir sin el documento.* Quien comparte el celular con un familiar podría cambiar el nombre de la ficha de otra persona.
- *Que Sofi cambie la ficha al oír otro nombre en el chat.* Un apodo o un familiar que escribe no prueban un nombre.
- *Volver a hacer la pregunta obligatoria de novedades.* Insistir sobre un «no» ya dado.

## Consecuencias

- Quien conoce el documento completo de otra persona y tiene su chat puede cambiarle el nombre. El de antes queda en sus notas para revertirlo.
- Revisar si las notas de «Corrigió su nombre» muestran usos indebidos, y si «Revisar su nombre» llega por apodos.
- Límites medidos con el modelo real: si se presenta en su primer mensaje, la primera respuesta aún puede usar el nombre de la ficha (avisa y lo sostiene cuando lo corrige); si solo cambia el apellido («Lucía Hernández» frente a «Lucía Fernández»), no lo nota. Para eso queda «Corregir» en su enlace.

## Referencias

`packages/services/src/su-enlace.ts` (`correctLinkName`, `pendingOf`, `saveLinkConsents`), `packages/services/src/agent-operations.ts` (`reportPatientNameMismatch`), `packages/agent/src/tools.ts` (`update_contact`) y `graph.ts` («Con quién hablas»), `packages/clinic-app/src/components/booking-data-form.tsx` (`YouReview`), `apps/api/src/routes/public-booking.ts`.
