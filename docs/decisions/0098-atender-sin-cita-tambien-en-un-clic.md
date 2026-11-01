# Atender sin cita también en un clic

Fecha: 2026-10-27 · Estado: aceptada · Amplía [0032](0032-la-cita-registra-la-llegada-la-atencion-la-cierra.md)

## Problema

Con cita, «Atender» abría la atención en un clic (0032). Sin cita, abría antes el cajón «Atender sin cita» con dos campos: el motivo y el profesional. El botón solo lo ve quien escribe en la historia, así que el profesional casi siempre era quien pulsaba. Y el motivo se volvía a pedir dentro, en «Consulta», que se abre sola al entrar. El usuario lo vio como un paso que no aportaba nada: «atender debería llevar directamente a la atención».

## Decisión y motivo

- **«Atender» es siempre un clic**, con cita o sin ella. Abre la atención a nombre de quien pulsa (el servidor ya lo ponía por defecto) y en la sede activa, la misma que muestra la Agenda.
- **El motivo no se pide al abrir.** Se dicta a Clío o se escribe dentro, en «Consulta». El cierre lo sigue exigiendo, como desde una cita. Al principio «Consulta» se abría sola cuando faltaba; se quitó (2026-11-01) porque tapaba a Clío, que es la vía que se quiere.
- **Si atiende otro profesional**, pulsa él «Atender» o «Tomar el relevo» dentro de la atención. No hace falta elegirlo antes.

## Alternativas descartadas

- *Dejar el cajón con el profesional elegido de antemano*: seguía siendo un paso de más para el caso de siempre.
- *Pedir solo el motivo en un diálogo corto*: duplica «Consulta», donde el motivo ya vive con el relato y el tiempo de enfermedad.

## Consecuencias

- Una atención puede abrirse sin motivo también sin cita. No se puede cerrar así, y «Atención sin firmar» del Administrador ya avisa de las que quedan abiertas.
- Revisar si aparecen muchas atenciones vacías abiertas por error: la salida sería descartarlas solas si nadie escribió nada.

## Referencias

- `packages/services/src/encounters.ts` (`createEncounter`): ya no exige el motivo sin cita.
- `packages/clinic-app/src/components/patient/new-encounter-button.tsx`: sin el cajón.
- Lienzo «Paciente: cada acción en su sitio», tablero 5.
