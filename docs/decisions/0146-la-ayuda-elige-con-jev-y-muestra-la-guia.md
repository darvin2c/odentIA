# 0146 · La Ayuda elige su respuesta con Jev y muestra la guía tal cual

Fecha: 2026-11-06 · Estado: aceptada · Sustituye a la [0013](0013-ayuda-responde-con-la-guia-del-sistema.md) · Precisa la 0007, la 0047 y la 0085

## Problema

La Ayuda (Ariadna) elegía su respuesta por palabras: cada tema sumaba puntos y ganaba el que más sumaba. La ronda de QA del 2026-11-04 la vio responder mal 9 de 14 preguntas.

- **Respondía con seguridad lo que no le preguntaron.** Medido por respuesta, en los bancos que nadie usó para ajustar acertaba el 36,7 % de lo que mostraba (estudio X8 y `eval:ayuda`).
- **Cuando no encontraba la pregunta frecuente, pegaba el párrafo de la pantalla.**
- **No reconocía las preguntas sobre las cifras de la clínica.**

El puntaje no separaba un acierto de un error, así que ningún umbral lo arreglaba. Al mismo tiempo, la Ayuda tiene que ser muy correcta y no puede inventar pantallas ni pasos.

## Decisión y motivo

- **Jev elige y la guía responde.** Jev, el modelo de decisión, elige entre las preguntas frecuentes y las pantallas de la guía, más «ninguna» y «datos» (`help.v1`, `help-decision.ts` de los servicios). Lo que se muestra es siempre el texto de la guía tal cual: el modelo no redacta. Así ataca lo que fallaba, que era elegir, y conserva lo que sí funcionaba de la 0013: no inventa.
- **El umbral es 0,90, elegido con datos.** Se midió con Jev real el 2026-11-06 con `eval:ayuda`:
  - **La curva.** Se trazó en los bancos ya usados para ajustar (desarrollo, control y final), y solo 0,90 cumple los cuatro mínimos del estudio.
  - **La confirmación.** Se hizo una sola vez en ronda, ciego y cifras (n = 177): de lo mostrado, es correcto el 100 % (cota inferior al 95 %, 90,1 %); no responde lo que no está en la guía el 100 %; resuelve el 94,4 % de lo que sí está, solo o con un toque; p95 de 302 ms.
  - **El costo.** Unos USD 0,00037 por pregunta.
  - **Los registros** están en `packages/agent/eval/ayuda-mediciones/`.
- **Cuatro salidas:**
  - **seguro:** la respuesta de la guía, con «Llévame»;
  - **duda:** «¿Es alguna de estas?», con hasta tres respuestas;
  - **ninguna:** «Esto no está en la guía», con «Enviar a odentIA»;
  - **datos:** la salida a Argos.
  «Ninguna» y «datos» juntas sobre el umbral también son «ninguna».
- **Las cifras de la clínica son de Argos, no de la Ayuda.** El botón sale solo si el rol ve Reportes y Argos está encendido, y dice que usa una pregunta del mes (0085). Sin eso, la Ayuda dice a quién pedírselo. La Ayuda sigue sin leer datos de la clínica.
- **Lo escrito como en la guía no llama a Jev.** Eso incluye una pregunta frecuente o una de sus formas, el nombre de una pantalla y lo que se toca en una sugerencia o en la duda.
- **Sin Jev, solo responden las palabras.** Si Jev no está, falla, se pasa del plazo (2 s) o no decide, la Ayuda responde solo con una pregunta frecuente que las palabras reconozcan; si no hay ninguna, dice «ninguna». Nunca pega el párrafo de la pantalla. Tampoco recurre al modelo que escribe: no da probabilidades y costaría más.
- **Jev decide en toda clínica, y lo paga odentIA.** La Ayuda es de odentIA: el costo va con el origen `ayuda`, no se cobra a la clínica ni cuenta para su presupuesto y figura en «Costo y margen» como lo que regalamos.
  - **Qué viaja a TypeSafe:** solo la pregunta y el nombre de la pantalla.
  - **El aviso:** junto a la caja dice «No escribas nombres de pacientes».
  - **El registro de tratamiento:** Jev pasa a figurar como encargado siempre, no solo con los agentes encendidos.
- **Lo que queda de cada pregunta.** `help_ask` guarda la pantalla, el tema y la pregunta frecuente que respondió (textos de la guía), cómo se decidió (`exacta`, `jev` o `respaldo`), lo que decidió Jev y su probabilidad. Nunca guarda el texto de la pregunta.
- **Lo que se conserva de la 0013:**
  - el nombre;
  - que es de odentIA para todo el equipo;
  - la guía comprobada contra el código;
  - «¿por qué no puedo?» con el estado real, ahora sobre lo que eligió Jev;
  - los permisos;
  - que no cambia nada;
  - el envío a odentIA;
  - el tope diario.

## Alternativas descartadas

- **RAG**, un modelo que redacta con lo recuperado: inventa nombres y pasos, y pedirle que no lo haga lo reduce sin eliminarlo. La medición dijo que el problema era elegir, no redactar.
- **Que Jev elija y un modelo redacte con comprobación (opción d del estudio).** La comprobación no ve un «no» que se volvió «sí». Se vuelve a mirar si `eval:ayuda` muestra muchas preguntas que la guía responde en partes y que dos respuestas no resuelven.
- **Seguir con las palabras y ajustar el umbral:** medido, ningún umbral separa aciertos de errores.
- **Que el respaldo sea el modelo que escribe:** sin probabilidades no hay criterio para callar, y cuesta más.

## Consecuencias

- **Beneficio:** casi nunca muestra una respuesta equivocada, dice cuándo no sabe y lleva las cifras a Argos.
- **Sacrificio:**
  - con 0,90 duda a menudo: en la confirmación, 71 de 177 terminaron en «¿Es alguna de estas?»;
  - cada pregunta que no está escrita como en la guía cuesta y tarda unos 300 ms;
  - la pregunta del equipo sale a un proveedor.
- **«Datos» casi no se reconoce todavía:** 0 % en la medición. Lo normal es que una pregunta de cifras termine en duda o en «ninguna».
- **Las condiciones para volver a medir:**
  - **qué invalida lo medido:** cambiar la redacción u orden de `help.v1` o el umbral. `product-prompts.test.ts` del agente (`__golden__/ayuda.json`) lo atrapa;
  - **los bancos:** el umbral se elige con los de ajuste y se confirma una vez con los ciegos. Mirar los fallos de un banco ciego para ajustar lo gasta.
- **Por revisar:** cuántas dudas y «ninguna» deja cada pantalla en `help_ask`, para escribir las preguntas frecuentes que faltan.

## Referencias

- **Servicios:**
  - `packages/services/src/help-decision.ts`;
  - `packages/services/src/help.ts` (`askHelp`);
  - `packages/services/src/help-preguntas.json`.
- **API:** `apps/api/src/routes/help.ts`.
- **Pantalla:** `packages/clinic-app/src/components/help-panel.tsx`.
- **Agente:**
  - `packages/agent/src/decision/eval-ayuda.ts`;
  - `packages/agent/eval/ayuda-mediciones/`.
- **Migración:** `packages/db/drizzle/0051_ayuda_con_jev.sql`.
- **Estudio:** X8, «Cómo debe responder la Ayuda (Ariadna) para ser muy correcta» (2026-11-05).
