# 0005 · Uso del modelo: ráfagas agrupadas y prompt de prefijo estable

Fecha: 2026-10-09 · Estado: aceptada · Precisada por [0104](0104-sofi-trabaja-con-la-atencion-entera-y-sabe-como-va.md) el 2026-10-29: lo de la corrida va después del historial y lo de la organización lleva su corte de caché

## Problema

Cada mensaje entrante encolaba su propia corrida del agente. Quien escribe tres mensajes seguidos provocaba tres llamadas al modelo y recibía tres respuestas. Además, cada llamada enviaba 23 esquemas de herramientas y un prompt que ponía la hora casi al principio, de modo que el proveedor no podía reutilizar desde su caché nada de lo que venía después (política y conocimiento de la clínica, que son lo más largo y lo más estable). El objetivo es gastar menos por turno sin que nadie se quede sin respuesta ni reciba una duplicada.

## Decisión y motivo

- **Ventana de ráfaga.** La corrida de un mensaje entrante se encola con retardo (`AGENT_BURST_WINDOW_SECONDS`, 4 s por defecto, 0–30). Al ejecutarse atiende los entrantes recientes sin responder del final del hilo (hasta 30 minutos: lo más antiguo es historial, no ráfaga) y toma el más reciente como disparador (libro, claves de idempotencia, aviso de «sin respuesta»).
- **Constancia explícita de lo leído.** La corrida que respondió o derivó anota en el libro, uno a uno, los demás mensajes de la ráfaga (`omitida` · `burst-covered`). Una corrida se salta solo si su propio mensaje ya consta como atendido; así también se evita repetir la respuesta en una reentrega de la cola. No se deduce de fechas: `message.created_at` es el inicio de la transacción de ingesta, no su confirmación, y un mensaje cuya ingesta tarda (audio, transcripción) quedaría «antes» de otro ya respondido sin que nadie lo hubiera leído.
- **Prompt de lo estable a lo cambiante.** Instrucciones, política y conocimiento de la organización; después el hilo; al final la instrucción de la corrida y la hora. El prefijo idéntico entre personas de la misma clínica es lo que el proveedor puede servir desde caché.
- **Conocimiento acotado.** Cada respuesta oficial se recorta a 600 caracteres con aviso; el texto completo se pide con `consultar_conocimiento` por título exacto.
- **Herramientas por organización, no por hilo.** Solo se quita la de plantillas cuando ningún canal activo las admite. Las herramientas van al principio de lo cacheable: una lista distinta por hilo ahorraría un esquema y partiría la caché en variantes.

## Alternativas descartadas

- *Debounce por conversación* (reiniciar la espera con cada mensaje): agrupa mejor ráfagas largas, pero exige estado por hilo y una respuesta puede retrasarse sin tope mientras la persona siga escribiendo.
- *Bloqueo o reserva por hilo* para que dos workers no atiendan la misma ráfaga: necesario solo con varias réplicas, que hoy no existen; añade sesiones con bloqueo consultivo al camino crítico.
- *Decidir «ya atendido» por fecha de creación*: más simple, pero puede dar por atendido un mensaje que ninguna corrida leyó.
- *Conocimiento solo por herramienta*: prompt mínimo, pero cada pregunta frecuente costaría una llamada extra al modelo.

## Consecuencias

- Beneficio: una ráfaga produce una llamada y una respuesta; el prompt reutilizable pasa de una quinta parte a casi todo; una reentrega no vuelve a llamar al modelo.
- Sacrificio: cada respuesta del agente llega con la demora de la ventana. Una ráfaga más larga que la ventana recibe más de una respuesta. La agrupación es de mejor esfuerzo con varias réplicas del worker: dos corridas simultáneas de la misma ráfaga pueden responder ambas (nunca se pierde un mensaje). Una respuesta oficial extensa cuesta una llamada más cuando hay que citarla entera.
- El ahorro real en tokens depende de la caché de cada proveedor y no está medido con uno real; `usage.test.ts` fija lo que el modelo recibe, no su coste.
- Revisar si se añade una segunda réplica del worker, si un canal exige respuesta inmediata, o cuando haya consumo real por organización.

## Referencias

- `packages/agent/src/run.ts` (ráfaga, constancia, exclusiones), `packages/agent/src/graph.ts` (orden del prompt), `packages/services/src/knowledge.ts`, `packages/db/src/queue.ts`, `apps/worker/src/inbound.ts`, `packages/agent/src/usage.test.ts`.
