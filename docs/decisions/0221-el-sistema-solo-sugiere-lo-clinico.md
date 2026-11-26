# 0221 · El sistema solo sugiere lo clínico

Fecha: 2026-11-26 · Estado: aceptada · Extiende la [0200](0200-avisar-no-decidir-por-el-profesional.md) (avisar, no decidir por el profesional) a todo lo clínico; revisa en parte la [0143](0143-en-la-receta-el-aviso-informa.md) (el peso en la receta de un niño)

## Problema

La 0200 quitó reglas que frenaban el cierre. Una revisión del código del 26 nov encontró otros lugares donde el sistema decidía lo clínico sin el profesional:

- **Fijaba un dato sin preguntar:**
  - la lesión quedaba tratada al firmar aunque el diagnóstico se desmarcara;
  - la fase pasaba sola a «Urgencia» al anotar un diagnóstico;
  - el examen físico sin estado quedaba «Sin alteraciones»;
  - «dos veces al día» se guardaba como «Cada 12 horas»;
  - «recomendada» salía en la opción que nadie recomendó;
  - un código fuera de la lista pasaba a su padre sin decirlo.
- **Frenaba por una regla clínica:**
  - el peso en la receta de un niño;
  - los topes de los signos vitales;
  - sondear una pieza que el odontograma corregido ya no tiene ausente.
- **Ordenaba el trabajo con su propio juicio:** bajaba a prioridad «baja» una consulta clínica que juzgaba no urgente.

El criterio del producto: el sistema no es médico ni odontólogo; lo máximo que puede hacer es sugerir.

## Decisión y motivo

- **Se guarda lo que se dijo.** Lo que el sistema deduce llega como propuesta o sugerencia visible, y el profesional la confirma, la cambia o la descarta. Ejemplos:
  - «para la presión» se guarda tal cual y sugiere hipertensión arterial;
  - lo que la madre dice de sí misma propone «Madre: diabetes»;
  - «no, la diabetes no» propone quitarla;
  - «a los dos años» propone la fecha por la edad;
  - sin decir presuntivo o definitivo, queda presuntivo.
- **Ninguna regla clínica frena.** Avisa y deja seguir, y queda la constancia de que se vio. Siguen frenando:
  - los permisos y la protección de datos;
  - lo que exige una norma citada, como la receta oficial de los controlados;
  - el mínimo de la nota clínica de la 0200.
- **Nada clínico cambia solo:**
  - lo que la firma dibuja en el odontograma se dice antes de firmar;
  - la fase sugerida se muestra en el tratamiento y no se mueve;
  - cambiar el servicio no cambia la fase.
- **La urgencia que estima el modelo solo sube la prioridad**, nunca la baja.
- **Los textos sugieren o avisan:** «Sugerencia: …», «Aviso: …», «Se dijo: …». No dicen «Debe…» ni «Contraindicado».

## Alternativas descartadas

- *Mantener los bloqueos como protección del paciente:* el profesional es quien responde por la atención. Un tope fijo impide registrar lo real (una glucosa de 650) o lo empuja a anotar otra cosa. El aviso protege igual y deja constancia.
- *Configurar por clínica qué regla frena:* suma opciones para reglas que no salen de un estándar (la 0200).

## Consecuencias

- Hay más propuestas por revisar, porque lo que antes se resolvía solo ahora espera un toque.
- Que Sofi no dé consejos clínicos sigue dependiendo de su instrucción. Se mide con los casos clínicos de su auditoría.
- Se revisa esta decisión si una norma exige un dato para emitir: entonces ese dato frena, citando la norma en el código.

## Referencias

- `packages/services/AGENTS.md` (dictado clínico y reglas clínicas)
- `packages/clinical/src/vitals.ts` (`readVitals`, `vitalsWarnings`)
- `packages/agent/src/decision/route.ts` (`routeHandoff`)
- `packages/services/src/dental/hooks.ts` (`resolveTreatedFindings`)
