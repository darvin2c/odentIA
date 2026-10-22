# 0013 · La Ayuda responde con la guía del sistema, atada a las pantallas

Fecha: 2026-10-11 · Estado: aceptada

## Problema

El equipo de una clínica necesita saber dónde se configura algo, dónde se ve y si se puede hacer con el sistema, sin leer un manual ni escribir a soporte. Una ayuda que responde con un modelo de lenguaje sobre documentación suelta tiene dos fallos conocidos: inventa pantallas y opciones que no existen, y sigue describiendo lo que ya cambió. Además su coste lo paga quien la ofrece, en cada pregunta, y el usuario final quiere algo simple.

## Decisión y motivo

- **Ayuda es un agente aparte, de odentIA, para todo el equipo.** No se enciende, no usa la voz de la clínica y la clínica no le sube ni le enseña nada. No es el Asesor: el Asesor mira los datos de la clínica y habla primero; la Ayuda conoce el sistema y responde cuando le preguntan.
- **Responde con una guía escrita, un tema por pantalla** (`HELP_TOPICS`): la ruta, el nombre con que el sistema la llama, para qué sirve y con qué palabras la busca la gente. La respuesta es el texto del tema o de una de sus preguntas frecuentes, con «Llévame».
- **La guía se comprueba contra el código.** Una prueba compara cada tema con las rutas reales de la aplicación y con los menús, y exige un tema por cada pantalla del menú y de Configuración, con el mismo nombre. Un tema que nombra algo que ya no existe, o una pantalla nueva sin tema, hace fallar la prueba: ese cambio no se publica.
- **El tema lo eligen las palabras de la pregunta**, sin modelo. Es gratis, se puede probar con un banco de preguntas y no inventa: si nada coincide lo bastante, dice que no está en la guía.
- **«¿Por qué no puedo?» mira el estado real**: comprobaciones concretas de lo que la clínica tiene configurado (unidades dentales, horarios, canales, servicios, agente apagado) y de lo que el rol de quien pregunta puede hacer, con quién sí puede.
- **Respeta los permisos sin decidirlos.** Lee la matriz canónica: si el rol no entra a una pantalla, lo dice y no ofrece llevarlo.
- **No cambia nada y no lee datos de pacientes**, conversaciones ni montos.
- **De lo que se pregunta no se guarda el texto**: solo la pantalla, el tema que respondió y si sirvió. Cuando no sabe o algo falla, la persona decide enviarlo a odentIA; ahí sí va su texto, con la pantalla, su rol y la versión.
- **Las preguntas iguales de distintas clínicas son un solo caso** para el equipo de odentIA, con contador; responderlo le llega a todas las personas que lo enviaron, en el mismo botón de Ayuda.
- **Tope diario por persona** (200 preguntas), para proteger el servicio.

## Alternativas descartadas

- *Un modelo que responde sobre la documentación (RAG)*: redacta con soltura, pero inventa y cuesta por pregunta; con decenas de temas cortos no aporta nada que la coincidencia por palabras no dé.
- *La misma pantalla del Asesor o del agente de Recepción*: otro público, otros permisos y otra fuente; mezclarlos confunde qué mira cada uno.
- *Generar la guía entera del código*: el código sabe la ruta y el nombre, no para qué sirve una pantalla ni cómo la busca la gente. Se genera lo que se puede comprobar y se escribe lo mínimo.
- *Abrir un caso automáticamente cuando no sabe*: enviaría texto del equipo sin que lo decida; lo envía la persona, con un toque.

## Consecuencias

- Beneficio: responde sin que la clínica configure nada, sin coste por uso y sin poder nombrar una pantalla que no existe.
- Sacrificio: solo sabe lo que está en la guía y lo dice con el texto del tema; no conversa ni entiende preguntas con otras palabras que las previstas. Lo que no supo responder es la lista de trabajo para mejorarla.
- No construido todavía: el modelo de decisión eligiendo el tema (el punto de entrada está: hoy elige la coincidencia por palabras), la creación del caso como incidencia en el repositorio privado de odentIA (los casos quedan en la base y se listan y responden con las funciones del servicio; no hay pantalla interna), «¿por qué?» junto a cada botón bloqueado, y guiar paso a paso.
- Revisar cuando el registro muestre muchas preguntas sin tema: añadir palabras o temas antes que un modelo.

## Referencias

- `packages/services/src/help-guide.ts`, `packages/services/src/help.ts`, `packages/services/src/help.test.ts` (guía contra el código), `apps/api/src/routes/help.ts`, `apps/dental-clinic/src/components/help-panel.tsx`, migración `0055`.
