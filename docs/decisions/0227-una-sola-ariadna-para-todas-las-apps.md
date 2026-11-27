# 0227 · Una sola Ariadna y una sola Ayuda para todas las apps

Fecha: 2026-11-27 · Estado: aceptada · Lienzo «Ariadna en gestorIA» (tableros 7 y 8) · Precisa la 0146, la 0178 y la 0211

## Problema

Ariadna responde en la Ayuda de las clínicas, pero el panel (`packages/clinic-app/src/components/help-panel.tsx`) y quien decide la respuesta (`decideHelp`, en la administración) solo servían a las clínicas. gestorIA no puede importar nada de ellas (ADR 0203) y tenía su propia página de Ayuda, distinta, sin nadie a quien preguntarle con sus palabras. Copiar el panel y el motor en gestorIA dejaría dos Arianas que mantener, medir y pagar, y dos Ayudas que se separan con cada cambio.

## Decisión y motivo

- **El panel de la Ayuda es uno solo y vive en lo común** (`HelpButton` de `shared/packages/ui-patterns/src/help/`): el botón de la cabecera, la conversación, las sugerencias de la pantalla, «Lo que se envía» y el pie con soporte. Cada app pone solo lo suyo: su nombre, a quiénes atiende, su servidor, sus casos con soporte, quién da acceso y el agente de sus cifras. Cambiar la Ayuda ahí la cambia en todas las apps, en el mismo cambio.
- **Se arma con AI Elements** (`Message`, `PromptInput`, `Suggestion`, `Shimmer`, `Sources`), adaptados en `shared/packages/ui/src/components/ai-elements/`. No se usa `Conversation`: se pega al final de la respuesta y la Ayuda lleva al principio de la última pregunta, para que una respuesta larga se lea desde arriba.
- **Ariadna es una sola, la de la administración.** Una app que es otro sistema le pregunta por el acuerdo (`POST /api/contract/help`, firmado) y manda su guía con cada pregunta: siempre la vigente, sin copiarla en la administración. Ariadna decide igual que para las clínicas (`answerAppHelp` sobre `decideHelp`, con los mismos textos a Jev) y devuelve solo ids de la guía; la app arma la respuesta con sus permisos.
- **Lo paga odentIA**, con el origen `ayuda`, por app (`admin.app_ai_usage`), y se ve en «Costo y margen» como lo que regalamos. Cada pregunta deja una fila sin el texto (`admin.app_help_ask`), como en las clínicas.

## Alternativas descartadas

- **Copiar el motor en `shared/` y que cada app llame a Jev por su cuenta:** gestorIA no dependería de la administración para responder, pero serían dos Arianas, dos claves de Jev y dos mediciones.
- **Guardar la guía de cada app en la administración:** evita mandarla en cada pregunta (unos 20 KB), pero suma una tabla, un aviso más del acuerdo y el riesgo de responder con una guía vieja.
- **Rehacer el panel en gestorIA:** dos Ayudas que se separan con cada cambio.

## Consecuencias

- **Beneficio:** una mejora a la Ayuda o a Ariadna llega a todas las apps; una app nueva solo pone su guía, su servidor y su color.
- **Sacrificio:** un cambio en el panel corre las pruebas de todas las clínicas. Si la administración no responde, la Ayuda de gestorIA no puede buscar con Jev: la app responde lo que reconozca por sus palabras y deja escribir a soporte. El tope diario de las apps (5000 preguntas por app) es para frenar errores, no para medir.
- **Cuándo revisarlo:** si una guía pasa de los 512 KB del acuerdo, o si Kairós necesita leer la guía de una app sin que la app pregunte.

## Referencias

`shared/packages/ui-patterns/src/help/`, `shared/packages/ui/src/components/ai-elements/`, `packages/clinic-app/src/components/help-panel.tsx`, `shared/packages/contract/src/messages.ts` (`helpAskQuestion`), `packages/services/src/app-help.ts`, `apps/api/src/routes/app-contract.ts`, `packages/services/src/saas-cost.ts`. ADR 0146, 0178, 0203, 0211 y 0218.
