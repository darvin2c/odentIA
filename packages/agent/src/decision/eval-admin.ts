/**
 * Prueba de lo que el modelo hace para el Administrador, sobre pedidos y
 * mensajes de ejemplo propios (nunca de pacientes reales). Uso:
 *
 *   pnpm --filter @odentia/agent eval:admin -- --provider=baseline|jev|openai_decisions [--file=eval/administrador-pedidos.json]
 *
 * Mide las dos cosas que decide un modelo: entender un pedido con palabras
 * (línea e intención, entre opciones cerradas) y «¿ya avisó algo?» antes de un
 * seguimiento. Imprime cuántas veces acertó y los tokens por llamada. No toca
 * ninguna base ni envía nada. El resultado es evidencia de este conjunto, no
 * un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type AdminInterpretation, interpretAdminRequest } from "@odentia/services"
import { ALREADY_TOLD_MIN, ALREADY_TOLD_QUESTION, alreadyToldState, asAdminDecider } from "../admin.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"

interface RequestExample {
  text: string
  /** null: no habla de ninguna línea, y no debe armarse nada. */
  key: string | null
  /** null: no se evalúa (el pedido solo trae algo que no se puede). */
  intent?: string | null
  /** El pedido no deja saber si la línea ya existe: «prender» vale igual que «cambiar», y no se compara si la prende. */
  eitherWay?: boolean
  changes?: Record<string, unknown> | null
  /** Tiene que decir que algo de lo pedido no se puede. */
  unsupported?: boolean
}

interface ToldExample {
  reason: string
  messages: string[]
  expected: boolean
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "baseline")
if (!["baseline", "jev", "openai_decisions"].includes(requested)) {
  throw new Error(`Proveedor desconocido: ${requested} (baseline | jev | openai_decisions)`)
}
const provider = requested as DecisionProvider
const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/administrador-pedidos.json")), "utf8")) as {
  pedidos: RequestExample[]
  ya_aviso: ToldExample[]
}

const env = process.env
const spec = resolveLlmSpec(platformLlmFromEnv(env))
if (provider === "baseline" && spec.provider === "fake") throw new Error("Esta prueba es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor, o usa --provider=jev")
const model = await createDecisionModel(
  provider,
  {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    ...(env.OPENAI_DECISIONS_API_KEY
      ? { openai: { apiKey: env.OPENAI_DECISIONS_API_KEY, baseUrl: env.OPENAI_DECISIONS_BASE_URL, model: env.OPENAI_DECISIONS_MODEL } }
      : {}),
    timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000),
  },
  spec,
)
if (!model) throw new Error("Elige un proveedor distinto de none")

const tokens = (usage: { inputTokens: number; outputTokens: number } | null) => (usage ? usage.inputTokens + usage.outputTokens : null)
function spread(values: number[]): string {
  if (values.length === 0) return "el proveedor no informó tokens"
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted[Math.floor(sorted.length / 2)]
  return `mínimo ${sorted[0]} · habitual ${middle} · máximo ${sorted[sorted.length - 1]} · total ${sorted.reduce((sum, value) => sum + value, 0)}`
}
const sameChanges = (expected: Record<string, unknown>, got: AdminInterpretation["changes"], ignoreEnabled: boolean) => {
  const clean = (value: object) => JSON.stringify(Object.entries(value).filter(([key]) => !(ignoreEnabled && key === "enabled")).sort())
  return clean(expected) === clean(got)
}

// --- Entender un pedido ---------------------------------------------------------
const decider = asAdminDecider(model)
const used: number[] = []
const inputs: number[] = []
const misses: string[] = []
let line = 0
let intent = 0
let intentTotal = 0
let whole = 0
let wholeTotal = 0
let refused = 0
let refusedTotal = 0
let failed = 0
for (const example of bank.pedidos) {
  let got: AdminInterpretation
  try {
    got = await interpretAdminRequest(example.text, decider)
  } catch (error) {
    failed += 1
    misses.push(`«${example.text}» → el modelo no respondió (${error instanceof Error ? error.message : "error"})`)
    continue
  }
  const total = tokens(got.usage)
  if (total !== null) {
    used.push(total)
    inputs.push(got.usage?.inputTokens ?? 0)
  }
  // Lo que no es de ninguna línea no debe darse por entendido: ahí no se arma nada.
  const gotKey = got.understood ? got.key : null
  const lineOk = gotKey === example.key
  if (lineOk) line += 1
  else misses.push(`«${example.text}» → línea esperada ${example.key ?? "ninguna"}, obtuvo ${gotKey ?? "ninguna"}`)
  if (example.key === null) {
    refusedTotal += 1
    if (lineOk) refused += 1
    continue
  }
  const intentOk = got.intent === example.intent || (!!example.eitherWay && got.intent === "prender")
  if (example.intent) {
    intentTotal += 1
    if (lineOk && intentOk) intent += 1
    else if (lineOk) misses.push(`«${example.text}» → intención esperada ${example.intent}, obtuvo ${got.intent ?? "ninguna"}`)
  }
  if (example.changes) {
    wholeTotal += 1
    if (lineOk && intentOk && sameChanges(example.changes, got.changes, !!example.eitherWay)) whole += 1
    else if (lineOk && intentOk) misses.push(`«${example.text}» → cambio esperado ${JSON.stringify(example.changes)}, obtuvo ${JSON.stringify(got.changes)}`)
  }
  if (example.unsupported && lineOk && got.unsupported.length === 0) misses.push(`«${example.text}» → debía decir que no se puede y no lo dijo`)
}
const pct = (hits: number, total: number) => (total === 0 ? "sin casos" : `${hits}/${total} (${((hits / total) * 100).toFixed(0)} %)`)
console.log(`Proveedor ${model.provider} · modelo ${provider === "baseline" ? spec.modelName : (env.JEV_MODEL ?? "por defecto")}`)
console.log(`Entender un pedido · ${bank.pedidos.length} pedidos de ejemplo`)
console.log(`  línea correcta            ${pct(line, bank.pedidos.length)}`)
console.log(`  no arma lo que no existe  ${pct(refused, refusedTotal)}`)
console.log(`  intención correcta        ${pct(intent, intentTotal)}`)
console.log(`  cambio completo correcto  ${pct(whole, wholeTotal)}`)
if (failed > 0) console.log(`  sin respuesta del modelo  ${failed}`)
console.log(`  tokens por pedido: ${spread(used)}`)
if (inputs.length > 0) console.log(`  de entrada por pedido: ${spread(inputs)}`)
for (const miss of misses) console.log(`  - ${miss}`)

// --- «¿Ya avisó algo?» -----------------------------------------------------------
const toldUsed: number[] = []
const toldMisses: string[] = []
let toldHits = 0
for (const example of bank.ya_aviso) {
  try {
    const result = await model.decide(alreadyToldState(example), [ALREADY_TOLD_QUESTION])
    const total = tokens(result.usage)
    if (total !== null) toldUsed.push(total)
    const answer = result.answers.find((item) => item.id === "ya_aviso")
    const probability = answer?.kind === "yesno" ? answer.probability : 0
    if (probability >= ALREADY_TOLD_MIN === example.expected) toldHits += 1
    else toldMisses.push(`«${example.messages[0]}» (${example.reason}) → esperado ${example.expected ? "sí" : "no"}, probabilidad ${probability.toFixed(2)}`)
  } catch (error) {
    toldMisses.push(`«${example.messages[0]}» → el modelo no respondió (${error instanceof Error ? error.message : "error"})`)
  }
}
console.log(`«¿Ya avisó algo?» · ${bank.ya_aviso.length} ejemplos`)
console.log(`  acierto            ${pct(toldHits, bank.ya_aviso.length)}`)
console.log(`  tokens por llamada: ${spread(toldUsed)}`)
for (const miss of toldMisses) console.log(`  - ${miss}`)
