# 0194 · Kairós le pregunta a Ariadna; la ayuda se da en Soporte

Fecha: 2026-11-16 · Estado: aceptada · Reemplaza a la [0191](0191-ariadna-en-los-chats.md); extiende la [0190](0190-kairos-vende.md)

## Problema

La 0191 hizo del WhatsApp, Instagram y Messenger de Sallca un segundo canal de ayuda: Ariadna respondía ahí a las clínicas con app. Toda la ayuda se da en Soporte, dentro de la app, donde se ve la cuenta y el rol de quien pregunta; otro canal de ayuda la parte en dos y enseña a escribir por donde no corresponde. Y quien todavía no usa la app pregunta por funciones («¿se puede firmar en la tablet?») que Kairós no sabía contestar: solo dice lo de las webs, y lo demás lo pasaba al equipo.

## Decisión y motivo

- **Ariadna no responde en los chats de Sallca.** Sin su interruptor ni su turno: una clínica con app que escribe por ahí queda para el equipo, como antes de la 0191, y Soporte la lleva a la app. No hay respuesta automática que la mande a Soporte: haría falta otra vía con sus propias reglas de quién la ve, para un caso que el equipo resuelve con una respuesta.
- **Kairós le pregunta a Ariadna.** Cuando quien está comprando pregunta si el sistema hace algo, Kairós usa `preguntar_a_ariadna`: `askGuideForSale` busca en la guía de la Ayuda de ese producto, con el mismo Jev y el mismo filtro de la Ayuda (`withoutPersonData`), sin redactar y sin datos de ninguna clínica. Kairós lo cuenta en su tono de venta, en una o dos frases y sin los pasos de la pantalla.
- **Le pregunta como quien ya usa el sistema** («¿Cómo firma el paciente en la tablet?»): así la guía responde segura. Si duda, le devuelve sus preguntas parecidas y Kairós puede volver a preguntar con una tal cual, que se responde sin modelo. Sin Jev (falló o tardó) no hay respuesta: una coincidencia de palabras no basta para afirmar. Las horas que trae la guía no sustentan ninguna hora de lo que sale.
- **Lo que la guía no tiene no se afirma**, ni que sí ni que no: Kairós ofrece verlo en la presentación o lo pasa al equipo.
- **Las columnas de la 0191 se quedan sin uso** (`kairos_setting.ariadna_*`, `kairos_chat_turn.agent` y `ariadna_reply`, `saas_outreach.by_ariadna`, `saas_follow_up.by_ariadna`): la migración ya corrió en producción y borrarlas en el mismo despliegue rompería la imagen anterior. Se borran en un cambio aparte.

## Alternativas descartadas

- *Una respuesta fija a la clínica con app, con el enlace a Soporte.* Útil, pero pide otra vía automática con su visibilidad y su «una vez»; el equipo lo resuelve igual con una respuesta.
- *Que Ariadna escriba la respuesta de venta.* Mezcla dos voces: Ariadna explica cómo se usa, Kairós vende.
- *Poner en las webs todas las funciones para que Kairós las lea.* La guía ya las dice y se mantiene con cada cambio de pantalla.

## Consecuencias

- Lo que no pasa la comprobación antes de enviar (una hora, un precio, algo dado por hecho) ya no va directo al aviso fijo: el modelo recibe una vez lo que no pudo salir y lo reescribe, como `verifyReply` de Sofi; a la segunda, el aviso fijo. Medido el 16 nov: 0 avisos fijos en 124 turnos (antes de este cambio, 2 por elegir una hora ofrecida en el mensaje anterior).
- Lo que pregunta quien compra viaja a Jev (con el filtro de la Ayuda); su costo entra en el gasto de Kairós (`vende`).
- La guía está escrita para quien usa la app: Kairós la traduce a venta y puede quedarse corto; se mide con `eval:kairos-vende`.

## Referencias

- `packages/services/src/kairos-guide.ts`, `packages/agent/src/kairos-vende.ts` (`preguntar_a_ariadna`), `apps/worker/src/kairos-vende.ts` (`guide`).
- Medición: `packages/agent/eval/kairos-vende.json` (`k17-…`, `latidia-recetas`, `vistia-medida`).
