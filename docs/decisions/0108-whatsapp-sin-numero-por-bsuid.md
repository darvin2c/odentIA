# 0108 · WhatsApp sin número: la persona por su BSUID

Fecha: 2026-10-30 · Estado: aceptada

## Problema

Quien usa nombre de usuario en WhatsApp puede ocultar su número. Si la empresa no le escribió ni recibió nada de ella en 30 días y no la tiene en su agenda, Meta no manda `from` ni `wa_id`: manda solo su BSUID (`from_user_id`, `user_id`), el id que le da para esa empresa. odentIA armaba la dirección con `from` y guardó `wa:undefined`. La respuesta de Sofi salió a «undefined», Meta la rechazó (131009) y quedó como «no se sabe». Peor aún: todas las personas sin número habrían caído en la misma identidad `wa:undefined`, es decir, en la misma conversación.

## Decisión y motivo

- **La dirección es el número y, sin él, el BSUID**: `wa:<dígitos>` como siempre o `wa:<BSUID>` (`wa:PE.1349…`). El BSUID lleva el país y un punto, así que no se confunde con un número. Sin número ni BSUID el mensaje no entra.
- **La identidad guarda el BSUID** (`contact_identity.provider_user_id`, único por clínica y canal) y la entrada la busca también por él (`settleProviderUser`). Así la persona sigue siendo una sola cuando cambia lo que Meta manda:
  - Escribió sin número y después llega con él (Meta lo manda en cuanto se le responde): su identidad y su conversación pasan a su número, que es como la conocen la ficha, «Usarlo como su WhatsApp» y los envíos.
  - Llega sin número y su identidad ya tiene su número: el mensaje entra con ese número, en su conversación de siempre.
  - Con número y BSUID: se guarda el BSUID, o se pone al día, porque Meta lo regenera cuando la persona cambia de número.
- **Se responde con `recipient`** cuando la dirección es un BSUID. Si hay número, se usa `to`, como Meta.
- **Nunca se unen dos identidades que ya existen**, siguiendo la regla de siempre: lo decide el equipo con «Reasignar canal».
- **Un rechazo claro de Meta no es ambiguo**: si Meta responde 4xx con su error, el mensaje no salió y queda `failed` con su motivo (`ProviderRejectedError`). Una caída de la red, un 5xx o una respuesta sin id siguen siendo `unknown` y no se reenvían. La Bandeja dice en palabras por qué no llegó (`deliveryNote`); el motivo de Meta en inglés no se muestra.

## Alternativas descartadas

- Usar siempre el BSUID como dirección: obliga a migrar todas las identidades y conversaciones, que hoy son por número, y el número sigue siendo como la clínica conoce a la persona.
- Guardar el BSUID como una segunda identidad del mismo contacto: la persona tendría dos WhatsApp en su ficha y dos conversaciones en el mismo número de la clínica.

## Consecuencias

- Quien escribió con número antes de este cambio y vuelve después de 30 días sin número no tiene su BSUID guardado: entra como persona nueva y el equipo la une con «Reasignar canal». Desde este cambio, cada mensaje con número guarda el BSUID.
- Quien solo escribió sin número no tiene teléfono en su ficha mientras Meta no lo mande; la ficha la muestra por su nombre.
- Bloquear (Block Users API) sigue usando el número.
- La conversación `wa:undefined` de antes de este cambio no se puede reparar: no se guardó el BSUID. Esa persona entra bien en cuanto vuelva a escribir.

## Referencias

`packages/channels/src/whatsapp-cloud-api.ts` (`personOf`, `recipientOf`), `packages/services/src/contacts.ts` (`settleProviderUser`), `apps/worker/src/outbound.ts`, `packages/services/src/conversations.ts` (`deliveryNoteOf`). Meta: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids
