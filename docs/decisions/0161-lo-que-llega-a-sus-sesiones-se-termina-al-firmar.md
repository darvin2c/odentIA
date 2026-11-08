# 0161 · Lo que llega a sus sesiones previstas se termina al firmar

Fecha: 2026-11-08 · Estado: aceptada · Precisa la regla «Nada se termina solo» de las sesiones en la cita (PR 505)

## Problema

Desde el PR 505, al firmar, lo que con la atención de hoy llega a sus sesiones previstas pregunta «¿Terminaste?» con «Sí, terminar» y «Falta otra sesión», sin ninguna marcada, y sin respuesta quedaba en curso («Nada se termina solo»). La QA del 2026-11-08 (X1) firmó una resina de una sola sesión sin tocar la pregunta: hecha y cobrada, quedó «En curso», salió en «Por agendar», «Qué sigue» pidió la cita de la próxima sesión y no se dibujó en el odontograma firmado. Solo completar dibuja lo tratado (`setPlanItemStatus(…, "realizado", encounterId)`). La misma resina, si se aceptaba al hacerla, sí se cerraba sola: la regla se contradecía.

Lo normal, cuando se hicieron las sesiones previstas, es haber terminado. Pedir la respuesta obvia en cada firma carga al profesional justo cuando cierra, y la omisión deja un pendiente falso para recepción y Argos.

## Decisión y motivo

- **«Sí, terminar» viene elegido.** Lo que con hoy llega a sus sesiones previstas (o las pasa), incluida la de una sola sesión, pregunta «¿Terminaste?» con «Sí, terminar» marcado y «Falta otra sesión» a un toque. Debajo dice qué pasará al firmar. Siempre hay una de las dos elegida.
- **Firmar sin cambiarlo lo termina.** La regla vive en el servicio (`finalizeEncounter` → `applySessionAnswers`): lo de `closing.sessions.finishing` que no viene en `addSessionPlanItemIds` queda realizado en esa atención, antes de firmar el odontograma. Así también lo hace un cliente que no manda respuestas, como una pantalla vieja en caché. «Falta otra sesión» suma una sesión prevista y lo deja en curso, como antes.
- **Lo que viene elegido no frena la firma.** Si algo impide completarlo (por ejemplo, un presupuesto anulado), queda en curso y la firma sigue. Lo que se pide explícitamente (`completePlanItemIds`) sí falla con su motivo.
- **A mitad no cambia nada.** Lo que aún no llega a sus previstas («sesión 1 de 2») dice «Sigue en curso» y no pregunta. Terminarlo antes sigue siendo «Completar» en «Hecho hoy».
- **El cierre avisa lo que se firmará.** El odontograma que anuncia el cierre cuenta como hecho lo que la firma terminará.
- **Al firmar con lo dictado** se ve el mismo bloque. Si lo confirmado al firmar lleva un tratamiento a sus previstas que no se había mostrado, la firma se detiene en el cierre para mostrarlo, como ya hacía con los consentimientos.

Vale igual en odentIA y latidIA: las sesiones y el cierre son comunes. El odontograma solo existe en odentIA.

## Alternativas descartadas

- *Seguir sin marcar (la regla anterior):* deja lo hecho y cobrado como pendiente cuando nadie responde, que es lo habitual en la última firma del día.
- *No preguntar en los de una sola sesión:* quita la salida cuando las sesiones previstas quedaron en 1 por omisión y el tratamiento necesita otra.
- *Marcarlo solo en la pantalla, con el servicio exigiendo la respuesta:* el servicio y la pantalla dirían cosas distintas, y una pantalla vieja seguiría dejando todo abierto.
- *Pedir confirmación aparte antes de firmar:* otro paso en el recorrido más frecuente para confirmar lo obvio.

## Consecuencias

- Lo hecho deja de salir como pendiente y queda dibujado en el odontograma firmado sin un toque de más.
- Sacrificio: las sesiones previstas valen 1 si nadie las cambia. Una endodoncia indicada con 1 sesión se termina en la primera firma si no se elige «Falta otra sesión». Un tratamiento realizado no se reabre desde la atención firmada. Si esto pasa con frecuencia, conviene que el catálogo traiga las sesiones típicas de cada servicio, o una forma de reabrir que sume una sesión sin anular lo hecho.
- Lo que en producción quedó abierto con sus previstas cumplidas se terminará en su próxima firma, salvo que se elija «Falta otra sesión».

## Referencias

- `packages/services/src/encounters.ts` (`closingSessionsOf`, `applySessionAnswers`), `packages/services/src/dental/odontogram.ts` (`closingOdontogramOf`).
- `packages/clinic-app/src/components/patient/encounter-closing.tsx` (`ClosingSessions`), `encounter-editor.tsx`.
- Pruebas: `sessions-in-appointment.test.ts` (X1), `dental/odontogram-country.test.ts`, `e2e/sesiones-en-la-cita.spec.ts`.
