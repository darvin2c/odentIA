# El motivo de la reserva se ofrece, no se firma solo

Fecha: 2026-11-04 · Estado: aceptada · Precisa [0032](0032-la-cita-registra-la-llegada-la-atencion-la-cierra.md) y [0098](0098-atender-sin-cita-tambien-en-un-clic.md)

## Problema

Al atender desde una cita, la atención copiaba como motivo de consulta lo que recepción escribió al reservar («Limpieza», «Control»). Ese motivo ya cumplía el requisito del cierre, así que se podía firmar como motivo del profesional algo que no escribió y que nada le pedía revisar. Y si después se dictaba el motivo real, lo dictado se sumaba debajo («Limpieza / Dolor en la muela…»): parecía que Clío lo había llenado mal. El motivo de consulta es la queja de la persona, y el de la reserva es para qué se agendó: no son lo mismo.

## Decisión y motivo

- **La atención nace sin motivo**, también desde una cita. El de la reserva se ofrece en la tarjeta «Consulta» («Se agendó como… · falta el motivo») y dentro del bloque, las dos con «Usar como motivo». Cuenta solo cuando quien atiende lo usa o escribe otro.
- **Lo dictado o escrito entra limpio**: como el campo sigue vacío hasta confirmarlo, no se suma al de la reserva. La regla de agregar sin reemplazar sigue para lo que el profesional ya escribió.
- El cierre sigue exigiendo el motivo (0003). Cuando el de la reserva sirve, es un toque más, en la misma tarjeta; a cambio, lo firmado es lo que el profesional confirmó.

## Alternativas descartadas

- *Seguir copiándolo*: firma lo que escribió otro y duplica el motivo al dictar.
- *Copiarlo y reemplazarlo al dictar*: lo dictado lo borraría sin aviso, y una atención que no se dicta seguiría firmando el de la reserva.
- *No mostrarlo*: se pierde lo que ya se sabía de la cita y hay que escribirlo de nuevo.

## Consecuencias

- Desde una cita, cerrar sin dictar pide un toque («Usar como motivo») o escribir el motivo.
- Sofi no guarda en la cita lo que la persona le contó al reservar: esas citas no traen nada que ofrecer. Llevarlo a la cita es otra decisión.
- Revisar con cuántas atenciones desde una cita se firma el motivo tal como se agendó: si casi todas, la salida sería confirmarlo con el mismo «Finalizar y firmar», mostrándolo en el cierre.

## Referencias

- `packages/services/src/encounters.ts`: `createEncounter` ya no copia el motivo; `getEncounterDetail` entrega `bookedReason`.
- `packages/clinic-app/src/components/patient/encounter-editor.tsx`: la sugerencia y la tarjeta.
