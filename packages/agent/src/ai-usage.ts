import { AsyncLocalStorage } from "node:async_hooks"
import { type Db, withOrgContext } from "@odentia/db"
import type { AiUsageOrigin } from "@odentia/db/schema/agent"
import { type AiUsageEntry, recordAiUsage } from "@odentia/services"

/**
 * Precio de lista de un modelo en USD: por millón de tokens o por minuto de
 * audio. `cachedInput` es lo servido desde la caché y `cacheWrite`, lo que se
 * escribe en ella (el proveedor los cobra aparte); sin ellos vale `input`.
 * `minSeconds`: lo mínimo que el proveedor cobra por audio, aunque dure menos.
 */
interface ModelPrice {
  input?: number
  cachedInput?: number
  cacheWrite?: number
  output?: number
  perMinute?: number
  minSeconds?: number
}

/**
 * Precios de los modelos que usa odentIA, revisados el 2026-10-15 para la
 * ADR 0031. Un modelo sin fila deja su uso con costo null: nunca 0 ni un
 * estimado. Si un proveedor cambia su precio, se cambia aquí; lo ya
 * registrado conserva el costo de su momento.

 * - gpt-6-luna: el de la página de precios de OpenAI, leída el 2026-10-17;
 *   caché: lectura 0,1× y escritura 1,25× de la entrada. Chat Completions
 *   cobra la escritura (medido el 2026-10-17, ADR 0012).
 * - text-embedding-3-small y whisper-1: precios de lista de OpenAI.
 * - gpt-4o-mini-transcribe: OpenAI lo cobra por tokens y responde con tokens
 *   (`usage.type: "tokens"`); los USD 0,003 por minuto de su página son una
 *   estimación y quedan por si algún día informa minutos. Entrada USD 1,25
 *   (los tokens de audio: no tienen otro precio) y salida USD 5 por millón,
 *   de developers.openai.com/api/docs/pricing, leída el 2026-10-20.
 * - whisper-large-v3-turbo y whisper-large-v3 (Groq, darvin2c/odentIA#158):
 *   USD 0,04 y 0,111 por hora de audio, de console.groq.com/docs/models; cobra
 *   como mínimo 10 s por audio (console.groq.com/docs/speech-to-text). Ambas
 *   leídas el 2026-10-20.
 * - jev-1.13.0 (modelo de decisión de toda clínica, ADR 0047): el de
 *   docs.typesafe.ai/models, leído el 2026-10-17; la salida no se cobra.
 */
export const AI_PRICES: Record<string, ModelPrice> = {

  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  "jev-1.13.0": { input: 0.042, output: 0 },
  "text-embedding-3-small": { input: 0.02 },
  "whisper-1": { perMinute: 0.006 },
  "gpt-4o-mini-transcribe": { input: 1.25, output: 5, perMinute: 0.003 },
  "whisper-large-v3-turbo": { perMinute: 0.04 / 60, minSeconds: 10 },
  "whisper-large-v3": { perMinute: 0.111 / 60, minSeconds: 10 },
}

/** Lo que reporta una llamada; los campos ausentes son los que el proveedor no entregó. */
export interface AiUse {
  provider: string
  model: string
  inputTokens?: number | null
  cachedInputTokens?: number | null
  cacheWriteTokens?: number | null
  outputTokens?: number | null
  audioSeconds?: number | null
}

/** Precio de un modelo por su nombre exacto o sin la fecha que añaden algunos proveedores. */
function priceOf(model: string): ModelPrice | null {
  return AI_PRICES[model] ?? AI_PRICES[model.replace(/-\d{4}-?\d{2}-?\d{2}$/, "")] ?? null
}

const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Costo en millonésimas de USD con lo que reportó el proveedor. null si no
 * hay precio para el modelo, si no reportó nada o si reportó algo que su
 * precio no cubre (salida de un modelo con precio solo de entrada).
 */
export function costMicrosOf(use: Omit<AiUse, "provider">): number | null {
  const price = priceOf(use.model)
  if (!price) return null
  const reported = [use.inputTokens, use.outputTokens, use.audioSeconds].some((v) => typeof v === "number")
  if (!reported) return null
  const input = num(use.inputTokens)
  const cached = num(use.cachedInputTokens)
  const written = num(use.cacheWriteTokens)
  const output = num(use.outputTokens)
  const seconds = num(use.audioSeconds)
  const billedSeconds = seconds > 0 ? Math.max(seconds, price.minSeconds ?? 0) : 0
  if ((input > 0 && price.input === undefined) || (output > 0 && price.output === undefined)) return null
  if (seconds > 0 && price.perMinute === undefined) return null
  const fresh = Math.max(0, input - cached - written)
  const usd =
    (fresh * (price.input ?? 0) +
      cached * (price.cachedInput ?? price.input ?? 0) +
      written * (price.cacheWrite ?? price.input ?? 0) +
      output * (price.output ?? 0)) /
      1_000_000 +
    (billedSeconds / 60) * (price.perMinute ?? 0)
  return Math.round(usd * 1_000_000)
}

const meter = new AsyncLocalStorage<AiUse[]>()

/** Anota lo que reportó una respuesta de un modelo de chat (LangChain `usage_metadata`). */
export function reportReplyUse(provider: string, model: string, reply: { usage_metadata?: unknown }): void {
  if (provider === "fake") return
  const meta = (reply.usage_metadata ?? {}) as {
    input_tokens?: unknown
    output_tokens?: unknown
    input_token_details?: { cache_read?: unknown; cache_creation?: unknown }
  }
  const n = (v: unknown) => (typeof v === "number" ? v : null)
  reportAiUse({
    provider,
    model,
    inputTokens: n(meta.input_tokens),
    cachedInputTokens: n(meta.input_token_details?.cache_read),
    cacheWriteTokens: n(meta.input_token_details?.cache_creation),
    outputTokens: n(meta.output_tokens),
  })
}

/**
 * Anota una llamada pagada en la operación en curso. Fuera de una operación
 * medida (evaluaciones, pruebas unitarias) no hace nada.
 */
export function reportAiUse(use: AiUse): void {
  meter.getStore()?.push(use)
}

const hasUsage = (use: AiUse) => [use.inputTokens, use.outputTokens, use.audioSeconds].some((v) => typeof v === "number")

/**
 * Una fila por proveedor y modelo. Si alguna llamada del grupo no reportó su
 * uso, el grupo queda con tokens y costo null: una suma parcial afirmaría
 * menos de lo gastado.
 */
export function summarizeAiUses(uses: readonly AiUse[]): AiUsageEntry[] {
  const groups = new Map<string, AiUse[]>()
  for (const use of uses) {
    const key = `${use.provider}\u0000${use.model}`
    groups.set(key, [...(groups.get(key) ?? []), use])
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as AiUse
    const complete = group.every(hasUsage)
    const total = (field: keyof Pick<AiUse, "inputTokens" | "cachedInputTokens" | "cacheWriteTokens" | "outputTokens" | "audioSeconds">) => {
      if (!complete || !group.some((use) => typeof use[field] === "number")) return null
      return group.reduce((sum, use) => sum + num(use[field]), 0)
    }
    const totals = {
      inputTokens: total("inputTokens"),
      cachedInputTokens: total("cachedInputTokens"),
      cacheWriteTokens: total("cacheWriteTokens"),
      outputTokens: total("outputTokens"),
      audioSeconds: total("audioSeconds"),
    }
    return {
      provider: first.provider,
      model: first.model,
      calls: group.length,
      ...totals,
      costMicros: complete ? costMicrosOf({ model: first.model, ...totals }) : null,
    }
  })
}

/**
 * Lo anotado hasta ahora en la operación en curso, ya resumido, y lo deja en
 * cero: la corrida lo guarda junto con su fila del libro y lo que se gaste
 * después (la sombra de decisión) se guarda al terminar.
 */
export function takeAiUsage(): AiUsageEntry[] {
  const store = meter.getStore()
  if (!store?.length) return []
  return summarizeAiUses(store.splice(0, store.length))
}

/**
 * Mide una operación: todo lo que se anote dentro de `run` (modelo que
 * escribe, modelo de decisión, vectores, transcripción) se guarda con `save`
 * al terminar, también si falla: lo gastado se gastó igual. Un fallo al
 * guardar nunca cambia el resultado de la operación.
 */
export async function withAiMeter<T>(run: () => Promise<T>, save: (entries: AiUsageEntry[]) => Promise<void>): Promise<T> {
  const uses: AiUse[] = []
  try {
    return await meter.run(uses, run)
  } finally {
    if (uses.length) {
      await save(summarizeAiUses(uses)).catch((error: unknown) => {
        console.error(`uso de IA sin registrar (${error instanceof Error ? error.message : String(error)})`)
      })
    }
  }
}

/**
 * Mide una operación de una clínica y guarda su uso con el origen dado (ADR
 * 0031). La usan la corrida, las pruebas, el dictado, el Administrador, la
 * transcripción y el índice de vectores: una sola forma de medir.
 */
export function meterAiUse<T>(
  db: Db,
  orgId: string,
  origin: AiUsageOrigin,
  run: () => Promise<T>,
  conversationId: string | null = null,
): Promise<T> {
  return withAiMeter(run, (entries) => withOrgContext(db, orgId, (tx) => recordAiUsage(tx, orgId, { origin, conversationId, entries })))
}
