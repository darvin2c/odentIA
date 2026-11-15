# 0191 · Ariadna responde por chat a las clínicas con app

Fecha: 2026-11-15 · Estado: aceptada · Extiende la [0190](0190-kairos-vende.md) («a una clínica con app no le responde Kairós») y la [0146](0146-la-ayuda-elige-con-jev-y-muestra-la-guia.md) (la Ayuda con la guía); respeta la [0013](0013-ayuda-responde-con-la-guia-del-sistema.md)

## Problema

Una clínica que ya usa su app escribe a Sallca por WhatsApp para preguntar cómo se hace algo («¿cómo anulo una cita?»). Kairós no le responde (es venta) y la conversación espera a Soporte, a veces horas, para algo que la guía de la Ayuda ya dice. Mezclado ahí llegan también un cobro, un «no me deja» y hasta el mensaje de un paciente.

## Decisión y motivo

- **Ariadna atiende el chat de la clínica que ya tiene su app; nunca Kairós.** Se decide por el cliente de la conversación (`saas_client.organization_id`), que ligó una persona, nunca por el teléfono. El mismo ciclo del worker de Kairós (`kairos-vende`): un turno por mensaje, los mismos topes del día (uno solo entre los dos), la pausa de «Lo atiendo yo» y las comprobaciones al reservar y antes de escribir (`kairosChatBlocked` con el agente).
- **Con la guía de su producto y sin datos de la clínica.** `askHelpByChat` usa lo mismo que la Ayuda de la app (`decideHelp`, Jev, quien redacta y `helpWrittenProblem`), sin pantalla y con el mismo filtro (`withoutPersonData`, 0146): lo que puede ser el dato de una persona (solo cifras, cuatro o más seguidas, un correo o un nombre suelto) no viaja así; se le quitan correos y cifras y, si lo que queda sigue pareciéndolo, no viaja. Una pregunta corriente viaja tal cual, con sus cifras cortas o un nombre dentro. Lo redactado además no puede traer un correo, una dirección ni un dominio (`ariadnaWrittenProblem`); si los trae, sale la guía tal cual. Lo que sale es la guía tal cual, lo redactado y comprobado, o un texto fijo. Lleva el enlace a la pantalla en la app de esa clínica, que pide iniciar sesión y aplica sus permisos. No sabe quién escribe ni con qué rol.
- **Lo que no es de la guía se aparta antes**, por palabras y, si las palabras no dicen nada, con una pregunta más a Jev (`ariadna_chat`, con el umbral de la Ayuda):
  - cobros, su plan, comprar algo más, otra sede u otro producto: pasa a **Administración**; la conversación es de Administración desde ese mensaje: lo que escribió desde nuestra última respuesta, lo que llegue después, su actividad, lo que responde Ariadna y Hoy quedan solo para Administración; cada respuesta nace «Solo administración» (quitarlo se dice aparte, `adminOnlyOverride`), y Soporte no ve que se pasó ni puede devolverla a Ariadna. Si Ariadna no puede responder (el tope o un error), un cobro reconocido por las palabras igual va a Administración;
  - «no me deja», un error o un permiso: le **ofrece** la Ayuda de la app (ahí sí ve su cuenta) o Soporte; con un sí, o si insiste, **pasa a Soporte**;
  - una cifra o un dato de su clínica: por aquí no se dan, dice dónde verlo en la app;
  - un paciente: le explica que escriba a su clínica y una persona lo ve en Hoy;
  - lo que la guía no tiene o no está segura: no inventa, ofrece Soporte.
- **Pasar es pausar.** Como Kairós: la conversación queda pausada sin persona, con a quién y por qué (`kairos_chat_turn.ariadna_reply`), y «Responder» sale en Hoy para quien corresponde. «Devolver a Ariadna» la reanuda.
- **Se presenta y firma.** «Soy Ariadna, la Ayuda de odentIA», recuerda que también puede preguntar en la app y firma «Ariadna · <marca>». Lo suyo queda en el historial con su nombre (`by_ariadna`).
- **Su propio interruptor**, junto al de Kairós, solo Administración (`kairos_setting.ariadna_enabled`), nace apagado y se prende con la medición (`eval:ariadna-chat`) sin graves y el sí del dueño. Grave: dar o inventar un dato de la clínica, un paso que la guía no tiene, responder un cobro o atender a un paciente como a la clínica.

## Alternativas descartadas

- *Que Ariadna lea la cuenta de la clínica para decir qué le falta.* Por chat no se sabe quién escribe: ese estado lo da la Ayuda de la app, con su sesión y su rol.
- *Que Kairós también responda a las clínicas con app.* Kairós vende; mezclar soporte y venta en la misma voz hace que un cobro o un «no me deja» se responda como una venta.
- *Un modelo que escriba la respuesta libre.* Sale más natural, pero puede inventar un paso; la guía tal cual se comprueba sin modelo.

## Consecuencias

- Lo que se le escribe a Sallca por chat desde una clínica con app llega a Jev (con el filtro de la Ayuda: sin lo que parece el dato de una persona, no sin toda cifra) y, si junta varias respuestas, al modelo que escribe; el costo va con el origen `ayuda` de esa clínica.
- Si una persona mueve la conversación a otro cliente mientras Ariadna responde, el turno se omite: lo pensado era para otra clínica.
- Las palabras que apartan cobros y pacientes son una red por forma: algo dicho de otra manera depende de la pregunta a Jev; se mide con el banco.
- Si una persona ligó mal la conversación a una clínica, Ariadna responde a quien no es: la conversación sigue siendo de quien la ligó.

## Referencias

- Servicios: `packages/services/src/ariadna-chat.ts`, `kairos-sells.ts` (`ariadnaChatContext`, `getAriadnaChats`), `admin-inbound-chat.ts` (`prepareKairosChatReply` con `agent`).
- Worker: `apps/worker/src/kairos-vende.ts` (`answerAriadna`). Medición: `packages/agent/src/eval-ariadna-chat.ts` y `eval/ariadna-chat.json`. Migración `0133_ariadna_en_los_chats`.
