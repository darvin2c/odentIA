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
 *   DEEPSEEK_API_KEY) escribe DeepSeek en vez del modelo de Argos, y con ARGOS_MODELO=gpt-6-sol otro modelo
 *   de OpenAI con la misma cuenta: solo para comparar, el modelo de Argos lo fija ADR 0052. Su costo sale de
 *   los precios de hora pico de DeepSeek o de `OPENAI_PRICES`.
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
import { createConfiguredChatModel, type LlmSpec, platformLlmFromEnv, resolveLlmSpec } from "../llm.js"

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
const goldenFile = goldenPath ? (JSON.parse(readFileSync(resolve(goldenPath), "utf8")) as { calculado?: string; respuestas: Array<{ id: string; respuesta: string; nota?: string }> }) : null
// La nota trae las otras lecturas válidas de la pregunta: quien califica también la lee.
const golden = new Map<string, { respuesta: string; nota?: string }>(goldenFile ? goldenFile.respuestas.map((row) => [row.id, row]) : [])
// Las respuestas correctas cuentan «hasta esta hora»: Argos responde a esa misma hora, o un cobro de los minutos
// que tarda la vuelta cambia la cifra de «los mismos días» (pasó con un pago de las 13:15).
const at = goldenFile?.calculado ? new Date(goldenFile.calculado) : undefined
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
/**
 * Otro modelo de OpenAI para comparar, con la misma cuenta y el mismo camino que el de Argos (USD por millón;
 * de sitios de terceros leídos el 2026-10-22, sin verificar en la página de OpenAI).
 */
const OPENAI_PRICES = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
} as const
const deepseek = (Object.keys(DEEPSEEK_PRICES) as Array<keyof typeof DEEPSEEK_PRICES>).find((name) => name === env.ARGOS_MODELO)
const openaiModel = (Object.keys(OPENAI_PRICES) as Array<keyof typeof OPENAI_PRICES>).find((name) => name === env.ARGOS_MODELO)
if (env.ARGOS_MODELO && !deepseek && !openaiModel) throw new Error("ARGOS_MODELO es deepseek-flash, deepseek-v4-pro o gpt-6-sol")
/** Lo que costó con el otro modelo de OpenAI: lo que escribió a su precio (se anota con el nombre del de Argos) y Jev al suyo. */
const openaiMicros = (uses: AiUsageEntry[]) => {
  const price = openaiModel ? OPENAI_PRICES[openaiModel] : null
  if (!price) return 0
  const written = uses.filter((use) => use.provider === "openai")
  const rest = knownCostMicros(uses.filter((use) => use.provider !== "openai")) ?? 0
  return written.reduce((sum, use) => {
    const cached = use.cachedInputTokens ?? 0
    return sum + ((use.inputTokens ?? 0) - cached) * price.input + cached * price.cachedInput + (use.outputTokens ?? 0) * price.output
  }, rest)
}
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
  ...(openaiModel
    ? {
        // El mismo camino que `argosModel`, con otro modelo: con razonamiento va por /v1/responses.
        createModel: (spec: LlmSpec) => {
          const effort = reasoning ?? ARGOS_REASONING
          return createConfiguredChatModel({ ...spec, modelName: openaiModel }, { explicitCache: true, temperature: 0, ...(effort === "none" ? {} : { reasoning: effort }) })
        },
      }
    : {}),
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

/** El periodo como se ve arriba de la respuesta: el botón y «Comparado con…», o «A hoy…». */
function periodLine(answer: ArgosAskResult): string | null {
  if (answer.kind !== "respuesta") return null
  const { period } = answer
  // La sede se ve junto al periodo cuando la consulta la usa: también cuenta como dicha.
  const branch = period.branch ? (period.branch.options.find((option) => option.id === period.branch?.id)?.name ?? "Todas las sedes") : null
  return [period.label, period.other ? `contra ${period.other.label}` : null, period.compareLabel ? `comparado con ${period.compareLabel}` : null, branch]
    .filter(Boolean)
    .join(" · ")
}

/** Lo que diría la pantalla, en una línea. */
function said(answer: ArgosAskResult): string {
  if (answer.kind === "respuesta")
    return [answer.partial ? "[parcial]" : "", answer.text, answer.missing ? `Falta: ${answer.missing}` : ""].filter(Boolean).join(" ")
  if (answer.kind === "no_existe") return [answer.message, answer.missing ? `Falta: ${answer.missing}` : "", answer.closest ? `Cercano: ${answer.closest.text}` : ""].filter(Boolean).join(" ")
  return `[${answer.kind}] ${answer.message}`
}

const out: Array<Record<string, unknown>> = []
let total = 0
/** Del modelo que escribe: lo que costó y sus tokens de entrada, con los leídos y los escritos en la caché. */
const writer = { micros: 0, entrada: 0, leidos: 0, escritos: 0 }
for (const question of bank.preguntas.filter((item) => !only.length || only.includes(item.id))) {
  const uses: AiUsageEntry[] = []
  const problems: string[] = []
  const steps: string[] = []
  const started = Date.now()
  const answer = await withAiMeter(
    () =>
      askArgos(db, { ...deps, onProblem: (problem) => problems.push(problem), onStep: (step) => steps.push(step) }, { orgId: ORG, userId: owner.userId, memberRole: role, text: question.texto, ...(at ? { now: at } : {}) }),
    async (entries) => {
      uses.push(...entries)
    },
  )
  const micros = deepseek ? deepseekMicros(uses) : openaiModel ? openaiMicros(uses) : (knownCostMicros(uses) ?? 0)
  total += micros
  const written = uses.filter((use) => use.provider === "openai")
  const writes = written.reduce((sum, use) => sum + use.calls, 0)
  const sum = (pick: (use: AiUsageEntry) => number | null) => written.reduce((all, use) => all + (pick(use) ?? 0), 0)
  const tokens = { entrada: sum((use) => use.inputTokens), leidos: sum((use) => use.cachedInputTokens), escritos: sum((use) => use.cacheWriteTokens), salida: sum((use) => use.outputTokens) }
  writer.micros += deepseek ? deepseekMicros(written) : openaiModel ? openaiMicros(written) : (knownCostMicros(written) ?? 0)
  writer.entrada += tokens.entrada
  writer.leidos += tokens.leidos
  writer.escritos += tokens.escritos
  const row = {
    id: question.id,
    texto: question.texto,
    espera: question.espera,
    correcta: golden.get(question.id)?.respuesta ?? null,
    nota: golden.get(question.id)?.nota ?? null,
    kind: answer.kind,
    periodo: periodLine(answer),
    argos: said(answer),
    como: answer.kind === "respuesta" ? answer.how : null,
    sql: answer.kind === "respuesta" ? answer.query : null,
    fuente: answer.kind === "respuesta" ? answer.source : null,
    elige: answer.kind === "respuesta" && answer.choose ? `${answer.choose.message} (${answer.choose.options.map((option) => option.label).join("; ")})` : null,
    pasos: steps,
    llamadas: writes,
    tokens,
    problemas: problems,
    usd: micros / 1_000_000,
    ms: Date.now() - started,
  }
  out.push(row)
  console.log(`\n### ${row.id} · ${row.texto}${row.espera === "trampa" ? " (trampa)" : ""}`)
  if (row.correcta) console.log(`- Correcta: ${row.correcta}`)
  if (row.nota) console.log(`- Nota (otra lectura válida): ${row.nota}`)
  if (row.periodo) console.log(`- Periodo (arriba de la respuesta): ${row.periodo}`)
  if (row.elige) console.log(`- Antes de responder, la pantalla pregunta: ${row.elige}`)
  console.log(`- Argos: ${row.argos}`)
  if (row.fuente) console.log(`- Marca: ${row.fuente === "oficial" ? "Cifra oficial" : "Cálculo de Argos"}`)
  if (row.como) console.log(`- Cómo: ${row.como}`)
  if (row.sql) console.log(`- SQL: ${String(row.sql).replace(/\s+/g, " ")}`)
  if (steps.length) console.log(`- Pasos: ${steps.join(" → ")}`)
  for (const problem of problems) console.log(`- La base rechazó: ${problem}`)
  console.log(
    `- ${writes} llamada(s) al modelo que escribe · USD ${row.usd.toFixed(6)} · ${row.ms} ms · ${tokens.entrada} tokens de entrada: ${tokens.leidos} leídos de la caché y ${tokens.escritos} escritos`,
  )
}
const share = (part: number) => `${writer.entrada ? Math.round((100 * part) / writer.entrada) : 0} %`
console.log(`\n${out.length} preguntas · USD ${(total / 1_000_000).toFixed(5)} en total · USD ${(total / 1_000_000 / Math.max(out.length, 1)).toFixed(6)} por pregunta`)
console.log(
  `Modelo que escribe: USD ${(writer.micros / 1_000_000 / Math.max(out.length, 1)).toFixed(6)} por pregunta · de ${writer.entrada} tokens de entrada, ${share(writer.leidos)} leídos de la caché y ${share(writer.escritos)} escritos`,
)
const jsonPath = arg("json", "")
if (jsonPath) writeFileSync(resolve(jsonPath), `${JSON.stringify({ corrido: new Date().toISOString(), org: ORG, rol: role, modelo: deepseek ?? openaiModel ?? "gpt-6-luna", razonamiento: reasoning ?? ARGOS_REASONING, usd: total / 1_000_000, respuestas: out }, null, 2)}\n`)
process.exit(0)
