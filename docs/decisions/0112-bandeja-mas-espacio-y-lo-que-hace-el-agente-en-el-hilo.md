# 0112 · Bandeja: más espacio para la conversación y lo que hace el agente, en el hilo

- Fecha: 2026-10-30.
- Estado: aceptada. Precisa el ADR 0050 en cómo se muestran los temas: su lógica no cambia.

## Problema

La Bandeja gastaba 216 px de alto antes de la lista y, con un tema abierto, dejaba 231 px para los mensajes. El mismo tema se decía hasta siete veces (fila, cabecera, franja, cita, burbuja, caja y ayuda) y hasta trece avisos podían apilarse junto a la caja.

Lo que el agente ya hizo no estaba en la conversación: solo se veía lo que esperaba un sí, y lo hecho quedaba en Contexto › Actividad con palabras del sistema. Muchas de sus acciones (etiquetas, datos, tareas, enlaces, comprobantes) no dejaban ningún registro que se pudiera mostrar.

«Contexto» apilaba siete bloques y, para ver citas, plan, cobros o historia, había que salir a la página de la persona. Odontología no lo recibía porque pedía leer el CRM.

## Decisión y motivo

- Una sola fila de pestañas y filtros bajo la misma cabecera general, y filas de dos líneas. La segunda línea dice una sola cosa: lo que pide a una persona, cómo se cerró, lo último que hizo el agente, en qué está o el último mensaje.
- El tema vive en la caja, donde se responde: el encabezado de la caja dice de quién es y a qué responde, y sus acciones van en «…». Ya no hay franja arriba ni «Solo este tema»: el hilo abre en lo último, con el mensaje del tema resaltado. El botón dice «Enviar y resolver», porque Enter resuelve y antes esa consecuencia solo la decía un ícono. Junto a la caja, un solo aviso a la vez; un error siempre se ve.
- Lo que hizo el agente va en el hilo, en su hora, y por su importancia: tarjeta lo que cambia algo que otros van a usar o pide una decisión, línea lo menor (varias seguidas se juntan) y nada lo que solo consulta. La propuesta que espera el sí sale de ahí, no de otra franja. Las palabras las da el servidor (`listAgentActions`).
- `agent_action_log` guarda en una frase lo que el agente hace sin propuesta. Es un registro de solo anexado: no decide nada y el modelo no lo lee, así que no cambia sus respuestas; si falla, la corrida sigue.
- Sin ver al agente (`agent.read` o `agent.decide`), se sabe que propuso algo, no qué: la regla que ya tenía la franja.
- «Contexto» es una fila por sección con lo que hay dentro en una línea, y entra a cada una en el mismo panel, con los componentes de la página de la persona. Lo que necesita ancho (historia, odontograma, documentos) se abre grande. Empieza cerrado y queda como lo dejaste. Cada fila sale para quien puede abrirla; odontología lo recibe de quien ya es paciente, sin lo comercial. La línea de resumen no es una lectura clínica: de la historia solo dice las alergias.
- Los mensajes aprobados se abren al pedirlos: títulos con buscador a un lado y, al otro, el mensaje como saldrá. La lista ya no reemplaza la caja ni se come el hilo.

## Alternativas descartadas

- Ocultar la cabecera general o la barra lateral para ganar alto: se pierde la navegación y lo común de toda la aplicación; quitar el subtítulo y unir las filas ganaba casi lo mismo.
- Sacar las acciones de la tabla de propuestas y del registro de corridas: las propuestas no cubren lo directo, y `tools_used` guarda el nombre de la herramienta, no qué hizo.
- Una tarjeta por cada acción: etiquetas y tareas llenarían el hilo, que es el problema que se quería quitar.
- Copiar los datos de la persona en un resumen propio de la Bandeja: duplicaría reglas y permisos de su página.

## Consecuencias

- `/api/conversations/:id/agent-actions` y `/context` son nuevas, y la lista lleva `lastAction`.
- Una herramienta nueva del agente que cambie algo, sin propuesta, anota su frase con `noteAction`; si no, no se verá en el hilo.
- Las secciones de la página de la persona ahora también se usan a 392 px: un cambio en ellas se revisa a ese ancho.
- Abrir «Clínica» no pide nada de la historia hasta tocar una de sus partes, y ese pedido deja su traza como en su página.
