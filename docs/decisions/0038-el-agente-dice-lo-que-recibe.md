# 0038 · El agente dice lo que recibe: índice, tres precios y el interés que anota el sistema

Fecha: 2026-10-16 · Estado: aceptada · Precisa: [0021](0021-el-agente-siempre-responde-y-sabe-todo-lo-de-la-clinica.md), [0028](0028-ventas-que-se-mueven-solas.md)

## Problema

Con 120 servicios el agente buscaba bien, pero dos instrucciones escritas antes de la búsqueda lo mandaban por otro lado: «arriba ya tienes los servicios con sus tarifas… sin llamar otras herramientas» cuando no había ninguno, y un aviso que lo mandaba a herramientas que no tenían el dato. Lo mismo pasaba con «Informar» o «Agendar» apagados, con el permiso de novedades (citaba otra pregunta y prometía «solo le escribiremos por sus citas») y con listas cortadas sin aviso (tres citas, seis resultados, veinte reglas). Además, nada impedía mandar el tarifario entero, y quien preguntaba un precio casi nunca quedaba anotado como interesado.

## Decisión y motivo

- **Las instrucciones se arman con lo que llega en el turno.** Funciones encendidas, herramientas del turno y si los servicios van enteros, como índice o no van. Ningún texto fijo afirma un dato ni nombra una herramienta que el turno no tiene; lo prueba `catalogo.test.ts`.
- **Clínica grande: índice corto.** Pasados 40 servicios va «Especialidad: servicio, servicio…», sin precio ni id: el agente sabe qué hay y el precio llega al buscar. Lo que no encuentra queda en «Preguntas sin respuesta».
- **Nunca el tarifario: hasta tres servicios con precio por conversación.** Lo dice el manual y lo cumple el código: la comprobación antes de enviar sabe de qué servicio es cada importe (su línea en lo recibido) y cuenta los ya dichos en la traza de la atención. El cuarto no sale; repetir uno sí.
- **El interés lo anota el sistema, no el modelo que escribe.** El buscador identifica un servicio concreto (por palabras, sin empate); el modelo de decisión, si la clínica tiene uno, responde una sola pregunta de sí o no sobre ese servicio; sin él vale «preguntó el precio o la disponibilidad». La oportunidad se crea o se actualiza en «Interesado», en Recepción, y no se crea si ya aceptó un presupuesto con ese servicio. Mover de etapa sale del agente: las etapas avanzan solas.
- **Si una lista se corta, lo dice con el número.** Las reglas aprendidas llegan todas hasta 40; pasado el tope, el agente y «Aprender» dicen cuántas quedaron fuera.

## Alternativas descartadas

- *Pedirle al modelo de decisión que elija entre todos los servicios*: tiende a la primera opción y se confunde con listas largas.
- *Identificar el servicio por significado (vectores)*: siempre hay uno «más parecido», también para lo que la clínica no hace; bastaría para anotar interesados falsos.
- *Solo la regla en el prompt para los tres precios*: el modelo no recuerda con certeza qué dijo en turnos anteriores; la traza sí.
- *Que el modelo que escribe cree la oportunidad*: ya podía hacerlo y casi nunca lo hacía en el camino «información».

## Consecuencias

- Beneficio: «¿cuánto la prótesis total?» se busca en vez de responder «no tengo ese dato»; la clínica ve a los interesados sin que nadie los registre.
- Sacrificio: una pregunta ambigua («prótesis total», con superior e inferior) no anota nada; el tope de tres cuenta servicios por su línea en lo recibido, así que un importe que no sale de una línea de servicio (un presupuesto, un saldo) no cuenta. El umbral de interés (0,7) está sin medir con proveedores reales.
- Revisar con corridas reales (`eval:month`) el umbral de interés y si tres precios es el número correcto.

## Referencias

- `packages/agent/src/graph.ts` (`receptionPrompt`, `PromptFacts`), `decision/route.ts` (`routeInstruction`, `routeToolsFor`), `tools.ts` (`priceCap`), `verify.ts` (`subject`), `interest.ts`; `packages/services/src/agent-clinic-info.ts` (`formatServiceIndex`, `identifyAskedService`), `opportunities.ts` (`noteServiceInterest`), `service-catalog.ts` (`setServicesPriceDisclosure`); lienzo de la fase 4, tableros 1 y 1b, decisiones 4, 5, 15 (v2) y 17.
