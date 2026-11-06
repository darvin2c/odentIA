# 0143 · En la receta, el aviso informa y la receta guarda lo que se vio

Fecha: 2026-11-06 · Estado: aceptada · Sustituye en parte a [0072](0072-alergias-de-una-lista-propia-quitar-sin-borrar.md) («Recetar igual pese al aviso pide un motivo escrito») y precisa [0012](0012-asistente-clinico-sugiere-y-el-odontologo-confirma.md) (la receta dictada con aviso)

## Problema

Con un aviso de alergia, o de algo contraindicado en el embarazo, recetar igual pedía marcar «lo vi» y escribir un motivo. Ese paso frenaba a quien receta, y lo que quedaba guardado era el motivo, no el aviso que vio. Además:
- la receta no mostraba lo que el paciente ya toma ni sus enfermedades;
- no avisaba si se recetaba algo del mismo principio activo o del mismo grupo que ya toma (en la ronda de QA del 2026-11-04, ibuprofeno a quien toma otro AINE);
- en latidIA, la medicación habitual elegida de su lista se guardaba sin código ATC.

## Decisión y motivo

El usuario lo decidió el 2026-11-05: «todo lo que mostramos es informativo; no podemos tomar decisiones por el médico» y «siempre alertamos».

- **La alergia y lo contraindicado en el embarazo se avisan y no piden nada.**
  - El aviso va junto al medicamento y en el bloque de avisos, y quien receta emite.
  - El motivo es opcional y, si se escribe, queda en la receta.
  - Los controlados siguen en su receta oficial y el peso de un niño sigue siendo obligatorio, porque lo pide la ley o la dosis, no una preferencia.
- **La receta guarda lo que se vio** (`prescription.alerts_seen`), con el nombre de quien la firmó.
  - La pantalla envía los avisos que mostró, tal cual (`alertsShown`). El servidor guarda como vistos los de alergia y embarazo, que exige haber mostrado, y los duplicados que la pantalla mostró.
  - Un aviso de alergia o embarazo que el servidor encuentra y la pantalla no mostró responde 409 para mostrarlo. Lo que no se mostró nunca se firma como visto.
  - Se guarda en palabras, como se leyó: la directiva del MINSA para historias clínicas electrónicas pide guardar el aviso y lo que respondió quien receta. La exportación FHIR (`DetectedIssue`) queda para cuando se exporte la receta.
- **Lo que ya toma, a la vista.** Arriba del formulario, su medicación vigente (sin fecha de fin o con una que aún no pasa) y sus enfermedades activas.
- **El duplicado por ATC solo informa** (`duplicateWarnings`, en `@odentia/clinical`, la misma regla para la pantalla, el dictado y el servidor):
  - avisa el mismo principio activo (el mismo ATC), el mismo grupo con nombre (por ejemplo, los AINE) o, fuera de ellos, el mismo subgrupo químico, salvo los subgrupos «X»;
  - también avisa el mismo medicamento dos veces en la receta;
  - no frena.
- **La medicación habitual lleva el ATC de la lista del producto.** Lo guardado antes sin código se resuelve al recetar.

## Alternativas descartadas

- *Mantener el motivo obligatorio:* deja constancia, pero frena y decide por el profesional cuándo hace falta explicar.
- *Una lista de reglas de interacciones:* necesita un responsable clínico de cada regla y una base con licencia. El usuario la dejó para después.
- *Guardar todo lo que calcula el servidor como «visto»:* firmaría como visto un aviso que la pantalla nunca mostró.

## Consecuencias

- Recetar con un aviso cuesta lo mismo que sin él, y la receta dice qué se vio y quién lo vio.
- Una pantalla con datos viejos (otra sesión agregó una alergia) recibe 409, vuelve a leer y muestra el aviso.
- Las recetas de antes conservan su motivo y siguen diciendo «Recetada pese al aviso».

## Referencias

- `packages/services/src/prescriptions.ts` (`createPrescription`, `currentMedicationsOf`), `packages/clinical/src/allergens.ts` (`duplicateWarnings`), `packages/services/src/encounter-dictation.ts`, `packages/clinic-app/src/components/patient/clinical-panels.tsx` y `prescription-alerts.tsx`.
- `packages/db/drizzle/0049_avisos_de_la_receta.sql`.
