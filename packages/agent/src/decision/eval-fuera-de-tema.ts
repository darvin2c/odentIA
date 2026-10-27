/**
 * ¿Reconoce el modelo de decisión lo que no tiene nada que ver con la clínica?
 * Mide la pregunta de intención con la opción candidata `off_topic` sobre
 * `eval/fuera-de-tema.json` más los 38 ejemplos de `eval/decisiones-ejemplos.json`
 * (todos de la clínica). Uso:
 *
 *   pnpm --filter @odentia/agent eval:off-topic -- --provider=jev [--repeats=2]
 *
 * El error caro es marcar como ajeno algo de la clínica (la persona se queda
 * sin respuesta útil): se lista cada uno con su probabilidad, para fijar el
 * umbral. Evidencia de este banco, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"
import { triageState } from "./points.js"
import { answerOf, type DecisionQuestion } from "./port.js"
import { agentTextsFor } from "@odentia/services"
import { ROUTE_HANDOFF, routeQuestions } from "./route.js"

/** La pregunta de intención en producción ya trae la opción `off_topic` (desde triage.v4). */
const CANDIDATE_QUESTIONS: DecisionQuestion[] = routeQuestions(agentTextsFor("dental"))

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const provider = arg("provider", "jev") as DecisionProvider
const repeats = Number(arg("repeats", "1"))
const bank = JSON.parse(readFileSync(resolve("eval/fuera-de-tema.json"), "utf8")) as { ejemplos: Array<{ texto: string; fuera: boolean }> }
const base = JSON.parse(readFileSync(resolve("eval/decisiones-ejemplos.json"), "utf8")) as Array<{
  previous?: Array<{ direction: "in" | "out"; body: string }>
  burst?: string[]
  latest: string
  expected: { intent: string }
}>
const cases = [
  ...bank.ejemplos.map((e) => ({ texto: e.texto, fuera: e.fuera, previous: [] as Array<{ direction: "in" | "out"; body: string }>, burst: [] as string[], intent: null as string | null })),
  ...base.map((e) => ({ texto: e.latest, fuera: false, previous: e.previous ?? [], burst: e.burst ?? [], intent: e.expected.intent })),
]

const env = process.env
const spec = resolveLlmSpec(platformLlmFromEnv(env))
const decision = await createDecisionModel(
  provider,
  {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000),
  },
  spec,
)
if (!decision) throw new Error("Elige un proveedor de decisión")

const rows: Array<{ texto: string; fuera: boolean; intent: string | null; p: number; handoff: number; before: string | null }> = []
for (const item of cases) {
  for (let i = 0; i < repeats; i++) {
    const result = await decision.decide(triageState(item.previous, item.texto, item.burst), CANDIDATE_QUESTIONS)
    const intent = answerOf(result, "intent", "choice")
    const handoff = answerOf(result, "handoff", "yesno")
    rows.push({
      texto: item.texto,
      fuera: item.fuera,
      intent: intent?.choice ?? null,
      p: intent?.probabilities?.[intent.choice] ?? 0,
      handoff: handoff?.probability ?? 0,
      before: item.intent,
    })
  }
}

const offTopic = (row: (typeof rows)[number], threshold: number) => row.intent === "off_topic" && row.p >= threshold && row.handoff < ROUTE_HANDOFF
const outside = rows.filter((r) => r.fuera)
const inside = rows.filter((r) => !r.fuera)
console.log(`Proveedor ${decision.provider} · ${outside.length} fuera de tema · ${inside.length} de la clínica · ${repeats} repetición(es)`)
for (const threshold of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const caught = outside.filter((r) => offTopic(r, threshold)).length
  const wrong = inside.filter((r) => offTopic(r, threshold)).length
  console.log(`  umbral ${threshold}: atrapa ${caught}/${outside.length} fuera de tema · marca como ajeno ${wrong}/${inside.length} de la clínica`)
}
const kept = inside.filter((r) => r.before !== null)
console.log(`  intención en los 38 de siempre: ${kept.filter((r) => r.intent === r.before).length}/${kept.length} (antes 36/38)`)
console.log("\nFuera de tema que no atrapó (umbral 0.6):")
for (const r of outside.filter((x) => !offTopic(x, 0.6))) console.log(`  - «${r.texto}» → ${r.intent} (${r.p.toFixed(2)})`)
console.log("\nDe la clínica marcado como ajeno, con cualquier probabilidad:")
for (const r of inside.filter((x) => x.intent === "off_topic")) console.log(`  - «${r.texto}» → off_topic (${r.p.toFixed(2)})`)
console.log("\nCambios de intención en los 38 de siempre:")
for (const r of kept.filter((x) => x.intent !== x.before)) console.log(`  - «${r.texto}» → esperado ${r.before}, obtuvo ${r.intent} (${r.p.toFixed(2)})`)
