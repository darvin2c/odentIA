/**
 * `pnpm --filter @odentia/agent eval:compare -- [--org=dental-smile] [--llm=chatgpt_6,claude_5_5] [--out=archivo.json]`
 *
 * Compara los dos modelos que puede elegir la clínica (ADR 0022) con las
 * conversaciones de `eval/comparar-modelos.json`, por «Probar»
 * (`simulateAgentSandbox`): el mismo grafo, la misma ficha, el mismo modelo de
 * decisión y los datos reales de la clínica indicada en la base de desarrollo.
 * No envía, no escribe en la base y no cambia el modelo guardado de la clínica:
 * el modelo de cada pasada se elige aquí. Por cada turno guarda la respuesta,
 * si respondió o derivó, lo que no pasó la comprobación, herramientas, tokens y
 * tiempo. La calidad la juzga una persona leyendo las respuestas contra
 * «espera». Evidencia de este banco, no un benchmark de los proveedores.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { env } from "node:process"
import { createAppDb } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { secretsKeyFromEnv } from "@odentia/services"
import { eq } from "drizzle-orm"
import { embedderFromEnv } from "./embeddings.js"
import type { AgentLlm } from "@odentia/services"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { EMPTY_SANDBOX_STATE, type SandboxTurn, simulateAgentSandbox } from "./run.js"

interface Caso {
  id: string
  mensajes: string[]
  espera: string
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(new URL("../eval/comparar-modelos.json", import.meta.url), "utf8")) as { casos: Caso[] }
const slug = arg("org", "dental-smile")
const llms = arg("llm", "chatgpt_6,claude_5_5").split(",") as AgentLlm[]
const only = arg("casos", "")
const out = arg("out", "")
const casos = only ? bank.casos.filter((c) => only.split(",").includes(c.id)) : bank.casos

if (!env.APP_DATABASE_URL) throw new Error("Falta APP_DATABASE_URL (la base de desarrollo)")
const db = createAppDb(env.APP_DATABASE_URL)
const [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug)).limit(1)
if (!org) throw new Error(`No existe la organización «${slug}»`)
const platform = platformLlmFromEnv(env)
const deps = {
  secretsKey: secretsKeyFromEnv(env.SECRETS_KEY),
  platform,
  embedder: embedderFromEnv(env),
  decisions: {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    ...(env.OPENAI_DECISIONS_API_KEY
      ? { openai: { apiKey: env.OPENAI_DECISIONS_API_KEY, baseUrl: env.OPENAI_DECISIONS_BASE_URL, model: env.OPENAI_DECISIONS_MODEL } }
      : {}),
    timeoutMs: Number(env.DECISIONS_TIMEOUT_MS ?? 5000),
  },
}

const rows: Array<Record<string, unknown>> = []
for (const llm of llms) {
  const spec = resolveLlmSpec({ llm }, platform)
  // El modelo de la pasada lo decide el banco, no la configuración guardada de la clínica.
  const createModel = () => createConfiguredChatModel(spec)
  for (const caso of casos) {
    const transcript: SandboxTurn[] = []
    let state = structuredClone(EMPTY_SANDBOX_STATE)
    for (const [turno, mensaje] of caso.mensajes.entries()) {
      const started = Date.now()
      let row: Record<string, unknown>
      try {
        const result = await simulateAgentSandbox(db, { ...deps, createModel }, { orgId: org.id, transcript, message: mensaje, state })
        state = result.state
        row = {
          llm,
          modelo: spec.modelName,
          caso: caso.id,
          turno: turno + 1,
          mensaje,
          respuesta: result.reply,
          respondio: result.replied,
          derivo: result.handedOff,
          sinSustento: result.checks.filter((check) => !check.ok).map((check) => check.value ?? check.kind),
          herramientas: result.toolsUsed,
          tokensEntrada: result.inputTokens,
          tokensSalida: result.outputTokens,
          ms: result.latencyMs,
        }
        transcript.push({ role: "contact", text: mensaje }, { role: "agent", text: result.reply })
      } catch (error) {
        row = { llm, modelo: spec.modelName, caso: caso.id, turno: turno + 1, mensaje, error: String((error as Error)?.message ?? error).slice(0, 300), ms: Date.now() - started }
        transcript.push({ role: "contact", text: mensaje })
      }
      rows.push(row)
      console.log(JSON.stringify(row))
    }
  }
}

for (const llm of llms) {
  const mine = rows.filter((r) => r.llm === llm)
  const ok = mine.filter((r) => !r.error)
  const sum = (key: string) => ok.reduce((total, r) => total + (typeof r[key] === "number" ? (r[key] as number) : 0), 0)
  const ms = ok.map((r) => r.ms as number).sort((a, b) => a - b)
  console.error(
    `${llm}: ${ok.length}/${mine.length} turnos sin error · derivó ${ok.filter((r) => r.derivo).length} · sin sustento ${ok.filter((r) => (r.sinSustento as unknown[]).length > 0).length} · tokens ${sum("tokensEntrada")} entrada / ${sum("tokensSalida")} salida · mediana ${ms[Math.floor(ms.length / 2)] ?? 0} ms`,
  )
}
if (out) writeFileSync(out, JSON.stringify({ casos: bank.casos, filas: rows }, null, 2))
process.exit(0)
