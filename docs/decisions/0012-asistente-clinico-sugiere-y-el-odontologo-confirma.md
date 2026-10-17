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
- **Al firmar, lo no confirmado no entra**: la pantalla nombra las sugerencias que quedan (qué es, de qué bloque y qué le falta) y firmar las descarta. Mientras se dicta o se ordena no se puede firmar.
- **Las sugerencias se arman mientras se dicta y viven en su bloque** (Consulta, Diagnóstico, Plan, Controles), no en un panel aparte. Cada pausa de unos segundos, y al pausar o terminar, envía a ordenar solo el tramo nuevo: una llamada al modelo por pausa, nunca por palabra. El tramo lleva su identidad, de modo que reintentarlo no duplica sugerencias.
- **Corregir hablando**: con el tramo viajan lo último ya ordenado y las sugerencias de ese dictado que siguen sin decidir, numeradas y sin tarifas. El asistente puede cambiar una («no, es la veintiséis») o quitarla («quita la endodoncia»); el servicio lo valida como cualquier edición, solo sobre sugerencias pendientes, y guarda cómo estaba para poder deshacerlo.
- **Se guarda lo mínimo**: de cada sugerencia, la frase que la originó, y solo si está tal cual en lo dictado; el dictado completo no se conserva en el servidor. «Lo dictado» que ve el odontólogo como respaldo vive en la pantalla y se pierde al salir de ella. La auditoría cuenta sugerencias, correcciones y descartes, sin texto clínico.
- **Apagado por defecto**, por clínica. Se puede probar con un dictado de práctica que no toca ninguna atención.
- **Voz**: el reconocimiento es el del navegador cuando lo tiene; el micrófono solo se enciende con «Dictar» o «Reanudar» y se apaga al pausar, terminar o salir. El dictado siempre se puede escribir o pegar, y eso se ordena en una sola llamada.

## Alternativas descartadas

- *Escribir directo en el borrador de la atención*: rápido, pero un error pasa inadvertido entre texto que parece ya revisado.
- *Que el modelo elija la prestación y su precio*: el tarifario es de la clínica; adivinar un servicio parecido cambia lo que se cobra.
- *Transcribir en el servidor con un servicio de audio*: mejor reconocimiento, pero el audio de una consulta saldría de la clínica y exige otro proveedor y otro consentimiento. Queda para cuando se decida grabar la consulta.
- *Guardar el dictado completo como respaldo*: duplica información clínica fuera de la historia sin que nadie la firme.
- *Reenviar todo el dictado en cada pausa y reemplazar las sugerencias*: las correcciones se entienden solas, pero las sugerencias cambian de identidad en cada llamada, lo ya confirmado o descartado reaparece y el costo crece con la duración.
- *Columnas nuevas para el tramo y el valor anterior de una corrección*: es lo limpio, pero exige una migración; por ahora van como metadatos dentro del `payload` de la sugerencia.

## Consecuencias

- Beneficio: el odontólogo dicta, revisa y firma; nada entra sin su confirmación y cada registro pasó por las mismas reglas que uno escrito.
- Sacrificio: revisar sugerencias toma un momento, y el reconocimiento de voz depende del navegador (en los que no lo tienen se escribe o se pega el texto).
- El texto dictado viaja al proveedor del modelo configurado por la clínica. Es información de salud: queda como nota legal pendiente revisar el encargo de tratamiento con ese proveedor antes de usarlo con pacientes reales.
- Costo: un dictado hablado hace una llamada al modelo por cada pausa de unos 2,5 segundos con algo nuevo que ordenar, más una al pausar o terminar si quedó algo. Cada una lleva una parte fija (el esquema, las instrucciones y los nombres de los servicios) y lo de la pausa (la fecha, hasta 600 caracteres de contexto, las sugerencias pendientes y el tramo). Antes era una sola llamada por dictado.
- Caché: la parte fija es igual en toda la atención y va marcada para la caché del proveedor (`cache_control` en Claude; corte explícito con `prompt_cache_options` en ChatGPT 6). La primera pausa la escribe a 1,25× de la entrada y las siguientes la leen a 0,1×. Con la hora en las instrucciones, cada pausa la escribía y no la leía nunca: medido el 2026-10-17 con ChatGPT 6, seis pausas pasaron de USD 0,0019 a 0,0007. Si pasan más de 5 minutos entre pausas (30 en ChatGPT 6), la caché vence y esa pausa la escribe de nuevo.
- Un tramo que termina a mitad de una idea puede dejar una sugerencia incompleta («por revisar»); el contexto y las sugerencias pendientes lo reducen, no lo eliminan.
- No construido todavía: odontograma por voz, recetas y vocabulario propio de cada odontólogo. La pantalla no sabe a qué bloque irá lo que aún se está oyendo: lo muestra en la barra del dictado, no dentro de un bloque. Las rutas de plan y de controles aún declaran sus campos por separado de la declaración que usa el asistente.
- La calidad con que un modelo real entiende un dictado, sus correcciones por voz y la cita literal de cada fragmento no está medida: el modo de demostración reconoce unas pocas frases por reglas.

## Referencias

- `packages/services/src/encounter-dictation.ts`, `packages/agent/src/dictation.ts`, `apps/api/src/routes/encounter-dictation.ts`, `apps/platform/src/components/patient/dictation-*.ts(x)`, operaciones `atencion.nota`, `atencion.diagnostico`, `plan.indicacion` y `control.crear`, migración `0054`.
