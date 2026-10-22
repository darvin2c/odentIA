/**
 * ¿Reconoce el modelo de decisión el spam sin mandar a Spam a una persona?
 * Mide la pregunta `spam` y la regla de `readRoute` (lo que habla de la
 * clínica o pide una persona nunca es spam) sobre `eval/spam.json` más los 38
 * ejemplos de `eval/decisiones-ejemplos.json` (todos de personas). Uso:
 *
 *   pnpm --filter @odentia/agent eval:spam -- --provider=jev [--repeats=3]
 *
 * El error caro es mandar a Spam a una persona (se queda sin respuesta): se
 * lista cada uno con su probabilidad. El umbral `ROUTE_SPAM` (0,9) se deja si
 * ninguna persona cae en Spam en ninguna repetición y se detectan al menos 9
 * de cada 10 spam (tablero 9 del lienzo). Evidencia de este banco, no un
 * benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { createDecisionModel, type DecisionProvider } from "./index.js"
import { triageState } from "./points.js"
import { agentTextsFor } from "@odentia/services"
import { readRoute, ROUTE_SPAM, routeQuestions } from "./route.js"

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const provider = arg("provider", "jev") as DecisionProvider
const repeats = Number(arg("repeats", "3"))
const bank = JSON.parse(readFileSync(resolve("eval/spam.json"), "utf8")) as { ejemplos: Array<{ texto: string; spam: boolean }> }
const base = JSON.parse(readFileSync(resolve("eval/decisiones-ejemplos.json"), "utf8")) as Array<{
  previous?: Array<{ direction: "in" | "out"; body: string }>
  burst?: string[]
  latest: string
}>
const cases = [
  ...bank.ejemplos.map((e) => ({ texto: e.texto, spam: e.spam, previous: [] as Array<{ direction: "in" | "out"; body: string }>, burst: [] as string[] })),
  ...base.map((e) => ({ texto: e.latest, spam: false, previous: e.previous ?? [], burst: e.burst ?? [] })),
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

const rows: Array<{ texto: string; spam: boolean; p: number; reason: string | null }> = []
for (const item of cases) {
  for (let i = 0; i < repeats; i++) {
    const route = readRoute(await decision.decide(triageState(item.previous, item.texto, item.burst), routeQuestions(agentTextsFor("dental"))))
    rows.push({ texto: item.texto, spam: item.spam, p: route.spam?.probability ?? 0, reason: route.spam?.reason ?? null })
  }
}

const spam = rows.filter((r) => r.spam)
const people = rows.filter((r) => !r.spam)
console.log(`Proveedor ${decision.provider} · ${spam.length / repeats} spam · ${people.length / repeats} personas · ${repeats} repetición(es)`)
for (const threshold of [0.6, 0.7, 0.8, 0.9, 0.95]) {
  const caught = spam.filter((r) => r.p >= threshold).length
  const wrong = people.filter((r) => r.p >= threshold).length
  console.log(`  umbral ${threshold}: atrapa ${caught}/${spam.length} spam · manda a Spam ${wrong}/${people.length} personas`)
}
const ok = people.every((r) => r.p < ROUTE_SPAM) && spam.filter((r) => r.p >= ROUTE_SPAM).length >= 0.9 * spam.length
console.log(`\nCon el umbral de hoy (${ROUTE_SPAM}): ${ok ? "cumple" : "NO cumple"} (ninguna persona en Spam y 9 de cada 10 spam atrapados)`)
console.log("\nSpam que no atrapó:")
for (const r of spam.filter((x) => x.p < ROUTE_SPAM)) console.log(`  - «${r.texto}» → ${r.p.toFixed(2)}`)
console.log("\nPersonas con probabilidad de spam de 0,5 o más (el error caro):")
for (const r of people.filter((x) => x.p >= 0.5)) console.log(`  - «${r.texto}» → ${r.reason} (${r.p.toFixed(2)})`)
