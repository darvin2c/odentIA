/**
 * La Ayuda medida por respuesta (estudio X8): cuántas veces se muestra el
 * texto de la guía que responde y, sobre todo, cuántas se muestra uno
 * equivocado como si fuera el bueno. El banco es `help-preguntas.json` de los
 * servicios, etiquetado por respuesta: preguntas escritas por el equipo, nunca
 * mensajes reales. Uso:
 *
 *   pnpm --filter @odentia/agent eval:ayuda -- --provider=buscador|buscador-faq|fake|baseline|jev [--banco=ronda,ciego] [--umbral=0.6] [--detalle] [--file=…]
 *
 * - `buscador`: el de hoy, sin modelo (`matchHelpTopics`): la pregunta frecuente
 *   o, si no hay, el párrafo de la pantalla. No cuesta.
 * - `buscador-faq`: el mismo, pero solo responde con una pregunta frecuente y si
 *   no la hay calla: el respaldo cuando Jev no responde. No cuesta.
 * - `fake`: el modelo de decisión de demostración; sirve para ver el recorrido,
 *   no para medir.
 * - `jev` y `baseline` hacen la pregunta `help.v1` al proveedor: cuestan.
 *
 * Con un modelo de decisión imprime la curva por umbral con los mínimos del
 * estudio, para elegir el umbral con datos: las mismas respuestas se leen con
 * cada umbral, sin volver a llamar. No toca ninguna base ni envía nada. El
 * resultado es evidencia de este banco, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { agentTextsFor, helpTopicsFor, matchHelpTopics } from "@odentia/services"
import { costMicrosOf } from "../ai-usage.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import {
  HELP_CONFIDENT,
  HELP_SELECT_VERSION,
  helpCandidates,
  type HelpOption,
  helpOptions,
  helpQuestion,
  helpScreenName,
  type HelpSelection,
  helpState,
  readHelpSelection,
} from "./help.js"
import { createDecisionModel, type DecisionModel, type DecisionResult } from "./index.js"

type Product = "odentia" | "latidia"
type Expected = "respuesta" | "ninguna" | "datos"

/** Una pregunta del banco. `expected` es la pantalla (la etiqueta vieja); lo demás, la respuesta. */
interface BankItem {
  q: string
  expected: string[]
  producto?: Product
  /** Ruta de la pantalla desde donde se preguntó, si se sabe. */
  pantalla?: string
  faqs?: string[]
  temas?: string[]
  es?: "ninguna" | "datos"
}

const PRODUCTS = { odentia: "dental", latidia: "medical" } as const
/** Los que no se usaron para ajustar el buscador: con ellos se elige el umbral. */
const DECIDE_WITH = ["ronda", "ciego", "cifras"]
const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
/** Mínimos para salir (estudio X8, «Qué exigir antes de salir»). */
const MINIMUM = { shownRight: 0.95, quietWithoutAnswer: 0.95, resolved: 0.7, p95Ms: 2_000 }
/** Una clínica de 10 personas que preguntan 5 veces al día, 26 días (estudio X8). */
const MONTHLY_QUESTIONS = 1_300

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "buscador")
const PROVIDERS = ["buscador", "buscador-faq", "fake", "baseline", "jev"]
if (!PROVIDERS.includes(requested)) throw new Error(`Proveedor desconocido: ${requested} (${PROVIDERS.join(" | ")})`)
const searchOnly = requested === "buscador" || requested === "buscador-faq"
const threshold = Number(arg("umbral", String(HELP_CONFIDENT)))
const detail = process.argv.includes("--detalle")
const file = arg("file", "")
const banks = JSON.parse(readFileSync(file || new URL("../../../services/src/help-preguntas.json", import.meta.url), "utf8")) as Record<string, BankItem[]>
const chosen = arg("banco", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
for (const name of chosen) if (!banks[name]) throw new Error(`El banco no tiene «${name}» (${Object.keys(banks).join(", ")})`)
const bankNames = chosen.length > 0 ? chosen : Object.keys(banks)

const env = process.env
async function decisionModel(): Promise<DecisionModel | null> {
  if (searchOnly) return null
  const timeoutMs = Number(env.DECISIONS_TIMEOUT_MS ?? 5000)
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

const expectedOf = (item: BankItem): Expected => item.es ?? "respuesta"
const keyOf = (option: HelpOption) => (option.kind === "faq" ? `faq:${option.faq.q}` : `tema:${option.topic.id}`)
const accepted = (item: BankItem) => new Set([...(item.faqs ?? []).map((q) => `faq:${q}`), ...(item.temas ?? []).map((id) => `tema:${id}`)])
const shownName = (option: HelpOption) => (option.kind === "faq" ? `FAQ «${option.faq.q}»` : `párrafo de ${option.topic.id}`)
const wanted = (item: BankItem) =>
  item.es ?? [...(item.faqs ?? []).map((q) => `FAQ «${q}»`), ...(item.temas ?? []).map((id) => `párrafo de ${id}`)].join(" o ")

interface Asked {
  bank: string
  item: BankItem
  candidates: HelpOption[]
  /** Lo que respondió el proveedor; nulo si no respondió (en la Ayuda, el respaldo sin Jev). */
  result: DecisionResult | null
  /** El buscador ya decide: no tiene umbral. */
  fixed: HelpSelection | null
}

function bySearch(item: BankItem, product: Product): HelpSelection {
  const [match] = matchHelpTopics(item.q, guides[product].topics)
  if (!match || (requested === "buscador-faq" && !match.faq)) return { verdict: "ninguna", shown: [], offered: [], top: null }
  const option: HelpOption = match.faq ? { kind: "faq", topic: match.topic, faq: match.faq } : { kind: "tema", topic: match.topic }
  return { verdict: "seguro", shown: [option], offered: [], top: null }
}

const asked: Asked[] = []
const failures: string[] = []
for (const bank of bankNames) {
  for (const item of banks[bank] ?? []) {
    const product = item.producto ?? "odentia"
    const guide = guides[product]
    const candidates = helpCandidates(guide.options, item.q)
    if (!model) {
      asked.push({ bank, item, candidates, result: null, fixed: bySearch(item, product) })
      continue
    }
    const screen = item.pantalla ? helpScreenName(item.pantalla, guide.topics) : null
    try {
      const result = await model.decide(helpState(item.q, screen), [helpQuestion(candidates, guide.texts)])
      asked.push({ bank, item, candidates, result, fixed: null })
    } catch (error) {
      failures.push(`[${bank}] «${item.q}» → ${error instanceof Error ? error.message : String(error)}`)
      asked.push({ bank, item, candidates, result: null, fixed: null })
    }
  }
}

const selectionAt = (entry: Asked, at: number): HelpSelection | null =>
  entry.fixed ?? (entry.result ? readHelpSelection(entry.result, entry.candidates, at) : null)

function tally(entries: Asked[], at: number) {
  const out = {
    n: entries.length,
    answerable: 0,
    unanswerable: 0,
    data: 0,
    sure: 0,
    sureRight: 0,
    sureWrong: 0,
    sameScreen: 0,
    secondWrong: 0,
    doubtRight: 0,
    doubtWithout: 0,
    noneRight: 0,
    noneWrong: 0,
    dataRight: 0,
    dataWrong: 0,
    quiet: 0,
    failed: 0,
    wrong: [] as string[],
    missed: [] as string[],
  }
  for (const entry of entries) {
    const { item } = entry
    const expected = expectedOf(item)
    if (expected === "respuesta") out.answerable += 1
    else out.unanswerable += 1
    if (expected === "datos") out.data += 1
    const selection = selectionAt(entry, at)
    const tag = `[${entry.bank} · ${item.producto ?? "odentia"}] «${item.q}»`
    if (!selection) {
      out.failed += 1
      if (expected !== "respuesta") out.quiet += 1
      continue
    }
    const ok = accepted(item)
    const top = selection.top === null ? "" : ` (${selection.top.toFixed(2)})`
    if (selection.verdict === "seguro") {
      out.sure += 1
      const [first, second] = selection.shown
      if (first && ok.has(keyOf(first))) {
        out.sureRight += 1
        if (second && !ok.has(keyOf(second))) {
          out.secondWrong += 1
          out.missed.push(`${tag} → acertó, pero mostró además ${shownName(second)}`)
        }
      } else {
        out.sureWrong += 1
        const screenRight = first !== undefined && item.expected.includes(first.topic.id)
        if (screenRight) out.sameScreen += 1
        out.wrong.push(`${tag} → mostró ${selection.shown.map(shownName).join(" y ")}${top}${screenRight ? " [pantalla correcta]" : ""}; esperado: ${wanted(item)}`)
      }
      continue
    }
    if (expected !== "respuesta") out.quiet += 1
    if (selection.verdict === "duda") {
      if (expected !== "respuesta") continue
      if (selection.offered.some((option) => ok.has(keyOf(option)))) out.doubtRight += 1
      else {
        out.doubtWithout += 1
        out.missed.push(`${tag} → dudó sin la correcta entre ${selection.offered.map(shownName).join(", ") || "nada"}${top}; esperado: ${wanted(item)}`)
      }
      continue
    }
    const said = selection.verdict === "ninguna" ? "ninguna" : "datos"
    if (said === expected) {
      if (said === "ninguna") out.noneRight += 1
      else out.dataRight += 1
      continue
    }
    if (said === "ninguna") out.noneWrong += 1
    else out.dataWrong += 1
    out.missed.push(`${tag} → dijo «${said}»${top}; esperado: ${wanted(item)}`)
  }
  return out
}

const share = (hits: number, of: number) => (of === 0 ? "—" : `${((hits / of) * 100).toFixed(1)} %`)
const resolvedOf = (t: ReturnType<typeof tally>) => t.sureRight + t.doubtRight
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
console.log(`  bancos: ${bankNames.map((name) => `${name} ${banks[name]?.length ?? 0}`).join(" · ")}`)
if (model && !model.reportsProbabilities) console.log("  Este proveedor no entrega probabilidades: nunca está seguro y todo cuenta como duda.")

console.log(`\nPor banco${searchOnly ? "" : `, con el umbral ${threshold}`}:`)
console.log(
  `  ${"banco".padEnd(11)}${pad("n", 5)}${pad("seguro bien", 13)}${pad("seguro mal", 12)}${pad("(pantalla bien)", 17)}${pad("duda c/correcta", 17)}${pad("duda sin", 10)}${pad("ninguna bien", 14)}${pad("ninguna mal", 13)}${pad("datos bien", 12)}${pad("datos mal", 11)}${pad("fallos", 8)}`,
)
for (const bank of bankNames) {
  const t = tally(
    asked.filter((entry) => entry.bank === bank),
    threshold,
  )
  console.log(
    `  ${bank.padEnd(11)}${pad(t.n, 5)}${pad(t.sureRight, 13)}${pad(t.sureWrong, 12)}${pad(t.sameScreen, 17)}${pad(t.doubtRight, 17)}${pad(t.doubtWithout, 10)}${pad(t.noneRight, 14)}${pad(t.noneWrong, 13)}${pad(t.dataRight, 12)}${pad(t.dataWrong, 11)}${pad(t.failed, 8)}`,
  )
}
console.log("  (pantalla bien): de los «seguro mal», cuántos eligieron la pantalla correcta con otra respuesta o con su párrafo.")

const deciding = asked.filter((entry) => DECIDE_WITH.includes(entry.bank))
const decideLabel = DECIDE_WITH.filter((name) => bankNames.includes(name)).join(" + ")
function metricsRow(label: string, t: ReturnType<typeof tally>): string {
  return `  ${label.padEnd(8)}${pad(share(t.sureRight, t.sure), 12)}${pad(share(t.quiet, t.unanswerable), 14)}${pad(share(resolvedOf(t), t.answerable), 14)}${pad(t.sureWrong, 11)}${pad(share(t.dataRight, t.data), 13)}`
}
if (deciding.length > 0) {
  console.log(`\nLo que exige el estudio, en ${decideLabel} (n = ${deciding.length}):`)
  console.log(`  ${"umbral".padEnd(8)}${pad("mostrado", 12)}${pad("sin respuesta", 14)}${pad("con respuesta", 14)}${pad("seguro y", 11)}${pad("«datos»", 13)}`)
  console.log(`  ${"".padEnd(8)}${pad("correcto", 12)}${pad("no responde", 14)}${pad("resuelve", 14)}${pad("mal", 11)}${pad("bien dicho", 13)}`)
  console.log(`  ${"mínimo".padEnd(8)}${pad("≥ 95 %", 12)}${pad("≥ 95 %", 14)}${pad("≥ 70 %", 14)}`)
  if (searchOnly) console.log(metricsRow("—", tally(deciding, threshold)))
  else {
    const passing: number[] = []
    for (const at of THRESHOLDS) {
      const t = tally(deciding, at)
      console.log(metricsRow(at.toFixed(2), t))
      const meets = t.sure > 0 && t.sureRight / t.sure >= MINIMUM.shownRight && t.quiet / Math.max(1, t.unanswerable) >= MINIMUM.quietWithoutAnswer && resolvedOf(t) / Math.max(1, t.answerable) >= MINIMUM.resolved
      if (meets) passing.push(at)
    }
    console.log(passing.length > 0 ? `  Cumplen los tres mínimos: ${passing.map((at) => at.toFixed(2)).join(", ")}.` : "  Ningún umbral cumple los tres mínimos: no se cambia la Ayuda (estudio X8).")
  }
  console.log("  Mirar los fallos de «ronda» o «ciego» para ajustar las opciones los gasta: hay que escribir otro banco ciego.")
}

const results = asked.flatMap((entry) => (entry.result ? [entry.result] : []))
if (results.length > 0) {
  const sorted = results.map((result) => result.latencyMs).sort((a, b) => a - b)
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  const p95 = at(0.95)
  console.log(`\nDemora: p50 ${at(0.5)} ms · p95 ${p95} ms (mínimo para salir ≤ ${MINIMUM.p95Ms} ms${p95 > MINIMUM.p95Ms ? ": NO lo cumple" : ""}; plazo de esta medición ${env.DECISIONS_TIMEOUT_MS ?? 5000} ms)`)
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
  console.log(`\nSin respuesta del proveedor (${failures.length}; en la Ayuda irían al respaldo sin Jev):`)
  for (const failure of failures) console.log(`  - ${failure}`)
}

const atThreshold = tally(asked, threshold)
console.log(`\nSeguro y se equivoca${searchOnly ? "" : ` con el umbral ${threshold}`} (${atThreshold.wrong.length}):`)
for (const line of atThreshold.wrong) console.log(`  - ${line}`)
if (detail) {
  console.log(`\nLo demás que no resolvió (${atThreshold.missed.length}):`)
  for (const line of atThreshold.missed) console.log(`  - ${line}`)
}
