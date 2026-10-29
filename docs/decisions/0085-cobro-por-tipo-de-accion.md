# 0085 · Cobro por tipo de acción, Argos con preguntas incluidas y almacenamiento por GB

Fecha: 2026-10-24 · Estado: aceptada; implementadas las fases 1 y 2 (contar y cobrar), 3 (sin topes y el presupuesto), 4 (lo que ve la clínica), 5 (la administración), 6 (la web, los términos y la presentación de Fundadores) y 7 (`eval:month` compara el costo de cada conversación con el peor de su tipo); los planes de producción los crea la administración · Precisa [0031](0031-cobro-por-accion-con-un-plan-que-vuelve-en-credito.md) (qué se cobra y a qué precio), cambia el 40 % de [0062](0062-fundadores-alta-por-invitacion-y-precios-de-la-administracion.md) por 50 % y sigue a [0084](0084-sofi-responde-siempre.md) («Sofi responde siempre»). Estudio «Cómo cobra odentIA» y lienzo «Cobro por tipo odentIA» (aprobado el 2026-10-24).

## Problema

La ADR 0031 cobraba igual cualquier conversación de Sofi y cualquier consulta de Clío. Una persona que solo preguntaba el horario costaba lo mismo que una a la que Sofi le reservó una cita, y una receta suelta lo mismo que una primera consulta con odontograma, plan con opciones y receta. Medido el 2026-10-23, lo que nos cuesta cada una crece en esa misma proporción: una receta cuesta unos USD 0,0002 y una primera consulta completa, 0,004.

También faltaban tres cosas. Argos respondía gratis sin límite de dinero (solo un tope de 200 preguntas al día). El almacenamiento, que es lo único que crece solo cada mes, no se medía ni se cobraba. Y la cita recuperada se cobraba también a quien solo reprogramaba su tratamiento, y al que Argos le escribía por una deuda.

## Decisión y motivo

Tres principios del dueño del producto: **todo lo que hace un agente es una acción y se cobra**; **nunca se cobra doble**; **ningún agente se calla por un tope: el único límite es el presupuesto de la clínica**.

- **Sofi, según lo que pasó en la agenda**, una vez por persona en la ventana de las condiciones comerciales (24 horas):
  - `informa` (USD 0,10; USD 0,20 desde la [0105](0105-informa-a-020-y-su-bloque-de-mensajes-en-sombra.md), que además le pone un bloque de mensajes, por ahora en sombra): no cambió nada en la agenda; respondió, confirmó una cita, dio la dirección o un precio;
  - `gestiona` (USD 0,50): movió o canceló una cita, o reservó una nueva, en esa ventana;
  - `agenda` (USD 1,00): la cita que reservó Sofi se dio. Se cobra como una fila aparte con la diferencia (USD 0,50) cuando el paciente asiste; si no viene, queda en «Gestiona».
  - Se lee de las propuestas ejecutadas de esa persona (`agent_proposal`) y de las reservas desde el enlace de esa ventana. Mientras la conversación no se cobró, sube de tipo sola: al ejecutarse la propuesta, al reservar desde el enlace o en la corrida siguiente.
- **Clío, según lo que dejó hecho y el odontólogo confirmó**, una vez por atención:
  - `completa` (USD 0,50): armó un presupuesto (una indicación del plan, con una o varias opciones);
  - `estandar` (USD 0,20): un diagnóstico, el odontograma o dos bloques o más;
  - `simple` (USD 0,10): un solo bloque (receta, nota o control).
  - No hay tope por odontólogo ni regla de pausas: cada consulta es un paciente atendido que le dejó dinero a la clínica.
- **La cita recuperada, USD 2**, cuando la persona **no tenía cita ni tratamiento en curso** al escribirle Argos, reservó en los días de las condiciones y vino. Lo que decide es si ya tenía cita, no el nombre del mensaje:
  - no cuenta si tenía una cita futura vigente, ni si tenía un tratamiento aceptado sin terminar;
  - el saldo vencido (`cobranza_vencida`) no recupera a nadie y nunca cuenta;
  - el aviso de un control sin cita sí cuenta (antes se regalaba);
  - si cuenta, se cobra solo ella: la conversación se devuelve y no sube a «Agenda».
- **Argos: preguntas incluidas y paquetes.** El plan trae 300 preguntas al mes; cada paquete de 100 cuesta USD 3 y se suma solo con el permiso de quien administra la clínica, o sin preguntar si encendió «Sumar solas» (`argos_auto_pack`, apagado al empezar). No cuentan las preguntas que Argos no pudo responder ni las que fueron a la Ayuda. Un paquete comprado en los últimos 7 días del mes dura hasta el cierre del siguiente: lo que le quedó sigue. Reemplaza al tope de 200 al día.
- **Almacenamiento: 20 GB incluidos y USD 0,20 por GB extra al mes.** Se mide cada día lo guardado (`storage_usage_day`: documentos, tomografías y adjuntos de conversaciones) y el extra del mes sale del promedio de sus días, como cobra el proveedor. Nunca se deja de guardar. La base de datos no se cobra.
- **Un plan sin precios por tipo** cobra cada tipo con el único precio de su acción, como antes de esta decisión, y su conversación no sube a «Agenda»: los planes que ya existen siguen cobrando igual hasta que se les ponen los precios nuevos.
- **Precios fijos y negociables.** Informa, Simple, Estándar, el paquete de preguntas y el GB extra no admiten descuento negociado (`fixed_price_tiers`): son baratos y cualquier descuento los dejaría sin margen. Solo se negocian Gestiona, Agenda, Completa y la cita recuperada, como en la ADR 0031. La comprobación del doble se hace por tipo: un precio negociable, al descuento máximo, nunca baja del doble de su peor costo. Uno fijo es barato a propósito y su peor costo es un caso extremo: por debajo del doble se guarda y queda «Atento» (la consulta simple en una atención absurda de 60 pausas que deja una sola receta vale 1,9 veces; con Fundadores, menos de lo que cuesta).
- **Fundadores, 50 % menos** en todo, solo para las 20 primeras clínicas y durante sus 12 meses garantizados.
- **Sin topes; el presupuesto es el único límite.** Se quitan el tope de 40 respuestas por persona y día y el tope diario de corridas de Sofi (`agent_config.daily_run_limit`, migración `0094_sin_topes`). Al llegar al presupuesto del mes que fija la clínica:
  - Sofi pasa al equipo a quien no estaba conversando, con un mensaje fijo, sin la IA y sin cobro, una sola vez por persona y día (D4): «Gracias por escribir a {clínica}. En un momento te atiende alguien del equipo.». En el chat web sale el aviso de siempre, que pide dónde avisarle. Una alarma pasa con su aviso, como siempre (ADR 0084);
  - Clío no empieza a escuchar en una atención nueva; la que ya dictaba (tiene gasto de IA con su `encounter_id`) sigue hasta firmarse;
  - Argos no escribe para recuperar: esos mensajes esperan y, cuando la clínica sube el presupuesto o empieza otro mes, salen los que siguen teniendo sentido; si la persona ya tiene su cita, se descartan solos (D5). Los recordatorios, los avisos de cita y el saldo vencido siguen;
  - Argos responde lo incluido y no suma paquetes, ni con permiso ni solo;
  - nada queda a medias: lo que ya empezó se termina y se cobra («Cobrado tras el presupuesto»: la cita que vino, la conversación que ya estaba abierta);
  - el almacenamiento no cuenta para el presupuesto: guardar nunca detiene a un agente.
- **Postpago.** Todo, también el paquete de preguntas y el almacenamiento, va en la factura del mes o de la quincena. No hay recargas ni pagos por adelantado.
- **Cada gasto de IA dice a qué acción pertenece** cuando se sabe (`ai_usage.encounter_id`, `report_question_id`), para ver después lo que costó cada cosa.
- **«Costo y margen» en la administración**, en la ficha de cada clínica y de todas en Inicio:
  - lo cobrado sin impuesto frente a lo que nos costó, por agente y tipo;
  - lo que se regala va en su fila: las preguntas incluidas, Jev, las pruebas y lo que pasó al equipo;
  - el espacio se calcula al precio del proveedor y el servidor con un estimado por clínica;
  - el margen se dice también tras la comisión del vendedor, que se calcula sin impuesto.
  - Una alarma interna avisa cuando la IA pasa del 20 % de lo que paga la clínica o de USD 30 al mes, y nunca corta nada. También se avisa de la Fundadora sin encender un agente en 60 días.
  - Reemplaza a «Margen bajo dos meses seguidos».
- **WhatsApp ni se cobra ni se estima.** Se quitan las tarifas de Meta de la administración (`saas_whatsapp_rate`, migración `0095_sin_tarifas_de_whatsapp`): la clínica lo revisa en Meta con el enlace.

## Alternativas descartadas

- **Un precio único por acción (ADR 0031).** Hace que lo simple parezca caro, y la clínica con anuncios, que recibe muchas preguntas de precio, paga como si Sofi le reservara a todos.
- **Tope de Clío por odontólogo (USD 29) o escalones de Sofi.** El dueño los descartó: se cobra por acción, y los tipos ya hacen que lo simple cueste poco.
- **Cobrar «Agenda» solo al asistir, o solo al reservar.** Al reservar Sofi ya hizo su trabajo, pero sin asistencia «no es cita»: por eso reservar es «Gestiona» y sube al asistir.
- **Paquetes de preguntas por adelantado o recargas con bono.** odentIA es postpago.
- **Un tope de preguntas al día, de pausas, de respuestas por persona o de corridas al día.** Callan a un agente; el límite es el presupuesto que fija la clínica. Quien escribe sin parar (un bot) lo detecta el spam (ADR 0054), no un tope.

## Consecuencias

- La clínica mediana del estudio pasa de USD 288 a unos 224 al mes, con 96 % de margen típico y 77 % en el peor caso tras la comisión.
- Una conversación cobrada que después mueve una cita no sube de tipo: lo cobrado no se reescribe (un disparador lo impide). Pasa solo si la ventana cruza el cierre del mes.
- El tipo de una conversación se decide con las propuestas del agente y las reservas del enlace; una cita que mueve el equipo no cuenta como trabajo de Sofi.
- Hay que medir con clínicas piloto la mezcla real de tipos y los GB.

## Referencias

`packages/services/src/saas-actions.ts` (`conversationTierOf`, `consultationTierOf`, `recoveredSql`, `countAgendaUpgrade`), `saas-included.ts` (`getArgosAllowance`, `ensureArgosQuestion`, `countStorageAction`), `saas-invoicing.ts`, `seed-saas-billing.ts`, pruebas en `saas-tiers.test.ts`; `saas-terms.ts` (`assertClioCanListen`, avisos del presupuesto), `automation.ts` (`BUDGET_HOLD`), `packages/agent/src/run.ts` (el presupuesto en Sofi), `saas-cost.ts` (`getClinicCostMargin`, `getCostMarginOverview`), pruebas en `saas-budget.test.ts` y `saas-cost.test.ts`; migraciones `0092_cobro_por_tipo.sql`, `0093_cobro_por_tipo_reglas.sql`, `0094_sin_topes.sql` y `0095_sin_tarifas_de_whatsapp.sql`.
