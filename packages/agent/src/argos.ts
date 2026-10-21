import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  ARGOS_SCREENS,
  ARGOS_WORDS,
  type ArgosColumnKind,
  type ArgosKey,
  type ArgosOutcome,
  type ArgosQueryResult,
  type ArgosScreenKey,
  type ArgosSentencePart,
  type ArgosStoredAnswer,
  type ArgosStoredPlan,
  argosCatalogText,
  argosColumnLabel,
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
  frase_vacia: z.string().describe("La frase si la consulta no trae filas (sin huecos)."),
  como: z.string().describe("«Así lo calculé»: una o dos frases simples con qué se contó, de qué periodo y con qué regla."),
  falta: z.string().describe("En parcial o no_existe: lo que odentIA no registra. Vacío si nada falta."),
  sql_cercana: z.string().describe("En no_existe: una consulta con lo más cercano que sí existe. Vacía si no hay."),
  frase_cercana: z.string().describe("La frase de sql_cercana, con sus huecos. Vacía si no hay."),
  titulo: z.string().describe("Un título corto de la respuesta, sin nombres de personas: «Lo cobrado este mes»."),
  // Texto y no una lista cerrada: una pantalla desconocida no bota la respuesta, vale «ninguna».
  pantalla: z.string().describe(`La pantalla de odentIA donde se ve esto, para el botón «Abrir…»: ${ARGOS_SCREENS.join(", ")}.`),
  seguir: z
    .array(
      z.object({
        etiqueta: z.string().describe("El botón, de 1 a 4 palabras: «¿Y ayer?», «Por monto», «Por sede», «Solo productos»."),
        sql: z.string().describe("La consulta completa de esa variante."),
        frase: z.string().describe("Su frase con huecos."),
        frase_vacia: z.string().describe("Su frase si no trae filas."),
        como: z.string().describe("Su «Así lo calculé»."),
      }),
    )
    .describe("Hasta 3 variantes que la persona querría ver después; vacío en no_existe. Más de 3 no se usan."),
})

export type ArgosPlan = z.infer<typeof planSchema>

const RULES = `Eres Argos, de odentIA: respondes preguntas sobre el negocio de una clínica dental. Escribes UNA consulta de PostgreSQL de solo lectura sobre las vistas de abajo (nunca otras tablas) y una frase con huecos que odentIA llenará con el resultado. Nunca ves los datos y nunca escribes una cifra del resultado: las cifras salen solo de los huecos.

El periodo:
- Una tendencia sin periodo («¿estamos creciendo o disminuyendo?», «¿cómo vamos?»): los últimos 3 meses completos contra los 3 meses completos anteriores; el mes en curso no entra.
- Si la pregunta no dice periodo y no es una tendencia, usa el de la pantalla si se indica y, si no, el mes en curso. Solo lo que mide frecuencia o tiempo («más frecuentes», «cada cuánto vuelven», «cuánto tardan», «cuánto dura un tratamiento») y el valor de un paciente según cómo llegó miran el último año hasta hoy (dia > current_date - interval '1 year'), no meses completos.
- Lo pendiente se mide a hoy, no por mes: lo que deben, los presupuestos que esperan respuesta, lo aceptado que falta hacer, el inventario, las citas por venir.
- Al comparar el mes en curso con otro mes («contra el mes anterior»), usa los mismos días de ese mes (del 1 al mismo día de hoy), nunca el mes entero.
- «Los últimos N meses» y la evolución mes a mes son los N meses completos anteriores al actual; el mes en curso no entra.
- Al buscar el mejor o el peor mes, el mes en curso (incompleto) no entra; sin periodo, mira los últimos 12 meses completos.
- current_date y now() ya están en la zona de la clínica.

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
- Dice, en pocas palabras y solo cuando cambia la cifra, qué periodo o supuesto usaste, con nombres: «del 1 al 20 de octubre», «en septiembre de 2026», «en los últimos 12 meses (de noviembre de 2025 a octubre de 2026)», «hoy». Si comparas, nombra los dos periodos: «del 1 al 20 de octubre, frente a los mismos días de septiembre». Si la pregunta se puede entender de dos formas, di también qué contaste: «volvieron {pacientes} pacientes que llevaban más de 6 meses sin venir». El detalle del cálculo va en «como», no en la frase.
- Huecos: {columna} es el valor de esa columna en la primera fila; {lista} son las filas (hasta 12) como «col1 (col2, col3)», en el orden de tu consulta, y odentIA dice cuántas más hay; {filas} es cuántas filas trajo la consulta. El hueco ya trae su formato: no agregues moneda ni «%» junto a él. Nunca llames «filas» ni «lista» a una columna.
- {lista} va una sola vez y al final de la frase, después de dos puntos: «Los que más deben: {lista}.». Para el mayor y el menor (el mejor y el peor mes) no uses {lista}: una sola fila con columnas como mejor_mes, mejor_dinero, peor_mes y peor_dinero.
- Una lista de personas, ventas o cosas dice antes cuántas son en total y, si es dinero, cuánto suman, con columnas que empiezan con total_general: count(*) over () AS total_general y sum(saldo) over () AS total_general_dinero. «{total_general} pacientes te deben {total_general_dinero}. Los que más deben: {lista}.» Esas columnas no salen en la lista.
- Un cambio entre dos periodos va en una columna que empieza con variacion y termina en _pct (variacion_pct): odentIA le pone el signo («+1 %», «-32 %»). La frase nombra los dos periodos y sus cifras.
- Cada hueco {columna} es siempre la primera fila: para dos cifras de filas distintas, arma una sola fila con una columna por cifra.
- Lo que sale en la lista se lee: un estado o un tipo va en palabras (CASE estado WHEN 'hace_falta' THEN 'bajo el mínimo' … END), nunca su código; y no pongas columnas que la pregunta no necesita.

Para seguir:
- En «seguir», hasta 3 variantes de la misma respuesta que la persona querría ver después: otra fecha («¿Y ayer?», «¿Y el mes pasado?»), otro orden («Por monto»), otro grupo («Por sede», «Por profesional»), un filtro («Solo productos») o, si la pregunta se puede entender de otra forma, esa otra lectura. Cada una con su consulta completa y su frase; odentIA las corre al tocar el botón, sin volver a preguntarte.

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
  /** Lo que muestra la pantalla desde donde se pregunta (decisión D7). */
  screen?: { from: string; to: string; branch: string | null } | null
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
    `Ahora en la clínica: ${now} (zona ${input.zone.timezone}). ${argosPeriodNames(input.now, input.zone)}`,
    input.screen
      ? `La pantalla muestra del ${input.screen.from} al ${input.screen.to}${input.screen.branch ? `, solo la sede «${input.screen.branch}»` : ", todas las sedes"}: úsalo si la pregunta no dice otro periodo o sede.`
      : "",
    input.previous ? `Pregunta anterior: «${input.previous.text.slice(0, 300)}»\nSu consulta: ${input.previous.query.slice(0, 2000)}` : "",
    `Pregunta: «${input.question}»`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return [new SystemMessage({ content: mark ? [{ type: "text", text: fixed, ...mark }] : fixed }), new HumanMessage({ content: human })]
}

/**
 * Los periodos de la frase con su nombre, calculados aquí: el modelo los copia
 * en vez de contarlos (se equivocaba de mes al nombrar «los últimos 12 meses»).
 */
export function argosPeriodNames(now: Date, zone: { timezone: string; locale: string }): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now)
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const [year, month, day] = [get("year"), get("month"), get("day")]
  const monthName = (back: number, withYear = true) =>
    new Intl.DateTimeFormat(zone.locale, { timeZone: "UTC", month: "long", ...(withYear ? { year: "numeric" } : {}) })
      .format(new Date(Date.UTC(year, month - 1 - back, 1)))
      .toLocaleLowerCase(zone.locale)
  /** «de julio a setiembre de 2026», con el año en los dos si cruza de año. */
  const range = (from: number, to: number) =>
    `de ${monthName(from, new Date(Date.UTC(year, month - 1 - from, 1)).getUTCFullYear() !== new Date(Date.UTC(year, month - 1 - to, 1)).getUTCFullYear())} a ${monthName(to)}`
  const dayName = (date: Date) => new Intl.DateTimeFormat(zone.locale, { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(date)
  const yearAgo = new Date(Date.UTC(year - 1, month - 1, day + 1))
  return [
    `El mes en curso es ${monthName(0)} y va del 1 al ${day}; el mes anterior, ${monthName(1)} (sus mismos días: del 1 al ${day}).`,
    `Los últimos 3 meses completos van ${range(3, 1)}; los 3 anteriores, ${range(6, 4)}.`,
    `Los últimos 12 meses completos van ${range(12, 1)}.`,
    `El último año hasta hoy va del ${dayName(yearAgo)} al ${dayName(new Date(Date.UTC(year, month - 1, day)))}.`,
    "Usa estos nombres en la frase, tal cual.",
  ].join(" ")
}

/** Con el modelo de demostración: unas pocas preguntas por palabras, sin proveedor. */
export function demoArgosPlan(question: string): ArgosPlan {
  const text = question.toLowerCase()
  const empty = { falta: "", sql_cercana: "", frase_cercana: "", seguir: [] }
  if (/cobr|ingres/.test(text))
    return {
      ...empty,
      tipo: "consulta",
      sql: "select coalesce(sum(importe), 0) as cobrado_dinero from cobros where dia >= date_trunc('month', current_date)",
      frase: "Este mes se cobró {cobrado_dinero}.",
      frase_vacia: "Este mes no se cobró nada.",
      como: "Lo cobrado del mes en curso: pagos menos anulaciones y devoluciones.",
      titulo: "Lo cobrado este mes",
      pantalla: "finanzas",
      seguir: [
        {
          etiqueta: "Por medio de pago",
          sql: "select medio, sum(importe) as cobrado_dinero from cobros where dia >= date_trunc('month', current_date) and medio is not null group by medio order by cobrado_dinero desc",
          frase: "Este mes, por medio de pago: {lista}.",
          frase_vacia: "Este mes no se cobró nada.",
          como: "Lo cobrado del mes en curso por medio de pago.",
        },
      ],
    }
  if (/cita/.test(text)) {
    const tomorrow = /mañana/.test(text)
    return {
      ...empty,
      tipo: "consulta",
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
      sql: "select count(*) as pacientes from pacientes where primera_atencion >= date_trunc('month', current_date)",
      frase: "Este mes llegaron {pacientes} pacientes nuevos.",
      frase_vacia: "Este mes no llegaron pacientes nuevos.",
      como: "Pacientes cuya primera cita atendida fue este mes.",
      titulo: "Pacientes nuevos este mes",
      pantalla: "pacientes",
    }
  return {
    ...empty,
    tipo: "no_existe",
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
  /** Corre la consulta del plan: su resultado o el problema que se le devuelve al modelo (sin datos). */
  const attempt = (plan: Pick<ArgosPlan, "sql" | "frase" | "frase_vacia">) => runPlan(run, plan)

  let plan: ArgosPlan
  let result: ArgosQueryResult | null = null
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
    return { kind: "no_existe", message, missing: plan.falta.trim() || null, closest: await closestOf(plan, run, ready.zone) }
  }
  if (!result) {
    await record("no_pudo", plan.sql, true)
    return timedOut ? { kind: "tiempo", message: ARGOS_WORDS.tiempo } : { kind: "no_pudo", message: ARGOS_WORDS.noPudo }
  }
  const main = shown(plan, result, ready.zone)
  // Las de seguir ya corridas: la que falla, no llena su frase o no tiene nombre no se ofrece.
  const follows = plan.seguir.slice(0, 3)
  const options = (
    await Promise.all(
      follows.map(async (follow, index) => {
        if (!follow.etiqueta.trim()) return null
        const outcome = await attempt(follow).catch(() => null)
        return outcome && "result" in outcome && !argosSentenceProblem(outcome.result.rows.length ? follow.frase : follow.frase_vacia, outcome.result.rows.length)
          ? { index, label: follow.etiqueta.trim(), how: follow.como.trim() || plan.como, query: follow.sql, answer: shown(follow, outcome.result, ready.zone) }
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
  }
  const questionId = await record(plan.tipo === "parcial" ? "parcial" : "respondida", plan.sql, true, stored)
  return {
    kind: "respuesta",
    questionId,
    title: stored.titulo,
    screen: pantalla,
    partial: plan.tipo !== "consulta",
    ...main,
    how: plan.como,
    missing: plan.falta.trim() || null,
    query: plan.sql,
    options,
  }
}

/**
 * Vuelve a correr una respuesta guardada (una fijada en el Resumen) con la
 * llave de quien la mira. Si ya no corre o su rol no la ve, null.
 */
export async function showArgosAnswer(
  db: Db,
  input: { orgId: string; memberRole: string; answer: ArgosStoredAnswer; zone: Parameters<typeof fillArgosSentence>[2] },
): Promise<ArgosShown | null> {
  const outcome = await runPlan((query) => runArgosQuery(db, { orgId: input.orgId, memberRole: input.memberRole, query }), input.answer).catch(() => null)
  return outcome && "result" in outcome ? shown(input.answer, outcome.result, input.zone) : null
}

/** Corre una consulta del plan: su resultado o el problema que se le devuelve al modelo (sin datos). */
async function runPlan(
  run: (query: string) => Promise<ArgosQueryResult>,
  plan: Pick<ArgosPlan, "sql" | "frase" | "frase_vacia">,
): Promise<{ result: ArgosQueryResult } | { problem: string; code: ArgosQueryError["code"] | "HUECOS" }> {
  try {
    const result = await run(plan.sql)
    const holes = unknownArgosHoles(result.rows.length ? plan.frase : plan.frase_vacia, result)
    return holes.length ? { problem: `la frase usa ${holes.map((hole) => `{${hole}}`).join(", ")}, que no son columnas del resultado`, code: "HUECOS" } : { result }
  } catch (error) {
    if (!(error instanceof ArgosQueryError) || error.code === "PERMISO") throw error
    return { problem: error.message, code: error.code }
  }
}

/** La frase llena (o la de sin filas) y su tabla. */
function shown(plan: Pick<ArgosPlan, "frase" | "frase_vacia">, result: ArgosQueryResult, zone: Parameters<typeof fillArgosSentence>[2]): ArgosShown {
  const filled = result.rows.length ? fillArgosSentence(plan.frase, result, zone) : { text: plan.frase_vacia, parts: [{ text: plan.frase_vacia }] }
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
): Promise<ArgosClosest | null> {
  if (!plan.sql_cercana.trim() || !plan.frase_cercana.trim()) return null
  try {
    const result = await run(plan.sql_cercana)
    if (!result.rows.length || unknownArgosHoles(plan.frase_cercana, result).length) return null
    const filled = fillArgosSentence(plan.frase_cercana, result, zone)
    return { text: filled.text, sentence: filled.parts, query: plan.sql_cercana, table: tableOf(result, zone) }
  } catch {
    return null
  }
}
