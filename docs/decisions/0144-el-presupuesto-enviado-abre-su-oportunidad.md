# 0144 · El presupuesto enviado también abre su oportunidad

Fecha: 2026-11-06 · Estado: aceptada · Precisa a [0028](0028-ventas-que-se-mueven-solas.md)

## Problema

Con la 0028, una oportunidad nace cuando la persona pide algo concreto (la anota el agente) o cuando el equipo la crea, y avanza sola con la cita, el presupuesto y su respuesta. Lo que se vende en el sillón quedaba fuera: el odontólogo indica, arma y entrega el presupuesto sin que nadie haya preguntado antes, y el tablero no se enteraba. Oportunidades decía que había menos ventas en curso de las que había.

Al resolverlo aparece otro hueco: la regla «se une a la del mismo tratamiento o, si no hay, a la más reciente» dejaba que el segundo presupuesto de una persona tomara la oportunidad del primero mientras este seguía esperando respuesta, y al decidir el primero se cerraba la del segundo.

## Decisión y motivo

- **Entregar un presupuesto sin una oportunidad abierta que le corresponda abre la suya** (`linkPresentedBudget` con `opens`, desde `deliverBudget`). Entregar es imprimirlo o enviarlo: el mismo momento que ya mueve a «Presupuesto enviado». La crea `createOpportunity` (`presentedBudget`) con las reglas de siempre, salvo el paso: nace en «Presupuesto enviado», porque nunca fue «Interesado».
  - Es de la persona del paciente, unida al presupuesto y sin responsable (Recepción, como toda la que nadie tomó). El odontólogo no ve Oportunidades: no queda a su cargo.
  - Su título son los tratamientos de la opción que vale («Resina y Endodoncia», «Resina, Endodoncia y 2 más»); su servicio, el de esa opción si es uno solo; su valor, el total presentado.
  - Es un paso del sistema (`origin` automático) que lleva el nombre de quien lo entregó: el historial dice «Se abrió sola en «Presupuesto enviado»: Ana presentó el presupuesto» y la Actividad del equipo, «Se abrió una oportunidad al entregar un presupuesto» a su nombre (`opportunity.created_from_budget`).
- **Un presupuesto que espera respuesta es su propio interés.** Para unir un presupuesto, primero cuenta la oportunidad que ya es suya o del que reemplaza (una revisión sigue con la de su original); después, la del mismo tratamiento o la más reciente, como en la 0028, pero nunca una que espera la respuesta a otro presupuesto (`budgetAwaitsAnswerSql`). La misma excepción vale para «no se duplica una abierta del mismo interés» cuando la nueva trae su presupuesto.
- **Reenviar no abre otra, ni una revisión de lo ya vendido.** Reenviar no vuelve a entregar, y la oportunidad ya unida al presupuesto es la primera que se elige. Una revisión (conserva el número) no abre otra si una versión anterior ya tuvo la suya, aunque se haya decidido: es la misma venta y se contaría dos veces.
- **No se rellena hacia atrás.** Decidir un presupuesto entregado antes de este cambio sin oportunidad sigue como hoy: se une a una abierta que le corresponda, si la hay, y la cierra; si no hay, no se abre ninguna.

## Alternativas descartadas

- *Que la cree el equipo a mano*: es lo que no pasaba; el tablero dependería otra vez de que alguien se acuerde.
- *Abrirla en «Interesado» y moverla en el mismo instante*: dejaría en el historial un paso que no ocurrió y dos eventos con la misma hora.
- *Dejarla a nombre del odontólogo que lo entregó*: no ve Oportunidades ni le toca llamar; quedaría una tarjeta que nadie atiende.
- *Ponerla a nombre del representante cuando el paciente es menor*: añade un caso sin un problema comprobado; la persona del paciente es la que se busca en el tablero.
- *Rellenar con una migración las oportunidades de los presupuestos ya enviados*: inventaría fechas e historiales; lo nuevo empieza con este cambio.

## Consecuencias

- El tablero y su total muestran también lo que se presupuestó en la clínica, sin trabajo de nadie; «Te espera» y «Retomar un presupuesto» siguen igual.
- Una persona puede tener a la vez una oportunidad por presupuesto pendiente, además de las que anotó el agente.
- Sacrificio: el presupuesto que se une a la más reciente de otro interés (por ejemplo, la que anotó el agente por un blanqueamiento) conserva el título de esa oportunidad; la 0028 lo decidió así y no se reabre aquí.
- Se revisa si las clínicas piden que una de estas oportunidades quede a cargo de alguien al nacer.

## Referencias

- `packages/services/src/opportunities.ts` (`linkPresentedBudget`, `openForBudget`, `pickOpportunity`, `waitsOnOtherBudget`, `createOpportunity`), `budgets.ts` (`deliverBudget`, `budgetInterest`), `audit-words.ts`.
- Pruebas: `packages/services/src/budget-opportunity.test.ts`.
