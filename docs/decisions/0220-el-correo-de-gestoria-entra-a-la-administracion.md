# 0220 · El correo de gestorIA entra a la administración

Fecha: 2026-11-25 · Estado: aceptada · Extiende la [0186](0186-correo-de-la-administracion.md) (el correo de la administración) con la lista de apps de la [0201](0201-la-cuenta-conoce-las-apps.md)

## Problema

La administración es una sola para todas las apps y también es omnicanal: lo que se le escribe a una app se lee y se responde en la Bandeja. El Email Worker solo conocía los dominios de las tres apps de clínicas (`odentia32.com`, `latidia72.com`, `vistia20.com`), y todo el camino del correo razonaba por producto clínico: lo que llegara a `hola@gestoria24.com` no entraba, y si entraba, la respuesta habría salido como odentIA. gestorIA es otro sistema (ADR 0201): no es un producto clínico, y sus clientes todavía no están en el ARM.

## Decisión y motivo

- **gestoria24.com es un dominio más del Worker.** Sus buzones fijos (`hola@`, `soporte@`, `contacto@`, `fundadores@`), las direcciones del equipo por el atrapa todo y lo que solo se reenvía siguen las mismas reglas que en las clínicas. El Worker manda la app del dominio en `product`: el producto de sus clínicas o la clave `gestoria`.
- **El correo guarda la app a la que escribieron en `saas_inbound_email.product`**, como los planes (`saas_plan.product = 'gestoria'`, ADR 0211): la lista es `SAAS_INBOUND_EMAIL_APPS`, las de clínicas más las que son otro sistema. Lo que razona por producto clínico sigue igual; lo que no lo es se ve con su clave.
- **Lo de gestorIA queda sin cliente** (`inboundEmailHasClients`): no se liga solo (ni por el hilo ni por el correo exacto), la Bandeja no sugiere ninguno ni ofrece elegirlo o crearlo, y ligarlo a mano responde 400. Los clientes del ARM son de las clínicas: ligarlo a uno pondría sus adjuntos en esa ficha, permitiría mandarle una propuesta de una clínica con la marca de gestorIA y le diría a Kairós que es de otra app. Tampoco cuenta en «Sin cliente», que es lo que espera que alguien diga de quién es.
- **La respuesta sale con la marca y el dominio de la app (`MailApp`, `replyAppOf`).** Lo que llegó a gestorIA sale desde `gestoria24.com` («Ada Lovelace · gestorIA», «Soporte · gestorIA» o «gestorIA» desde `hola@`) con la marca de gestorIA. En las clínicas no cambia: manda la ficha del cliente y, sin cliente, el dominio. El remitente es el de quien responde, como siempre (`GESTORIA_SMTP_FROM` es el de los correos del sistema, no el de las conversaciones).
- **Kairós no liga ni responde lo de gestorIA.** No pide «di de quién es» ni prepara la respuesta: los clientes del ARM son de las clínicas y Kairós vende esas apps. Lo atiende una persona en la Bandeja, donde el correo se marca «gestorIA».

## Alternativas descartadas

- *Una columna `app` aparte y `product` nulo para gestorIA.* Repite lo que ya dice el dominio y obliga a leer dos columnas en cada consulta del correo; los planes ya resolvieron lo mismo con la clave de la app en `product`.
- *Meter gestorIA en `CLINICAL_PRODUCTS`.* Abriría para gestorIA todo lo de las clínicas (bibliotecas, fichas, permisos), que no le corresponde.
- *Que Kairós también responda lo de gestorIA.* Le hablaría de las apps de clínicas a quien preguntó por gestorIA; necesita lo que gestorIA vende y medirse aparte.

## Consecuencias

- Cada correo a gestoria24.com queda en la Bandeja y se responde desde ahí, con hilo y con su marca. Necesita pasos a mano: publicar el Worker y encender Email Routing en la zona `gestoria24.com`; y, para que las respuestas lleguen, que ZeptoMail tenga verificado ese dominio (SPF y DKIM).
- Un correo de gestorIA no tiene ficha: sin cliente no lleva propuestas ni documentos, y su historia vive solo en la Bandeja. Revisar cuando el ARM sepa de clientes de gestorIA: entonces se ligarían a esos, y Kairós podría ligarlos y responderlos.

## Referencias

- Worker: `infra/cloudflare/email-inbound/src/route.ts` (`APPS`) y su `README.md`.
- `packages/db/src/schema/admin-arm.ts` (`SAAS_INBOUND_EMAIL_APPS`, migración `0160_el_correo_de_gestoria`), `packages/services/src/admin-staff-mail.ts` (`MailApp`, `replyAppOf`), `admin-sales.ts`, `admin-inbound-email.ts`, `admin-inbox.ts`, `admin-kairos.ts`; `apps/api/src/routes/inbound-email.ts`.
