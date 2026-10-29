/**
 * Lo que cuesta Clío en una atención entera. Uso:
 *
 *   pnpm --filter @odentia/agent eval:atencion [-- --file=eval/atenciones-completas.json]
 *
 * Cada atención es lo que oye el micrófono, pausa por pausa: el profesional
 * dicta y conversa con el paciente, y el paciente responde. Cada pausa es una
 * llamada al modelo, como en la atención (`askDictationModel` con el perfil del
 * producto): con lo último ya ordenado y las sugerencias pendientes, nombradas
 * como las nombra el servicio (`dictationModelLabel`). Lo que el modelo pide
 * quitar sale de las pendientes. Imprime llamadas, tokens y costo de cada
 * atención con los precios de `ai-usage.ts`, junto a lo que cobra la clínica
 * por esa atención (ADR 0085). No toca ninguna base ni envía nada: es evidencia
 * de estos guiones, no una medición de clínicas reales.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type DictationDraft, dictationModelLabel, type ProductDictation } from "@odentia/services"
import { DENTAL_DICTATION, dictationFindingsText } from "@odentia/services/dental"
import { examSystemsText, MEDICAL_DICTATION } from "@odentia/services/medical"
import { costMicrosOf } from "./ai-usage.js"
import { DENTAL_DICTATION_PROFILE } from "./dental/dictation.js"
import { askDictationModel, type DictationProfile } from "./dictation.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { MEDICAL_DICTATION_PROFILE } from "./medical/dictation.js"

/** Lo que cobra la clínica por Clío en una atención, según lo que dejó hecho (ADR 0085). */
const PRICE_USD = { simple: 0.1, estandar: 0.2, completa: 0.5 } as const

interface FullEncounter {
  id: string
  producto: "dental" | "medico"
  /** El tipo que cobraría por lo que deja hecho. */
  tipo: keyof typeof PRICE_USD
  /** Lo que oye el micrófono hasta cada pausa de 2,5 s: dictado y conversación, sin decir quién habla. */
  pausas: string[]
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/atenciones-completas.json")), "utf8")) as {
  servicios: { dental: string[]; medico: string[] }
  atenciones: FullEncounter[]
}
const spec = resolveLlmSpec(platformLlmFromEnv(process.env))
if (spec.provider === "fake") throw new Error("Esta medición es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor")

const PRODUCTS: Record<FullEncounter["producto"], { profile: DictationProfile; dictation: ProductDictation; catalog: string }> = {
  dental: { profile: DENTAL_DICTATION_PROFILE, dictation: DENTAL_DICTATION, catalog: dictationFindingsText() },
  medico: { profile: MEDICAL_DICTATION_PROFILE, dictation: MEDICAL_DICTATION, catalog: examSystemsText() },
}
/** Lo último ya ordenado que acompaña a cada pausa, como en la pantalla (`CONTEXT_CHARS`). */
const CONTEXT_CHARS = 600

interface Result {
  id: string
  producto: string
  tipo: keyof typeof PRICE_USD
  llamadas: number
  sinHerramienta: number
  entrada: number
  leidoDeCache: number
  salida: number
  micros: number
  sinPrecio: number
  sugerencias: Record<string, number>
}

async function run(encounter: FullEncounter): Promise<Result> {
  const { profile, dictation, catalog } = PRODUCTS[encounter.producto]
  const model = await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
  const result: Result = { id: encounter.id, producto: encounter.producto, tipo: encounter.tipo, llamadas: 0, sinHerramienta: 0, entrada: 0, leidoDeCache: 0, salida: 0, micros: 0, sinPrecio: 0, sugerencias: {} }
  let pending: DictationDraft[] = []
  let heard = ""
  const now = new Date()
  for (const pause of encounter.pausas) {
    const { read, reply } = await askDictationModel(
      model,
      spec,
      {
        provider: spec.provider,
        services: encounter.producto === "dental" ? bank.servicios.dental : bank.servicios.medico,
        diagnosisList: "CIE-10 (OMS)",
        catalog,
        zone: { locale: "es-PE", timezone: "America/Lima" },
        now,
        transcript: pause,
        context: heard.slice(-CONTEXT_CHARS).trim(),
        pending: pending.slice(0, 40).map((item) => ({ label: dictationModelLabel(item, dictation) })),
      },
      profile,
    )
    heard = `${heard} ${pause}`
    result.llamadas += 1
    const meta = (reply.usage_metadata ?? {}) as { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } }
    result.entrada += meta.input_tokens ?? 0
    result.leidoDeCache += meta.input_token_details?.cache_read ?? 0
    result.salida += meta.output_tokens ?? 0
    const cost = costMicrosOf({
      model: spec.modelName,
      inputTokens: meta.input_tokens ?? null,
      cachedInputTokens: meta.input_token_details?.cache_read ?? null,
      cacheWriteTokens: meta.input_token_details?.cache_creation ?? null,
      outputTokens: meta.output_tokens ?? null,
    })
    if (cost === null) result.sinPrecio += 1
    else result.micros += cost
    if (!read) {
      result.sinHerramienta += 1
      continue
    }
    // Lo que pidió quitar deja de estar pendiente; lo nuevo se suma.
    const removed = new Set(read.removals.map((item) => item.index))
    pending = pending.filter((_, index) => !removed.has(index))
    for (const draft of read.drafts) {
      pending.push(draft)
      result.sugerencias[draft.kind] = (result.sugerencias[draft.kind] ?? 0) + 1
    }
  }
  return result
}

const results = await Promise.all(bank.atenciones.map((encounter) => run(encounter)))
const usd = (micros: number) => micros / 1_000_000
const money = (value: number) => `USD ${value.toFixed(4)}`

for (const item of results) {
  const price = PRICE_USD[item.tipo]
  const cost = usd(item.micros)
  console.log(
    [
      `${item.id} (${item.producto}, ${item.tipo})`,
      `  ${item.llamadas} pausas · ${item.entrada} tokens de entrada (${item.leidoDeCache} leídos de la caché) · ${item.salida} de salida`,
      `  costo ${money(cost)}${item.sinPrecio ? ` (+${item.sinPrecio} llamadas sin precio)` : ""} · por pausa ${money(cost / item.llamadas)}`,
      `  cobra ${money(price)} (Fundadores ${money(price / 2)}) · el costo es el ${((cost / price) * 100).toFixed(1)} % (${((cost / (price / 2)) * 100).toFixed(1)} % con Fundadores)`,
      `  sugerencias: ${Object.entries(item.sugerencias).map(([kind, count]) => `${kind} ${count}`).join(", ") || "ninguna"}${item.sinHerramienta ? ` · ${item.sinHerramienta} pausas sin herramienta` : ""}`,
    ].join("\n"),
  )
}
const total = results.reduce((sum, item) => sum + usd(item.micros), 0)
const calls = results.reduce((sum, item) => sum + item.llamadas, 0)
console.log(`\nTotal: ${results.length} atenciones, ${calls} pausas, ${money(total)} · promedio por atención ${money(total / results.length)} · por pausa ${money(total / calls)} (modelo ${spec.modelName})`)
