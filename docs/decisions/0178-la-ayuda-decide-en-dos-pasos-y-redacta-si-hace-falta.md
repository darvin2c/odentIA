# 0178 · La Ayuda decide en dos pasos, redacta solo si hace falta y muestra videos

Fecha: 2026-11-10 · Estado: aceptada · Precisa la [0146](0146-la-ayuda-elige-con-jev-y-muestra-la-guia.md) · Precisa la 0007 y la 0052

## Problema

Alguien preguntó en la Ayuda «¿tenemos tareas por paciente?» y recibió «No estoy segura de qué preguntas», con «¿Qué es Inicio?» y «¿Qué es Tareas?» para elegir. Había tres causas.

- **La guía no lo decía.** Las tareas por paciente existen, pero ninguna respuesta lo contaba. Una revisión de la guía contra el código, pantalla por pantalla, encontró 254 cosas que la app hace y la guía no decía, y 28 que decía mal. latidIA y vistIA respondían con la guía dental y unas palabras cambiadas.
- **La guía ya no cabía en una pregunta.** Jev elige entre 250 opciones como mucho. odentIA estaba en 249 y vistIA en 256: en vistIA un filtro por palabras ya recortaba la lista antes de Jev, que es justo lo que la 0146 dejó de usar para elegir.
- **La duda era una salida muy frecuente.** En la confirmación de la 0146, 71 de 177 preguntas acabaron en «¿Es alguna de estas?», y esa tabla no cuenta las dudas sobre lo que la guía no responde (`duda-calla` de `help-measure.ts`), que también las hubo. Cuando la respuesta estaba repartida entre dos textos, la Ayuda no podía unirlos.

## Decisión y motivo

- **La guía se completa y cada respuesta tiene nombre fijo.** Lo que faltaba se escribió por zona (`help-guide/`), comprobado contra las pantallas. Cada respuesta lleva `id`, que no cambia aunque se reescriba la pregunta: lo usan los videos, el registro y las mediciones. Lo que es solo de odentIA lleva `own` y los demás productos no lo heredan.
- **Jev decide en dos pasos (`help.v2`).**
  - **Primero, la categoría:** un tema de la guía o una parte de un tema muy grande (la ficha de una persona va en tres: sus datos, la historia clínica y el plan). Se toman las más probables hasta sumar 0,90, tres como mucho.
  - **Después, la respuesta**, entre las de esas categorías, con la misma pregunta y el mismo umbral de la 0146. Así Jev siempre ve entero el lugar donde busca y la guía puede crecer.
  - **Una categoría mal elegida no acaba en «no está».** Si las categorías elegidas no suman la certeza, se busca en toda la guía, por tandas que caben en una pregunta. Y antes de decir «Esto no está en la guía» se busca en el resto.
- **Se redacta solo si hace falta, y solo con la guía.** Cuando Jev no elige una respuesta pero dos o tres suman la certeza, se le pregunta con un sí o no si esos textos se completan. Si se completan, el modelo que escribe (0052) los une en una respuesta corta. Si compiten —la pregunta es ambigua, «¿cómo anulo?»— se ofrecen para elegir, como siempre.
  - **Lo redactado se comprueba sin modelo antes de mostrarse:** cada nombre entre «» y cada cifra tienen que estar en los textos de origen, tiene que citar alguno, ser texto corrido y corto. Si no pasa, falla o tarda más de 8 segundos, se ofrecen los textos para elegir.
  - **Se muestra como redactado, con sus textos de origen debajo**, cada uno con su «Llévame» y lo que el rol de quien pregunta puede hacer. La comprobación no ve un «no» que se volvió «sí»; por eso el origen queda a un toque.
  - **Con una respuesta segura no se redacta nada:** se muestra la guía tal cual, como en la 0146.
- **La pregunta siguiente entiende la anterior.** La pantalla manda la pregunta anterior y la pantalla de su respuesta si esa respuesta fue de la guía y tiene menos de 10 minutos. El servidor no guarda la conversación.
- **Lo que puede ser el dato de una persona sigue sin viajar, ahora por partes.** A un modelo la pregunta viaja sin cifras ni correos (`withoutPersonData`); si lo que queda puede ser un nombre suelto, no viaja. Lo mismo para la pregunta anterior. Antes, «¿cómo cobro 1 200 mitad Yape?» no llegaba a Jev por sus cifras.
- **Los videos se leen una vez al día, no al preguntar.** El worker lee la lista de reproducción de cada producto con la API de datos de YouTube y deja lo que hay en `catalog.help_video`.
  - **Se unen por una etiqueta** en la descripción del video (`#ayuda:<nombre fijo>`, `#ayuda:tema:<id>`, con el segundo de inicio si se quiere). Un video puede ir en varias respuestas y una respuesta mostrar hasta dos. No se unen a mano: una sola forma.
  - **Si la respuesta cambia después, el video no se esconde.** Queda «por revisar» para soporte, que dice «Sigue valiendo» o pide regrabarlo. La huella son las palabras de la respuesta: una coma no la cambia.
  - **Se abren en YouTube.** No se incrusta el reproductor ni se usa lo que dice el video como fuente de respuestas.
- **Soporte cuenta lo que nadie respondió.** «Ninguna es lo que busco» queda anotado, sin el texto, y cuenta como una pregunta sin respuesta. Antes la duda no se contaba, y el caso de este problema era una duda.
- **Lo que se conserva de la 0146:** el nombre, que la paga odentIA, lo tocado o escrito como en la guía sin modelo, «datos» a Argos, «¿por qué no puedo?» con el estado real, los permisos, el tope diario, el respaldo por palabras sin Jev y que nunca se guarda el texto de la pregunta.

## Alternativas descartadas

- **Que el modelo que escribe lea toda la guía y responda** (lo primero que se propuso): cada pregunta costaría leer la guía entera y el modelo tendría de dónde mezclar pantallas. La 0146 midió que el problema era elegir.
- **Redactar siempre que haya duda:** Jev también duda ante lo que la guía no responde; redactar ahí es inventar. Por eso las partes tienen que sumar la certeza entre ellas, sin «ninguna», y completarse.
- **Partir «Pacientes» en tres temas:** rompe la ruta única de cada tema, los bloqueos de «¿por qué no puedo?» y las estadísticas. La categoría es un campo de la respuesta.
- **Esconder el video cuando cambia su respuesta:** la guía cambió 144 veces en 30 días; los videos desaparecerían casi a diario sin que nadie se entere.
- **Leer el canal por su feed público, sin clave:** trae solo los 15 más nuevos y no está documentado.

## Consecuencias

- **Sin medir todavía con Jev ni con el modelo que escribe.** Los umbrales nuevos (0,90 de categorías, 0,15 por parte, 0,80 de «se completan») son puntos de partida. No se da por mejor que la 0146 hasta medirlo con `eval:ayuda`: el paso 1 con las categorías del banco, el conjunto, y la redacción con un juez.
- **El banco se queda corto:** 627 preguntas son de odentIA, 14 de latidIA y ninguna de vistIA; no tiene pares de seguimiento ni preguntas de dos partes, y 147 dicen «ninguna» sobre la guía de antes. Hay que escribir lo que falta antes de confirmar.
- **Cuesta más por pregunta:** dos llamadas a Jev en vez de una, más las tandas cuando la categoría no es segura, más el modelo que escribe cuando se redacta.
- **El modelo que escribe pasa a recibir preguntas del equipo de toda clínica** (sin cifras ni correos), además de Jev. El registro de tratamiento lo tiene que decir. Pendiente legal.
- **La lectura de YouTube no se probó contra YouTube:** en este cambio no había clave. Está probada con respuestas de muestra.
- **Qué invalida lo medido:** cambiar la redacción u orden de cualquiera de las tres preguntas, las instrucciones de quien redacta o un umbral. `product-prompts.test.ts` del agente lo atrapa (`__golden__/ayuda.json`, `ayuda-pasos.json`).

## Referencias

- **Servicios:** `packages/services/src/help-decision.ts`, `help.ts`, `help-guide.ts`, `help-guide/`, `help-videos.ts`.
- **Agente:** `packages/agent/src/help-writer.ts`, `decision/fake.ts`.
- **API:** `apps/api/src/routes/help.ts`, `admin-support.ts`.
- **Worker:** `apps/worker/src/help-videos.ts`.
- **Pantalla:** `packages/clinic-app/src/components/help-panel.tsx`; soporte, `apps/admin/src/routes/_app/support.tsx`.
- **Migración:** `packages/db/drizzle/0095_ayuda_responde.sql`, `0096_ayuda_responde_reglas.sql`.
