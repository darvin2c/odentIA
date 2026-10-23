/**
 * Prueba de cómo entiende Argos una pregunta sobre Reportes (ADR 0070), sobre
 * preguntas de ejemplo propias (nunca de pacientes). Uso:
 *
 *   pnpm --filter @odentia/agent eval:reports -- --provider=jev|baseline [--file=eval/reportes-preguntas.json]
 *
 * Mide lo que pide la fase 5 antes de abrirlo: de las preguntas que están en
 * la lista, cuántas se responden con la cifra y la agrupación correctas; las
 * que no están, que digan «todavía no sé» o pregunten, y que ninguna invente
 * (responder otra cifra). Imprime tokens y costo por pregunta con `AI_PRICES`.
 * No toca ninguna base ni envía nada. El resultado es evidencia de este
 * conjunto, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { agentTextsFor, interpretReportQuestion, type ReportInterpretationResult } from "@odentia/services"
import { asAdminDecider } from "../admin.js"
import { AI_PRICES } from "../ai-usage.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"

interface Example {
  text: string
  kind: "cifra" | "no_sabe" | "clinico" | "accion" | "otro"
  figure?: string
  group?: string
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "baseline")
if (!["baseline", "jev"].includes(requested)) throw new Error(`Proveedor desconocido: ${requested} (baseline | jev)`)
const provider = requested as DecisionProvider
const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/reportes-preguntas.json")), "utf8")) as { preguntas: Example[] }

const env = process.env
const spec = resolveLlmSpec(platformLlmFromEnv(env))
if (provider === "baseline" && spec.provider === "fake") throw new Error("Esta prueba es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor, o usa --provider=jev")
const model = await createDecisionModel(
  provider,
  { ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}), timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000) },
  spec,
)
if (!model) throw new Error("Elige un proveedor distinto de none")
const decider = asAdminDecider(model)
const modelName = provider === "baseline" ? spec.modelName : (env.JEV_MODEL ?? "jev-1.13.0")
const price = AI_PRICES[modelName]

const tokens: number[] = []
const costs: number[] = []
const misses: string[] = []
const counts = { right: 0, figureOnly: 0, asked: 0, saidUnknown: 0, invented: 0, failed: 0, offRight: 0 }
const inList = bank.preguntas.filter((example) => example.kind === "cifra").length
const unknown = bank.preguntas.filter((example) => example.kind === "no_sabe").length
const off = bank.preguntas.length - inList - unknown

for (const example of bank.preguntas) {
  let got: ReportInterpretationResult
  try {
    got = await interpretReportQuestion(example.text, decider, { timezone: "America/Lima", now: new Date(), branches: [], billing: true, texts: agentTextsFor("dental") })
  } catch (error) {
    counts.failed += 1
    misses.push(`«${example.text}» → el modelo no respondió (${error instanceof Error ? error.message : "error"})`)
    continue
  }
  if (got.usage) {
    tokens.push(got.usage.inputTokens + got.usage.outputTokens)
    if (price) costs.push((got.usage.inputTokens * (price.input ?? 0) + got.usage.outputTokens * (price.output ?? 0)) / 1_000_000)
  }
  const result = got.interpretation
  if (example.kind === "cifra") {
    if (result.kind === "cifra") {
      if (result.figure !== example.figure) {
        counts.invented += 1
        misses.push(`«${example.text}» → respondió ${result.figure}, se esperaba ${example.figure}`)
      } else if (example.group && result.group !== example.group) {
        counts.figureOnly += 1
        misses.push(`«${example.text}» → cifra bien, agrupó ${result.group} en vez de ${example.group}`)
      } else counts.right += 1
    } else if (result.kind === "pregunta") {
      counts.asked += 1
      const offered = result.candidates.map((candidate) => candidate.figure)
      misses.push(`«${example.text}» → preguntó entre ${offered.join(", ")}${offered.includes(example.figure ?? "") ? "" : ` (sin ${example.figure})`}`)
    } else misses.push(`«${example.text}» → ${result.kind}, se esperaba ${example.figure}`)
    continue
  }
  if (example.kind === "no_sabe") {
    if (result.kind === "no_sabe" || result.kind === "pregunta") counts.saidUnknown += 1
    else if (result.kind === "cifra") {
      counts.invented += 1
      misses.push(`«${example.text}» → respondió ${result.figure} y no está en la lista`)
    } else misses.push(`«${example.text}» → ${result.kind}, se esperaba «todavía no sé»`)
    continue
  }
  if (result.kind === example.kind) counts.offRight += 1
  else {
    if (result.kind === "cifra") counts.invented += 1
    misses.push(`«${example.text}» → ${result.kind}${result.kind === "cifra" ? ` (${result.figure})` : ""}, se esperaba ${example.kind}`)
  }
}

const pct = (hits: number, total: number) => (total === 0 ? "sin casos" : `${hits}/${total} (${((hits / total) * 100).toFixed(0)} %)`)
function spread(values: number[], format: (value: number) => string = String): string {
  if (values.length === 0) return "el proveedor no informó"
  const sorted = [...values].sort((a, b) => a - b)
  return `mínimo ${format(sorted[0]!)} · habitual ${format(sorted[Math.floor(sorted.length / 2)]!)} · máximo ${format(sorted[sorted.length - 1]!)}`
}
const usd = (value: number) => `USD ${value.toFixed(6)}`
console.log(`Proveedor ${model.provider} · modelo ${modelName} · ${bank.preguntas.length} preguntas`)
console.log(`  en la lista, cifra y agrupación bien  ${pct(counts.right, inList)}`)
console.log(`  en la lista, cifra bien y otra agrupación  ${pct(counts.figureOnly, inList)}`)
console.log(`  en la lista, preguntó entre opciones  ${pct(counts.asked, inList)}`)
console.log(`  fuera de la lista, «todavía no sé» o preguntó  ${pct(counts.saidUnknown, unknown)}`)
console.log(`  clínico, acción u otra cosa, reconocido  ${pct(counts.offRight, off)}`)
console.log(`  inventó (respondió otra cifra)  ${counts.invented}`)
if (counts.failed > 0) console.log(`  sin respuesta del modelo  ${counts.failed}`)
console.log(`  tokens por pregunta: ${spread(tokens)}`)
console.log(`  costo por pregunta: ${price ? spread(costs, usd) : "sin precio en AI_PRICES"}`)
if (costs.length > 0) {
  const worst = Math.max(...costs)
  console.log(`  1 000 preguntas al mes, todas como la más cara: ${usd(worst * 1000)}`)
}
for (const miss of misses) console.log(`  - ${miss}`)
