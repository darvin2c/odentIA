# 0054 · Spam y Bloquear

Fecha: 2026-10-18 · Estado: aceptada · Precisa [0031](0031-cobro-por-accion-con-un-plan-que-vuelve-en-credito.md), [0047](0047-jev-decide-en-toda-clinica.md) y [0050](0050-el-agente-nunca-se-calla.md) · Issue 77

## Problema

Un bot, una cadena o una estafa le escribían a la clínica y Recepción los atendía como a cualquiera.

- Lo que Jev daba por ajeno recibía el texto fijo con cada mensaje.
- Si Jev dudaba, respondía el modelo y se cobraba la conversación (USD 0,50 por persona y día).
- Pasado el límite diario por persona, cada mensaje abría otro tema en «Por atender».

No existía ningún estado para decir «esto no se atiende», ni una forma de cortar a quien acosa.

Meta no es el costo. Desde el 1 de julio de 2025 cobra por mensaje y solo la plantilla; responder dentro de las 24 horas es gratis. Lo que cuesta el spam es la factura de la clínica, el modelo y el tiempo de recepción.

## Decisión y motivo

Hay dos estados de la persona, en una sola columna (`contact.screen`). Ninguno se cobra (el agente no llama al modelo) y ninguno sale en las cuatro pestañas, en Inicio, en Reportes ni en «Por registrar». Lo cambia solo `contact-screen.ts`; la historia queda en la auditoría.

- **Spam** es sobre lo que mandó. Se decide en este orden; lo que protege va primero:
  1. Quien es paciente, alguien a quien el equipo ya le escribió o quien alguien sacó con «No es spam» nunca va sola a Spam.
  2. El mismo texto 5 veces en una hora va a Spam (código, sin modelo).
  3. Jev, con 90 % o más, la manda a Spam (fase 3).
  4. Una persona del equipo puede decir «Es spam», nunca para un paciente.

  Lo que escribe se guarda y no se responde. A sus mensajes nuevos se los vuelve a mirar si el texto no se repite, como mucho 5 por día. Se queda en Spam solo si lo nuevo también es spam; si no, sale sola y el agente la atiende, aunque la haya marcado una persona. La conversación lo dice durante 7 días, con quién la había marcado. Pasados 90 días, su texto y sus adjuntos se borran.

- **Bloqueado** es sobre la persona. Lo decide solo alguien que maneja los contactos (`crm.write`: recepción, dueño y administración), con motivo y lo que pasó escrito. Nunca sale solo.
  - Nadie le escribe: ni el equipo, ni el agente, ni lo automático.
  - En WhatsApp también se bloquea con la Block Users API, que solo acepta a quien escribió en las últimas 24 horas. Si escribió antes, se bloquea en cuanto vuelva a escribir.
  - Un paciente no se bloquea: se archiva.
  - Lo de un bloqueado no se borra, porque puede servir de prueba.

- En la Bandeja, Spam y Bloqueados son dos listas junto a las pestañas, en gris. Bloqueados no lleva número: no es trabajo.

## Alternativas descartadas

- **Un solo estado, «Bloqueado» para todo.** En WhatsApp bloquear significa que la persona no puede escribir; para un error de Jev sería un castigo.
- **Responder una vez a quien cae en Spam.** Ayuda si Jev se equivoca con un paciente, pero le confirma el número a cada estafador y puede enganchar a la respuesta automática de otro negocio.
- **Que la marca de una persona del equipo sea definitiva.** Perder a alguien que vuelve a escribir para pedir una cita cuesta mucho más que una conversación.
- **Una quinta pestaña o un filtro dentro de «Cerradas».** La pestaña le da a Spam el peso de «Por atender»; dentro de «Cerradas», nadie lo encuentra.

## Consecuencias

- La Bandeja, Inicio y Reportes muestran solo lo que alguien tiene que atender.
- Un error de Jev tiene dos salidas: la persona escribe algo real o el equipo dice «No es spam».
- Revisar si suben los «No es spam» de una clínica: el umbral se mide con `eval:spam`.

## Referencias

- Código: `contact-screen.ts`, `contact-screen-actions.ts`, `conversation-state.ts` (vistas `spam` y `blocked`), `apps/worker/src/contact-screens.ts` y `setBlocked` de WhatsApp.
- Lienzo del issue 77, decisiones 1 a 16.
- [Block Users API](https://developers.facebook.com/docs/whatsapp/cloud-api/block-users) y [precios de WhatsApp](https://developers.facebook.com/docs/whatsapp/pricing), leídas el 2026-10-18.
