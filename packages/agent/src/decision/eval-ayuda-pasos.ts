/**
 * La Ayuda en dos pasos (`help.v2`, ADR 0178), medida por respuesta con el
 * recorrido real (`decideHelp` de los servicios): la categoría, la respuesta
 * dentro de ella, la búsqueda en toda la guía cuando la categoría no es segura
 * y, si la respuesta está repartida, si Jev dice que las partes se completan.
 * El banco es `help-preguntas.json` de los servicios: preguntas escritas por
 * el equipo, nunca mensajes reales. Uso:
 *
 *   pnpm --filter @odentia/agent eval:ayuda-pasos -- --provider=fake|jev [--banco=…] [--redactar] [--detalle] [--ver-ciegos] [--file=…]
 *
 * - `fake`: el modelo de decisión de demostración; sirve para ver el recorrido,
 *   no para medir.
 * - `jev`: llama a Jev (cuesta): entre 2 y unas 6 llamadas por pregunta.
 * - `--redactar`: además llama al modelo que escribe cuando las partes se
 *   completan (cuesta más) y lista lo redactado, para leerlo: aquí no hay juez.
 *   Sin él, solo se cuenta cuántas se habrían redactado.
 *
 * A diferencia de `eval:ayuda` (la pregunta `help.v1` sola, con su curva de
 * umbrales), aquí los umbrales son los del código: cambiar uno es otra corrida.
 * Las preguntas de confirmación (ronda, ciego, cifras) no se listan salvo con
 * `--ver-ciegos`: mirarlas para ajustar las gasta. No toca ninguna base ni
 * envía nada. El resultado es evidencia de este banco, no un benchmark.
 */
import { readFileSync } from "node:fs"
import {
  agentTextsFor,
  decideHelp,
  HELP_FLOW_VERSION,
  type HelpDecider,
  helpAreaOf,
  helpAreas,
  type HelpOption,
  helpOptions,
  helpScreenName,
  helpTopicsFor,
  helpTextForModel,
  type HelpWriter,
} from "@odentia/services"

import { asAdminDecider } from "../admin.js"
import { costMicrosOf } from "../ai-usage.js"
import { createHelpWriter } from "../help-writer.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { HELP_MINIMUM, type HelpBankItem, helpMetrics, helpOutcome, type HelpOutcome, meetsHelpMinimum, tallyHelp } from "./help-measure.js"
import { createDecisionModel, createFakeDecisionModel } from "./index.js"

const PRODUCTS = { odentia: "dental", latidia: "medical", vistia: "optical" } as const
type Product = keyof typeof PRODUCTS
const CONFIRM = ["ronda", "ciego", "cifras"]
const MONTHLY_QUESTIONS = 1_300

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "fake")
if (requested !== "fake" && requested !== "jev") throw new Error(`Proveedor desconocido: ${requested} (fake | jev)`)
const writeToo = process.argv.includes("--redactar")
const detail = process.argv.includes("--detalle")
const showHeldOut = process.argv.includes("--ver-ciegos")
const file = arg("file", "")
const timeoutMs = Number(process.env.DECISIONS_TIMEOUT_MS ?? 5000)
const banks = JSON.parse(readFileSync(file || new URL("../../../services/src/help-preguntas.json", import.meta.url), "utf8")) as Record<
  string,
  Array<Omit<HelpBankItem, "producto"> & { producto?: Product; antes?: { q: string; donde?: string } }>
>
const chosen = arg("banco", "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
for (const name of chosen) if (!banks[name]) throw new Error(`El banco no tiene «${name}» (${Object.keys(banks).join(", ")})`)
const bankNames = chosen.length > 0 ? chosen : Object.keys(banks)

const env = process.env
const model =
  requested === "fake"
    ? createFakeDecisionModel()
    : await (() => {
        if (!env.JEV_API_KEY?.trim()) throw new Error("Falta JEV_API_KEY: esta medición llama a Jev")
        return createDecisionModel("jev", { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL }, timeoutMs }, resolveLlmSpec({ fake: true }))
      })()
if (!model) throw new Error("Jev no está configurado: revisa JEV_API_KEY")
const base = asAdminDecider(model)

const guides = Object.fromEntries(
  (Object.keys(PRODUCTS) as Product[]).map((product) => {
    const topics = helpTopicsFor(PRODUCTS[product])
    return [product, { topics, options: helpOptions(topics), texts: agentTextsFor(PRODUCTS[product]) }]
  }),
) as Record<Product, { topics: ReturnType<typeof helpTopicsFor>; options: HelpOption[]; texts: ReturnType<typeof agentTextsFor> }>

interface Asked {
  bank: string
  item: (typeof banks)[string][number]
  product: Product
  decided: Awaited<ReturnType<typeof decideHelp>>
  /** Llamadas a Jev de esa pregunta, con lo que tardó y gastó cada una. */
  calls: Array<{ id: string; ms: number; model: string; usage: { inputTokens: number; outputTokens: number } | null }>
  ms: number
  /** Jev dijo que las partes se completan: se redactó, o se habría redactado. */
  joined: boolean
  written: string | null
}

const realWriter = writeToo ? createHelpWriter(requested === "fake" ? { fake: true } : platformLlmFromEnv(env)) : null
if (writeToo && !realWriter) throw new Error("--redactar necesita la clave del modelo que escribe (LLM_OPENAI_API_KEY)")

const asked: Asked[] = []
const skipped = new Map<string, number>()
for (const bank of bankNames) {
  for (const item of banks[bank] ?? []) {
    if (item.repite && CONFIRM.includes(bank)) {
      skipped.set(bank, (skipped.get(bank) ?? 0) + 1)
      continue
    }
    const product = item.producto ?? "odentia"
    const guide = guides[product]
    const calls: Asked["calls"] = []
    const decider: HelpDecider = {
      async decide(state, questions) {
        const startedAt = Date.now()
        const result = await base.decide(state, questions)
        calls.push({ id: questions[0]?.id ?? "", ms: Date.now() - startedAt, model: result.model, usage: result.usage })
        return result
      },
    }
    let joined = false
    let written: string | null = null
    const writer: HelpWriter = async (input) => {
      joined = true
      written = realWriter ? await realWriter(input) : null
      return written
    }
    const startedAt = Date.now()
    // Lo mismo que hace la Ayuda: a un modelo viaja sin cifras ni correos, o no viaja.
    const forModel = helpTextForModel(item.q)
    const previous = item.antes ? { question: item.antes.q, where: item.antes.donde ?? null } : null
    const decided = await decideHelp(forModel ?? item.q, item.pantalla ? helpScreenName(item.pantalla, guide.topics) : null, guide.topics, guide.texts, forModel === null ? null : decider, writer, previous)
    asked.push({ bank, item, product, decided, calls, ms: Date.now() - startedAt, joined, written })
  }
}

const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)} %`)
const pad = (text: string | number, width: number) => String(text).padStart(width)
const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(6)}`
const middle = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const p95of = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] ?? 0
}

console.log(`Ayuda · ${HELP_FLOW_VERSION} · proveedor ${model.provider} (${asked.flatMap((entry) => entry.calls)[0]?.model ?? "sin respuesta"})${writeToo ? " · redactando" : ""}`)
for (const product of Object.keys(PRODUCTS) as Product[]) {
  const { topics, options } = guides[product]
  const sizes = new Map<string, number>()
  for (const option of options) sizes.set(helpAreaOf(option), (sizes.get(helpAreaOf(option)) ?? 0) + 1)
  console.log(`  guía ${product}: ${topics.length} pantallas, ${options.filter((option) => option.kind === "faq").length} preguntas frecuentes, ${helpAreas(topics).length} categorías; la mayor tiene ${Math.max(...sizes.values())} opciones`)
}
console.log(
  `  bancos: ${bankNames.map((name) => `${name} ${(banks[name]?.length ?? 0) - (skipped.get(name) ?? 0)}${skipped.get(name) ? ` (${skipped.get(name)} repetidas, fuera)` : ""}`).join(" · ")}`,
)
if (requested === "fake") console.log("  El modelo de demostración decide por palabras en común: esto muestra el recorrido, no mide a Jev.")

const fallback = (entry: Asked) => entry.decided.via === "respaldo"
const tallyOf = (entries: Asked[]) => tallyHelp(entries.map((entry) => ({ item: entry.item as HelpBankItem, selection: entry.decided.selection, fallback: fallback(entry) })))
const count = (outcomes: Record<HelpOutcome, number>, ...kinds: HelpOutcome[]) => kinds.reduce((sum, kind) => sum + outcomes[kind], 0)

/** ¿La categoría elegida era la de la respuesta? Solo donde Jev eligió una y el banco dice la pantalla. */
function areaRight(entry: Asked): boolean | null {
  if (!entry.decided.area || entry.item.expected.length === 0) return null
  const guide = guides[entry.product]
  const accepted = new Set(
    guide.options.filter((option) => (option.kind === "faq" ? (entry.item.faqs ?? []).includes(option.faq.q) : (entry.item.temas ?? []).includes(option.topic.id))).map(helpAreaOf),
  )
  return accepted.size === 0 ? null : accepted.has(entry.decided.area)
}

console.log("\nPor banco:")
console.log(
  `  ${"banco".padEnd(11)}${pad("n", 5)}${pad("seguro bien", 13)}${pad("seguro mal", 12)}${pad("redactadas", 12)}${pad("duda c/correcta", 17)}${pad("duda sin", 10)}${pad("duda calla", 12)}${pad("ninguna bien", 14)}${pad("ninguna mal", 13)}${pad("datos bien", 12)}${pad("datos mal", 11)}${pad("sin Jev", 9)}`,
)
for (const bank of bankNames) {
  const entries = asked.filter((entry) => entry.bank === bank)
  const t = tallyOf(entries)
  const o = t.outcomes
  console.log(
    `  ${bank.padEnd(11)}${pad(t.n, 5)}${pad(o["seguro-bien"], 13)}${pad(count(o, "seguro-mal", "segunda-mal"), 12)}${pad(entries.filter((entry) => entry.joined).length, 12)}${pad(o["duda-con"], 17)}${pad(o["duda-sin"], 10)}${pad(o["duda-calla"], 12)}${pad(o["ninguna-bien"], 14)}${pad(o["ninguna-mal"], 13)}${pad(o["datos-bien"], 12)}${pad(o["datos-mal"], 11)}${pad(t.fallback, 9)}`,
  )
}
console.log("  «redactadas»: Jev dijo que dos o tres respuestas se completan. Sin --redactar cuentan como duda; con él, como seguro si todas sus partes corresponden.")

const perQuestionMs = asked.filter((entry) => entry.calls.length > 0).map((entry) => entry.ms)
const p95 = perQuestionMs.length > 0 ? p95of(perQuestionMs) : null
for (const [label, entries] of [
  ["Ajuste (desarrollo + control + final)", asked.filter((entry) => !CONFIRM.includes(entry.bank))],
  ["Confirmación (ronda + ciego + cifras)", asked.filter((entry) => CONFIRM.includes(entry.bank))],
] as const) {
  if (entries.length === 0) continue
  const t = tallyOf(entries)
  const metrics = helpMetrics(t)
  const areas = entries.map(areaRight).filter((value): value is boolean => value !== null)
  console.log(`\n${label}, n = ${entries.length}:`)
  console.log(`  De lo que muestra como respuesta, corresponde: ${pct(metrics.shownRight)} (cota inferior 95 %: ${pct(metrics.shownRightLow)}; mínimo ${pct(HELP_MINIMUM.shownRight)})`)
  console.log(`  Lo que la guía no responde y no recibe una respuesta: ${pct(metrics.quiet)} (mínimo ${pct(HELP_MINIMUM.quietWithoutAnswer)})`)
  console.log(`  Lo que la guía responde y se resuelve solo o con un toque: ${pct(metrics.resolved)} (mínimo ${pct(HELP_MINIMUM.resolved)})`)
  console.log(`  Seguro y mal: ${metrics.sureWrong} · «datos» bien dicho: ${pct(metrics.dataRight)}`)
  console.log(`  Primer paso: de ${areas.length} con categoría segura, acertó ${areas.filter(Boolean).length} (${pct(areas.length ? areas.filter(Boolean).length / areas.length : null)}); en ${entries.filter((entry) => entry.decided.via === "jev" && !entry.decided.area && entry.decided.selection.verdict !== "datos").length} buscó en toda la guía o dijo «ninguna» en el primer paso`)
  console.log(`  Cumple los mínimos: ${meetsHelpMinimum(metrics, p95) ? "sí" : "no"}`)
}

const allCalls = asked.flatMap((entry) => entry.calls)
if (allCalls.length > 0) {
  const perQuestion = asked.filter((entry) => entry.calls.length > 0)
  console.log(
    `\nLlamadas a Jev por pregunta: habitual ${middle(perQuestion.map((entry) => entry.calls.length))} · máximo ${Math.max(...perQuestion.map((entry) => entry.calls.length))} (${allCalls.length} en total)`,
  )
  console.log(`Demora por pregunta, con todos sus pasos: p50 ${middle(perQuestionMs)} ms · p95 ${p95} ms (mínimo para salir ≤ ${HELP_MINIMUM.p95Ms} ms${p95 !== null && p95 > HELP_MINIMUM.p95Ms ? ": NO lo cumple" : ""})`)
  if (requested === "fake") console.log("Tokens y costo: el modelo de demostración no los informa de verdad.")
  else {
    const costs = perQuestion.map((entry) =>
      entry.calls.reduce<number | null>((sum, call) => {
        const cost = call.usage ? costMicrosOf({ model: call.model, inputTokens: call.usage.inputTokens, outputTokens: call.usage.outputTokens }) : null
        return sum === null || cost === null ? null : sum + cost
      }, 0),
    )
    const priced = costs.filter((cost): cost is number => cost !== null)
    if (priced.length === 0) console.log("Costo: el proveedor no informó su uso o el modelo no tiene precio en AI_PRICES.")
    else {
      console.log(`Costo de Jev por pregunta: habitual ${usd(middle(priced))} · máximo ${usd(Math.max(...priced))} · esta corrida ${usd(priced.reduce((sum, cost) => sum + cost, 0))} (${priced.length} preguntas con precio, de ${perQuestion.length})`)
      console.log(`${MONTHLY_QUESTIONS} preguntas al mes (clínica de 10 personas, estudio X8): ${usd(middle(priced) * MONTHLY_QUESTIONS)}, sin contar lo redactado`)
    }
  }
}

const shownName = (option: HelpOption) => (option.kind === "faq" ? `FAQ «${option.faq.q}»` : `párrafo de ${option.topic.id}`)
const wanted = (item: Asked["item"]) => item.es ?? [...(item.faqs ?? []).map((q) => `FAQ «${q}»`), ...(item.temas ?? []).map((id) => `párrafo de ${id}`)].join(" o ")
const wrong: string[] = []
const missed: string[] = []
let hidden = 0
for (const entry of asked) {
  const outcome = helpOutcome(entry.item as HelpBankItem, entry.decided.selection)
  const bad = outcome === "seguro-mal" || outcome === "segunda-mal"
  const lost = outcome === "duda-sin" || outcome === "ninguna-mal" || outcome === "datos-mal"
  if (!bad && !lost) continue
  if (CONFIRM.includes(entry.bank) && !showHeldOut) {
    hidden += 1
    continue
  }
  const line = `[${entry.bank} · ${entry.product}] «${entry.item.q}» → ${entry.decided.selection.verdict}${entry.decided.area ? ` en ${entry.decided.area}` : ""}: ${[...entry.decided.selection.shown, ...entry.decided.selection.offered].map(shownName).join(", ") || "nada"}; esperado: ${wanted(entry.item)}`
  ;(bad ? wrong : missed).push(line)
}
console.log(`\nSeguro y se equivoca (${wrong.length}):`)
for (const line of wrong) console.log(`  - ${line}`)
if (detail) {
  console.log(`\nLo demás que no resolvió (${missed.length}):`)
  for (const line of missed) console.log(`  - ${line}`)
}
if (hidden > 0) console.log(`\n… y ${hidden} fallos en los bancos de confirmación: --ver-ciegos los muestra, y mirarlos para ajustar los gasta.`)

if (writeToo) {
  const texts = asked.filter((entry) => entry.joined && (!CONFIRM.includes(entry.bank) || showHeldOut))
  console.log(`\nLo redactado, para leerlo (${texts.length}; aquí no hay juez). «Se mostró» es que pasó la comprobación de nombres y cifras:`)
  for (const entry of texts) {
    console.log(`  - [${entry.bank} · ${entry.product}] «${entry.item.q}»`)
    console.log(`      partes: ${entry.decided.written ? entry.decided.selection.shown.map(shownName).join(" + ") : "(no se mostró)"}`)
    console.log(`      ${entry.decided.written ? "se mostró" : "NO se mostró"}: ${entry.written ?? "(sin texto)"}`)
  }
}
