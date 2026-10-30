# 0110 · WhatsApp sin número: la persona por su BSUID

Fecha: 2026-10-30 · Estado: aceptada

## Problema

Quien usa nombre de usuario en WhatsApp puede ocultar su número. Si la empresa no le escribió ni recibió nada de ella en 30 días y no la tiene en su agenda, Meta no manda `from` ni `wa_id`: manda solo su BSUID (`from_user_id`, `user_id`), el id que le da para esa empresa. odentIA armaba la dirección con `from` y guardó `wa:undefined`. La respuesta de Sofi salió a «undefined», Meta la rechazó (131009) y quedó como «no se sabe». Peor aún: todas las personas sin número habrían caído en la misma identidad `wa:undefined`, es decir, en la misma conversación.

## Decisión y motivo

- **La dirección es el número y, sin él, el BSUID**: `wa:<dígitos>` como siempre o `wa:<BSUID>` (`wa:PE.1349…`). El BSUID lleva el país y un punto, así que no se confunde con un número. Sin número ni BSUID el mensaje no entra.
- **La identidad guarda el BSUID** (`contact_identity.provider_user_id`, único por clínica y canal) y la entrada la busca también por él (`settleProviderUser`). Así la persona sigue siendo una sola cuando cambia lo que Meta manda:
  - Escribió sin número y después llega con él (Meta lo manda en cuanto se le responde): su identidad y su conversación pasan a su número, que es como la conocen la ficha, «Usarlo como su WhatsApp» y los envíos.
  - Llega sin número y su identidad ya tiene su número: el mensaje entra con ese número, en su conversación de siempre.
  - Con número y BSUID: se guarda el BSUID, o se pone al día, porque Meta lo regenera cuando la persona cambia de número.
  - Su ficha ya tenía su número como otra identidad (el equipo lo puso como su WhatsApp mientras ella lo ocultaba): son la misma cuenta de WhatsApp, así que la identidad del número se queda con el BSUID y con las conversaciones de la otra, y la otra se borra.
- **Se responde con `recipient`** cuando la dirección es un BSUID. Si hay número, se usa `to`, como Meta.
- **Nunca se unen identidades de dos fichas**, siguiendo la regla de siempre: lo decide el equipo con «Reasignar canal». Mientras tanto, cada mensaje entra por su dirección.
- **Las conversaciones no se funden**: si la persona ya tenía una conversación por su número en esa conexión, la que tenía sin número queda como su historial, en la misma identidad, y lo nuevo llega a la del número. Sus mensajes no se mueven porque las citas y lo que hizo Sofi (derivaciones, propuestas, registros) están atados a su conversación.
- **Un rechazo claro del proveedor no es ambiguo**: si WhatsApp, Messenger, Instagram o Telegram responden 4xx con su error, el mensaje no salió y queda `failed` con su motivo (`ProviderRejectedError`). Una caída de la red, un 5xx o una respuesta sin id siguen siendo `unknown` y no se reenvían. La Bandeja dice en palabras por qué no llegó (`deliveryNote`); el motivo de Meta en inglés no se muestra.
- **Un límite de ritmo se reintenta** (`ProviderThrottledError`: en WhatsApp 4, 80007, 130429 y 131056; en Messenger e Instagram 4, 17, 32, 613, 80001, 80002 y 80006; en Telegram 429): no salió, así que reintentarlo no lo duplica. El mensaje sigue en cola y vuelve a intentarse a los 1, 2, 4 y 8 minutos; al quinto intento queda `failed`. Los mensajes de una conversación salen en orden: mientras uno anterior sigue en cola con su trabajo pendiente, el siguiente lo espera y vuelve a la cola a los 30 segundos sin gastar sus intentos. Se mira el trabajo y no la hora: una respuesta «Por entregar» se escribió hace horas y aun así va primero, y uno que quedó en cola sin trabajo no frena la conversación. Si al final no salió, la conciliación lo trata como no entregado y deja la tarea de llamarle, porque no hay nada que arreglar en la conexión.
- **Bloquear a quien oculta su número** usa su BSUID en `user_id` de la Block Users API, como indica Meta.

## Alternativas descartadas

- Usar siempre el BSUID como dirección: obliga a migrar todas las identidades y conversaciones, que hoy son por número, y el número sigue siendo como la clínica conoce a la persona.
- Guardar el BSUID como una segunda identidad del mismo contacto: la persona tendría dos WhatsApp en su ficha y dos conversaciones en el mismo número de la clínica.

## Consecuencias

- Quien escribió con número antes de este cambio y vuelve después de 30 días sin número no tiene su BSUID guardado: entra como persona nueva y el equipo la une con «Reasignar canal». Desde este cambio, cada mensaje con número guarda el BSUID.
- Quien solo escribió sin número no tiene teléfono en su ficha mientras Meta no lo mande; la ficha la muestra por su nombre.
- La conversación `wa:undefined` de antes de este cambio no se puede reparar: no se guardó el BSUID. Esa persona entra bien en cuanto vuelva a escribir.

## Referencias

`packages/channels/src/whatsapp-cloud-api.ts` (`personOf`, `recipientOf`), `packages/services/src/contacts.ts` (`settleProviderUser`), `apps/worker/src/outbound.ts`, `packages/services/src/conversations.ts` (`deliveryNoteOf`). Meta: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
