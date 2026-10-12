/**
 * Evaluación de un modelo de decisión sobre ejemplos propios etiquetados
 * (nunca mensajes reales de pacientes sin autorización). Uso:
 *
 *   pnpm --filter @odentia/agent eval:decisions -- --provider=fake|baseline|jev|openai_decisions (fake exige LLM_MODEL=fake) [--file=eval/decisiones-ejemplos.json]
 *
 * Imprime acierto por pregunta y repetibilidad. Las credenciales se leen
 * del entorno (LLM_*, JEV_*, OPENAI_DECISIONS_*). El resultado es evidencia
 * de este conjunto, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"
import { TRIAGE_QUESTIONS, triageOutcome, triageState } from "./points.js"

interface Example {
  previous?: Array<{ direction: "in" | "out"; body: string }>
  /** Mensajes que el contacto envió seguidos antes del último, del más antiguo al más reciente. */
  burst?: string[]
  latest: string
  expected: { requires_reply: boolean; handoff: boolean; urgency: number; intent: string; unsubscribe: boolean }
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

// `fake` equivale a la línea base con LLM_MODEL=fake (modelo de decisión falso).
const requested = arg("provider", "fake")
if (!["fake", "baseline", "jev", "openai_decisions"].includes(requested)) {
  throw new Error(`Proveedor desconocido: ${requested} (fake | baseline | jev | openai_decisions)`)
}
if (requested === "fake" && (process.env.LLM_MODEL ?? "fake") !== "fake") {
  throw new Error("--provider=fake exige LLM_MODEL=fake; con un LLM real usa --provider=baseline")
}
const provider = (requested === "fake" ? "baseline" : requested) as DecisionProvider
const file = resolve(arg("file", "eval/decisiones-ejemplos.json"))
const repeats = Number(arg("repeats", "1"))
const examples = JSON.parse(readFileSync(file, "utf8")) as Example[]

const env = process.env
const spec = resolveLlmSpec({ model: null }, null, {
  modelName: env.LLM_MODEL ?? "fake",
  apiKey: env.LLM_API_KEY || undefined,
  baseUrl: env.LLM_BASE_URL,
  allowInsecureBaseUrl: env.LLM_ALLOW_INSECURE_BASE_URL === "true",
})
const decision = await createDecisionModel(
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
if (!decision) throw new Error("Elige un proveedor distinto de none")

const hits: Record<string, number> = {}
const totals: Record<string, number> = {}
const latencies: number[] = []
let flips = 0
let comparisons = 0
const mistakes: string[] = []
const bump = (key: string, ok: boolean, miss?: () => string) => {
  totals[key] = (totals[key] ?? 0) + 1
  if (ok) hits[key] = (hits[key] ?? 0) + 1
  else if (miss) mistakes.push(`${key}: «${miss()}`)
}

for (const example of examples) {
  const state = triageState(example.previous ?? [], example.latest, example.burst ?? [])
  let first: string | null = null
  for (let i = 0; i < repeats; i += 1) {
    const result = await decision.decide(state, TRIAGE_QUESTIONS)
    latencies.push(result.latencyMs)
    // Mismos umbrales que la sombra (triageOutcome): se mide lo que se haría.
    const outcome = triageOutcome(result)
    // Cada fallo se lista con lo esperado y lo obtenido: es lo que sirve para ajustar umbrales.
    const miss = (expected: unknown, got: unknown) => () => `${example.latest}» → esperado ${String(expected)}, obtuvo ${String(got)}`
    bump("requires_reply", outcome.wouldSkipReply === !example.expected.requires_reply, miss(example.expected.requires_reply, !outcome.wouldSkipReply))
    bump("handoff", outcome.wouldHandoff === example.expected.handoff, miss(example.expected.handoff, outcome.wouldHandoff))
    bump("urgency", outcome.urgencyLevel === example.expected.urgency, miss(example.expected.urgency, outcome.urgencyLevel))
    bump("intent", outcome.intent === example.expected.intent, miss(example.expected.intent, outcome.intent))
    bump("unsubscribe", outcome.wouldFlagUnsubscribe === example.expected.unsubscribe, miss(example.expected.unsubscribe, outcome.wouldFlagUnsubscribe))
    const signature = JSON.stringify(outcome)
    if (first === null) first = signature
    else {
      comparisons += 1
      if (signature !== first) flips += 1
    }
  }
}

const sorted = [...latencies].sort((a, b) => a - b)
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
console.log(`Proveedor ${decision.provider} · ${examples.length} ejemplos · ${repeats} repetición(es)`)
for (const key of Object.keys(totals)) {
  console.log(`  ${key.padEnd(15)} ${hits[key] ?? 0}/${totals[key]} (${(((hits[key] ?? 0) / totals[key]!) * 100).toFixed(0)} %)`)
}
if (comparisons > 0) console.log(`  repetibilidad: ${comparisons - flips}/${comparisons} respuestas iguales entre repeticiones`)
console.log(`  latencia p50 ${p(0.5)} ms · p95 ${p(0.95)} ms`)
for (const mistake of mistakes) console.log(`  - ${mistake}`)
