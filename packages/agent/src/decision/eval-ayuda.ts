/**
 * La Ayuda medida por respuesta (estudio X8): cuántas veces se muestra el
 * texto de la guía que responde y, sobre todo, cuántas se muestra uno
 * equivocado como si fuera el bueno. El banco es `help-preguntas.json` de los
 * servicios, etiquetado por respuesta: preguntas escritas por el equipo, nunca
 * mensajes reales. Uso:
 *
 *   pnpm --filter @odentia/agent eval:ayuda -- --provider=buscador|buscador-faq|fake|baseline|jev [--umbral=0.6] [--banco=…] [--detalle] [--ver-ciegos] [--file=…]
 *
 * - `buscador`: el de hoy, sin modelo (`matchHelpTopics`): la pregunta frecuente
 *   o, si no hay, el párrafo de la pantalla. No cuesta.
 * - `buscador-faq`: el mismo, pero solo responde con una pregunta frecuente y si
 *   no la hay calla: el respaldo cuando Jev no responde. No cuesta.
 * - `fake`: el modelo de decisión de demostración; sirve para ver el recorrido,
 *   no para medir.
 * - `jev` y `baseline` hacen la pregunta `help.v1` al proveedor: cuestan. Una
 *   llamada que falla se responde con el respaldo (`buscador-faq`), como lo
 *   haría la Ayuda, y se cuenta en «fallos».
 *
 * El umbral se elige con la curva de los bancos de ajuste (desarrollo, control
 * y final) y se confirma una sola vez, con `--umbral`, en los de confirmación
 * (ronda, ciego y cifras): las mismas respuestas se leen con cada umbral, sin
 * volver a llamar. Las preguntas de confirmación no se listan salvo con
 * `--ver-ciegos`: mirarlas para ajustar las gasta. No toca ninguna base ni
 * envía nada. El resultado es evidencia de este banco, no un benchmark del
 * proveedor.
 */
import { readFileSync } from "node:fs"
import { costMicrosOf } from "../ai-usage.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import {
  agentTextsFor,
  HELP_CONFIDENT,
  HELP_SELECT_VERSION,
  helpCandidates,
  type HelpOption,
  helpOptions,
  helpQuestion,
  helpScreenName,
  type HelpSelection,
  helpState,
  helpTopicsFor,
  matchHelpTopics,
  readHelpSelection,
} from "@odentia/services"
import {
  HELP_MINIMUM,
  type HelpBankItem,
  type HelpMetrics,
  type HelpOutcome,
  helpMetrics,
  helpOutcome,
  meetsHelpMinimum,
  tallyHelp,
} from "./help-measure.js"
import { createDecisionModel, type DecisionModel, type DecisionResult } from "./index.js"

type Product = "odentia" | "latidia"

const PRODUCTS = { odentia: "dental", latidia: "medical" } as const
/** Ya se usaron para ajustar el buscador: con ellos se elige el umbral. */
const TUNE = ["desarrollo", "control", "final"]
/** Nadie los usó para ajustar: confirman el umbral elegido, una vez. */
const CONFIRM = ["ronda", "ciego", "cifras"]
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
/** Una clínica de 10 personas que preguntan 5 veces al día, 26 días (estudio X8). */
const MONTHLY_QUESTIONS = 1_300
/** Desde esta proporción de llamadas fallidas, el p95 ya es el plazo. */
const FAILED_SHARE_WARNING = 0.05

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "buscador")
const PROVIDERS = ["buscador", "buscador-faq", "fake", "baseline", "jev"]
if (!PROVIDERS.includes(requested)) throw new Error(`Proveedor desconocido: ${requested} (${PROVIDERS.join(" | ")})`)
const searchOnly = requested === "buscador" || requested === "buscador-faq"
const threshold = Number(arg("umbral", String(HELP_CONFIDENT)).replace(",", "."))
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error(`--umbral va entre 0 (sin incluirlo) y 1, por ejemplo 0.6 o 0,6: «${arg("umbral", "")}»`)
const detail = process.argv.includes("--detalle")
const showHeldOut = process.argv.includes("--ver-ciegos")
const file = arg("file", "")
const timeoutMs = Number(process.env.DECISIONS_TIMEOUT_MS ?? 5000)
const banks = JSON.parse(readFileSync(file || new URL("../../../services/src/help-preguntas.json", import.meta.url), "utf8")) as Record<string, HelpBankItem[]>
const chosen = arg("banco", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
for (const name of chosen) if (!banks[name]) throw new Error(`El banco no tiene «${name}» (${Object.keys(banks).join(", ")})`)
const bankNames = chosen.length > 0 ? chosen : Object.keys(banks)

const env = process.env
async function decisionModel(): Promise<DecisionModel | null> {
  if (searchOnly) return null
  if (requested === "fake") {
    if ((env.LLM_MODEL ?? "fake") !== "fake") throw new Error("--provider=fake exige LLM_MODEL=fake; con un LLM real usa --provider=baseline")
    return createDecisionModel("baseline", { timeoutMs }, resolveLlmSpec({ fake: true }))
  }
  if (requested === "jev") {
    if (!env.JEV_API_KEY?.trim()) throw new Error("Falta JEV_API_KEY: esta medición llama a Jev")
    // Jev no usa el modelo que escribe: no hace falta su clave.
    return createDecisionModel("jev", { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL }, timeoutMs }, resolveLlmSpec({ fake: true }))
  }
  const spec = resolveLlmSpec(platformLlmFromEnv(env))
  if (spec.provider === "fake") throw new Error("--provider=baseline es con el modelo que escribe: quita LLM_MODEL=fake y define su clave, o usa --provider=fake")
  return createDecisionModel("baseline", { timeoutMs }, spec)
}
const model = await decisionModel()

const guides = Object.fromEntries(
  (Object.keys(PRODUCTS) as Product[]).map((product) => {
    const topics = helpTopicsFor(PRODUCTS[product])
    return [product, { topics, options: helpOptions(topics), texts: agentTextsFor(PRODUCTS[product]) }]
  }),
) as Record<Product, { topics: ReturnType<typeof helpTopicsFor>; options: HelpOption[]; texts: ReturnType<typeof agentTextsFor> }>

const shownName = (option: HelpOption) => (option.kind === "faq" ? `FAQ «${option.faq.q}»` : `párrafo de ${option.topic.id}`)
const wanted = (item: HelpBankItem) =>
  item.es ?? [...(item.faqs ?? []).map((q) => `FAQ «${q}»`), ...(item.temas ?? []).map((id) => `párrafo de ${id}`)].join(" o ")

interface Asked {
  bank: string
  item: HelpBankItem
  candidates: HelpOption[]
  /** Lo que respondió el proveedor; nulo con el buscador o si no respondió. */
  result: DecisionResult | null
  /** Lo que decide sin umbral: el buscador, o el respaldo cuando el proveedor no respondió. */
  fixed: HelpSelection | null
  failed: boolean
  /** Lo que tardó la llamada, también si falló; nulo sin llamada. */
  elapsedMs: number | null
}

function bySearch(item: HelpBankItem, product: Product, onlyFaq: boolean): HelpSelection {
  const [match] = matchHelpTopics(item.q, guides[product].topics)
  if (!match || (onlyFaq && !match.faq)) return { verdict: "ninguna", shown: [], offered: [], top: null }
  const option: HelpOption = match.faq ? { kind: "faq", topic: match.topic, faq: match.faq } : { kind: "tema", topic: match.topic }
  return { verdict: "seguro", shown: [option], offered: [], top: null }
}

const asked: Asked[] = []
const failures: string[] = []
const skipped = new Map<string, number>()
for (const bank of bankNames) {
  for (const item of banks[bank] ?? []) {
    // Ya está en un banco de ajuste: no confirma nada.
    if (item.repite && CONFIRM.includes(bank)) {
      skipped.set(bank, (skipped.get(bank) ?? 0) + 1)
      continue
    }
    const product = item.producto ?? "odentia"
    const guide = guides[product]
    const candidates = helpCandidates(guide.options, item.q)
    if (!model) {
      asked.push({ bank, item, candidates, result: null, fixed: bySearch(item, product, requested === "buscador-faq"), failed: false, elapsedMs: null })
      continue
    }
    const screen = item.pantalla ? helpScreenName(item.pantalla, guide.topics) : null
    const startedAt = Date.now()
    try {
      const result = await model.decide(helpState(item.q, screen), [helpQuestion(candidates, guide.texts)])
      asked.push({ bank, item, candidates, result, fixed: null, failed: false, elapsedMs: Date.now() - startedAt })
    } catch (error) {
      const elapsedMs = Date.now() - startedAt
      if (!CONFIRM.includes(bank) || showHeldOut) failures.push(`[${bank}] «${item.q}» → ${error instanceof Error ? error.message : String(error)} (${elapsedMs} ms)`)
      asked.push({ bank, item, candidates, result: null, fixed: bySearch(item, product, true), failed: true, elapsedMs })
    }
  }
}

const selectionAt = (entry: Asked, at: number): HelpSelection =>
  entry.fixed ?? (entry.result ? readHelpSelection(entry.result, entry.candidates, at) : { verdict: "duda", shown: [], offered: [], top: null })
const judged = (entries: Asked[], at: number) => entries.map((entry) => ({ entry, selection: selectionAt(entry, at) }))
const tallyAt = (entries: Asked[], at: number) => tallyHelp(judged(entries, at).map(({ entry, selection }) => ({ item: entry.item, selection, fallback: entry.failed })))

// La demora cuenta también las llamadas que fallaron, con lo que tardaron.
const calls = asked.flatMap((entry) => (entry.elapsedMs === null ? [] : [entry.elapsedMs])).sort((a, b) => a - b)
const percentile = (q: number) => calls[Math.min(calls.length - 1, Math.floor(q * calls.length))] ?? 0
const failedCalls = asked.filter((entry) => entry.failed).length
const failedShare = calls.length > 0 ? failedCalls / calls.length : 0
const measuredP95 = calls.length > 0 ? percentile(0.95) : null
/** Con más del 5 % de fallos, el p95 del veredicto es al menos el plazo. */
const p95 = measuredP95 === null ? null : failedShare > FAILED_SHARE_WARNING ? Math.max(measuredP95, timeoutMs) : measuredP95

const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)} %`)
const pad = (text: string | number, width: number) => String(text).padStart(width)

const providerLabel = model ? `${model.provider} (${asked.find((entry) => entry.result)?.result?.model ?? "sin respuesta"})` : requested
console.log(`Ayuda · ${searchOnly ? "sin modelo" : HELP_SELECT_VERSION} · proveedor ${providerLabel}`)
for (const product of Object.keys(PRODUCTS) as Product[]) {
  const { topics, options, texts } = guides[product]
  const question = helpQuestion(options, texts)
  const chars = question.kind === "choice" ? question.options.reduce((sum, option) => sum + option.value.length + (option.description?.length ?? 0), question.instructions.length) : 0
  const faqs = options.filter((option) => option.kind === "faq").length
  console.log(
    `  guía ${product}: ${topics.length} pantallas y ${faqs} preguntas frecuentes → ${question.kind === "choice" ? question.options.length : 0} opciones con «datos» y «ninguna», ${chars} caracteres (≈ ${Math.round(chars / 4)} tokens a 4 car./token, sin tokenizador)`,
  )
}
console.log(
  `  bancos: ${bankNames.map((name) => `${name} ${(banks[name]?.length ?? 0) - (skipped.get(name) ?? 0)}${skipped.get(name) ? ` (${skipped.get(name)} repetidas de los de ajuste, fuera)` : ""}`).join(" · ")}`,
)
if (model && !model.reportsProbabilities) console.log("  Este proveedor no entrega probabilidades: nunca está seguro y todo cuenta como duda.")

const count = (outcomes: Record<HelpOutcome, number>, ...kinds: HelpOutcome[]) => kinds.reduce((sum, kind) => sum + outcomes[kind], 0)
console.log(`\nPor banco${searchOnly ? "" : `, con el umbral ${threshold}`}:`)
console.log(
  `  ${"banco".padEnd(11)}${pad("n", 5)}${pad("seguro bien", 13)}${pad("seguro mal", 12)}${pad("(2.ª mal)", 11)}${pad("(pantalla bien)", 17)}${pad("duda c/correcta", 17)}${pad("duda sin", 10)}${pad("ninguna bien", 14)}${pad("ninguna mal", 13)}${pad("datos bien", 12)}${pad("datos mal", 11)}${pad("fallos", 8)}`,
)
for (const bank of bankNames) {
  const entries = asked.filter((entry) => entry.bank === bank)
  const t = tallyAt(entries, threshold)
  const o = t.outcomes
  const screenRight = judged(entries, threshold).filter(({ entry, selection }) => {
    const first = selection.shown[0]
    return helpOutcome(entry.item, selection) === "seguro-mal" && first !== undefined && entry.item.expected.includes(first.topic.id)
  }).length
  console.log(
    `  ${bank.padEnd(11)}${pad(t.n, 5)}${pad(o["seguro-bien"], 13)}${pad(count(o, "seguro-mal", "segunda-mal"), 12)}${pad(o["segunda-mal"], 11)}${pad(screenRight, 17)}${pad(o["duda-con"], 17)}${pad(o["duda-sin"], 10)}${pad(o["ninguna-bien"], 14)}${pad(o["ninguna-mal"], 13)}${pad(o["datos-bien"], 12)}${pad(o["datos-mal"], 11)}${pad(t.fallback, 8)}`,
  )
}
console.log("  «seguro bien»: todo lo que mostró corresponde. «seguro mal» incluye (2.ª mal), la primera bien y la segunda no, y (pantalla bien), la pantalla correcta con otra respuesta.")

const HEADER_1 = `  ${"umbral".padEnd(8)}${pad("mostrado", 11)}${pad("cota inf.", 11)}${pad("sin respuesta", 15)}${pad("con respuesta", 15)}${pad("seguro y", 10)}${pad("«datos»", 11)}${pad("fallos", 8)}${pad("cumple", 8)}`
const HEADER_2 = `  ${"".padEnd(8)}${pad("correcto", 11)}${pad("95 %", 11)}${pad("no responde", 15)}${pad("resuelve", 15)}${pad("mal", 10)}${pad("bien dicho", 11)}`
const MINIMUMS = `  ${"mínimo".padEnd(8)}${pad("≥ 95 %", 11)}${pad("", 11)}${pad("≥ 95 %", 15)}${pad("≥ 70 %", 15)}${pad("", 10)}${pad("", 11)}${pad("", 8)}${pad("p95 ≤ 2 s", 12)}`
function row(label: string, metrics: HelpMetrics, fallback: number): string {
  return `  ${label.padEnd(8)}${pad(pct(metrics.shownRight), 11)}${pad(pct(metrics.shownRightLow), 11)}${pad(pct(metrics.quiet), 15)}${pad(pct(metrics.resolved), 15)}${pad(metrics.sureWrong, 10)}${pad(pct(metrics.dataRight), 11)}${pad(fallback, 8)}${pad(meetsHelpMinimum(metrics, p95) ? "sí" : "no", 8)}`
}

const tuning = asked.filter((entry) => TUNE.includes(entry.bank))
if (tuning.length > 0) {
  console.log(`\nPara elegir el umbral, en ${TUNE.filter((name) => bankNames.includes(name)).join(" + ")} (n = ${tuning.length}; ya se usaron para ajustar el buscador):`)
  console.log(HEADER_1)
  console.log(HEADER_2)
  console.log(MINIMUMS)
  if (searchOnly) {
    const t = tallyAt(tuning, threshold)
    console.log(row("—", helpMetrics(t), t.fallback))
  } else {
    const passing: number[] = []
    for (const at of THRESHOLDS) {
      const t = tallyAt(tuning, at)
      const metrics = helpMetrics(t)
      console.log(row(at.toFixed(2), metrics, t.fallback))
      if (meetsHelpMinimum(metrics, p95)) passing.push(at)
    }
    console.log(
      passing.length > 0
        ? `  Cumplen los cuatro mínimos: ${passing.map((at) => at.toFixed(2)).join(", ")}. Confirma el más bajo, una sola vez, con --umbral=${passing[0]?.toFixed(2)}.`
        : "  Ningún umbral cumple los cuatro mínimos: no se cambia la Ayuda (estudio X8).",
    )
  }
}

const heldOut = asked.filter((entry) => CONFIRM.includes(entry.bank))
if (heldOut.length > 0) {
  const t = tallyAt(heldOut, threshold)
  console.log(`\nConfirmación${searchOnly ? "" : ` con el umbral ${threshold}`}, en ${CONFIRM.filter((name) => bankNames.includes(name)).join(" + ")} (n = ${heldOut.length}; nadie los usó para ajustar):`)
  console.log(HEADER_1)
  console.log(HEADER_2)
  console.log(MINIMUMS)
  console.log(row(searchOnly ? "—" : threshold.toFixed(2), helpMetrics(t), t.fallback))
}

const results = asked.flatMap((entry) => (entry.result ? [entry.result] : []))
if (calls.length > 0) {
  console.log(
    `\nDemora (${calls.length} llamadas, también las que fallaron): p50 ${percentile(0.5)} ms · p95 ${measuredP95} ms (mínimo para salir ≤ ${HELP_MINIMUM.p95Ms} ms${p95 !== null && p95 > HELP_MINIMUM.p95Ms ? ": NO lo cumple" : ""}; plazo de esta medición ${timeoutMs} ms)`,
  )
  if (failedShare > FAILED_SHARE_WARNING) {
    console.log(`  p95 ≥ plazo: fallaron ${failedCalls} de ${calls.length} llamadas (más del ${FAILED_SHARE_WARNING * 100} %); en «cumple» el p95 cuenta como ${p95} ms.`)
  } else if (failedCalls > 0) console.log(`  Fallaron ${failedCalls} de ${calls.length} llamadas; se respondieron con el respaldo sin Jev.`)
  const inputs = results.flatMap((result) => (result.usage ? [result.usage.inputTokens] : [])).sort((a, b) => a - b)
  const outputs = results.flatMap((result) => (result.usage ? [result.usage.outputTokens] : [])).sort((a, b) => a - b)
  const middle = (values: number[]) => values[Math.floor(values.length / 2)] ?? 0
  if (model?.provider === "fake") console.log("  Tokens y costo: el modelo de demostración no los informa de verdad.")
  else if (inputs.length === 0) console.log("  Tokens y costo: el proveedor no informó su uso.")
  else {
    console.log(`  Tokens de entrada por pregunta: mínimo ${inputs[0]} · habitual ${middle(inputs)} · máximo ${inputs[inputs.length - 1]}; de salida, habitual ${middle(outputs)}`)
    const costs = results.map((result) => (result.usage ? costMicrosOf({ model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }) : null))
    const priced = costs.filter((cost): cost is number => cost !== null).sort((a, b) => a - b)
    if (priced.length === 0) console.log(`  Costo: «${results[0]?.model}» no tiene precio en AI_PRICES.`)
    else {
      const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(6)}`
      const total = priced.reduce((sum, cost) => sum + cost, 0)
      console.log(`  Costo por pregunta: habitual ${usd(middle(priced))} · máximo ${usd(priced[priced.length - 1] ?? 0)} · esta corrida ${usd(total)} (${priced.length} llamadas con precio, de ${results.length})`)
      console.log(`  ${MONTHLY_QUESTIONS} preguntas al mes (clínica de 10 personas, estudio X8): ${usd(middle(priced) * MONTHLY_QUESTIONS)}`)
    }
  }
}
if (failures.length > 0) {
  console.log(`\nSin respuesta del proveedor (${failures.length}; se respondieron con el respaldo sin Jev):`)
  for (const failure of failures) console.log(`  - ${failure}`)
}

const lines = { wrong: [] as string[], missed: [] as string[] }
let hiddenWrong = 0
let hiddenMissed = 0
for (const { entry, selection } of judged(asked, threshold)) {
  const outcome = helpOutcome(entry.item, selection)
  const hidden = CONFIRM.includes(entry.bank) && !showHeldOut
  const tag = `[${entry.bank} · ${entry.item.producto ?? "odentia"}] «${entry.item.q}»`
  const top = selection.top === null ? "" : ` (${selection.top.toFixed(2)})`
  if (outcome === "seguro-mal" || outcome === "segunda-mal") {
    if (hidden) hiddenWrong += 1
    else lines.wrong.push(`${tag} → mostró ${selection.shown.map(shownName).join(" y ")}${top}${outcome === "segunda-mal" ? " [la segunda no corresponde]" : ""}; esperado: ${wanted(entry.item)}`)
    continue
  }
  const missed =
    outcome === "duda-sin"
      ? `dudó sin la correcta entre ${selection.offered.map(shownName).join(", ") || "nada"}`
      : outcome === "ninguna-mal" || outcome === "datos-mal"
        ? `dijo «${selection.verdict}»`
        : null
  if (!missed) continue
  if (hidden) hiddenMissed += 1
  else lines.missed.push(`${tag} → ${missed}${top}; esperado: ${wanted(entry.item)}`)
}
console.log(`\nSeguro y se equivoca${searchOnly ? "" : ` con el umbral ${threshold}`} (${lines.wrong.length + hiddenWrong}):`)
for (const line of lines.wrong) console.log(`  - ${line}`)
if (hiddenWrong > 0) console.log(`  … y ${hiddenWrong} en los bancos de confirmación: --ver-ciegos las muestra, y mirarlas para ajustar los gasta.`)
if (detail) {
  console.log(`\nLo demás que no resolvió (${lines.missed.length + hiddenMissed}):`)
  for (const line of lines.missed) console.log(`  - ${line}`)
  if (hiddenMissed > 0) console.log(`  … y ${hiddenMissed} en los bancos de confirmación (--ver-ciegos).`)
}
