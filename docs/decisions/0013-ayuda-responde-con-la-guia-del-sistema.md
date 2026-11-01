# 0013 · La Ayuda responde con la guía del sistema, atada a las pantallas

Fecha: 2026-10-11, revisada el 2026-11-01 · Estado: aceptada

## Problema

El equipo de una clínica necesita saber dónde se configura algo, dónde se ve y si se puede hacer con el sistema, sin leer un manual ni escribir a soporte. Una ayuda que responde con un modelo de lenguaje sobre documentación suelta tiene dos fallos conocidos: inventa pantallas y opciones que no existen, y sigue describiendo lo que ya cambió. Además su coste lo paga quien la ofrece, en cada pregunta, y el usuario final quiere algo simple.

## Decisión y motivo

- **Se llama Ariadna (2026-11-01), la del hilo del laberinto: lleva hasta donde está cada cosa.** El botón sigue diciendo «Ayuda», porque dice para qué sirve; cuando el texto habla de quien responde, dice Ariadna. El nombre no cambia cómo responde.
- **Ayuda es un agente aparte, de odentIA, para todo el equipo.** No se enciende, no usa la voz de la clínica y la clínica no le sube ni le enseña nada. No es el Asesor: el Asesor mira los datos de la clínica y habla primero; la Ayuda conoce el sistema y responde cuando le preguntan.
- **Responde con una guía escrita, un tema por pantalla** (`HELP_TOPICS`): la ruta, el nombre con que el sistema la llama, para qué sirve y con qué palabras la busca la gente. La respuesta es el texto del tema o de una de sus preguntas frecuentes, con «Llévame».
- **La guía se comprueba contra el código.** `help-guide.test.ts` compara cada tema con las rutas reales de la aplicación y con los menús, exige un tema por cada pantalla, con el mismo nombre del menú, y que cada «nombre» citado exista en las pantallas. El CI la corre en todo PR, aunque el cambio no toque servicios: esa prueba se perdió una vez al mover la aplicación y la guía se quedó atrás sin que nadie lo notara.
- **El tema lo eligen las palabras de la pregunta**, sin modelo. Es gratis, se puede probar con un banco de preguntas (`help-preguntas.json`, escritas sin ver la guía) y no inventa: si nada coincide lo bastante, dice que no está en la guía. Palabras completas, nunca una dentro de otra; cada una pesa según cuántas pantallas señala y dónde aparece en el tema. Responde una sola pantalla.
- **«¿Por qué no puedo?» mira el estado real de lo que preguntó** (si no nombró nada, de la pantalla donde está): comprobaciones concretas de lo que la clínica tiene configurado (unidades dentales, horarios, canales, servicios, agentes apagados) y de lo que el rol de quien pregunta puede hacer, con quién sí puede.
- **Respeta los permisos sin decidirlos.** Lee la matriz canónica: si el rol no entra a una pantalla, lo dice y no ofrece llevarlo.
- **No cambia nada y no lee datos de pacientes**, conversaciones ni montos.
- **De lo que se pregunta no se guarda el texto**: solo la pantalla, el tema que respondió y si sirvió. Soporte lo ve contado por pantalla y por tema en la administración. Cuando no sabe, o la respuesta no sirvió, la persona decide enviarlo a odentIA; ahí sí va su texto, con la pantalla, su rol y la versión.
- **Cada envío es un caso privado de su clínica.** Las preguntas iguales se agrupan solo para preparar respuestas comunes, sin mezclar hilos.
- **Tope diario por persona** (200 preguntas), para proteger el servicio.

## Alternativas descartadas

- *Un modelo que responde sobre la documentación (RAG)*: redacta con soltura, pero inventa y cuesta por pregunta; con decenas de temas cortos no aporta nada que la coincidencia por palabras no dé.
- *La misma pantalla del Asesor o del agente de Recepción*: otro público, otros permisos y otra fuente; mezclarlos confunde qué mira cada uno.
- *Generar la guía entera del código*: el código sabe la ruta y el nombre, no para qué sirve una pantalla ni cómo la busca la gente. Se genera lo que se puede comprobar y se escribe lo mínimo.
- *Abrir un caso automáticamente cuando no sabe*: enviaría texto del equipo sin que lo decida; lo envía la persona, con un toque.

## Consecuencias

- Beneficio: responde sin que la clínica configure nada, sin coste por uso y sin poder nombrar una pantalla que no existe.
- Sacrificio: solo sabe lo que está en la guía y lo dice con el texto del tema; no conversa y falla con frases muy alejadas de sus palabras. Lo que no supo responder es la lista de trabajo para mejorarla.
- No construido todavía: el modelo de decisión eligiendo el tema cuando las palabras no alcanzan (se probaría contra `help-preguntas.json`; no se hizo porque hay que medirlo con el proveedor real), «¿por qué?» junto a cada botón bloqueado, y guiar paso a paso.
- Revisar cuando el registro muestre muchas preguntas sin tema: añadir palabras o temas antes que un modelo.

## Referencias

- `packages/services/src/help-guide.ts`, `packages/services/src/help.ts`, `packages/services/src/help-guide.test.ts` (guía contra el código y banco de preguntas), `apps/api/src/routes/help.ts`, `packages/clinic-app/src/components/help-panel.tsx`.
