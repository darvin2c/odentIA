# 0076 · El chat web de la clínica y una fila por persona en la Bandeja

Fecha: 2026-10-20 · Estado: aceptada · Precisa a [0050](0050-el-agente-nunca-se-calla.md) · Issues 111 y 94 (pulido de la Bandeja)

## Problema

El chat web se pegaba con un bloque de 15 líneas que llevaba el color adentro. Cualquier sitio podía usarlo, así que cualquiera que copiara el código gastaba las conversaciones de la clínica. Pedía el nombre antes de dejar escribir. Al recargar la página, la conversación se perdía y nacía otra persona. Si Sofi pasaba un tema al equipo, le decía «te responden por aquí»; si la persona cerraba la pestaña, la respuesta no le llegaba. Probar el chat se cobraba y dejaba a alguien en Pacientes.

## Decisión y motivo

### El chat web

- **Un chat por clínica, servido desde su dirección** (decisión 7): `<script src="https://<clínica>.<dominio>/chat.js" async></script>`. La línea no cambia aunque cambien el color o el saludo. Sirve igual si la clínica tiene dos sitios. No hay un dominio propio del chat (`chat.<dominio>` chocaría con una clínica llamada «chat») ni identificadores en la línea.
- **Responde en los sitios que la clínica permite** (decisión 8). El primer sitio donde carga se registra solo. Si aparece en otro, la clínica ve «¿Es tuyo? Permitir · Bloquear», y mientras tanto ahí dice «No disponible».
  - El navegador solo deja mostrar el chat en los sitios permitidos (`frame-ancestors`).
  - Los sitios se guardan aparte de la conexión (`webchat_site`).
- **Se escribe sin dar el nombre** (decisión 9): el saludo es la primera burbuja de Sofi. La conversación sigue 30 días en ese navegador, con un token que solo vale para ella. «Generar un código nuevo» no deja a nadie sin su conversación: la clave anterior vale 30 días más.
- **Dónde avisarle** (decisión 10). Cuando hay un tema con el equipo, el chat pide el WhatsApp o el correo, «Solo lo usamos para responderte». La respuesta del equipo sale por ahí: por WhatsApp, «Por entregar» con «Ver respuesta» si pasaron 24 horas (ADR 0050), o por correo. Sin ninguno de los dos, el equipo ve «Sin forma de avisarle». Un número que ya es de otra persona no se usa: nunca se une otra ficha por el número.
- **Lo que recibe el visitante** es solo quién lo dijo en palabras (Sofi o la clínica), el texto y la hora. Nunca quién del equipo escribió por dentro, errores ni identificadores internos.
- **Probar sin publicar.** La conversación de prueba lleva «Prueba» en la Bandeja y Sofi responde de verdad. En cambio:
  - No se cobra.
  - No crea a nadie en Pacientes ni una oportunidad, no ejecuta reservas.
  - No avisa al sitio y no cuenta en Reportes.
  - Lo que gasta cuenta como «probar», con su tope.
  - Se borra con «Borrar esta prueba» o sola a los 7 días. Lo borra una función de la base que solo acepta una prueba de la clínica en contexto.

## Alternativas descartadas

- *Abierto a cualquier sitio, con la lista en opciones avanzadas* (lo aprobado antes): quien copia la línea gasta las conversaciones de la clínica sin que nadie lo note.
- *Pedir el nombre antes de escribir*: es un paso más antes de preguntar, y el nombre se pide cuando hace falta (al reservar).
- *Un campo para el teléfono o el correo desde el principio*: se pide cuando el equipo tiene que responder y la persona puede irse, no antes.

## Consecuencias

- La clínica pega una línea y se olvida. Si su web cambia de dominio, el sitio nuevo aparece pendiente y lo permite con un toque.
- Sacrificio: un sitio nuevo de la propia clínica no responde hasta que alguien lo permite. Lo avisa la campana.
- La conversación vive en el navegador del visitante: en otro dispositivo empieza otra, hasta que deja un WhatsApp y el equipo decide si es la misma persona.

## Referencias

`apps/platform/public/chat.js`, `apps/platform/src/routes/embed.index.tsx`, `packages/services/src/webchat.ts`, `apps/api/src/routes/webchat.ts`, `packages/channels/src/web-chat.ts`, `packages/services/src/topic-reply.ts` (`forwardWebchatReply`) y las migraciones 0056 y 0057.
