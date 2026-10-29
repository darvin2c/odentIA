# 0084 · Sofi responde siempre; el único horario es el de recontacto

Fecha: 2026-10-23 · Estado: aceptada · Modifica [0024](0024-ninguna-conversacion-queda-abierta.md) («fuera de horario se responde al abrir») y precisa [0042](0042-una-puerta-para-escribirle-a-alguien.md). Entrega 0 del plan de latidIA (issue #229), decisión 11 del lienzo.

## Problema

La página de Sofi tenía dos límites que dejaban a un paciente sin respuesta: «A qué horas responde» (Límites › Horario) y «En qué canales responde» (Límites › Canales). Con un horario de 8:00 a 20:00, quien escribía a las 2 a. m. «¿me pueden atender?» esperaba hasta la mañana; con Instagram desmarcado, lo que llegaba por ahí no lo respondía nadie. El dueño del producto lo dijo así: el horario era para recontactar en una hora decente, nunca para responder.

La urgencia empeoraba el problema. «Me duele el pecho y no puedo respirar» esperaba igual que cualquier mensaje: fuera del horario, durante los 15 minutos de un equipo que conversaba (ADR 0050) o callado por el tope por persona. Además, el aviso fijo que sale cuando el modelo falla no hablaba de emergencias, y Sofi nunca daba el número de emergencias del país.

## Decisión y motivo

- **Sofi responde siempre, a toda hora y en todos los canales.** Se quitan «A qué horas responde» y «Canales» (columnas `active_from_min`, `active_until_min` y `channels` de `agent_config`, migración 0091). Si la clínica apaga a Sofi, no responde: es su decisión y no se hace nada más.
- **Un solo horario: el de recontacto.** El «Horario para escribir» (decisión 18 v3, ADR 0042) pasa a llamarse «Horario de recontacto» y gobierna todo lo que el sistema inicia: retomar lo pendiente, recordatorios, controles, insistir y despedirse. Ya no lo recorta un horario del agente.
- **Una señal de alarma no espera a nadie.** `hasAlarmSignal` (`packages/agent/src/alarm.ts`) es una red por palabras, sin modelo, para que funcione aunque el modelo falle o se llegue a un tope. Solo entran frases fuertes: dolor de pecho, no poder respirar, desmayo, convulsión, sangrado que no para, la garganta que se cierra, señales de un derrame y hacerse daño. Con una:
  - la corrida no espera al equipo que conversa y no se calla porque la persona cite su mensaje o haya llegado al tope por persona;
  - el caso pasa con prioridad alta («Urgencia clínica»), decida lo que decida el modelo de decisión;
  - el aviso empieza por a dónde llamar, tanto el que redacta el modelo como el fijo.
- **El número de emergencias, por país y comprobado.** `emergencyNumberFor` (`@odentia/clinical`, con la fuente de cada uno) da Perú 106, Colombia 123, Chile 131, México 911, Costa Rica 911, Ecuador 911, El Salvador 132 y Argentina 911. Un país sin número comprobado dice «la emergencia más cercana»: nunca se inventa uno. Va en lo que sabe Sofi de la clínica junto al teléfono para urgencias de la clínica, y lo dice el aviso fijo (`emergencyAdvice`).
- **El número de emergencias, solo si la vida puede estar en peligro.** Una urgencia que marca el modelo de decisión sin señal de alarma (un dolor fuerte, un diente roto, una hinchazón con fiebre) pasa con prioridad alta y el aviso empieza por el teléfono para urgencias de la clínica (`urgentClinicPhone`), sin el número de emergencias. Medido con el modelo real: con la primera versión, «me duele horrible la muela» recibía «Llama ahora al 106», y un dolor de muela no es para una ambulancia. Si lo que contó podría llegar a eso, el modelo puede decirle que, si pasa, vaya a la emergencia más cercana.
- **El vencimiento de una tarea no es una hora de respuesta.** El aviso de una derivación no promete el plazo interno de la tarea del equipo («te responderá antes de las 2:45 a. m.» salió en la misma medición).

## Alternativas descartadas

- **Mantener el horario y los canales solo para las urgencias.** Deja al resto de los pacientes esperando, contra la regla del producto, y suma configuración que casi nadie necesita.
- **Detectar la urgencia solo con el modelo de decisión.** Ya existe (`urgency`), pero no sirve cuando el modelo falla, se agota el tope o la corrida espera al equipo, que son justo los casos que había que cubrir.
- **Un mensaje de emergencia con Sofi apagada.** El dueño lo descartó: si la clínica la apaga, no se hace nada.

## Consecuencias

- Se gana que ningún paciente espera para recibir respuesta y que una urgencia siempre recibe a dónde llamar: emergencias si su vida puede estar en peligro, la clínica si no.
- Se sacrifica que una clínica que quería atender ella misma en el día ya no puede apagar a Sofi por horario. Le queda apagarla, o tomar la conversación: Sofi se calla 15 minutos cuando el equipo escribe.
- Una falsa alarma cuesta un aviso de más y un caso con prioridad alta. Hay que revisar la lista de frases si los equipos se quejan de alarmas que no lo eran, o si aparece una emergencia que no se reconoció.
- Una frase negada justo antes no es una alarma (2026-10-29, `ALARM_NOT` de `product-agent.ts`, en las frases comunes y en las de cada producto): «tos y congestión, pero no me falta el aire» recibía el 106 en todas las rondas de latidIA. Solo cuenta la negación pegada a la frase («no me duele el pecho», «sin dolor en el pecho», «no tiene dificultad para respirar»); «nunca», el pasado de antes («no tenía») y «no se» (sin tildes también es «no sé») no la quitan, y hacerse daño ni el murciélago se niegan. En las 12 275 líneas de persona de la auditoría, las marcadas bajan de 7 a 3 (quedan las del murciélago), no se pierde ninguna de `eval/urgencias-medicas.json`, y ese caso, repetido en 3 bases nuevas, no recibió el 106 en ninguna.
- Un país nuevo no da número hasta que se comprueba en una fuente oficial.

## Referencias

`packages/agent/src/run.ts`, `alarm.ts`, `decision/route.ts` (`URGENT_SCORE`, `handoffFallbackNotice`), `packages/clinical/src/emergency.ts`, `packages/services/src/emergency-advice.ts`, `knowledge.ts`, `writing-hours.ts`; migración `0091_sofi_responde_siempre.sql`. Medición con el modelo real: `GUIONES=urgencias` en `packages/agent/src/consumo.eval.ts` (sección 3c).

## Actualización del 2026-10-29: una posible rabia es una señal de alarma

En una ronda de latidIA con casos nuevos al azar (issue #328), una persona escribió que despertó con un murciélago en su cuarto, que no sabía si la había mordido y que tenía un puntito rojo en el brazo. Sofi le dio el teléfono de urgencias del consultorio y pasó el caso al equipo; el juez esperaba que primero le dijera que fuera hoy a una emergencia. Falló igual en las dos versiones medidas: ninguna frase de la lista hablaba de una mordedura, y para el modelo de decisión era una urgencia sin peligro para la vida.

- **Una mordedura de animal, o un murciélago que pudo tocar a la persona, es una señal de alarma.** La rabia es mortal una vez que aparecen los síntomas, y la evita la vacuna a tiempo, que no pone un consultorio ni una clínica dental. Lo dicen fuentes oficiales:
  - La OMS cuenta el contacto directo con un murciélago como exposición grave (categoría III: lavar la herida, vacunar y dar inmunoglobulina de inmediato). En las Américas, los murciélagos hematófagos son hoy la principal fuente de rabia humana.
  - El MINSA atiende toda mordedura de un animal como una urgencia (NTS N.° 131-MINSA/2017/DGIESP, con su cuadro de manejo en la alerta AE-CDC N.° 017-2023). Cuenta como exposición grave la mordedura o el arañazo de un animal silvestre, como el murciélago, o de uno desconocido, y la de un perro o un gato en la cara, la cabeza, el cuello o la punta de los dedos.
  - La mordida de un murciélago puede ser tan pequeña que no se note (CDC). Por eso basta despertar con uno en el cuarto.
- **Solo frases fuertes.** Entran un animal que muerde a una persona («me mordió un perro», «a mi hijo lo mordió un perro», «un perro mordió a mi hija», «una mordedura de gato») y un murciélago con contacto, sueño, el cuarto, una herida o la emergencia en la misma frase. No entran:
  - el arañazo de una mascota: si es leve, el MINSA observa al animal diez días antes de vacunar, y lo que atiende siempre como urgencia es la mordedura;
  - los roedores, que no transmiten la rabia;
  - un murciélago sin contacto («hay murciélagos en la selva», la vacuna antes de un viaje);
  - lo que una mascota muerde sin morder a nadie: «mi gato mordió y rompió el protector bucal» salió en una ronda de odentIA.
- **En los dos productos.** Las frases van en la lista común (`alarm.ts`), no en la de latidIA: el riesgo no depende de la clínica, y a un niño mordido en la boca por un perro lo pueden llevar a su dentista. Lo que en una clínica dental podía dar una falsa alarma («al morder», «la mordida», los aparatos que muerden las mascotas) queda fuera por la forma de las frases.
- **Medido el 2026-10-29**, con pacientes inventados por un modelo, no con una clínica real:
  - En las 12 275 líneas de persona de las rondas anteriores de la auditoría (10 644 de odentIA y 1 631 de latidIA), las frases nuevas solo marcan las del caso del murciélago.
  - Con `GUIONES=urgencias` y el modelo real, en odentIA, la mordida de perro en la boca y el murciélago al despertar pasan con prioridad alta y su aviso empieza por el 106. «Mi perro me mordió la placa» no dispara la alarma, y las urgencias de la boca siguen sin el 106.
  - En la ronda de latidIA con los mismos 20 casos, ninguna otra conversación disparó las frases nuevas, y cumplieron todo 7 (antes, 4 y 8). En el caso del murciélago, la primera respuesta dijo a dónde ir en 8 de 9 corridas, frente a 0 de 2 antes; la otra lo condicionó a «si crees que tu vida puede estar en peligro». No cumplió todo en ninguna, como antes, por fluidez: ante una persona que insiste, repite el teléfono de la clínica y la misma advertencia en cada respuesta.

### Alternativas descartadas

- **Solo en latidIA.** Deja sin aviso al paciente de una clínica dental mordido en la cara, que el MINSA cuenta como exposición grave.
- **Cualquier mención de un murciélago.** Sin contacto no hay exposición (OMS), y la vacuna antes de viajar no es una urgencia.
- **Un aviso propio para la rabia** (lavar la herida y vacunarse hoy). Es consejo clínico, que Sofi no da. «La emergencia más cercana» ya le dice a dónde ir.

### Consecuencias

- La mordida leve del perro de la casa también recibe a dónde llamar y pasa con prioridad alta. Es la falsa alarma que se acepta, porque el MINSA la atiende como urgencia. Con la alarma el camino es derivar: en ese turno no se reserva hora, y la reserva queda para el equipo.
- La red es por frase: «no sé si me mordió», sin nombrar al animal, no la dispara. La dispara el mensaje en que cuenta lo del murciélago, que suele ser el primero. Cada mensaje que vuelve a nombrarlo junto a la emergencia o la mordida la dispara de nuevo, y ese aviso vuelve a empezar por el 106.
- Hay que revisar las frases si los equipos se quejan de avisos por mascotas, o si aparece otra forma común de contarlo.

Referencias: `alarm.ts` y `alarm.test.ts`; `consumo.eval.ts` (`URGENCIES`); `eval/urgencias-medicas.json`. OMS, nota descriptiva «Rabia» (who.int/news-room/fact-sheets/detail/rabies); CDC-MINSA, alerta epidemiológica AE-CDC N.° 017-2023, anexo 2 (el cuadro de la NTS N.° 131-MINSA/2017/DGIESP, pág. 26); CDC, «Preventing Rabies from Bats» (cdc.gov/rabies/prevention/bats.html).
