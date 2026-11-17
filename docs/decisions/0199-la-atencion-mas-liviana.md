# 0199 · La atención más liviana: lo de antes arriba, lo repetido fuera y el paciente a la vista

Fecha: 2026-11-16 · Estado: aceptada · Revisa, de ADR 0165, que lo indicado hoy salga en «Hoy viene a…» con «Hacerla hoy»; y, de ADR 0117 (cambio del 13 nov, punto 2), que la ficha odontoestomatológica se ofrezca en cada atención

## Problema

El estudio de la atención (16 nov) la recorrió con cinco voces y diez casos. Funciona, pero pesa: una primera consulta mide unos 3 500 px a 1440, con unas 20 frases grises que explican reglas aunque el bloque ya tenga algo, tarjetas enteras para decir que no hay nada y lo que falta para firmar dicho en tres lugares (y el pie callaba la firma de la paciente cuando faltaba la colegiatura). «Hoy viene a…» repetía lo que se acababa de indicar. La ficha odontoestomatológica se ofrecía en cada sesión y en la urgencia. Con una pieza abierta al lado, abrir «Anotar su respuesta» o el dictado la hacía saltar encima como ventana. Pasada la cabecera, el nombre y las alergias quedaban 2 474 px arriba mientras se escribía la evolución o se recetaba.

## Decisión y motivo

- **Las frases de regla, solo con el bloque vacío** (estándar E2, para toda la app; regla en `ui-patterns/AGENTS.md`). Con contenido, el título solo; la regla pasa a la Ayuda o a un ejemplo dentro del campo. Sin tarjeta para decir que no hay nada («Hoy viene a…» vacía, fichas sin ofrecer). Los avisos clínicos y legales no son frases de regla y no se ocultan nunca.
- **El pie fijo es el único lugar de lo que falta para firmar**, y lo dice entero: lo que pide el cierre, la colegiatura y las firmas que esperan («Faltan 2: tu colegiatura y la firma de Carmen»). El cierre de la página no lo repite; el diálogo de firmar pone primero lo que se decide.
- **«Hoy viene a…» lleva solo lo que viene de antes**, en todos los productos (`encounterVisitOf`): lo indicado en esta misma atención no es «a qué viene». Su «Hacerla hoy» pasa a la fila del Plan de lo indicado y aceptado hoy, con la misma operación (`bringTreatmentToEncounter`), para que el consentimiento siga pidiéndose antes del acto; nunca en lo que «va después» de otro. «Registrar lo de hoy» avisa «Pide el consentimiento «…»: Preparar y firmar» antes de registrar, sin frenar (Ley 29414: el consentimiento es previo).
- **La ficha que el producto llena una vez por plan** (`ProductForms.oncePerPlan`; odentIA: la odontoestomatológica) se ofrece mientras el plan de ahora no tenga una finalizada, nunca en una urgencia (el motivo empieza con «Urgencia»), y otra vez cuando el paciente regresa con un plan nuevo. Las demás se ofrecen como siempre: el control de ortodoncia se repite.
- **Lo que una página pone al lado de sí misma nunca pasa a ventana porque se abrió otra cosa** (regla 5 de `side-dock`, `useStaysBeside`): se cierra y queda marcado; con algo escrito, pregunta como un borrador. Mientras se atiende, el menú lateral va en íconos sin pisar la preferencia guardada (`holdCollapsed`).
- **Pocas opciones cortas, en pastillas** (`RadioChips`, seis o menos): la sigla en la pastilla y el nombre entero debajo de la elegida.
- **El paciente siempre a la vista**: al pasar la cabecera, una línea fija con el nombre, la edad, las alertas por riesgo, «Guardado» y «Dictar», gemela del pie; la página reserva su alto (`scroll-padding-top`, WCAG 2.4.11).

## Alternativas descartadas

- *Quitar «Hacerla hoy» de lo indicado hoy sin llevarlo al Plan:* el consentimiento de lo indicado y hecho en la misma consulta se pediría después de hacerlo.
- *Ofrecer la odontoestomatológica solo en la primera atención:* si la primera es una urgencia, no se ofrecería nunca; y la norma pide volver a evaluar al reingreso.
- *Una columna «una vez / se repite» en la plantilla:* pedía migración para una sola ficha; lo declara el producto, que es quien la trae.
- *Dejar que la pieza pase a cajón al estrecharse, como antes:* es el cambio de contexto que nadie pidió (WCAG 3.2.2).

## Consecuencias

- Menos texto y menos alto a la vista; lo que se quitó de la página sigue respondido en la Ayuda.
- Sacrificio: la regla se lee en la Ayuda, no al lado del bloque con contenido; quien no la conozca la busca ahí.
- Lo que queda fuera: «Riesgo y alta» de la ficha al terminar el plan (pide decidir cuándo termina un plan dentro de la atención y ofrecer solo una sección de una ficha); y el cobro por sesión en la fila de lo hecho, que la fila ya no muestra para lo del plan.
- Se revisaría si las clínicas piden ver la regla junto a cada bloque, o si una urgencia se marca de otra forma que el motivo.

## Referencias

- Lienzo del estudio de la atención (tableros P09 a P12 y Estándares) y actas del 16 nov.
- `packages/ui-patterns/src/side-dock.tsx`, `app-shell.tsx`, `packages/ui/src/components/sidebar.tsx`.
- `packages/services/src/encounter-visit.ts`, `consultation-forms.ts`, `dental/forms.ts`, `encounters.ts` (`doneLines`).
- `packages/clinic-app/src/components/patient/encounter-editor.tsx`, `encounter-plan-panel.tsx`, `encounter-procedures.tsx`, `encounter-closing.tsx`, `encounter-visit.tsx`.
- Pruebas: `side-dock.test.tsx`, `encounter-visit.test.ts`, `consultation-forms.test.ts`, `ficha-toma-la-pieza.test.ts`.
