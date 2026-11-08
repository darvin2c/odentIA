# 0144 · El presupuesto enviado también abre su oportunidad

Fecha: 2026-11-06 · Estado: aceptada · Precisa a [0028](0028-ventas-que-se-mueven-solas.md)

Precisada por [0153](0153-presupuesto-con-caminos.md): aceptado en parte con algo que espera respuesta, la oportunidad sigue abierta; se decide al final.

Precisada el 2026-11-07 (QA del perfil del paciente, X7, y su revisión): «la más reciente» es la abierta más reciente de la persona que no está unida a otro presupuesto, sea cual sea su servicio. La ficha mostraba como de un tratamiento la oportunidad de otro presupuesto; y exigir el mismo servicio dejaba abierta la que anotó el agente y abría otra cuando lo presentado no repetía su servicio (interés «Ortodoncia», presupuesto «Brackets metálicos»). Si no hay ninguna, se abre la suya.

## Problema

Con la 0028, una oportunidad nace cuando la persona pide algo concreto (la anota el agente) o cuando el equipo la crea, y avanza sola con la cita, el presupuesto y su respuesta. Lo que se vende en el sillón quedaba fuera: el odontólogo indica, arma y entrega el presupuesto sin que nadie haya preguntado antes, y el tablero no se enteraba. Oportunidades decía que había menos ventas en curso de las que había.

Al resolverlo aparecen otros huecos, porque desde ahora casi toda venta tiene un presupuesto detrás:

- la regla «se une a la del mismo tratamiento o, si no hay, a la más reciente» dejaba que el segundo presupuesto de una persona tomara la oportunidad del primero mientras este esperaba respuesta;
- la revisión de un presupuesto ya decidido podía tomar otra oportunidad y ganarla: la misma venta contada dos veces;
- un presupuesto anulado dejaba su oportunidad abierta, diciendo que se cerraría sola;
- lo que Sofi anota cuando la persona pregunta por un tratamiento de su presupuesto pendiente, o lo que anota la madre de un menor, abría otra tarjeta para la misma venta;
- el presupuesto que nadie responde dejaba su oportunidad abierta para siempre, inflando lo que el tablero da por en curso.

## Decisión y motivo

- **Entregar un presupuesto sin una oportunidad abierta que le corresponda abre la suya** (`linkPresentedBudget` con `opens`, desde `deliverBudget`). Entregar es imprimirlo o enviarlo: el mismo momento que ya mueve a «Presupuesto enviado». La crea `createOpportunity` (`presentedBudget`) con las reglas de siempre, salvo el paso: nace en «Presupuesto enviado», porque nunca fue «Interesado».
  - Es de la persona del paciente, unida al presupuesto y sin responsable (Recepción, como toda la que nadie tomó). El odontólogo no ve Oportunidades: no queda a su cargo.
  - Su título son los tratamientos de la opción que vale («Resina y Endodoncia», «Resina, Endodoncia y 2 más»); al decidirlo, los de la opción elegida, salvo que una persona le haya cambiado el nombre. Su servicio, el de esa opción si es uno solo; su valor, el total presentado.
  - Es un paso del sistema (`origin` automático) que lleva el nombre de quien lo entregó: el historial dice «Se abrió sola en «Presupuesto enviado»: Ana presentó el presupuesto» y la Actividad del equipo, «Se abrió una oportunidad al entregar un presupuesto» a su nombre (`opportunity.created_from_budget`).
- **A qué oportunidad se une un presupuesto**, en este orden:
  1. la que ya es suya o del que reemplaza (una revisión sigue con la de su original);
  2. la del mismo tratamiento: de la persona o la que anotó sin paciente su apoderada (`guardian`) que no tiene ficha propia, que pasa a llevar al paciente; esta nunca cuenta como «la más reciente». Una madre que también es paciente pregunta por lo suyo: paciente ≠ interlocutor ≠ responsable;
  3. la más reciente de la persona que no está unida a otro presupuesto, sea cual sea su servicio (ver la precisión de arriba).
  Nunca una que espera la respuesta a otro presupuesto (`budgetAwaitsAnswerSql`): un presupuesto que espera respuesta es su propio interés.
- **Una revisión de lo que ya tuvo su oportunidad es la misma venta** (las versiones conservan el número): sigue con la suya si está abierta; si se perdió (no respondió, el precio, la rechazó), la reabre, porque es otra oportunidad de cerrarla; si se ganó, no toma otra ni abre una. Al decidirla se busca en toda la familia (ella y la versión que reemplaza).
- **Reenviar no abre otra.** Reenviar no vuelve a entregar, y la oportunidad ya unida al presupuesto es la primera que se elige.
- **Anular un presupuesto entregado suelta su oportunidad** (`releaseCancelledBudget`, desde `cancelBudget`). La que nació de él y nadie trabajó (sin tareas ni notas) se cierra como perdida, «Otro» con la nota «Se anuló el presupuesto», a nombre de quien lo anuló (`opportunity.closed_budget_cancelled`). La que ya era de otro interés, o tiene trabajo encima, sigue abierta sin presupuesto y deja de decir que se cierra sola.
- **El mismo interés incluye el presupuesto pendiente.** Lo que anota Sofi (`noteServiceInterest`) y crear una oportunidad sin paciente (`sameOpenInterest`) encuentran la abierta de ese servicio de la persona y de su propia ficha, también si el servicio está en su presupuesto que espera respuesta, y siguen con esa. Cuando lo hace el agente, también la de los pacientes que lleva como apoderada sin ficha propia; si el agente sabe de qué paciente es, lo pasa (`patientId`). El equipo no se amplía a otros pacientes.
- **Lo que nadie respondió deja de esperar** (`closeUnansweredBudgetOpportunities`, en el ciclo del worker junto a `settleTasks`, una vez por día local de la clínica, aunque el Administrador esté apagado). Pasados 30 días del fin de la vigencia (`valid_until`) de un presupuesto entregado que sigue sin respuesta:
  - la oportunidad que nació de él se cierra sola como perdida, «No responde» (la etiqueta que ya existe en la lista), a nombre del sistema (`opportunity.closed_budget_expired`); la que era de otro interés solo se suelta del presupuesto, como al anularlo;
  - la tarjeta lo avisa antes: «Si no responde, el 6 dic se cierra sola como perdida: tómala o déjale una tarea para seguirla»;
  - no se toca la que alguien trabaja (un responsable, una tarea, una nota, un cambio a mano o un mensaje suyo que anotó Sofi después de entregarlo) ni la que tiene otra versión en borrador. Un presupuesto sin vigencia no vence;
  - si la persona responde después, se reabre: aceptarlo o rechazarlo la decide con la regla de siempre, «lo pienso» la deja abierta y escribirle a Sofi por ese tratamiento sigue con la misma;
  - cada una va en su propio punto de guardado y el ciclo salta la que otra transacción tiene tomada; la respuesta que llega a la vez espera a que el ciclo termine y la reabre.
- **Fecha de corte: nunca hacia atrás.** Solo alcanza a los presupuestos cuya entrega quedó registrada con la marca `unansweredCloses` en `budget.delivered` (`UNANSWERED_RULE_MARK`): toda entrega desde el despliegue de este cambio la lleva y ninguna de antes. Es la fecha de corte, guardada en cada entrega, sin una constante que adivine el día del despliegue.
- **Una persona a la vez.** Unir o abrir por un presupuesto, anotar un interés y crear una oportunidad (el equipo, `crear_oportunidad` del agente) toman un candado por persona (`lockPeople`, en el orden de su `hashtext`): dos entregas o una entrega y un mensaje al mismo tiempo no abren dos tarjetas por lo mismo.
- **No se rellena hacia atrás.** Decidir un presupuesto entregado antes de este cambio sin oportunidad la busca por el mismo orden y la cierra; si no hay, no se abre ninguna.

## Alternativas descartadas

- *Que la cree el equipo a mano*: es lo que no pasaba; el tablero dependería otra vez de que alguien se acuerde.
- *Abrirla en «Interesado» y moverla en el mismo instante*: dejaría en el historial un paso que no ocurrió y dos eventos con la misma hora.
- *Dejarla a nombre del odontólogo que lo entregó*: no ve Oportunidades ni le toca llamar; quedaría una tarjeta que nadie atiende.
- *Abrir siempre la del presupuesto a nombre del representante cuando el paciente es menor*: cambiaría a quién va cada tarjeta sin un caso que lo pida. El caso comprobado es otro, y se resuelve uniendo: la madre preguntó por el tratamiento antes de que se lo presupuestaran a su hijo.
- *Cerrar como perdida toda oportunidad de un presupuesto anulado*: perdería el interés que existía antes del presupuesto o el trabajo que alguien ya le dedicó.
- *Rellenar con una migración las oportunidades de los presupuestos ya enviados*: inventaría fechas e historiales; lo nuevo empieza con este cambio.

## Consecuencias

- El tablero y su total muestran también lo que se presupuestó en la clínica, sin trabajo de nadie; «Te espera» y «Retomar un presupuesto» siguen igual.
- Una persona puede tener a la vez una oportunidad por presupuesto pendiente, además de las que anotó el agente.
- Sacrificio: el presupuesto que se une a la más reciente de otro interés (por ejemplo, la que anotó el agente por un blanqueamiento) conserva el título de esa oportunidad, como decidió la 0028. Nunca toma la que ya es de otro presupuesto.
- Lo que nadie respondió sale del tablero abierto a los 30 días de vencido y cuenta como perdido por «No responde» en el tablero y en Argos; Reportes no lee oportunidades.
- Se revisa si las clínicas piden que una de estas oportunidades quede a cargo de alguien al nacer.

## Referencias

- `packages/services/src/opportunities.ts` (`linkPresentedBudget`, `openForBudget`, `pickOpportunity`, `budgetFamily`, `waitsOnOtherBudget`, `includesService`, `carriedBy`, `lockPeople`, `releaseCancelledBudget`, `closeUnansweredBudgetOpportunities`, `closeUnansweredOncePerDay`, `unansweredRuleSql`, `UNANSWERED_RULE_MARK`, `createOpportunity`, `noteServiceInterest`), `agent-admin.ts` (`tickAutomations`), `budgets.ts` (`deliverBudget`, `decideBudget`, `cancelBudget`, `budgetInterest`), `audit-words.ts`.
- Pruebas: `packages/services/src/budget-opportunity.test.ts`.
