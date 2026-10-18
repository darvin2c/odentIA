# 0060 · El horario guarda desde cuándo vale

Fecha: 2026-10-18 · Estado: aceptada · Decisión 4 de Reportes v2 (issue 113)

## Problema

Reportes › Agenda dice cuánto de la agenda de cada profesional se ocupó y cuándo queda libre, mes a mes. Para eso necesita el horario que tenía cada profesional cada día.

`setProfessionalSchedule` borraba el horario y volvía a insertar el nuevo. Al cambiar un horario, los meses anteriores se recalculaban con el de hoy:

- Un profesional que dejó de atender los sábados aparecía «libre» todos los sábados del año pasado.
- Uno que sumó una tarde parecía haber tenido horas libres que nunca existieron.

La agenda y las reservas solo necesitan el horario vigente; nadie más leía el anterior.

## Decisión y motivo

- **Cambiar un horario cierra el anterior en vez de borrarlo.** `professional_schedule` lleva `valid_from` (el primer día en que vale, día de la sede) y `valid_until` (el día en que dejó de valer). La fila vigente es la activa y no tiene fin; la base lo exige (`professional_schedule_validity_check`).
- **El cambio vale desde hoy.** Lo que empezó hoy mismo se reemplaza: un día no tiene dos horarios. Guardar el mismo horario no deja otra versión.
- **La agenda, las reservas, el agente y Configuración siguen leyendo solo lo activo.** No cambian.
- **Reportes cuenta cada día con la versión que valía ese día** (`agendaMinutes`). Antes del primer horario guardado de un profesional usa el de hoy y la respuesta lo dice (`map.assumed`, `firstSchedule`), para que la pantalla lo avise. Lo que ya existía al migrar vale desde el día en que se guardó.

## Alternativas descartadas

- *Una tabla aparte con la historia:* dos lugares para el mismo horario y una copia que hay que mantener en cada guardado.
- *Elegir a mano desde qué día vale un cambio:* útil para cambios programados, pero agrega un control a una pantalla que hoy es simple y nadie lo pidió. Si se pide, `valid_from` ya lo admite.
- *Usar siempre el horario de hoy:* es lo que había; las cifras de meses anteriores mentían.

## Consecuencias

- La historia de la agenda es verdadera desde que se guarda; antes, la pantalla dice que usó el de hoy.
- Las filas cerradas se acumulan (una por turno y cambio): pocas, y solo las lee Reportes.
- Si se agrega un horario por unidad dental (ocupación por unidad, para después), seguirá la misma regla.

## Referencias

- `packages/services/src/availability.ts` (`setProfessionalSchedule`), `packages/services/src/report-agenda.ts` (`agendaMinutes`).
- Migraciones `0027_como_nos_conocio_compras_pagadas_y_horario_con_historia` y `0028_compras_pagadas_y_horario_con_historia_reglas`.
