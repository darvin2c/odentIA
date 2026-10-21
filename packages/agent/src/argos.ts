import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  ARGOS_COMPARES,
  ARGOS_SCREENS,
  ARGOS_WORDS,
  type ArgosChoice,
  type ArgosColumnKind,
  type ArgosKey,
  type ArgosOutcome,
  type ArgosPeriodView,
  type ArgosQueryResult,
  type ArgosResolvedPeriod,
  type ArgosScreenKey,
  type ArgosSentencePart,
  type ArgosStoredAnswer,
  type ArgosStoredPlan,
  type ArgosWords,
  bindArgosPeriod,
  argosCatalogText,
  argosChoiceOf,
  argosColumnLabel,
  argosGrainOf,
  argosPeriodView,
  argosUsesBranch,
  fillArgosWords,
  findArgosBranch,
  getArgosPlan,
  getOrgLocale,
  listArgosBranches,
  resolveArgosPeriod,
  validation,
  isArgosHiddenColumn,
  argosKeyOf,
  ArgosQueryError,
  argosScreen,
  argosSentenceProblem,
  fillArgosSentence,
  formatArgosValue,
  prepareArgosQuestion,
  recordArgosQuestion,
  type ReportQuery,
  runArgosQuery,
  ServiceError,
  unknownArgosHoles,
} from "@odentia/services"
import { z } from "zod"
import { createAdminDecisionModel } from "./admin.js"
import { reportReplyUse } from "./ai-usage.js"
import { answerOf, type DecisionModel, type DecisionQuestion, type PlatformDecisions } from "./decision/index.js"
import { createConfiguredChatModel, type LlmSpec, resolveLlmSpec } from "./llm.js"
import type { AgentRuntime } from "./run.js"

/**
 * Argos responde preguntas del negocio escribiendo una consulta sobre las
 * vistas `argos` (ADR 0075). Jev decide la fila (una pregunta de los datos, de
 * cómo se usa odentIA u otra cosa) con solo el texto. ChatGPT 6 recibe la
 * pregunta y la descripción de las vistas que lee el rol de quien pregunta, y
 * devuelve la consulta y una frase con huecos: nunca ve el resultado ni
 * escribe un número. La consulta pasa por el revisor y corre con la llave del
 * rol (`runArgosQuery`); los huecos los llena el servidor (`fillArgosSentence`).
 * Si la base la rechaza, el modelo la corrige una vez con el error, que no trae
 * datos. Lo que no está en las vistas lo dice y ofrece lo más cercano.
 */

const TOOL_NAME = "responder"

/** Lo que devuelve el modelo: la consulta y las frases, sin ningún número del resultado. */
const planSchema = z.object({
  tipo: z
    .enum(["consulta", "parcial", "no_existe"])
    .describe("consulta: se responde con las vistas. parcial: solo una parte. no_existe: las vistas no tienen ese dato."),
  sql: z.string().describe("Una sola consulta SELECT (o WITH … SELECT) sobre las vistas; vacía en no_existe."),
  frase: z
    .string()
    .describe("La respuesta, breve, con huecos {columna}, {lista} o {filas}. Nunca escribas una cifra del resultado. En no_existe, qué falta dicho en palabras simples y sin huecos."),
  frase_vacia: z.string().describe("La frase si la consulta no trae filas (sin más huecos que {periodo} y {periodo_antes})."),
  como: z.string().describe("«Así lo calculé»: una o dos frases simples con qué se contó, de qué periodo y con qué regla."),
  falta: z.string().describe("En parcial o no_existe: lo que odentIA no registra. Vacío si nada falta."),
  sql_cercana: z.string().describe("En no_existe: una consulta con lo más cercano que sí existe. Vacía si no hay."),
  frase_cercana: z.string().describe("La frase de sql_cercana, con sus huecos. Vacía si no hay."),
  titulo: z.string().describe("Un título corto de la respuesta, sin nombres de personas ni periodo: «Lo cobrado», «Lo que más se vendió»."),
  // Texto y no una lista cerrada: una pantalla desconocida no bota la respuesta, vale «ninguna».
  pantalla: z.string().describe(`La pantalla de odentIA donde se ve esto, para el botón «Abrir…»: ${ARGOS_SCREENS.join(", ")}.`),
  seguir: z
    .array(
      z.object({
        etiqueta: z.string().describe("El botón, de 1 a 4 palabras: «Por monto», «Por sede», «Solo productos». Nunca otra fecha."),
        sql: z.string().describe("La consulta completa de esa variante."),
        frase: z.string().describe("Su frase con huecos."),
        frase_vacia: z.string().describe("Su frase si no trae filas."),
        como: z.string().describe("Su «Así lo calculé»."),
      }),
    )
    .describe("Hasta 3 variantes que la persona querría ver después; vacío en no_existe. Más de 3 no se usan."),
  periodo: z.string().describe("El periodo de la respuesta (ver «El periodo»): este_mes, mes_pasado, ultimos_N_meses, este_ano, AAAA-MM, hoy, ayer, AAAA-MM-DD, esta_semana, semana_pasada, ultimos_N_dias, AAAA-MM-DD..AAAA-MM-DD o a_hoy."),
  compara: z.enum(ARGOS_COMPARES).describe("no, anterior, año_anterior u otro (la pregunta nombra dos periodos)."),
  otro_periodo: z.string().describe("Con compara otro: el segundo periodo. Vacío si no."),
  sede: z.string().describe("La sede que nombra la pregunta, tal cual. Vacío si no nombra ninguna."),
})

export type ArgosPlan = z.infer<typeof planSchema>

const RULES = `Eres Argos, de odentIA: respondes preguntas sobre el negocio de una clínica dental. Escribes UNA consulta de PostgreSQL de solo lectura sobre las vistas de abajo (nunca otras tablas) y una frase con huecos que odentIA llenará con el resultado. Nunca ves los datos y nunca escribes una cifra del resultado: las cifras salen solo de los huecos.

El periodo (las fechas las pone odentIA):
- Elige en «periodo» el que pide la pregunta y filtra la consulta con :desde y :hasta (instantes; :hasta no entra) sobre la fecha y hora de la vista (momento, pagado_en, cargado_en, inicio, fecha, emitido_en, presentado_en, indicado_en, creada_en…), o con :dia_desde y :dia_hasta (:dia_hasta no entra) si la vista solo tiene días. Nunca escribas fechas, current_date ni now() para el periodo: odentIA pone las mismas fechas que Reportes y, si el periodo llega a hoy, corta los dos lados a la misma hora. La pantalla deja cambiar el periodo y vuelve a correr tu consulta con otras fechas.
- «periodo» es uno de: este_mes, mes_pasado, ultimos_N_meses (N meses completos antes del actual), este_ano, AAAA-MM (un mes), hoy, ayer, AAAA-MM-DD (un día), esta_semana, semana_pasada, ultimos_N_dias (hasta hoy), AAAA-MM-DD..AAAA-MM-DD (unas fechas) o a_hoy.
- Sin periodo en la pregunta: el de la pantalla si se indica; si no, este_mes. Una tendencia («¿estamos creciendo?», «¿cómo vamos?»): ultimos_3_meses comparado con el anterior. Lo mes a mes y el mejor o el peor mes, sin periodo: ultimos_12_meses (solo meses completos). Lo que mide frecuencia o tiempo («más frecuentes», «cada cuánto vuelven», «cuánto tardan», «cuánto dura un tratamiento») y el valor de un paciente según cómo llegó: ultimos_365_dias.
- a_hoy es lo que se mide a hoy y no por periodo: lo que deben, los presupuestos que esperan respuesta, lo aceptado que falta hacer, el inventario, las citas por venir, los pacientes sin venir. Con a_hoy la consulta no usa :desde ni :hasta (current_date y now() ya están en la zona de la clínica).
- «compara»: no; anterior si compara con el periodo anterior («contra el mes anterior», una tendencia), y odentIA pone los mismos días de antes; año_anterior si compara con el año pasado; otro si la pregunta nombra dos periodos («¿marzo o julio?»), con el segundo en «otro_periodo». Lo de antes se filtra con :desde_antes y :hasta_antes (o :dia_desde_antes y :dia_hasta_antes), en la misma fila que lo de ahora.
- La sede la pone odentIA: si la vista tiene sede y la respuesta no va por sede, filtra con (:sede is null or <vista>.sede = :sede). Si la pregunta nombra una sede, va en «sede» tal cual; si no, vacío.

Qué contar:
- En una clínica «vender» incluye tratamientos y productos. «Lo que se vendió» es lo pagado (pagos_por_venta); lo cargado sin pagar es «lo que no se cobró» o «lo que deben».
- «Ticket promedio» es el promedio de ventas.importe (por venta), no el de los tickets de pago.
- odentIA no emite facturas ni boletas, solo tickets de pago: nunca digas «facturado» ni «facturación». Si preguntan por eso, dilo en la frase y responde con lo cobrado (cobros). Si preguntan qué parte de lo facturado se cobró, es lo cargado (ventas.importe) y lo pagado de eso (ventas.pagado), de las ventas del periodo.
- «Lo más …» se ordena por lo que pregunta: «más ingresos» o «más dinero» por monto, «más veces» o «más frecuentes» por cuántas veces; si no lo dice, por cuántas veces y después por monto.
- Cuenta y agrupa a las personas por su paciente_id (o persona_id) cuando la vista lo tenga: hay nombres repetidos. Esos ids no se muestran.
- Al agrupar por un nombre (profesional, concepto, sede, categoría), deja fuera las filas sin nombre (null), salvo que la pregunta las pida.
- Para juntar cifras de dos vistas, suma cada vista por separado (una subconsulta o un WITH por vista) y junta los totales después: un JOIN de filas de dos vistas antes de sumar las multiplica.
- Antes de responder no_existe, mira si se arma con las vistas y las cifras de abajo (margen, retención, pagos parciales, valor por cómo nos conoció, prospectos, horas clínicas…). no_existe es solo para lo de «Lo que odentIA no registra», lo clínico (diagnósticos, enfermedades, alergias, la historia clínica) o lo que ninguna vista tiene.
- Si lo pedido no está, tipo no_existe y sin consulta: dilo con palabras simples y, si hay algo cercano que sí existe, ponlo en sql_cercana con su frase_cercana. Nunca respondas otra cifra como si fuera la pedida: los controles vencidos no son tratamientos atrasados, ni quien indicó un tratamiento es quien lo hará.
- Si solo puedes responder una parte, tipo parcial: la consulta responde esa parte y «falta» dice lo que no se puede saber.
- Un consejo, una prioridad, una causa o un juicio («¿qué debería hacer…?», «¿por qué bajaron…?», «¿qué estoy desaprovechando?», «¿qué cambio en mi agenda?»): odentIA no aconseja ni sabe causas. Tipo parcial: la frase lo dice primero, en pocas palabras («Qué hacer lo decides tú; lo registrado que sirve para decidirlo:», «No sé por qué bajaron; lo que cambió:»), y sigue con cifras de las vistas sobre ese tema, nunca con una recomendación ni con una cifra que las vistas no tienen (oportunidades «perdidas», montos estimados). «falta» dice que odentIA no da consejos ni sabe causas. Las cifras de cada tema:
  - Dinero, oportunidades o prioridades: los presupuestos que esperan respuesta (cuántos y cuánto), lo aceptado que falta hacer (cuánto, y cuánto de eso no tiene cita), lo que te deben hace más de 30 días y los pacientes «Sin venir». Si habla de la semana, además las citas que quedan hasta el domingo sin confirmar.
  - La agenda: las horas libres del mes en curso por día de la semana y hora (agenda_por_hora), las franjas con más horas libres primero, y la agenda ocupada.
  - «¿Por qué subió o bajó…?»: las cifras de los dos periodos y lo que más cambió entre ellos (por concepto, profesional o sede), sin decir que eso es la causa.

La frase:
- Dice el periodo con {periodo} y lo de antes con {periodo_antes}: odentIA los llena con palabras y preposición («del 1 al 21 de octubre», «en setiembre», «hoy»; «en los mismos días de setiembre», «en agosto»). Van donde iría el periodo, sin nada delante: «{periodo} cobraste {cobrado_dinero}; {periodo_antes}, {antes_dinero}: {variacion_pct}.». Nunca escribas un periodo, un mes ni una fecha con tus palabras, tampoco en «como» ni en el título. Si la pregunta se puede entender de dos formas, di también qué contaste: «volvieron {pacientes} pacientes que llevaban más de 6 meses sin venir». El detalle del cálculo va en «como», no en la frase.
- Huecos: {columna} es el valor de esa columna en la primera fila; {lista} son las filas (hasta 12) como «col1 (col2, col3)», en el orden de tu consulta, y odentIA dice cuántas más hay; {filas} es cuántas filas trajo la consulta. El hueco ya trae su formato: no agregues moneda ni «%» junto a él. Nunca llames «filas», «lista» ni «periodo» a una columna.
- {lista} va una sola vez y al final de la frase, después de dos puntos: «Los que más deben: {lista}.». Para el mayor y el menor (el mejor y el peor mes) no uses {lista}: una sola fila con columnas como mejor_mes, mejor_dinero, peor_mes y peor_dinero.
- Una lista de personas, ventas o cosas dice antes cuántas son en total y, si es dinero, cuánto suman, con columnas que empiezan con total_general: count(*) over () AS total_general y sum(saldo) over () AS total_general_dinero. «{total_general} pacientes te deben {total_general_dinero}. Los que más deben: {lista}.» Esas columnas no salen en la lista.
- Un cambio entre dos periodos va en una columna que empieza con variacion y termina en _pct (variacion_pct): odentIA le pone el signo («+1 %», «-32 %»). La frase nombra los dos periodos y sus cifras.
- Cada hueco {columna} es siempre la primera fila: para dos cifras de filas distintas, arma una sola fila con una columna por cifra.
- Lo que sale en la lista se lee: un estado o un tipo va en palabras (CASE estado WHEN 'hace_falta' THEN 'bajo el mínimo' … END), nunca su código; y no pongas columnas que la pregunta no necesita.

Para seguir:
- En «seguir», hasta 3 variantes de la misma respuesta que la persona querría ver después: otro orden («Por monto»), otro grupo («Por sede», «Por profesional»), un filtro («Solo productos») o, si la pregunta se puede entender de otra forma, esa otra lectura. Nunca otra fecha: el periodo se cambia en la pantalla. Cada una con su consulta completa (con el mismo periodo: :desde, :hasta y lo de antes) y su frase; odentIA las corre al tocar el botón, sin volver a preguntarte.

La consulta:
- Una sola sentencia SELECT (o WITH … SELECT), sin punto y coma, sin comentarios, sin comillas dobles y sin generate_series (para meses, date_trunc sobre las filas). Sin LIMIT, salvo que la pregunta pida un número («los 5 que más…»): odentIA muestra las primeras y dice cuántas más hay. Ordena la lista para que lo importante salga primero.
- Columnas del resultado en español y en minúsculas: el dinero (y solo el dinero, nunca una cantidad) con el sufijo _dinero, los porcentajes (de 0 a 100, redondeados) con _pct y un mes como el primer día de ese mes (date) con _mes, que odentIA muestra «mayo de 2026». Las fechas van como date o timestamptz, nunca como texto.

Español neutro, breve.`

const CACHE_MARK: Partial<Record<LlmSpec["provider"], Record<string, unknown>>> = {
  openai: { prompt_cache_breakpoint: { mode: "explicit" } },
}

export interface ArgosAsk {
  question: string
  key: ArgosKey
  now: Date
  zone: { timezone: string; locale: string }
  /** El periodo y la sede de Reportes cuando se pregunta desde ahí (decisión D7). */
  screen?: { period: string; branch: string | null } | null
  /** La pregunta anterior de la conversación y su consulta (decisión D3): «¿Y ayer?». */
  previous?: { text: string; query: string } | null
}

/**
 * Los mensajes al modelo. Lo fijo (las reglas y las vistas de la llave) va
 * primero y marcado para la caché del proveedor: es igual en cada pregunta de
 * ese rol. Lo que cambia (la hora, la pantalla, lo anterior y la pregunta) va
 * después.
 */
export function argosMessages(provider: LlmSpec["provider"], input: ArgosAsk): BaseMessage[] {
  const fixed = `${RULES}\n\n${argosCatalogText(input.key)}`
  const mark = CACHE_MARK[provider]
  const now = new Intl.DateTimeFormat(input.zone.locale, { timeZone: input.zone.timezone, dateStyle: "full", timeStyle: "short" }).format(input.now)
  const human = [
    `Ahora en la clínica: ${now} (zona ${input.zone.timezone}).`,
    input.screen
      ? `En Reportes se ve el periodo «${input.screen.period}»${input.screen.branch ? ` y la sede «${input.screen.branch}»` : ", todas las sedes"}: úsalos si la pregunta no dice otro periodo o sede.`
      : "",
    input.previous ? `Pregunta anterior: «${input.previous.text.slice(0, 300)}»\nSu consulta: ${input.previous.query.slice(0, 2000)}` : "",
    `Pregunta: «${input.question}»`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return [new SystemMessage({ content: mark ? [{ type: "text", text: fixed, ...mark }] : fixed }), new HumanMessage({ content: human })]
}

/** Con el modelo de demostración: unas pocas preguntas por palabras, sin proveedor. */
export function demoArgosPlan(question: string): ArgosPlan {
  const text = question.toLowerCase()
  const empty = { falta: "", sql_cercana: "", frase_cercana: "", seguir: [], compara: "no" as const, otro_periodo: "", sede: "" }
  if (/cobr|ingres/.test(text))
    return {
      ...empty,
      tipo: "consulta",
      periodo: "este_mes",
      sql: "select coalesce(sum(importe), 0) as cobrado_dinero from cobros where momento >= :desde and momento < :hasta and (:sede is null or sede = :sede)",
      frase: "{periodo} se cobró {cobrado_dinero}.",
      frase_vacia: "{periodo} no se cobró nada.",
      como: "Lo cobrado {periodo}: pagos menos anulaciones y devoluciones.",
      titulo: "Lo cobrado",
      pantalla: "finanzas",
      seguir: [
        {
          etiqueta: "Por medio de pago",
          sql: "select medio, sum(importe) as cobrado_dinero from cobros where momento >= :desde and momento < :hasta and (:sede is null or sede = :sede) and medio is not null group by medio order by cobrado_dinero desc",
          frase: "{periodo}, por medio de pago: {lista}.",
          frase_vacia: "{periodo} no se cobró nada.",
          como: "Lo cobrado {periodo} por medio de pago.",
        },
      ],
    }
  if (/cita/.test(text)) {
    const tomorrow = /mañana/.test(text)
    return {
      ...empty,
      tipo: "consulta",
      // Las citas por venir se cuentan a hoy, sin periodo que cambiar (D12).
      periodo: "a_hoy",
      sql: `select count(*) as citas from citas where dia = current_date${tomorrow ? " + 1" : ""} and estado in ('programada', 'confirmada', 'atendida')`,
      frase: `${tomorrow ? "Mañana hay" : "Hoy hay"} {citas} citas.`,
      frase_vacia: "No hay citas.",
      como: `Citas de ${tomorrow ? "mañana" : "hoy"} que siguen en pie.`,
      titulo: tomorrow ? "Las citas de mañana" : "Las citas de hoy",
      pantalla: "agenda",
    }
  }
  if (/paciente/.test(text) && /nuev/.test(text))
    return {
      ...empty,
      tipo: "consulta",
      periodo: "este_mes",
      sql: "select count(*) as pacientes from pacientes where primera_atencion >= :dia_desde and primera_atencion < :dia_hasta",
      frase: "{periodo} llegaron {pacientes} pacientes nuevos.",
      frase_vacia: "{periodo} no llegaron pacientes nuevos.",
      como: "Pacientes cuya primera cita atendida fue {periodo}.",
      titulo: "Pacientes nuevos",
      pantalla: "pacientes",
    }
  return {
    ...empty,
    tipo: "no_existe",
    periodo: "a_hoy",
    sql: "",
    frase: "Con el modelo de demostración solo respondo lo cobrado, las citas y los pacientes nuevos.",
    frase_vacia: "",
    como: "",
    titulo: "",
    pantalla: "ninguna",
  }
}

/** Cuánto piensa el modelo antes de escribir el plan; «none», nada (para medir sin pensar). */
export type ArgosReasoning = "none" | "low" | "medium" | "high"

/**
 * Lo que piensa Argos si nadie dice otra cosa. Medido con 88 preguntas nuevas del
 * dueño: sin pensar acertaba el 67 % (con una revisión del plan aparte); pensando
 * alto, el 82 %, con 6 s más de espera y USD 0,0002 más por pregunta.
 */
export const ARGOS_REASONING: ArgosReasoning = "high"

/** El modelo escribe la consulta y las frases. Con `retry`, la corrige con el problema que tuvo la anterior. */
export async function writeArgosPlan(
  deps: Pick<AgentRuntime, "platform" | "createModel"> & { reasoning?: ArgosReasoning },
  input: ArgosAsk & { retry?: { plan: ArgosPlan; problem: string } },
): Promise<ArgosPlan> {
  const spec = resolveLlmSpec(deps.platform)
  if (spec.provider === "fake" && !deps.createModel) return demoArgosPlan(input.question)
  const answer = tool(async () => "respondido", {
    name: TOOL_NAME,
    description: "Entrega la consulta y las frases de la respuesta.",
    schema: planSchema,
  })
  const reasoning = deps.reasoning ?? ARGOS_REASONING
  const model = deps.createModel
    ? await deps.createModel(spec)
    : await createConfiguredChatModel(spec, { explicitCache: true, temperature: 0, ...(reasoning === "none" ? {} : { reasoning }) })
  type Bindable = { bindTools: (tools: unknown[], options?: Record<string, unknown>) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }
  const bound = typeof (model as unknown as Partial<Bindable>).bindTools === "function" ? (model as unknown as Bindable).bindTools([answer], { tool_choice: TOOL_NAME }) : model
  const messages = argosMessages(spec.provider, input)
  if (input.retry)
    messages.push(
      new HumanMessage({
        content: `Tu consulta anterior fue:\n${input.retry.plan.sql}\nY tu frase: «${input.retry.plan.frase}»\nNo se pudo usar: ${input.retry.problem}. Corrígela y responde otra vez.`,
      }),
    )
  const reply = await bound.invoke(messages)
  reportReplyUse(spec.provider, spec.modelName, reply)
  const call = reply instanceof AIMessage || "tool_calls" in reply ? (reply as AIMessage).tool_calls?.find((item) => item.name === TOOL_NAME) : undefined
  const parsed = planSchema.safeParse(call?.args)
  if (!parsed.success) throw new ServiceError("ARGOS_UNREADABLE", 502, ARGOS_WORDS.sinModelo)
  return parsed.data
}

/** La fila del buscador (decisión D1): Jev la decide con solo el texto. */
export const ARGOS_ROUTE_QUESTION: DecisionQuestion = {
  id: "argos.fila",
  kind: "choice",
  instructions: "Alguien del equipo de una clínica dental escribió esto. ¿Qué es?",
  options: [
    {
      value: "negocio",
      description:
        "Una pregunta sobre los datos o el negocio de la clínica: dinero, cobros, ventas, pacientes, citas, agenda, tratamientos, presupuestos, promociones, inventario o el equipo. También pedir un consejo, prioridades o causas del negocio («¿qué debería hacer…?», «¿qué acciones tomo esta semana?», «¿por qué bajaron…?»).",
    },
    { value: "ayuda", description: "Cómo se usa odentIA: dónde está algo o cómo se hace algo en el sistema." },
    { value: "buscar", description: "Un nombre o una palabra suelta para encontrar algo (una persona, un servicio, un producto), no una pregunta." },
    { value: "otro", description: "Un saludo, algo ajeno a la clínica o un pedido de que odentIA haga algo ahora (enviar, cambiar, agendar)." },
  ],
}

export type ArgosRoute = "negocio" | "ayuda" | "buscar" | "otro"

const ROUTES: readonly ArgosRoute[] = ["negocio", "ayuda", "buscar", "otro"]

/**
 * La fila sin modelo de decisión (demostración o Jev caído): «cómo se hace» es
 * de la Ayuda, una pregunta es de los datos y lo demás se busca.
 */
/** La fila por palabras, sin modelo: lo que se usa si Jev no responde y, con Argos apagado, para la Ayuda. */
export function routeByWords(text: string): ArgosRoute {
  if (/\b(c[oó]mo (hago|se|puedo)|d[oó]nde (est[aá]|encuentro|veo|configuro))\b/i.test(text)) return "ayuda"
  return /[¿?]|\b(cu[aá]nt[oa]s?|qu[eé]|qui[eé]n(es)?|cu[aá]l(es)?|hay|tengo|tenemos)\b/i.test(text) ? "negocio" : "buscar"
}

/**
 * Sin respuesta de Jev (sin modelo, se negó o falló) decide `fallback`: en el
 * buscador, las palabras, para no poner a Argos primero ante un nombre; al
 * preguntarle a Argos, los datos, porque la persona ya lo eligió.
 */
export async function routeArgosQuestion(model: DecisionModel | null, text: string, fallback: (text: string) => ArgosRoute = routeByWords): Promise<ArgosRoute> {
  if (!model) return fallback(text)
  try {
    const result = await model.decide(text, [ARGOS_ROUTE_QUESTION])
    const choice = answerOf(result, ARGOS_ROUTE_QUESTION.id, "choice")?.choice
    return ROUTES.find((route) => route === choice) ?? fallback(text)
  } catch {
    return fallback(text)
  }
}

/** La fila del buscador para quien puede preguntarle a Argos: solo el texto viaja a Jev. Lo pagado lo mide quien llama. */
export async function routeArgos(db: Db, deps: ArgosDeps, orgId: string, text: string, fallback: (text: string) => ArgosRoute = routeByWords): Promise<ArgosRoute> {
  const decision = deps.decisionModel !== undefined ? deps.decisionModel : await createAdminDecisionModel(db, deps, orgId).catch(() => null)
  return routeArgosQuestion(decision, text, fallback)
}

export interface ArgosTable {
  columns: Array<{ name: string; label: string; kind: ArgosColumnKind }>
  /** Los valores tal cual (para dibujar), con los ids que no se muestran: abren la página de la persona. */
  rows: ArgosQueryResult["rows"]
  /** Cada celda de `columns` con el formato de la clínica, la misma de la frase: la pantalla no formatea. */
  display: Array<Record<string, string>>
  truncated: boolean
}

export interface ArgosClosest {
  text: string
  sentence: ArgosSentencePart[]
  query: string
  table: ArgosTable
}

/** La pantalla que propuso el modelo, si es una de las de odentIA. */
function screenOf(value: string): ArgosScreenKey {
  return (ARGOS_SCREENS as readonly string[]).includes(value) ? (value as ArgosScreenKey) : "ninguna"
}

/** Una respuesta lista para mostrar: la frase llena y su tabla. */
export interface ArgosShown {
  text: string
  sentence: ArgosSentencePart[]
  table: ArgosTable
}

export type ArgosAskResult =
  | (ArgosShown & {
      kind: "respuesta"
      /** Con él se fija, se descarga y se sigue (D2, D5). */
      questionId: string
      title: string
      screen: ArgosScreenKey
      partial: boolean
      /** «Así lo calculé». */
      how: string
      missing: string | null
      /** Lo que la pantalla manda con la pregunta siguiente para entender «¿y de esos…?» (D3). */
      query: string
      /**
       * Para seguir sin volver a llamar al modelo: ya corridas, cada una con su «Así lo calculé» y su consulta (la que
       * viaja como anterior si se está viendo); `index` es su número para fijar y descargar.
       */
      options: Array<{ index: number; label: string; how: string; query: string; answer: ArgosShown }>
      /** El periodo que se ve y cómo cambiarlo (D8 a D16); en lo que es a hoy, solo su texto. */
      period: ArgosPeriodView
    })
  | { kind: "no_existe"; message: string; missing: string | null; closest: ArgosClosest | null }
  | { kind: "ayuda" | "otro" | "apagado" | "tope" | "sin_modelo" | "no_pudo" | "tiempo" | "sin_permiso"; message: string }

function tableOf(result: ArgosQueryResult, zone: Parameters<typeof fillArgosSentence>[2]): ArgosTable {
  // Los ids siguen en las filas (para abrir a la persona desde la pantalla), pero no son una columna que se muestre.
  const shownColumns = result.columns.filter((column) => !isArgosHiddenColumn(column.name))
  const columns = shownColumns.map((column) => ({ ...column, label: argosColumnLabel(column.name) }))
  const display = result.rows.map((row) => Object.fromEntries(shownColumns.map((column) => [column.name, formatArgosValue(row[column.name] ?? null, column, zone)])))
  return { columns, rows: result.rows, display, truncated: result.truncated }
}

export interface ArgosDeps extends Pick<AgentRuntime, "platform" | "createModel" | "secretsKey"> {
  decisions?: PlatformDecisions
  /** Sustituye el modelo de decisión (pruebas); `null` = sin modelo de decisión. */
  decisionModel?: DecisionModel | null
  /** Cada vez que la base rechaza una consulta del modelo o su frase no se lee (para medir; no trae datos). */
  onProblem?: (problem: string) => void
  /** Cuánto piensa el modelo antes de escribir el plan (para medir); sin él, `ARGOS_REASONING`. */
  reasoning?: ArgosReasoning
}

/**
 * Responde una pregunta de Argos de punta a punta. Recibe la conexión del rol
 * app; cada lectura abre su propio contexto de la clínica. Lo pagado al
 * proveedor lo mide quien llama (`meterAiUse`).
 */
export async function askArgos(
  db: Db,
  deps: ArgosDeps,
  input: {
    orgId: string
    userId: string
    memberRole: string
    text: string
    screen?: ReportQuery
    previous?: { text: string; query: string } | null
    /** La fila ya la decidió el buscador: no se le pregunta otra vez a Jev. */
    routed?: boolean
    now?: Date
  },
): Promise<ArgosAskResult> {
  const now = input.now ?? new Date()
  const key = argosKeyOf(input.memberRole)
  if (!key) return { kind: "sin_permiso", message: "Tu rol todavía no puede preguntarle a Argos." }
  const record = (outcome: ArgosOutcome, query: string | null, usedModel: boolean, plan: ArgosStoredPlan | null = null) =>
    withOrgContext(db, input.orgId, (tx) => recordArgosQuestion(tx, input.orgId, input.userId, { outcome, query, usedModel, plan }))

  const ready = await withOrgContext(db, input.orgId, async (tx) => ({
    ...(await prepareArgosQuestion(tx, input.orgId, now)),
    screen: input.screen ? await argosScreen(tx, input.orgId, input.screen, now) : null,
    branches: await listArgosBranches(tx, input.orgId),
  }))
  if (!ready.enabled) return { kind: "apagado", message: ARGOS_WORDS.apagado }
  if (ready.roomLeft <= 0) return { kind: "tope", message: ARGOS_WORDS.tope }

  // Quien eligió «Preguntarle a Argos» con un nombre suelto («buscar») también recibe respuesta.
  const route = input.routed ? "negocio" : await routeArgos(db, deps, input.orgId, input.text, () => "negocio")
  if (route === "ayuda" || route === "otro") {
    await record(route, null, false)
    return { kind: route, message: ARGOS_WORDS[route] }
  }

  const ask: ArgosAsk = { question: input.text, key, now, zone: ready.zone, screen: ready.screen, previous: input.previous ?? null }
  const run = (query: string) => runArgosQuery(db, { orgId: input.orgId, memberRole: input.memberRole, query })
  /** El periodo y la sede del plan: los que eligió el modelo y, si la pregunta no nombra una sede, la de Reportes (D7). */
  const bindingOf = (plan: ArgosPlan): ArgosBinding | { problem: string; code: "PERIODO" } => {
    let period: ArgosResolvedPeriod | null
    try {
      period = resolveArgosPeriod({ periodo: plan.periodo.trim() || "a_hoy", compara: plan.compara, otro: plan.otro_periodo.trim() || null }, ready.zone, now)
    } catch (error) {
      return { problem: `el periodo «${plan.periodo}» no sirve (${error instanceof Error ? error.message : "no se reconoce"}): elige uno de los de «El periodo»`, code: "PERIODO" }
    }
    const named = plan.sede.trim() || ready.screen?.branch || ""
    const branch = named ? findArgosBranch(ready.branches, named) : null
    if (named && !branch) return { problem: `la sede «${named}» no existe; las sedes son ${ready.branches.map((item) => `«${item.name}»`).join(", ")}`, code: "PERIODO" }
    return { period, branch }
  }
  /** Corre la consulta del plan con su periodo y su sede: su resultado o el problema que se le devuelve al modelo (sin datos). */
  const attempt = async (plan: ArgosPlan) => {
    const binding = bindingOf(plan)
    if ("problem" in binding) return binding
    const outcome = await runPlan(run, plan, binding)
    return "result" in outcome ? { ...outcome, binding } : outcome
  }

  let plan: ArgosPlan
  let result: ArgosQueryResult | null = null
  let binding: ArgosBinding = { period: null, branch: null }
  let timedOut = false
  try {
    plan = await writeArgosPlan(deps, ask)
    // Una sola corrección: si la segunda tampoco corre, se dice que no se pudo.
    for (let tries = 0; tries < 2 && !withoutQuery(plan); tries += 1) {
      const outcome = await attempt(plan)
      if ("result" in outcome) {
        // Una frase que no se lee (la lista dos veces o en medio) se corrige una vez; a la segunda se usa igual.
        const unreadable = tries === 0 ? argosSentenceProblem(outcome.result.rows.length ? plan.frase : plan.frase_vacia, outcome.result.rows.length) : null
        if (!unreadable) {
          result = outcome.result
          binding = outcome.binding
          break
        }
        deps.onProblem?.(unreadable)
        plan = await writeArgosPlan(deps, { ...ask, retry: { plan, problem: unreadable } })
        continue
      }
      deps.onProblem?.(outcome.problem)
      timedOut = outcome.code === "TIEMPO"
      if (tries === 0) plan = await writeArgosPlan(deps, { ...ask, retry: { plan, problem: outcome.problem } })
    }
  } catch (error) {
    if (error instanceof ArgosQueryError && error.code === "PERMISO") {
      await record("no_sabe", null, true)
      return { kind: "sin_permiso", message: error.message }
    }
    // El modelo no respondió: no cuenta para el tope (D6).
    await record("no_pudo", null, true)
    return { kind: "sin_modelo", message: ARGOS_WORDS.sinModelo }
  }

  if (withoutQuery(plan)) {
    await record("no_sabe", null, true)
    // Sin resultado no hay con qué llenar un hueco: una frase con huecos se cambia por lo que falta.
    const message = /\{\w+\}/.test(plan.frase) ? plan.falta.trim() || ARGOS_WORDS.noExiste : plan.frase
    const near = bindingOf(plan)
    return { kind: "no_existe", message, missing: plan.falta.trim() || null, closest: "problem" in near ? null : await closestOf(plan, run, ready.zone, near) }
  }
  if (!result) {
    await record("no_pudo", plan.sql, true)
    return timedOut ? { kind: "tiempo", message: ARGOS_WORDS.tiempo } : { kind: "no_pudo", message: ARGOS_WORDS.noPudo }
  }
  const words = binding.period?.words ?? {}
  const main = shown(plan, result, ready.zone, words)
  // Las de seguir ya corridas, con el mismo periodo y la misma sede: la que falla, no llena su frase o no tiene nombre no se ofrece.
  const follows = plan.seguir.slice(0, 3)
  const options = (
    await Promise.all(
      follows.map(async (follow, index) => {
        if (!follow.etiqueta.trim()) return null
        const outcome = await runPlan(run, follow, binding).catch(() => null)
        return outcome && "result" in outcome && !argosSentenceProblem(outcome.result.rows.length ? follow.frase : follow.frase_vacia, outcome.result.rows.length)
          ? { index, label: follow.etiqueta.trim(), how: fillArgosWords(follow.como.trim() || plan.como, words), query: follow.sql, answer: shown(follow, outcome.result, ready.zone, words) }
          : null
      }),
    )
  ).filter((option): option is NonNullable<typeof option> => option !== null)
  const offered = new Set(options.map((option) => option.index))
  const pantalla = screenOf(plan.pantalla)
  const stored: ArgosStoredPlan = {
    frase: plan.frase,
    frase_vacia: plan.frase_vacia,
    como: plan.como,
    titulo: plan.titulo.trim() || "Respuesta de Argos",
    pantalla,
    parcial: plan.tipo !== "consulta",
    falta: plan.falta.trim(),
    // Solo las que se ofrecieron se pueden fijar o descargar; las demás quedan vacías para conservar su número.
    seguir: follows.map((follow, index) => (offered.has(index) ? follow : null)),
    // Con esto se vuelve a correr con otro periodo o sede, sin el modelo (D9), y lo fijado sigue el de arriba (D11).
    periodo: binding.period?.spec ?? { periodo: "a_hoy", compara: "no" },
    sede: binding.branch?.name ?? null,
  }
  const questionId = await record(plan.tipo === "parcial" ? "parcial" : "respondida", plan.sql, true, stored)
  return {
    kind: "respuesta",
    questionId,
    title: stored.titulo,
    screen: pantalla,
    partial: plan.tipo !== "consulta",
    ...main,
    how: fillArgosWords(plan.como, words),
    missing: plan.falta.trim() || null,
    query: plan.sql,
    options,
    period: argosPeriodView(binding.period, ready.zone, now, { chosen: binding.branch, options: ready.branches, used: argosUsesBranch(plan.sql) }),
  }
}

/** El periodo y la sede con que se corre una consulta del plan. */
interface ArgosBinding {
  period: ArgosResolvedPeriod | null
  branch: { id: string; name: string } | null
}

/** Una respuesta vuelta a correr con otro periodo o sede (D9): sin el modelo y sin contar para el tope. */
export interface ArgosRerun extends ArgosShown {
  how: string
  options: Array<{ index: number; label: string; how: string; query: string; answer: ArgosShown }>
  period: ArgosPeriodView
}

/**
 * Vuelve a correr una respuesta ya dada con el periodo, el segundo periodo o
 * la sede que se eligieron en la pantalla: la principal y las de seguir que se
 * ofrecieron, con la llave de quien pregunta. Solo quien preguntó. La
 * comparación es la que pidió la pregunta (D14). Si la principal no corre,
 * se dice y la pantalla conserva lo que se veía.
 */
export async function rerunArgos(
  db: Db,
  input: { orgId: string; userId: string; memberRole: string; questionId: string; choice: ArgosChoice; now?: Date },
): Promise<ArgosRerun> {
  const now = input.now ?? new Date()
  const { row, zone, bound } = await withOrgContext(db, input.orgId, async (tx) => {
    const row = await getArgosPlan(tx, input.orgId, input.userId, input.questionId)
    const zone = await getOrgLocale(tx, input.orgId)
    return { row, zone, bound: await argosChoiceOf(tx, input.orgId, row.plan, input.choice, zone, now) }
  })
  if (bound.legacy) throw validation("Esta respuesta es de antes: pregúntala otra vez para cambiar su periodo")
  const binding: ArgosBinding = { period: bound.period, branch: bound.branch }
  const run = (query: string) => runArgosQuery(db, { orgId: input.orgId, memberRole: input.memberRole, query })
  const words = binding.period?.words ?? {}
  let main: Awaited<ReturnType<typeof runPlan>>
  try {
    main = await runPlan(run, { sql: row.query, frase: row.plan.frase, frase_vacia: row.plan.frase_vacia }, binding)
  } catch (error) {
    if (error instanceof ArgosQueryError) throw new ServiceError("FORBIDDEN", 403, error.message)
    throw error
  }
  if (!("result" in main)) throw new ServiceError("ARGOS_RERUN", 409, main.code === "TIEMPO" ? ARGOS_WORDS.tiempo : "No se pudo calcular con ese periodo.")
  const options = (
    await Promise.all(
      row.plan.seguir.map(async (follow, index) => {
        if (!follow) return null
        const outcome = await runPlan(run, follow, binding).catch(() => null)
        return outcome && "result" in outcome
          ? { index, label: follow.etiqueta.trim(), how: fillArgosWords(follow.como?.trim() || row.plan.como, words), query: follow.sql, answer: shown(follow, outcome.result, zone, words) }
          : null
      }),
    )
  ).filter((option): option is NonNullable<typeof option> => option !== null)
  return {
    ...shown(row.plan, main.result, zone, words),
    how: fillArgosWords(row.plan.como, words),
    options,
    period: argosPeriodView(
      bound.period,
      zone,
      now,
      { chosen: bound.branch, options: bound.branches, used: argosUsesBranch(row.query) },
      row.plan.periodo ? argosGrainOf(row.plan.periodo.periodo) : undefined,
    ),
  }
}

/**
 * Vuelve a correr una respuesta guardada (una fijada en el Resumen) con la
 * llave de quien la mira y, si tiene periodo, con el periodo y la sede de
 * arriba (D11); lo que es a hoy sigue a hoy. Si ya no corre o su rol no la ve,
 * null.
 */
export async function showArgosAnswer(
  db: Db,
  input: {
    orgId: string
    memberRole: string
    answer: ArgosStoredAnswer
    zone: Parameters<typeof fillArgosSentence>[2] & { locale: string }
    choice?: ArgosChoice
    now?: Date
  },
): Promise<(ArgosShown & { how: string; period: ArgosPeriodView | null }) | null> {
  const now = input.now ?? new Date()
  const bound = await withOrgContext(db, input.orgId, (tx) => argosChoiceOf(tx, input.orgId, input.answer, input.choice ?? {}, input.zone, now)).catch(() => null)
  if (!bound) return null
  const binding: ArgosBinding = { period: bound.period, branch: bound.branch }
  const outcome = await runPlan((query) => runArgosQuery(db, { orgId: input.orgId, memberRole: input.memberRole, query }), input.answer, binding).catch(() => null)
  if (!outcome || !("result" in outcome)) return null
  const words = binding.period?.words ?? {}
  return {
    ...shown(input.answer, outcome.result, input.zone, words),
    how: fillArgosWords(input.answer.como, words),
    period: bound.legacy ? null : argosPeriodView(bound.period, input.zone, now, { chosen: bound.branch, options: bound.branches, used: argosUsesBranch(input.answer.sql) }),
  }
}

/** Pone el periodo y la sede en una consulta del plan y la corre: su resultado o el problema que se le devuelve al modelo (sin datos). */
async function runPlan(
  run: (query: string) => Promise<ArgosQueryResult>,
  plan: Pick<ArgosPlan, "sql" | "frase" | "frase_vacia">,
  binding: ArgosBinding,
): Promise<{ result: ArgosQueryResult } | { problem: string; code: ArgosQueryError["code"] | "HUECOS" | "PERIODO" }> {
  const bound = bindArgosPeriod(plan.sql, binding.period, binding.branch?.name ?? null)
  if ("problem" in bound) return { problem: bound.problem, code: "PERIODO" }
  try {
    const result = await run(bound.sql)
    const holes = unknownArgosHoles(result.rows.length ? plan.frase : plan.frase_vacia, result, binding.period?.words ?? {})
    return holes.length ? { problem: `la frase usa ${holes.map((hole) => `{${hole}}`).join(", ")}, que no son columnas del resultado`, code: "HUECOS" } : { result }
  } catch (error) {
    if (!(error instanceof ArgosQueryError) || error.code === "PERMISO") throw error
    return { problem: error.message, code: error.code }
  }
}

/** La frase llena (o la de sin filas) y su tabla; el periodo lo dice odentIA. */
function shown(plan: Pick<ArgosPlan, "frase" | "frase_vacia">, result: ArgosQueryResult, zone: Parameters<typeof fillArgosSentence>[2], words: ArgosWords): ArgosShown {
  const empty = fillArgosWords(plan.frase_vacia, words)
  const filled = result.rows.length ? fillArgosSentence(plan.frase, result, zone, words) : { text: empty, parts: [{ text: empty }] }
  return { text: filled.text, sentence: filled.parts, table: tableOf(result, zone) }
}

/** Lo que no existe (o existe a medias) puede venir sin consulta: se responde con la frase y lo más cercano. */
function withoutQuery(plan: ArgosPlan): boolean {
  return plan.tipo !== "consulta" && !plan.sql.trim()
}

/** Lo más cercano que sí existe, cuando no hay respuesta: si el modelo lo propuso y corre; si falla, no se ofrece. */
async function closestOf(
  plan: ArgosPlan,
  run: (query: string) => Promise<ArgosQueryResult>,
  zone: Parameters<typeof fillArgosSentence>[2],
  binding: ArgosBinding,
): Promise<ArgosClosest | null> {
  if (!plan.sql_cercana.trim() || !plan.frase_cercana.trim()) return null
  const words = binding.period?.words ?? {}
  const bound = bindArgosPeriod(plan.sql_cercana, binding.period, binding.branch?.name ?? null)
  if ("problem" in bound) return null
  try {
    const result = await run(bound.sql)
    if (!result.rows.length || unknownArgosHoles(plan.frase_cercana, result, words).length) return null
    const filled = fillArgosSentence(plan.frase_cercana, result, zone, words)
    return { text: filled.text, sentence: filled.parts, query: plan.sql_cercana, table: tableOf(result, zone) }
  } catch {
    return null
  }
}
