# 0152 · El control se pide al firmar y se cumple con la visita que toca

Fecha: 2026-11-07 · Estado: aceptada · Ajusta a [0145](0145-una-regla-por-lo-que-falta-agendar.md) (qué es un control vencido) · Sigue a [0102](0102-clio-reserva-la-cita-y-arma-el-presupuesto.md) (el control no es una cita)

## Problema

La ronda de QA del 2026-11-06 (perfil, atención y seguimiento) encontró que el control y la cita viven separados y se desencuentran:

- Para indicar «vuelve en 6 meses» al terminar hacían falta unos 12 toques, y la fecha abría en mañana. Casi nadie lo hacía al firmar.
- Un control solo pasaba a «realizado» si se atendía la cita reservada desde él. Quien volvía por otra cita (Agenda, Sofi, «Su enlace») dejaba su control «vencido» para siempre.
- Cancelar la cita del control lo devolvía a pendiente, pero con la cita puesta: Argos lo leía como «tiene cita».
- «Avisar un control» le escribía también a quien ya tenía una cita, o a quien tenía el control reservado.
- «Programar control» reservaba en la sede activa, no en la de la atención, y «Usar esa cita» miraba 90 días desde hoy.
- Un control olvidado de hace dos años sacaba a la persona de «Por invitar a volver» para siempre.

## Decisión y motivo

- **Se pregunta al firmar.** El cierre trae «¿Cuándo vuelve?»: «En 1 semana», «En 1 mes», en los meses del producto (`recallMonths`: 6 en odentIA, 12 en latidIA), «Otra fecha» (el calendario abre cerca de la fecha probable) y «No hace falta». Ninguno viene marcado: sin elegir se firma igual y una línea avisa que recepción no lo verá; la auditoría del cierre guarda qué se eligió (`nextControl`). El tipo y el título los pone el sistema: de mantenimiento con los meses del producto; si no, «Control de» el primer procedimiento de hoy; si no hubo, «Control». Si la persona ya tiene un control pendiente o reservado, uno que se repite o uno dictado a Clío, el cierre no pregunta: dice «Vuelve el 6 may 2027» y «Cambiar» mueve el pendiente a otro día. Nunca quedan dos controles. Es el momento en que el profesional sabe la respuesta, sin salir del cierre.
- **El cierre cumple el control que ya tocaba.** Un control tiene ventana: abre `max(2 días, 25 % del intervalo)` antes de su día (intervalo = de cuando se indicó a su día) y no cierra. Un control a 6 meses abre unos 45 días antes; uno a una semana, 2 días antes. Al firmar, cada control pendiente con la ventana abierta, que no nació en esa atención, sale como casilla («Cumple su control de mantenimiento del 3 may»), marcada si quien firma atendió la atención donde se indicó. Firmar cumple los marcados con la misma marca que la cita del control (`by: "ventana"`) y su repetición. Anular la atención los devuelve a pendiente. La regla está una vez, en código y en SQL (`to-schedule.ts`), y la usan el cierre, «Qué sigue» y «Usar esa cita».
- **La cita no toma el control sola.** La cita reservada desde el control sigue siendo su cita; otra cita no lo toma. Cancelar la cita o marcar «No vino» devuelve el control a pendiente y la suelta. «Avisar un control» toma solo el pendiente, y solo de quien no tiene ninguna cita por venir: esa visita ya lo cumplirá.
- **La sede del control es la de su atención.** «Programar control» reserva ahí (sin ella, en la sede activa), y «Usar esa cita» ofrece las citas desde que abre su ventana, en cualquier sede.
- **«Por invitar a volver» no se pierde por un control olvidado.** Solo excluye a quien tiene un control pendiente o reservado de los últimos `recallMonths` meses.

## Alternativas descartadas

- *Que toda cita nueva tome el control pendiente* (la línea que 0145 dejó abierta): decide al reservar algo que solo se sabe al atender. Una limpieza reservada para mañana por otro motivo tomaría el control de ortodoncia de dentro de 5 meses, y cancelar o mover esa cita obligaría a deshacer y rehacer el vínculo en cada vía de reserva (Agenda, Sofi, «Su enlace», Clío). Quien firma sabe si esa visita lo cumplió; la casilla se lo pregunta con lo más probable marcado.
- *Una cita sin hora como control:* cambia lo que es una cita en toda la aplicación (Agenda, recordatorios, calendario, Argos).
- *Cumplir el control con cualquier visita, sin preguntar:* una urgencia de otro profesional cerraría en silencio un control clínico que no se hizo.
- *Ventana fija (por ejemplo, 30 días):* demasiado para un control a una semana, poco para uno a un año.
- *Atajos que vienen marcados:* el profesional firmaría un control que no eligió.

## Consecuencias

- El control queda indicado donde se decide, en uno o dos toques, y recepción lo ve para reservarlo.
- «Control vencido» deja de contar a quien ya vino: la visita que toca lo cumple al firmarse.
- Sacrificio: una visita dentro de la ventana cumple el control si quien firma lo deja marcado, aunque no fuera para eso; el texto lo dice («Cualquier atención desde unos días antes de su fecha le sirve»). Una cita por venir de la Agenda deja de recibir «Avisar un control», aunque sea para otra cosa.
- Las semillas y la API sin pantalla, que firman sin `followUpIds`, cumplen todos los controles que tocan.
- Se revisa si las clínicas desmarcan a menudo la casilla (la ventana sería ancha), o si piden que una cita de la Agenda del mismo día ya diga que es el control.

## Referencias

`packages/services/src/to-schedule.ts` (`controlWindowStart`, `controlWindowOpenSql`), `encounters.ts` (`closingControlsOf`, `finalizeEncounter`, `reopenFollowUpsOf`), `appointments.ts` (`releaseFollowUps`), `automation.ts` (`syncCheckupReminders`), `report-patients.ts` (`lapsedSql`), `follow-ups.ts` (`branchId`, `windowFrom`); pantalla: `packages/clinic-app/src/components/patient/encounter-closing.tsx` (`ClosingNextVisit`) y `follow-up-scheduler.tsx`. Mapa del área: §3-6 del flujo de la ronda de QA del 2026-11-06.
