# 0076 · El chat web de la clínica y una fila por persona en la Bandeja

Fecha: 2026-10-20 · Estado: aceptada · Precisa a [0050](0050-el-agente-nunca-se-calla.md) · Issues 111 y 94 (pulido de la Bandeja)

## Problema

El chat web se pegaba con un bloque de 15 líneas que llevaba el color adentro. Cualquier sitio podía usarlo, así que cualquiera que copiara el código gastaba las conversaciones de la clínica. Pedía el nombre antes de dejar escribir. Al recargar la página, la conversación se perdía y nacía otra persona. Si Sofi pasaba un tema al equipo, le decía «te responden por aquí»; si la persona cerraba la pestaña, la respuesta no le llegaba. Probar el chat se cobraba y dejaba a alguien en Pacientes.

En la Bandeja, Rosa aparecía dos veces si escribía por WhatsApp y por Telegram, cada fila con su estado y su número en las pestañas. Para ver lo que ya se le dijo había que abrir las dos.

## Decisión y motivo

### El chat web

- **Un chat por clínica, servido desde su dirección** (decisión 7): `<script src="https://<clínica>.<dominio>/chat.js" async></script>`. La línea no cambia aunque cambien el color o el saludo. Sirve igual si la clínica tiene dos sitios. No hay un dominio propio del chat (`chat.<dominio>` chocaría con una clínica llamada «chat») ni identificadores en la línea.
- **Responde en los sitios que la clínica permite** (decisión 8). El primer sitio donde carga se registra solo. Si aparece en otro, la clínica ve «¿Es tuyo? Permitir · Bloquear», y mientras tanto ahí dice «No disponible».
  - El sitio es el que dice el navegador (cabecera `Origin`), no lo que diga la página.
  - La API devuelve un ticket firmado de ese sitio. La ventana del chat lo presenta al abrir la conversación, así que abrir `/embed?site=…` desde otra página no basta.
  - El navegador solo deja mostrar el chat en los sitios permitidos (`frame-ancestors`).
  - El primero también se avisa en la campana y se puede bloquear: alguien pudo registrarse antes que la clínica.
  - Pendientes, como mucho 20.
  - Mirar la lista de Integraciones no crea el chat: nace al abrir su pantalla.
  - Los sitios se guardan aparte de la conexión (`webchat_site`).
- **Se escribe sin dar el nombre** (decisión 9): el saludo es la primera burbuja de Sofi. La conversación sigue 30 días en ese navegador, con un token que solo vale para ella.
  - El token se firma con una clave que sale de la clave de secretos del servidor y nunca se muestra (`webchatSessionKey`).
  - El código que se entrega a quien hace la web solo firma los avisos al sitio. Por eso con él no se lee ni se escribe ninguna conversación, y «Generar un código nuevo» no deja a nadie sin la suya.
  - Por lo mismo, el chat no recibe mensajes por un webhook firmado con ese código: entran solo con la sesión del visitante.
- **Dónde avisarle** (decisión 10). Cuando hay un tema con el equipo y la clínica tiene WhatsApp o un buzón conectado, el chat pide el WhatsApp o el correo, «Solo lo usamos para responderte».
  - La respuesta del equipo sale por ahí: por WhatsApp, «Por entregar» con «Ver respuesta» si pasaron 24 horas (ADR 0050), o por correo. Si «Ver respuesta» no sale y dejó un correo, va también por correo.
  - Una sola regla dice por dónde (`webchatReplyRoutes`): la usan el reenvío, «Sin forma de avisarle» en la Bandeja y lo que se acepta en el formulario.
  - Un número no se usa si ya es de otra persona, como identidad o como teléfono de otra ficha, ni si WhatsApp lo rechazó. Al visitante se le pide otro, sin decirle por qué. Nunca se une otra ficha por el número.
  - Usar el número que dejó es como «Escribirle» con el número de su ficha: lo decide quien responde (ADR 0027).
  - Lo que deja solo cambia la ficha de quien nació en ese chat: no la de un paciente ni la de quien escribe por otro canal.
  - Sofi dice «aquí abajo» solo si el chat va a pedirlo; si ya lo dejó, que le avisan por ahí; sin WhatsApp ni buzón en la clínica, que le responden en el chat.
- **Lo que recibe el visitante** es solo quién lo dijo en palabras (Sofi o la clínica), el texto y la hora. Nunca quién del equipo escribió por dentro, errores ni identificadores internos.
- **Probar sin publicar.** La conversación de prueba lleva «Prueba» en la Bandeja y Sofi responde de verdad. En cambio:
  - No se cobra.
  - No crea a nadie en Pacientes ni una oportunidad, no ejecuta reservas y no envía enlaces de reserva ni de registro (`TEST_CONVERSATION`).
  - No avisa al sitio, no cuenta en Reportes, ni en «Por revisar», ni en el Resumen del agente.
  - Lo que gasta cuenta como «probar», con su tope.
  - Se borra con «Borrar esta prueba» o sola a los 7 días. Lo borra una función de la base que solo acepta una prueba de la clínica en contexto.
  - Lo aprendido de una corrección queda. Lo que no debería haber dejado, como una cita, se suelta de la conversación y no se borra.
  - Si borrar falla en una clínica, el ciclo sigue con las demás.

### Una fila por persona

- **La lista y los números de las pestañas cuentan personas.** Cada persona está en el estado más urgente de sus conversaciones, en este orden: por atender, la atiende el agente, espera al paciente, cerrada (`VIEW_URGENCY`). Las pestañas siguen sin superponerse. Un canal suyo cerrado no la pone también en «Cerradas».
- **La fila muestra esa conversación**: su tema o su último mensaje y su estado. La hora y «sin leer» son de todos sus canales, y la fila lleva un icono por canal.
- **El hilo es una línea de tiempo** con los mensajes de todos sus canales y el canal en cada mensaje. Abrirla la deja leída en todos.
- **Por dónde sale la respuesta** (decisión 6):
  - Por la conversación que muestra la fila: la que más pide; en «Por atender», la que tiene el tema; entre iguales, la del último mensaje. Si es un tema, es el canal del tema.
  - La lista pagina por persona: si cambia la conversación que muestra, la persona no se repite ni se pierde entre páginas.
  - «Responder por» dice si cada canal está abierto (24 horas en WhatsApp, Instagram y Messenger) y deja cambiarlo sin perder lo escrito.
  - Un tema de otro canal se dice arriba con «Responder por <canal>»: se responde por ahí.
- **Se queda por canal, sin verse**: Sofi responde donde le escribieron, cada tema vive en su canal, el cierre a las 22 horas, la espera de 15 minutos y «sin leer» siguen por conversación. Cerrar o reabrir desde el hilo es de la conversación que responde.
- **Casos del borde**:
  - Un grupo de Telegram no es una persona y sigue con su propia fila: Telegram da a los grupos un id de chat negativo (`personKeySql`).
  - Dos fichas de la misma persona siguen separadas hasta que alguien diga «Es la misma persona». Nunca se juntan por coincidencia de teléfono: la fila es el `contact_id`.
  - Un enlace viejo `?conversation=` abre a la persona respondiendo por ese canal, y su fila queda marcada.

## Alternativas descartadas

- *Abierto a cualquier sitio, con la lista en opciones avanzadas* (lo aprobado antes): quien copia la línea gasta las conversaciones de la clínica sin que nadie lo note.
- *Pedir el nombre antes de escribir*: es un paso más antes de preguntar, y el nombre se pide cuando hace falta (al reservar).
- *Un campo para el teléfono o el correo desde el principio*: se pide cuando el equipo tiene que responder y la persona puede irse, no antes.
- *Juntar también por debajo, una conversación por persona*: rompería la ventana de 24 horas de cada canal, el cierre y la espera del agente, que dependen del canal. Por eso solo se junta lo que ve el equipo.
- *Abrir siempre por el canal del último mensaje* (decisión 6 al pie de la letra): la cabecera diría el estado de un canal y la fila el de otro. Por eso se abre la conversación de la fila, que es la del último mensaje cuando no hay otra más urgente.

## Consecuencias

- La clínica pega una línea y se olvida. Si su web cambia de dominio, el sitio nuevo aparece pendiente y lo permite con un toque.
- Sacrificio: un sitio nuevo de la propia clínica no responde hasta que alguien lo permite. Lo avisa la campana.
- La conversación vive en el navegador del visitante: en otro dispositivo empieza otra, hasta que deja un WhatsApp y el equipo decide si es la misma persona.
- Rosa sale una vez y su historia se lee de corrido. Contar personas pide el estado de cada conversación antes de agrupar: se calcula con las mismas reglas de `conversation-state.ts`, una consulta por vista, y con 1.500 conversaciones tarda 0,3 s (el conteo anterior por conversación, 3,4 s).

## Referencias

- Chat web: `apps/dental-clinic/public/chat.js`, `apps/dental-clinic/src/routes/embed.index.tsx`, `packages/services/src/webchat.ts`, `apps/api/src/routes/webchat.ts`, `packages/channels/src/web-chat.ts`, `packages/services/src/topic-reply.ts` (`forwardWebchatReply`) y las migraciones 0056 y 0057.
- Una fila por persona: `packages/services/src/inbox-person.ts`, `personKeySql` y `VIEW_URGENCY` en `conversation-state.ts`, `listPersonMessages` y `markRead` en `conversations.ts`, y la Bandeja (`apps/dental-clinic/src/routes/_org/inbox.tsx`).
