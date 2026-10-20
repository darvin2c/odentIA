import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  ARGOS_WORDS,
  type ArgosColumnKind,
  type ArgosKey,
  type ArgosOutcome,
  type ArgosQueryResult,
  type ArgosSentencePart,
  argosCatalogText,
  argosColumnLabel,
  isArgosIdColumn,
  argosKeyOf,
  ArgosQueryError,
  argosScreen,
  fillArgosSentence,
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
 * vistas `argos` (ADR 0073). Jev decide la fila (una pregunta de los datos, de
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
})

export type ArgosPlan = z.infer<typeof planSchema>

const RULES = `Eres Argos, de odentIA: respondes preguntas sobre el negocio de una clínica dental. Escribes UNA consulta de PostgreSQL de solo lectura sobre las vistas de abajo (nunca otras tablas) y una frase con huecos que odentIA llenará con el resultado. Nunca ves los datos y nunca escribes una cifra del resultado: las cifras salen solo de los huecos.

El periodo:
- Una tendencia sin periodo («¿estamos creciendo o disminuyendo?», «¿cómo vamos?»): los últimos 3 meses completos contra los 3 meses completos anteriores; el mes en curso no entra.
- Si la pregunta no dice periodo y no es una tendencia, usa el de la pantalla si se indica y, si no, el mes en curso. Solo lo que mide frecuencia («más frecuentes», «cada cuánto vuelven», «cuánto tardan») mira los últimos 12 meses.
- Lo pendiente se mide a hoy, no por mes: lo que deben, los presupuestos que esperan respuesta, lo aceptado que falta hacer, el inventario, las citas por venir.
- Al comparar el mes en curso con otro mes («contra el mes anterior»), usa los mismos días de ese mes (del 1 al mismo día de hoy), nunca el mes entero.
- Al buscar el mejor o el peor mes, el mes en curso (incompleto) no entra.
- current_date y now() ya están en la zona de la clínica.

Qué contar:
- En una clínica «vender» incluye tratamientos y productos. «Lo que se vendió» es lo pagado (pagos_por_venta); lo cargado sin pagar es «lo que no se cobró» o «lo que deben».
- «Ticket promedio» es el promedio de ventas.importe (por venta), no el de los tickets de pago.
- odentIA no emite facturas ni boletas, solo tickets de pago: nunca digas «facturado» ni «facturación». Si preguntan por eso, dilo en la frase y responde con lo cobrado (cobros).
- «Lo más …» se ordena por lo que pregunta: «más ingresos» o «más dinero» por monto, «más veces» o «más frecuentes» por cuántas veces; si no lo dice, por cuántas veces y después por monto.
- Cuenta y agrupa a las personas por su paciente_id (o persona_id) cuando la vista lo tenga: hay nombres repetidos. Esos ids no se muestran.
- Al agrupar por un nombre (profesional, concepto, sede, categoría), deja fuera las filas sin nombre (null), salvo que la pregunta las pida.
- Para juntar cifras de dos vistas, suma cada vista por separado (una subconsulta o un WITH por vista) y junta los totales después: un JOIN de filas de dos vistas antes de sumar las multiplica.
- Antes de responder no_existe, mira si se arma con las vistas y las cifras de abajo (margen, retención, pagos parciales, valor por cómo nos conoció, prospectos, horas clínicas…). no_existe es solo para lo de «Lo que odentIA no registra», lo clínico (diagnósticos, enfermedades, alergias, la historia clínica) o lo que ninguna vista tiene.
- Si lo pedido no está, tipo no_existe y sin consulta: dilo con palabras simples y, si hay algo cercano que sí existe, ponlo en sql_cercana con su frase_cercana. Nunca respondas otra cifra como si fuera la pedida: los controles vencidos no son tratamientos atrasados, ni quien indicó un tratamiento es quien lo hará.
- Si solo puedes responder una parte, tipo parcial: la consulta responde esa parte y «falta» dice lo que no se puede saber.

La frase:
- Dice, en pocas palabras y solo cuando cambia la cifra, qué periodo o supuesto usaste, con nombres: «del 1 al 20 de octubre», «en septiembre de 2026», «en los últimos 12 meses (de noviembre de 2025 a octubre de 2026)», «hoy». Si comparas, nombra los dos periodos: «del 1 al 20 de octubre, frente a los mismos días de septiembre». Si la pregunta se puede entender de dos formas, di también qué contaste: «volvieron {pacientes} pacientes que llevaban más de 6 meses sin venir». El detalle del cálculo va en «como», no en la frase.
- Huecos: {columna} es el valor de esa columna en la primera fila; {lista} son las filas (hasta 10) como «col1 (col2, col3)», en el orden de tu consulta, y odentIA dice cuántas más hay; {filas} es cuántas filas hay. El hueco ya trae su formato: no agregues moneda ni «%» junto a él.

La consulta:
- Una sola sentencia SELECT (o WITH … SELECT), sin punto y coma, sin comentarios, sin comillas dobles y sin LIMIT mayor a 50. Si la lista puede pasar de 10 filas, ordénala para que lo importante salga primero.
- Columnas del resultado en español y en minúsculas: el dinero con el sufijo _dinero, los porcentajes (de 0 a 100, redondeados) con _pct y un mes como el primer día de ese mes (date) con _mes, que odentIA muestra «mayo de 2026». Las fechas van como date o timestamptz, nunca como texto.

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
    `Ahora en la clínica: ${now} (zona ${input.zone.timezone}). El mes en curso va del día 1 hasta hoy.`,
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

/** Con el modelo de demostración: unas pocas preguntas por palabras, sin proveedor. */
export function demoArgosPlan(question: string): ArgosPlan {
  const text = question.toLowerCase()
  const empty = { falta: "", sql_cercana: "", frase_cercana: "" }
  if (/cobr|ingres/.test(text))
    return {
      ...empty,
      tipo: "consulta",
      sql: "select coalesce(sum(importe), 0) as cobrado_dinero from cobros where dia >= date_trunc('month', current_date)",
      frase: "Este mes se cobró {cobrado_dinero}.",
      frase_vacia: "Este mes no se cobró nada.",
      como: "Lo cobrado del mes en curso: pagos menos anulaciones y devoluciones.",
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
    }
  return {
    ...empty,
    tipo: "no_existe",
    sql: "",
    frase: "Con el modelo de demostración solo respondo lo cobrado, las citas y los pacientes nuevos.",
    frase_vacia: "",
    como: "",
  }
}

/** El modelo escribe la consulta y las frases. Con `retry`, la corrige con el problema que tuvo la anterior. */
export async function writeArgosPlan(
  deps: Pick<AgentRuntime, "platform" | "createModel">,
  input: ArgosAsk & { retry?: { plan: ArgosPlan; problem: string } },
): Promise<ArgosPlan> {
  const spec = resolveLlmSpec(deps.platform)
  if (spec.provider === "fake" && !deps.createModel) return demoArgosPlan(input.question)
  const answer = tool(async () => "respondido", {
    name: TOOL_NAME,
    description: "Entrega la consulta y las frases de la respuesta.",
    schema: planSchema,
  })
  const model = deps.createModel ? await deps.createModel(spec) : await createConfiguredChatModel(spec, { explicitCache: true, temperature: 0 })
  type Bindable = { bindTools: (tools: unknown[], options?: Record<string, unknown>) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }
  const bound = typeof (model as unknown as Partial<Bindable>).bindTools === "function" ? (model as unknown as Bindable).bindTools([answer], { tool_choice: TOOL_NAME }) : model
  const messages = argosMessages(spec.provider, input)
  if (input.retry)
    messages.push(
      new HumanMessage({
        content: `Tu consulta anterior fue:\n${input.retry.plan.sql}\nNo se pudo usar: ${input.retry.problem}. Corrígela y responde otra vez.`,
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
    { value: "negocio", description: "Una pregunta sobre los datos de la clínica: dinero, cobros, ventas, pacientes, citas, agenda, tratamientos, presupuestos, promociones, inventario o el equipo." },
    { value: "ayuda", description: "Cómo se usa odentIA: dónde está algo o cómo se hace algo en el sistema." },
    { value: "otro", description: "Un saludo, algo ajeno a la clínica o un pedido de hacer algo (enviar, cambiar, agendar)." },
  ],
}

export type ArgosRoute = "negocio" | "ayuda" | "otro"

/** Sin modelo de decisión (demostración o Jev caído) todo va a los datos: el modelo que escribe dirá si no existe. */
export async function routeArgosQuestion(model: DecisionModel | null, text: string): Promise<ArgosRoute> {
  if (!model) return /\b(c[oó]mo (hago|se|puedo)|d[oó]nde (est[aá]|encuentro|veo))\b/i.test(text) ? "ayuda" : "negocio"
  try {
    const result = await model.decide(text, [ARGOS_ROUTE_QUESTION])
    const choice = answerOf(result, ARGOS_ROUTE_QUESTION.id, "choice")?.choice
    return choice === "ayuda" || choice === "otro" ? choice : "negocio"
  } catch {
    return "negocio"
  }
}

export interface ArgosTable {
  columns: Array<{ name: string; label: string; kind: ArgosColumnKind }>
  rows: ArgosQueryResult["rows"]
  truncated: boolean
}

export interface ArgosClosest {
  text: string
  sentence: ArgosSentencePart[]
  query: string
  table: ArgosTable
}

export type ArgosAskResult =
  | {
      kind: "respuesta"
      partial: boolean
      text: string
      sentence: ArgosSentencePart[]
      /** «Así lo calculé». */
      how: string
      missing: string | null
      table: ArgosTable
      /** Lo que la pantalla guarda para seguir la conversación (D3) y fijar (D5). */
      query: string
    }
  | { kind: "no_existe"; message: string; missing: string | null; closest: ArgosClosest | null }
  | { kind: "ayuda" | "otro" | "apagado" | "tope" | "sin_modelo" | "no_pudo" | "sin_permiso"; message: string }

function tableOf(result: ArgosQueryResult): ArgosTable {
  // Los ids siguen en las filas (para abrir a la persona desde la pantalla), pero no son una columna que se muestre.
  const columns = result.columns.filter((column) => !isArgosIdColumn(column.name)).map((column) => ({ ...column, label: argosColumnLabel(column.name) }))
  return { columns, rows: result.rows, truncated: result.truncated }
}

export interface ArgosDeps extends Pick<AgentRuntime, "platform" | "createModel" | "secretsKey"> {
  decisions?: PlatformDecisions
  /** Sustituye el modelo de decisión (pruebas); `null` = sin modelo de decisión. */
  decisionModel?: DecisionModel | null
  /** Cada vez que la base rechaza una consulta del modelo (para medir; el error no trae datos). */
  onProblem?: (problem: string) => void
}

/**
 * Responde una pregunta de Argos de punta a punta. Recibe la conexión del rol
 * app; cada lectura abre su propio contexto de la clínica. Lo pagado al
 * proveedor lo mide quien llama (`meterAiUse`).
 */
export async function askArgos(
  db: Db,
  deps: ArgosDeps,
  input: { orgId: string; userId: string; memberRole: string; text: string; screen?: ReportQuery; previous?: { text: string; query: string } | null; now?: Date },
): Promise<ArgosAskResult> {
  const now = input.now ?? new Date()
  const key = argosKeyOf(input.memberRole)
  if (!key) return { kind: "sin_permiso", message: "Tu rol todavía no puede preguntarle a Argos." }
  const record = (outcome: ArgosOutcome, query: string | null, usedModel: boolean) =>
    withOrgContext(db, input.orgId, (tx) => recordArgosQuestion(tx, input.orgId, input.userId, { outcome, query, usedModel }))

  const ready = await withOrgContext(db, input.orgId, async (tx) => ({
    ...(await prepareArgosQuestion(tx, input.orgId, now)),
    screen: input.screen ? await argosScreen(tx, input.orgId, input.screen, now) : null,
  }))
  if (!ready.enabled) return { kind: "apagado", message: ARGOS_WORDS.apagado }
  if (ready.roomLeft <= 0) return { kind: "tope", message: ARGOS_WORDS.tope }

  const decision = deps.decisionModel !== undefined ? deps.decisionModel : await createAdminDecisionModel(db, deps, input.orgId).catch(() => null)
  const route = await routeArgosQuestion(decision, input.text)
  if (route !== "negocio") {
    await record(route, null, false)
    return { kind: route, message: ARGOS_WORDS[route] }
  }

  const ask: ArgosAsk = { question: input.text, key, now, zone: ready.zone, screen: ready.screen, previous: input.previous ?? null }
  const run = (query: string) => runArgosQuery(db, { orgId: input.orgId, memberRole: input.memberRole, query })
  /** Corre la consulta del plan: su resultado o el problema que se le devuelve al modelo (sin datos). */
  const attempt = async (plan: ArgosPlan): Promise<{ result: ArgosQueryResult } | { problem: string }> => {
    try {
      const result = await run(plan.sql)
      const holes = unknownArgosHoles(result.rows.length ? plan.frase : plan.frase_vacia, result)
      return holes.length ? { problem: `la frase usa ${holes.map((hole) => `{${hole}}`).join(", ")}, que no son columnas del resultado` } : { result }
    } catch (error) {
      if (!(error instanceof ArgosQueryError) || error.code === "PERMISO") throw error
      return { problem: error.message }
    }
  }

  let plan: ArgosPlan
  let result: ArgosQueryResult | null = null
  try {
    plan = await writeArgosPlan(deps, ask)
    // Una sola corrección: si la segunda tampoco corre, se dice que no se pudo.
    for (let tries = 0; tries < 2 && !withoutQuery(plan); tries += 1) {
      const outcome = await attempt(plan)
      if ("result" in outcome) {
        result = outcome.result
        break
      }
      deps.onProblem?.(outcome.problem)
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
    return { kind: "no_pudo", message: ARGOS_WORDS.noPudo }
  }
  const filled = result.rows.length ? fillArgosSentence(plan.frase, result, ready.zone) : { text: plan.frase_vacia, parts: [{ text: plan.frase_vacia }] }
  await record(plan.tipo === "parcial" ? "parcial" : "respondida", plan.sql, true)
  return {
    kind: "respuesta",
    partial: plan.tipo !== "consulta",
    text: filled.text,
    sentence: filled.parts,
    how: plan.como,
    missing: plan.falta.trim() || null,
    table: tableOf(result),
    query: plan.sql,
  }
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
    return { text: filled.text, sentence: filled.parts, query: plan.sql_cercana, table: tableOf(result) }
  } catch {
    return null
  }
}
