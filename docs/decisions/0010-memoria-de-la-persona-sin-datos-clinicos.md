# 0010 · Memoria de la persona: pocos datos prácticos, nunca clínicos

Fecha: 2026-10-10 · Estado: aceptada

## Problema

El agente recordaba lo acordado dentro de una conversación (0006), pero no de una conversación a la siguiente: quien dijo en WhatsApp que solo puede por la tarde tenía que repetirlo en el chat web un mes después. La plataforma es omnicanal y centrada en la persona; esa continuidad es parte de lo que promete. A la vez, lo que alguien cuenta por chat a una clínica incluye a menudo información de salud, que tiene su sitio —la historia clínica— con otros permisos, otra trazabilidad y otras obligaciones.

## Decisión y motivo

- **La memoria es de la persona, no del hilo ni del canal.** Se guarda por contacto y llega al agente en cualquier conversación de esa persona.
- **Son datos, no un resumen libre.** Cada dato es una frase corta con fecha y origen (lo dijo por tal canal, o lo anotó tal persona del equipo). Hasta 20 activos por persona. Un dato nuevo puede reemplazar a otro y cualquiera se quita; la fila se conserva como historia y el agente deja de usarla al instante.
- **Nunca nada clínico, lo registre el agente o el equipo.** Un filtro por palabras rechaza lo que parece información de salud y dice por qué. Es deliberadamente amplio: prefiere rechazar un dato inocente a guardar uno clínico. La instrucción al agente y la descripción del campo dicen lo mismo, pero la garantía es el filtro, no la obediencia del modelo.
- **El equipo ve y gobierna lo que recuerda** («Lo que recuerda el agente», desde el contexto de la persona): lee quien atiende conversaciones o lleva el CRM; añade, corrige o quita quien puede escribir en uno de los dos.
- **Lo que ya está en el sistema no se copia.** Por quién más escribe la persona y en qué sede suele atenderse salen de sus vínculos y sus citas en cada lectura; se muestran como «se cambia en la ficha».
- **Para el agente es contexto, no una orden**: si hoy la persona dice otra cosa, vale lo de hoy y reemplaza el dato.
- **La auditoría no repite el dato**: registra quién, cuándo y de quién.

## Alternativas descartadas

- *Resumen libre de la persona escrito por el modelo*: no se puede acotar lo que contiene, mezcla lo clínico con lo práctico y nadie puede corregir una frase sin reescribirlo todo.
- *Memoria por similitud sobre todo lo conversado*: recupera texto de conversaciones antiguas sin fecha ni origen claros, incluida información de salud.
- *Guardarlo en las notas o en los campos del contacto*: son del equipo, no llevan origen ni se retiran solos del contexto del agente, y el agente ya no debe escribir identidad.
- *Un clasificador con modelo para decidir qué es clínico*: otro coste por dato y un fallo silencioso posible; el filtro por palabras falla hacia el lado seguro.

## Consecuencias

- Beneficio: un dato dicho hoy se usa en la siguiente conversación, por el canal que sea, y el equipo lo ve y lo quita.
- Sacrificio: el filtro rechaza datos prácticos que usan palabras de salud («viene con su médico»), y no reconoce información de salud dicha con palabras que no están en la lista. No sustituye el criterio del equipo ni es evidencia de cumplimiento.
- Tratamiento de datos personales: es información de la persona guardada para atenderla; entra en lo que cubre el consentimiento de atención. Queda como nota legal pendiente si debe ofrecerse al titular verla o pedir su supresión desde el portal.
- Revisar la lista de palabras con casos reales de la clínica, y el tope de 20 si se llena con datos poco útiles.

## Referencias

- `packages/services/src/agent-person-memory.ts`, herramienta `recordar_dato` (`packages/agent/src/tools.ts`), operación `persona.recordar`, migración `0051`.
