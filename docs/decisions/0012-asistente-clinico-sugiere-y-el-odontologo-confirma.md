# 0012 · El asistente clínico sugiere; solo la confirmación del odontólogo escribe en la historia

Fecha: 2026-10-11 · Estado: aceptada

## Problema

El odontólogo registra la atención con las manos ocupadas o después, de memoria. Dictarla ahorra ese trabajo, pero la historia clínica es un documento con valor legal que firma un profesional: nada puede entrar en ella porque un modelo lo entendió así. Un diagnóstico mal oído, una pieza cambiada o una prestación con otro precio son errores clínicos y económicos.

## Decisión y motivo

- **El dictado produce sugerencias, no registros.** Cada sugerencia es el borrador de una operación de la atención (nota, diagnóstico, indicación del plan o control) y vive fuera de la historia hasta que se decide.
- **Confirmar es lo único que escribe, y lo hace con la operación de siempre**: la misma función de servicio, con sus validaciones, su permiso y su auditoría, que cuando el odontólogo lo escribe a mano. Si la operación rechaza el dato, la sugerencia sigue ahí para corregirla.
- **Solo quien lleva la atención en borrador** puede dictar en ella, confirmar o descartar. El asistente nunca firma ni cierra.
- **Lo que una persona debe elegir, lo elige una persona.** La prestación se busca en el tarifario por su nombre; si no hay una sola coincidencia, la sugerencia queda «por revisar» con las candidatas. Un código que no está en el catálogo CIE-10 o una pieza que no existe, igual. El precio nunca se dicta: sale del tarifario.
- **El esquema que llena el asistente sale de la declaración de campos** de cada operación (0008). Un campo nuevo declarado en la nota o en el diagnóstico aparece en el dictado sin tocar al asistente.
- **Al firmar, lo no confirmado no entra**: la pantalla avisa cuántas sugerencias quedan y firmar las descarta.
- **Se guarda lo mínimo**: de cada sugerencia, la frase que la originó; el dictado completo no se conserva. La auditoría cuenta sugerencias, sin texto clínico.
- **Apagado por defecto**, por clínica. Se puede probar con un dictado de práctica que no toca ninguna atención.
- **Voz**: el reconocimiento es el del navegador cuando lo tiene; el texto siempre se puede escribir o corregir antes de ordenarlo.

## Alternativas descartadas

- *Escribir directo en el borrador de la atención*: rápido, pero un error pasa inadvertido entre texto que parece ya revisado.
- *Que el modelo elija la prestación y su precio*: el tarifario es de la clínica; adivinar un servicio parecido cambia lo que se cobra.
- *Transcribir en el servidor con un servicio de audio*: mejor reconocimiento, pero el audio de una consulta saldría de la clínica y exige otro proveedor y otro consentimiento. Queda para cuando se decida grabar la consulta.
- *Guardar el dictado completo como respaldo*: duplica información clínica fuera de la historia sin que nadie la firme.

## Consecuencias

- Beneficio: el odontólogo dicta, revisa y firma; nada entra sin su confirmación y cada registro pasó por las mismas reglas que uno escrito.
- Sacrificio: revisar sugerencias toma un momento, y el reconocimiento de voz depende del navegador (en los que no lo tienen se escribe o se pega el texto).
- El texto dictado viaja al proveedor del modelo configurado por la clínica. Es información de salud: queda como nota legal pendiente revisar el encargo de tratamiento con ese proveedor antes de usarlo con pacientes reales.
- No construido todavía: odontograma por voz, recetas, vocabulario propio de cada odontólogo y sugerencias mientras se dicta. Las rutas de plan y de controles aún declaran sus campos por separado de la declaración que usa el asistente.
- La calidad con que un modelo real entiende un dictado no está medida: el modo de demostración reconoce unas pocas frases por reglas.

## Referencias

- `packages/services/src/encounter-dictation.ts`, `packages/agent/src/dictation.ts`, `apps/api/src/routes/encounter-dictation.ts`, `apps/platform/src/components/patient/dictation-panel.tsx`, operaciones `atencion.nota`, `atencion.diagnostico`, `plan.indicacion` y `control.crear`, migración `0054`.
