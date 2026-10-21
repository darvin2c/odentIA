/**
 * El examen de Argos con los modelos reales (ADR 0075, fase 2 del issue 192):
 * cada pregunta del banco pasa por `askArgos` de punta a punta (Jev decide la
 * fila, ChatGPT 6 escribe la consulta, la base la corre con la llave del rol)
 * sobre la base de desarrollo con su semilla. Uso:
 *
 *   pnpm --filter @odentia/agent eval:argos -- --file=eval/argos-holdout.json [--golden=respuestas.json --role=owner --org=seed-org-dental-smile --json=salida.json --only=r1,r6]
 *
 *   Con ARGOS_RAZONAMIENTO=none|low|medium|high cambia cuánto piensa el modelo antes de escribir
 *   (sin ella, lo de la pantalla: `ARGOS_REASONING`). Con ARGOS_MODELO=deepseek-flash|deepseek-v4-pro (y
 *   DEEPSEEK_API_KEY) escribe DeepSeek en vez del modelo de Argos: solo para comparar, el modelo de
 *   Argos lo fija ADR 0052. Su costo sale de los precios de hora pico de DeepSeek.
 *
 * Imprime, pregunta por pregunta, lo que respondió Argos al lado de la
 * respuesta correcta (`eval:argos-respuestas --json=`) y lo que costó cada
 * una con `AI_PRICES`. La calificación la hace una persona con esa lista: una
 * respuesta es buena si da la cifra correcta o, en una trampa, dice qué falta
 * sin inventar. Deja una fila en `report_question` por pregunta, como en la
 * pantalla. El resultado es evidencia de este banco y de esta semilla, no un
 * benchmark de los proveedores.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { ChatOpenAI } from "@langchain/openai"
import { resolve } from "node:path"
import { createAppDb, withOrgContext } from "@odentia/db"
import { type AiUsageEntry, knownCostMicros, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { withAiMeter } from "../ai-usage.js"
import { ARGOS_REASONING, type ArgosAskResult, type ArgosDeps, askArgos } from "../argos.js"
import { platformLlmFromEnv, resolveLlmSpec } from "../llm.js"

interface Question {
  id: string
  texto: string
  espera: "responde" | "trampa"
  debe?: string
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const env = process.env
const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/argos-holdout.json")), "utf8")) as { preguntas: Question[] }
const goldenPath = arg("golden", "")
const golden = new Map<string, string>(
  goldenPath ? (JSON.parse(readFileSync(resolve(goldenPath), "utf8")) as { respuestas: Array<{ id: string; respuesta: string }> }).respuestas.map((row) => [row.id, row.respuesta]) : [],
)
const ORG = arg("org", "seed-org-dental-smile")
const role = arg("role", "owner")
const only = arg("only", "").split(",").filter(Boolean)
const url = env.APP_DATABASE_URL
if (!url) throw new Error("Falta APP_DATABASE_URL (el .env de infra/dev)")
const platform = platformLlmFromEnv(env)
if (resolveLlmSpec(platform).provider === "fake") throw new Error("El examen es con el modelo real: quita LLM_MODEL=fake y define LLM_OPENAI_API_KEY")
if (!env.JEV_API_KEY) throw new Error("Falta JEV_API_KEY: Jev decide la fila")

const reasoning = (["none", "low", "medium", "high"] as const).find((value) => value === env.ARGOS_RAZONAMIENTO)
if (env.ARGOS_RAZONAMIENTO && !reasoning) throw new Error("ARGOS_RAZONAMIENTO es none, low, medium o high")
/** DeepSeek para comparar (USD por millón de tokens, hora pico: lo más caro; fuera de hora, la mitad). */
const DEEPSEEK_PRICES = {
  "deepseek-flash": { hit: 0.006, miss: 0.3, out: 1.2 },
  "deepseek-v4-pro": { hit: 0.044, miss: 1.32, out: 3.96 },
} as const
const deepseek = (Object.keys(DEEPSEEK_PRICES) as Array<keyof typeof DEEPSEEK_PRICES>).find((name) => name === env.ARGOS_MODELO)
if (env.ARGOS_MODELO && !deepseek) throw new Error("ARGOS_MODELO es deepseek-flash o deepseek-v4-pro")
if (deepseek && !env.DEEPSEEK_API_KEY) throw new Error("Falta DEEPSEEK_API_KEY")
/** Lo que costó con DeepSeek: lo leído de su caché a su precio y el resto como no leído. */
const deepseekMicros = (uses: AiUsageEntry[]) => {
  const price = deepseek ? DEEPSEEK_PRICES[deepseek] : null
  if (!price) return 0
  return uses.reduce((sum, use) => {
    const cached = use.cachedInputTokens ?? 0
    return sum + ((use.inputTokens ?? 0) - cached) * price.miss + cached * price.hit + (use.outputTokens ?? 0) * price.out
  }, 0)
}
const db = createAppDb(url)
const deps: ArgosDeps = {
  platform,
  decisions: { jev: { apiKey: env.JEV_API_KEY, ...(env.JEV_BASE_URL ? { baseUrl: env.JEV_BASE_URL } : {}), ...(env.JEV_MODEL ? { model: env.JEV_MODEL } : {}) }, timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000) },
  secretsKey: secretsKeyFromEnv(env.SECRETS_KEY ?? ""),
  // ARGOS_RAZONAMIENTO=none|low|medium|high: cuánto piensa el modelo antes de escribir.
  ...(reasoning ? { reasoning } : {}),
  ...(deepseek
    ? {
        createModel: async () => {
          const model = new ChatOpenAI({
            model: deepseek,
            apiKey: env.DEEPSEEK_API_KEY,
            timeout: 180_000,
            maxRetries: 1,
            modelKwargs: { reasoning_effort: "high" },
            configuration: { baseURL: "https://api.deepseek.com" },
          })
          // DeepSeek, cuando razona, no acepta obligar la herramienta: se le ofrece y la usa.
          return Object.assign(Object.create(model), {
            bindTools: (tools: Parameters<typeof model.bindTools>[0], options?: Parameters<typeof model.bindTools>[1]) =>
              model.bindTools(tools, { ...options, tool_choice: "auto" }),
          })
        },
      }
    : {}),
}
const [owner] = await withOrgContext(db, ORG, (tx) =>
  tx.execute<{ userId: string }>(sql`select user_id as "userId" from member where organization_id = ${ORG} and role in ('owner', 'admin') order by role = 'owner' desc, created_at limit 1`),
)
if (!owner) throw new Error(`La clínica ${ORG} no tiene propietario`)

/** Lo que diría la pantalla, en una línea. */
function said(answer: ArgosAskResult): string {
  if (answer.kind === "respuesta")
    return [answer.partial ? "[parcial]" : "", answer.text, answer.missing ? `Falta: ${answer.missing}` : ""].filter(Boolean).join(" ")
  if (answer.kind === "no_existe") return [answer.message, answer.missing ? `Falta: ${answer.missing}` : "", answer.closest ? `Cercano: ${answer.closest.text}` : ""].filter(Boolean).join(" ")
  return `[${answer.kind}] ${answer.message}`
}

const out: Array<Record<string, unknown>> = []
let total = 0
for (const question of bank.preguntas.filter((item) => !only.length || only.includes(item.id))) {
  const uses: AiUsageEntry[] = []
  const problems: string[] = []
  const started = Date.now()
  const answer = await withAiMeter(
    () => askArgos(db, { ...deps, onProblem: (problem) => problems.push(problem) }, { orgId: ORG, userId: owner.userId, memberRole: role, text: question.texto }),
    async (entries) => {
      uses.push(...entries)
    },
  )
  const micros = deepseek ? deepseekMicros(uses) : (knownCostMicros(uses) ?? 0)
  total += micros
  const writes = uses.filter((use) => use.provider === "openai").reduce((sum, use) => sum + use.calls, 0)
  const row = {
    id: question.id,
    texto: question.texto,
    espera: question.espera,
    correcta: golden.get(question.id) ?? null,
    kind: answer.kind,
    argos: said(answer),
    como: answer.kind === "respuesta" ? answer.how : null,
    sql: answer.kind === "respuesta" ? answer.query : null,
    llamadas: writes,
    problemas: problems,
    usd: micros / 1_000_000,
    ms: Date.now() - started,
  }
  out.push(row)
  console.log(`\n### ${row.id} · ${row.texto}${row.espera === "trampa" ? " (trampa)" : ""}`)
  if (row.correcta) console.log(`- Correcta: ${row.correcta}`)
  console.log(`- Argos: ${row.argos}`)
  if (row.como) console.log(`- Cómo: ${row.como}`)
  if (row.sql) console.log(`- SQL: ${String(row.sql).replace(/\s+/g, " ")}`)
  for (const problem of problems) console.log(`- La base rechazó: ${problem}`)
  console.log(`- ${writes} llamada(s) al modelo que escribe · USD ${row.usd.toFixed(6)} · ${row.ms} ms`)
}
console.log(`\n${out.length} preguntas · USD ${(total / 1_000_000).toFixed(5)} en total · USD ${(total / 1_000_000 / Math.max(out.length, 1)).toFixed(6)} por pregunta`)
const jsonPath = arg("json", "")
if (jsonPath) writeFileSync(resolve(jsonPath), `${JSON.stringify({ corrido: new Date().toISOString(), org: ORG, rol: role, modelo: deepseek ?? "gpt-6-luna", razonamiento: reasoning ?? ARGOS_REASONING, usd: total / 1_000_000, respuestas: out }, null, 2)}\n`)
process.exit(0)
