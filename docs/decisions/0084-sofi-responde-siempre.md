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

## Alternativas descartadas

- **Mantener el horario y los canales solo para las urgencias.** Deja al resto de los pacientes esperando, contra la regla del producto, y suma configuración que casi nadie necesita.
- **Detectar la urgencia solo con el modelo de decisión.** Ya existe (`urgency`), pero no sirve cuando el modelo falla, se agota el tope o la corrida espera al equipo, que son justo los casos que había que cubrir.
- **Un mensaje de emergencia con Sofi apagada.** El dueño lo descartó: si la clínica la apaga, no se hace nada.

## Consecuencias

- Se gana que ningún paciente espera para recibir respuesta y que una urgencia siempre recibe a dónde llamar.
- Se sacrifica que una clínica que quería atender ella misma en el día ya no puede apagar a Sofi por horario. Le queda apagarla, o tomar la conversación: Sofi se calla 15 minutos cuando el equipo escribe.
- Una falsa alarma cuesta un aviso de más y un caso con prioridad alta. Hay que revisar la lista de frases si los equipos se quejan de alarmas que no lo eran, o si aparece una emergencia que no se reconoció.
- Un país nuevo no da número hasta que se comprueba en una fuente oficial.

## Referencias

`packages/agent/src/run.ts`, `alarm.ts`, `decision/route.ts` (`URGENT_SCORE`, `handoffFallbackNotice`), `packages/clinical/src/emergency.ts`, `packages/services/src/emergency-advice.ts`, `knowledge.ts`, `writing-hours.ts`; migración `0091_sofi_responde_siempre.sql`.
