# 0196 · La Bandeja de la administración, las fases del cliente y lo que sale por cada canal

Fecha: 2026-11-16 · Estado: aceptada · Extiende la [0185](0185-arm-de-la-administracion.md), la [0186](0186-correo-de-la-administracion.md) y la [0189](0189-canales-de-la-administracion.md)

## Problema

Lo que nos escriben desde fuera de la app (correo de todos los buzones, WhatsApp, Instagram y Messenger) no tenía dónde vivir: un correo de alguien sin cliente era una tarjeta de Kairós sin asunto ni texto, el de un cliente solo aparecía en su historial, y no había un lugar donde ver qué falta responder. «Con cuenta» juntaba a la clínica que recién se da de alta con la que ya paga, el historial se ordenaba por tabla («Cuenta y pagos» llevaba el informe y la carga) y la ficha mostraba las mismas nueve pestañas en cualquier fase. Responder era una caja de texto con las marcas a la vista, los chats no podían mandar archivos y nada avisaba antes de enviar lo que un canal no acepta.

## Decisión y motivo

- **Una Bandeja, solo de Administración.** Una conversación por persona y canal: el chat (`saas_chat`) o el hilo de un correo, que se agrupa al leer subiendo por su cadena (el primer Message-ID de su `References` o, si no trae, el de su `In-Reply-To`) mientras sea de un correo o un envío que conocemos, hasta el primero del hilo (o el suyo, sin esas cabeceras). Un correo entra en un hilo solo si quien lo envía está verificado y es parte de él: lo empezó, le escribimos ahí, le respondimos un correo de ese hilo o es de la clínica del hilo (su correo se ligó a ella por su correo exacto, o lo ligó una persona, y el hilo empezó con un correo de ella o le escribimos ahí). Si no, es su propia conversación, y por el hilo tampoco se liga a un cliente: quien conoce un Message-ID ajeno no lee ni recibe lo de otros. La conversación no se guarda aparte: se lee de lo que entró y lo que salió, y solo lo que marca una persona va en `saas_conversation_mark` («Lo atiendo yo» en un correo, «No necesita respuesta»). Tres estados: **Te toca** (espera a una persona, también si Kairós dejó la respuesta lista), **Kairós respondió** y **Respondida**; el número del menú cuenta solo «Te toca». Las tarjetas de Kairós que eran respuestas (`correo_sin_cliente`, `chat_sin_cliente`, `responder_chat`, `responder_correo`) se siguen creando, pero se deciden dentro de su conversación y ya no salen en Kairós ni en Hoy.
- **Soporte sigue siendo Soporte.** La ayuda llega por un solo canal, la Ayuda de la app, y su cola no cambia. El rol Soporte deja de ver los correos y los chats (antes veía soporte@ y los chats de clínicas con app): son de Administración, que lleva a la Ayuda a quien escribe por fuera.
- **Tres fases del cliente**, calculadas y nunca guardadas (`clientPhaseSql`): por vender, en alta (con cuenta, hasta su primer pago confirmado, la misma regla del paso del alta y del Embudo «Alta») y activo. La ficha muestra las pestañas de su fase, y el historial se ordena por lo que pasó: Conversaciones, Venta, Alta, Plan y pagos y Soporte.
- **Se escribe una vez y el envío lo adapta al canal.** El texto guarda las marcas de WhatsApp (`*negrita*`, `_cursiva_`, `~tachado~`); el correo las dibuja (`*x*` pasa a ser negrita y `**x**` lo sigue siendo), WhatsApp las manda tal cual e Instagram y Messenger, que no tienen formato, reciben texto limpio. El servidor dice el máximo de cada canal (WhatsApp 4096 caracteres, Messenger 2000, Instagram 1000 bytes) y qué archivos acepta, y lo comprueba al enviar; en un chat cada archivo sale como su propio mensaje (`file_ids` de uno), para que cada uno tenga su estado. WhatsApp informa además cuándo llegó y cuándo se leyó (`delivered_at`, `read_at`, una vez cada uno) y cuándo no llegó lo que ya había salido (`failed_at`, `failed_why`): esa parte deja la conversación en «Te toca» hasta que algo nuestro de después sí llegue, y si era de Kairós pasa al equipo.
- **«Mejorar con Kairós»** corrige y aclara lo que escribió una persona, sin cambiar lo que quiso decir ni agregar cifras, horas o precios que no estaban: si la propuesta trae un número nuevo, no sale. Muestra lo que cambiaría y la persona elige; nunca envía. Su gasto va a `kairos_ai_usage` con el uso `mejorar`.

## Alternativas descartadas

- *Una tabla de conversaciones que se mantiene en cada entrada y salida.* Obliga a tocar cada camino que escribe un correo o un chat y se descuadra con el primero que se olvide; leer de lo que ya existe da lo mismo con el volumen de la administración.
- *Mejorar solo las tarjetas de Kairós.* Más barato, pero seguiría sin haber un lugar donde ver todo lo que espera respuesta.
- *Un editor que oculte las marcas (ProseMirror y parecidos).* Agrega una dependencia y una conversión de ida y vuelta; el texto con marcas visibles y dibujadas es lo mismo que WhatsApp muestra al escribir y lo mismo que se guarda.

## Consecuencias

- Responder por fuera de la app es solo de Administración; si Soporte vuelve a necesitarlo, se le da la Bandeja con su filtro, no otra vía.
- Un hilo de correo que solo trae `In-Reply-To` de un correo que no conocemos queda como hilo propio. Una cadena más larga que 25 pasos se corta ahí.
- Quien contesta desde otra dirección (un colega, un segundo correo) entra al hilo si su correo es de una persona de esa clínica; si no, empieza su propia conversación, «¿De quién es?» sugiere la clínica del hilo y entra en cuanto alguien lo liga a ella o le respondemos. Un remitente sin verificar nunca entra en un hilo ajeno, aunque una persona lo ligue.
- De quién es un hilo listado lo dicen también sus correos de antes de la ventana de 180 días: se buscan desde el primero del hilo por la cadena, hacia adelante.
- La respuesta que dejó Kairós para un correo que ya no es el último de su hilo no se aprueba, y su pasada la retira para escribir la del nuevo.
- La fase depende del pago confirmado: una clínica Fundadora sin consumo sigue en alta hasta su primer pago.

## Referencias

- `packages/services/src/admin-inbox.ts`, `admin-clients.ts` (`clientPhaseSql`, `clientTimeline`), `admin-chat-send.ts`, `packages/mail/src/markdown.ts`.
- `apps/admin/src/routes/_app/inbox.tsx`, `components/arm/reply-editor.tsx`.
- Migraciones `0139_bandeja_de_la_administracion` y `0140_bandeja_de_la_administracion_reglas`.
