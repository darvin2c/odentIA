# 0105 · Lo usado en la atención es un total: se ve al firmar, se corrige ahí y se le dice a Clío

Fecha: 2026-10-29 · Estado: aceptada · Precisa la 0067

## Problema

Los materiales de cada servicio se descontaban al firmar (ADR 0067), pero casi no se veía: «Atención finalizada» solo hablaba de materiales si el descuento fallaba, y al firmar con sugerencias de Clío ni siquiera aparecía el aviso previo. Un material suelto («usé una mascarilla») solo lo podían agregar el dueño o la administración, después de firmar. Y si se lo decían a Clío, el riesgo era contar dos veces lo que ya traen los servicios. El sistema no puede trabar el trabajo del día a día por nada de esto.

## Decisión y motivo

- **Lo que se dice o se escribe de un material es el total usado de ese producto en la atención, nunca algo que se suma.** Reemplaza lo que traen sus servicios: es la regla de «Fueron 4, no 2», así que no hay un concepto nuevo. Si los servicios ya lo traen, la tarjeta lo dice («La limpieza ya trae 2 guantes: vale el total, no se suma»).
- **«Atención finalizada» dice lo que salió y, aparte, lo que no había (queda como faltante), con «Corregir» ahí mismo.** Es la misma ventana con Clío y sin él. «Listo» nunca espera.
- **Quien atendió agrega otro producto en «Corregir»**, no solo inventario. El servidor lo ofrece (`canAddProducts`) solo si la clínica tiene productos que se usan en las atenciones: sin ellos no aparece un bloque vacío en cada atención.
- **Clío anota lo que se dice usado** (clase `material`, operación `atencion.material`). Se busca en Inventario por su nombre; lo que no está queda por revisar y descartarlo no frena nada. Confirmado, espera a la firma como el total de ese producto y sale de la sede con lo demás. Quitarlo por voz antes de firmar es dejar de contarlo.

## Alternativas descartadas

- *Una lista editable de materiales en la atención abierta:* otra tabla y otro bloque en una pantalla llena, para lo que ya cubren los materiales de cada servicio y «Corregir».
- *Sumar lo dicho a lo de los servicios:* «usé guantes» no dice si es además o en total; sumar cuenta doble.
- *Descontar al confirmar lo dictado:* la atención aún puede anularse; el descuento es al firmar (ADR 0067).
- *Darle al modelo la lista de Inventario:* más texto en cada pausa del dictado; el servicio ya busca por nombre.

## Consecuencias

- Una clase más de sugerencia, común a odentIA y latidIA (migración 0018).
- Lo dictado se mide con `eval:dictado` (caóticos) y `eval:dictado-medico`, con dictados de materiales y de lo que no lo es (una resina hecha, un medicamento recetado).
- Si las clínicas piden anotar materiales durante la atención sin Clío, se revisa la lista editable descartada.

## Referencias

- `packages/services/src/service-materials.ts` (`encounterMaterialPlan`, `materialsFromServices`, `canAddProducts`) y `encounter-dictation.ts` (`prepareMaterial`, `settleMaterial`).
- `packages/agent/src/dictation.ts` (`materialsPrompt`).
- `packages/clinic-app/src/components/patient/encounter-materials.tsx` (`FinalizedMaterialsNote`, `EncounterMaterialsCorrection`).
