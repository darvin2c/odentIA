# 0125 · Inicio: una fila por persona, tres grupos y un solo panel para responder

Fecha: 2026-10-31 · Estado: aceptada · Ajusta a [0025](0025-un-pendiente-un-lugar.md) (la lista de «Te espera») y a [0050](0050-el-agente-nunca-se-calla.md) (quién puede responder un tema)

## Problema

«Te espera» decía qué faltaba, pero no ayudaba a resolverlo:

- Una sola lista mezclaba veinte tipos de fila, y cada uno decidía qué botón mostrar. Con 19 filas iguales en rojo, nada destacaba; en el teléfono, las barras a todo lo ancho tapaban los nombres.
- La misma persona salía varias veces: quien resolvía la cita de Elena no veía su presupuesto.
- «1 persona espera respuesta» era un número que mandaba a la Bandeja, sin decir quién ni qué pidió.
- «Tomar este tema» no hacía nada que se viera, y era el mismo caso con otro nombre: el servidor ya deja el tema a quien envía.
- Se respondía a ciegas: una pregunta y una caja. El resumen existía, pero nada decía que se abría tocando la fila, y no tenía dónde responder.
- En una atención sin firmar, el único botón a la vista era el que la anula. En una cita sin cerrar, «No vino», como si fuera lo único que pudo pasar.

## Decisión y motivo

- **Tres grupos con la escala de siempre:** Ahora, Hoy y Sin apuro (`band`, lo decide el servidor en `workspace-home.ts`). «Sin apuro» va plegado. La insignia sobra: el grupo ya lo dice.
- **Una fila por persona.** Queda lo más urgente y, si empatan, lo que escribió; lo demás va como «También» (`also`), en la fila y en el panel, si su rol puede verlo. Un pedido sobre sus datos no se pliega: tiene plazo.
- **Un solo botón, pequeño y siempre a la vista**, también en el teléfono: turquesa solo en «Ahora», claro en lo demás. Toda la fila abre lo mismo; solo «Llegó» y «Hecha» se hacen en la fila.
- **Cada conversación que espera es una fila**, con nombre y pregunta. Las cinco que más llevan; las demás, en la Bandeja.
- **Se va «Tomar este tema» de Inicio: siempre «Responder».** Responder lo que nadie tomó ya no exige tomarlo antes. Lo que tiene otra persona dice «Con Dr. Luis Prado» y, dentro, «Responder yo», que se lo pasa a quien escribe y le avisa al otro.
- **Un solo panel** (`PersonPanel`, `getPersonPanel`), en Inicio y en la Bandeja: sus mensajes, por qué se lo pasó el agente, sus citas, lo pendiente y la caja fija al pie. **Cada parte la decide el servidor según el rol**: recepción no ve lo clínico ni los cobros; odontología, ni cobros ni oportunidades, y del presupuesto solo lo que indicó; caja, solo la pregunta de un pago y la deuda.
- **Paneles para lo demás:** «¿Vino?» pregunta, con «Sí, registrar la atención» para quien atiende y «No vino» y luego «Reagendar» para los demás. «Llamar» muestra el número y «¿Qué te dijo?». «Revisar» en una atención dice qué tiene y qué falta, con «Continuar» primero y anular al final.
- **Al enviar**, se confirma y se ofrece «Siguiente: Rosa Quispe», con un botón: pasar solo podría hacer escribirle a quien no era.
- **Ayudas en la caja, sin modelo:** horarios libres con quien la atendió y precios de su lista, en textos fijos que se pueden cambiar y respetando cómo se dice cada precio. Tocar un horario no lo aparta.
- **«Enseñárselo a Sofi»** deja una lección por aprobar en Aprender. Nunca lo clínico ni lo de un pago: el servidor lo rechaza.
- **La colegiatura se escribe una vez**, desde el panel de la atención.
- **Los avisos que WhatsApp clasificó como publicidad van juntos en una fila**, que dice la consecuencia: no le llegan a todos. El panel trae un texto solo de aviso preparado por odentIA, listo para pedir otra revisión. WhatsApp decide: la pantalla nunca lo da por hecho. «Invitar a volver» se pide como promoción, porque lo es.

Quien trabaja debería ver a la persona, no al tipo de fila; empezar por lo más urgente, con el color y las palabras diciéndole por dónde; y resolver sin salir de Inicio, con lo que hace falta a la vista.

## Se apartó del lienzo

- El lienzo pedía «Enviar y resolver» y «Enviar, sigue pendiente». [0122](0122-responder-cada-tema-por-su-cuenta.md), posterior, ya decidió un solo «Enviar» y «Dejar pendiente» después, porque resolver se corrige y enviar no. El panel hace lo mismo que la Bandeja.

## Alternativas descartadas

- *Pasar solo a la siguiente persona*: podrías escribirle a quien no era.
- *«Lo veo después», «Listo» o «Cancelar»*: la × ya cierra.
- *«No contestó»*: sin guardar nada no cambia nada, y la fila sigue ahí.
- *Tomar el tema al empezar a escribir*: si lo dejas a medias, desaparecería de la lista de los demás.
- *Respuestas redactadas por el modelo*: más costo y más estado, sin necesidad por ahora.
- *«Empezar por…»*: el orden de la lista ya lo dice.

## Consecuencias

- Si dos responden a la vez, el segundo lo sabe al enviar y conserva lo escrito: nadie responde doble.
- Un tema se responde sin tomarlo antes, así que dos personas pueden estar escribiendo lo mismo un rato; el servidor solo deja enviar al primero.
- Lo que está en «Sin apuro» no se ve sin abrirlo: se revisa si algo se queda ahí sin que nadie lo mire.
- Los borradores quedan en el navegador de quien escribe, no en el servidor.
- Falta medir si mejoró: cuánto tarda en responderse un tema, cuántos se resuelven sin salir de Inicio y cuántas veces hace falta abrir la Bandeja desde el panel.

## Referencias

`packages/services/src/workspace-home.ts` (`bandWaiting`), `person-panel.ts`, `person-panel-suggestions.ts`, `agent-learning.ts` (`proposeLessonFromReply`), `automation-messages.ts` (`NOTICE_TEXTS`), `packages/clinic-app/src/components/home/waiting-list.tsx`, `home/row-panels.tsx`, `person/person-panel.tsx`.
