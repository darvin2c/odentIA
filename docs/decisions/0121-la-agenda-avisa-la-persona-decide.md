# La agenda avisa y la persona decide

Fecha: 2026-10-31 · Estado: aceptada

## Problema

El horario funcionaba como una prohibición. Reservar fuera de él estaba escondido detrás de «¿Es una urgencia?», lo gris no respondía, una cita fuera de horario no se podía mover ni alargar, y un bloqueo o una segunda cita a la misma hora no tenían salida. La clínica trabaja con excepciones todos los días; el sistema no puede trabarlas.

## Decisión y motivo

- **Tres niveles.** Libre: se reserva sin más. Excepción: fuera de horario, dentro de un bloqueo o una ausencia, o junto a otra cita del mismo profesional; se avisa, se reserva, queda marcada y el profesional recibe un aviso en la campana. Imposible: dos personas en la misma unidad a la misma hora; se ofrece otra hora.
- **Las excepciones las hace siempre una persona del equipo.** `outsideSchedule` y `overrideBusy` son campos `agent: "person"`: la herramienta del agente no los recibe, y el enlace y el portal nunca los envían. Sofi solo reserva lo libre.
- **Sin función «doble cita».** Es la misma advertencia al elegir una hora ocupada, no otra pantalla ni otro nombre.
- **La excepción se dice al elegir la hora**, no en una ventana al enviar: el botón cambia a «Reservar fuera de horario». Arrastrar sí pide confirmar, porque se puede hacer sin querer, y ofrece «Deshacer».
- **La base protege lo imposible.** `appointment.overlap_allowed` saca a esa cita de la exclusión del profesional; la exclusión de la unidad no cambia. Dos citas normales siguen sin poder pisarse.

## Alternativas descartadas

- *Pedir un motivo o un permiso especial*: un paso más en lo que ya se decidió con la advertencia a la vista.
- *Una marca guardada de «cita fuera de horario»*: la rejilla ya lo deduce comparando la cita con el horario, y cambiar el horario actualiza la marca.
- *Horario de un solo día*: resuelve abrir un sábado entero, que es otro caso; queda para después.

## Consecuencias

- Una clínica con una sola unidad nunca puede dar dos citas a la misma hora.
- Con la marca `overlap_allowed`, una cita normal posterior la comprueba solo el servicio, no la base: dos reservas simultáneas podrían pisarla. Se acepta: ya hay una persona que aceptó compartir esa hora.
- Editar los detalles de una cita fuera de horario sin cambiar hora ni profesional sigue funcionando; cambiar su servicio por otro de distinta duración pasa por la validación normal y puede rechazarse.

## Referencias

- `packages/services/src/availability.ts` (`validateAvailability`), `packages/services/src/appointments.ts`.
- `packages/db/drizzle/0031_excepciones_de_agenda_reglas.sql`.
- `packages/clinic-app/src/routes/_org/agenda.tsx`, `packages/clinic-app/src/components/agenda/when.tsx`.
