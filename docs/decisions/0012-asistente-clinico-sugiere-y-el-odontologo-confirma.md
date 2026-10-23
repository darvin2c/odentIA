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
- **Una parte que no cabe no bota la pausa.** El esquema le pide al modelo lo que el servicio guarda (hasta 40 sugerencias por tramo y 600 caracteres de cita), pero la respuesta se lee parte por parte: la cita más larga vale si se dijo, un registro con un dato que no encaja llega y queda «por revisar», y lo que no se puede usar se cuenta para avisar. Con el esquema estricto, ChatGPT 6 copiaba el tramo largo entero en la cita de la nota y un odontograma inicial pasaba de 10 diagnósticos: se perdía la pausa entera. Medido el 2026-10-17 con las mismas respuestas de ChatGPT 6: antes se perdían 11 de 24 pausas largas y las 10 densas; leídas por partes, ninguna. El esquema es igual en todas las pausas, así que la caché se sigue leyendo.
- **Corregir y quitar por voz se creen menos**, porque cambian lo que ya estaba: un «quita» sin la frase dicha que lo pide no se aplica, y más de 10 correcciones o «quita» en una pausa no se aplican (quedan pendientes y se cuentan). En la misma medición, las cuatro veces que llegaron más de 10 «quita» (20, 20, 30 y 40; los 40, de Claude en una pausa de charla y sin cita) eran sugerencias que nadie pidió quitar. Con una guía de 40 correcciones, ChatGPT 6 corrigió las 40 pendientes de un odontograma; la guía es de 10.
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
- Caché: la parte fija es igual en toda la atención y va marcada para la caché del proveedor (`cache_control` en Claude; corte explícito con `prompt_cache_options` en ChatGPT 6). La primera pausa la escribe a 1,25× de la entrada y las siguientes la leen a 0,1×. Con la hora en las instrucciones nada se reutilizaba: ChatGPT 6 escribía la caché en cada pausa sin leerla nunca y Claude 5.5 no la usaba. Medido el 2026-10-17, seis pausas: ChatGPT 6 pasó de USD 0,0019 a 0,0007 y Claude 5.5, de 0,0036 a 0,0019. Si pasan más de 5 minutos entre pausas (30 en ChatGPT 6), la caché vence y esa pausa la escribe de nuevo.
- Un tramo que termina a mitad de una idea puede dejar una sugerencia incompleta («por revisar»); el contexto y las sugerencias pendientes lo reducen, no lo eliminan.
- No construido todavía: recetas, consentimientos, presupuesto con opciones, preguntas sobre la historia y vocabulario propio de cada odontólogo. La pantalla no sabe a qué bloque irá lo que aún se está oyendo: lo muestra en la barra del dictado, no dentro de un bloque. Las rutas de plan y de controles aún declaran sus campos por separado de la declaración que usa el asistente.

## Actualización del 2026-10-23: nada se pierde sin aviso y el odontograma se dicta (issues 135 y 109)

Una prueba con ChatGPT 6 en la pantalla real perdió, sin aviso, «la 36 con caries oclusal, la 46 ausente y la 11 con corona»: el asistente no tenía dónde poner un hallazgo de una pieza y el servidor respondió «0 partes sin usar». Lo que más se perdía no era un error, sino lo que no tenía dónde ir.

- **Odontograma por voz.** Un hallazgo de una pieza (caries, ausente, corona, restauración, fractura…) es una sugerencia del bloque Odontograma, operación `odontograma.hallazgo`, que al confirmarse usa `registerToothFinding`, la misma del panel de la pieza: el hallazgo y, si la lista de la clínica le da uno, su diagnóstico presuntivo de la atención, en una sola sugerencia y no dos. Se valida con la norma del país (`validateFinding`): lo que la norma exige y no se dijo (la profundidad de una caries en Perú, el estado de una corona) queda por revisar y se elige con un toque o diciéndolo, como una corrección. Solo se dictan los hallazgos de una pieza que no piden marcar que se observó (implante, endodoncia, espigo, impactación) ni un dato que la voz no da bien (grado de movilidad, sentido del giro, posiciones): esos siguen tocando la pieza. La lista va en la parte fija del prompt (no cambia por clínica) y el mismo hallazgo pendiente no se guarda dos veces, porque el modelo a veces corrige una sugerencia y además la vuelve a registrar.
- **Lo que no se pudo usar se dice con su frase.** La respuesta de cada pausa trae, además de `omitted`, la frase que lo pidió (`unused`), solo si está tal cual en lo dictado; la pantalla la muestra hasta «Entendido» y la subraya en «Lo dictado». Cada registro cita solo su frase, no todo el tramo. No se promete un aviso para lo que el modelo calla: eso se ataca dándole dónde ponerlo y midiéndolo.
- **Una pausa que falla no frena las siguientes.** Se reintenta una vez sola (si el fallo es del proveedor) y, si vuelve a fallar, queda aparte con «Reintentar» y «Descartar esta parte»; lo dictado después se sigue ordenando. Al reintentar viaja con su contexto de entonces.
- **Un «quita» por voz se deshace** (opción B del issue 135): la sugerencia sale de lo pendiente pero queda a la vista, tachada en su bloque con lo que se dijo, y «Deshacer» la devuelve como estaba hasta firmar. Se descartó dejarla «por revisar» (opción A): cuando el asistente entendió bien, costaba un toque cada vez.
- **Medido el 2026-10-23** con `eval:dictado` (20 dictados de práctica, `eval/dictado-practica.json`), ChatGPT 6, tres corridas: 26 de 26 hallazgos con su pieza, 14 de 14 variantes y estados dichos, 25 de 25 diagnósticos, indicaciones, controles, notas, correcciones y «quita», y ningún hallazgo inventado; unos USD 0,00011–0,00013 por pausa con la caché leída. Antes de dos reglas del prompt, el modelo corregía otra sugerencia cuando se nombraba una que no existe («la tercera» sin tercera) y cambiaba «movilidad», que no se dicta, por «pieza extruida». Es evidencia de ese conjunto, no de cómo oye un navegador real.

## Referencias

- `packages/services/src/dental/encounter-dictation.ts`, `packages/agent/src/dental/dictation.ts` y `eval-dictado.ts`, `apps/api/src/routes/encounter-dictation.ts`, `apps/dental-clinic/src/components/patient/dictation-*.ts(x)`, operaciones `atencion.nota`, `atencion.diagnostico`, `plan.indicacion`, `control.crear` y `odontograma.hallazgo`, migraciones `0054` y `0085`.
