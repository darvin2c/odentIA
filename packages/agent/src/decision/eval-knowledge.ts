/**
 * Banco de preguntas para la elección de conocimiento: mide cuántas veces el
 * modelo de decisión elige la respuesta oficial correcta y, sobre todo,
 * cuántas se equivoca diciendo estar seguro. Ejemplos escritos por el equipo
 * (nunca mensajes reales de pacientes sin autorización). Uso:
 *
 *   pnpm --filter @odentia/agent eval:knowledge -- --provider=fake|baseline|jev|openai_decisions [--file=eval/conocimiento-banco.json]
 *
 * El resultado es evidencia de este banco, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { KnowledgeEntryItem } from "@odentia/services"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"
import { knowledgeCandidates, knowledgeQuestion, readKnowledgeSelection } from "./knowledge.js"

interface Bank {
  entries: Array<{ title: string; body: string; askForms?: string[] }>
  questions: Array<{ text: string; expected: string | null }>
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const requested = arg("provider", "fake")
if (!["fake", "baseline", "jev", "openai_decisions"].includes(requested)) {
  throw new Error(`Proveedor desconocido: ${requested} (fake | baseline | jev | openai_decisions)`)
}
if (requested === "fake" && (process.env.LLM_MODEL ?? "fake") !== "fake") {
  throw new Error("--provider=fake exige LLM_MODEL=fake; con un LLM real usa --provider=baseline")
}
const provider = (requested === "fake" ? "baseline" : requested) as DecisionProvider
const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/conocimiento-banco.json")), "utf8")) as Bank
const entries: KnowledgeEntryItem[] = bank.entries.map((entry, index) => ({
  id: `banco-${index + 1}`,
  kind: "faq",
  title: entry.title,
  body: entry.body,
  branchId: null,
  branchName: null,
  status: "publicada",
  state: "vigente",
  validFrom: null,
  validUntil: null,
  askForms: entry.askForms ?? [],
  basicKey: null,
  version: 1,
  createdBy: null,
  createdAt: "",
  updatedAt: "",
}))

const env = process.env
// Con --provider=fake la línea base es el modelo de decisión falso, sin proveedor.
const spec = resolveLlmSpec(requested === "fake" ? { fake: true } : platformLlmFromEnv(env))
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

// «Acierta» = lo que el agente haría con esa elección sirve: con tema esperado,
// la respuesta correcta está entre las elegidas (o duda y por tanto recibe
// todas); sin tema esperado, no afirma ninguno con seguridad.
let sure = 0
let sureRight = 0
let sureWrong = 0
let doubt = 0
let none = 0
let noneRight = 0
let missed = 0
const latencies: number[] = []
const mistakes: string[] = []

for (const question of bank.questions) {
  const candidates = knowledgeCandidates(entries, question.text)
  const result = await decision.decide(`Contact (latest): ${question.text}`, [knowledgeQuestion(candidates)])
  latencies.push(result.latencyMs)
  const selection = readKnowledgeSelection(result, candidates)
  const picked = selection.picked.map((entry) => entry.title)
  if (selection.verdict === "duda") {
    doubt += 1
    continue
  }
  if (selection.verdict === "ninguno") {
    none += 1
    if (question.expected === null) noneRight += 1
    else {
      missed += 1
      mistakes.push(`sin tema, pero había respuesta: «${question.text}» → ${question.expected}`)
    }
    continue
  }
  sure += 1
  if (question.expected !== null && picked.includes(question.expected)) sureRight += 1
  else {
    sureWrong += 1
    mistakes.push(`seguro y mal: «${question.text}» → eligió ${picked.join(" | ") || "nada"}; esperado ${question.expected ?? "ninguno"}`)
  }
}

const total = bank.questions.length
const pct = (n: number, of: number) => (of === 0 ? "—" : `${((n / of) * 100).toFixed(0)} %`)
const sorted = [...latencies].sort((a, b) => a - b)
const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
console.log(`Proveedor ${decision.provider} · ${entries.length} respuestas · ${total} preguntas`)
console.log(`  seguro y acierta        ${sureRight}/${sure} (${pct(sureRight, sure)})`)
console.log(`  seguro y se equivoca    ${sureWrong}/${sure} (${pct(sureWrong, sure)})  ← lo que no puede pasar de 1 de cada 20`)
console.log(`  dice «ninguno» bien     ${noneRight}/${none} (${pct(noneRight, none)}) · deja sin respuesta ${missed}`)
console.log(`  duda (camino caro)      ${doubt}/${total} (${pct(doubt, total)})`)
console.log(`  latencia p50 ${p(0.5)} ms · p95 ${p(0.95)} ms`)
if (!decision.reportsProbabilities) {
  console.log("  Este proveedor no entrega probabilidades: todo cuenta como duda y no ahorra nada.")
}
for (const mistake of mistakes) console.log(`  - ${mistake}`)
