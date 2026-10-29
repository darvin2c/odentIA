/**
 * Lo que cuesta Clío en una atención entera y lo que se cobraría por ella. Uso:
 *
 *   pnpm --filter @odentia/agent eval:atencion [-- --file=eval/atenciones-completas.json]
 *
 * Cada atención es lo que oye el micrófono, pausa por pausa: el profesional
 * dicta y conversa con el paciente (y con quien lo acompaña o la asistente), y
 * ellos responden. Cada pausa es una llamada al modelo, como en la atención
 * (`askDictationModel` con el perfil del producto): con lo último ya ordenado y
 * las sugerencias pendientes, nombradas como las nombra el servicio
 * (`dictationModelLabel`). Lo que el modelo pide quitar sale de las pendientes.
 * El tipo cobrado sale de lo que quedó, con la misma regla del cobro
 * (`consultationTierOf`, ADR 0085), suponiendo que el profesional lo confirma.
 * Imprime pausas, tokens, costo, lo que se cobraría (con y sin Fundadores) y el
 * margen, con los precios de `ai-usage.ts`. No toca ninguna base ni envía nada:
 * es evidencia de estos guiones, no una medición de clínicas reales.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { consultationTierOf, type DictationDraft, dictationFor, dictationModelLabel, type ProductDictation } from "@odentia/services"
import { costMicrosOf } from "./ai-usage.js"
import { askDictationModel, type DictationProfile } from "./dictation.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { dictationProfileFor } from "./products.js"

/** Lo que cobra la clínica por Clío en una atención, según lo que dejó hecho (ADR 0085). Fundadores, la mitad. */
const PRICE_USD = { simple: 0.1, estandar: 0.2, completa: 0.5 } as const

interface FullEncounter {
  id: string
  producto: "dental" | "medico"
  /** Lo que dura la cita real que representa, en minutos (con lo que se trabaja en silencio). */
  minutos: number
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
const only = arg("solo", "").split(",").filter(Boolean)
const spec = resolveLlmSpec(platformLlmFromEnv(process.env))
if (spec.provider === "fake") throw new Error("Esta medición es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor")

/**
 * El dictado de cada producto, elegido como en la atención (`products.ts`, ADR
 * 0079): lo común no importa lo dental ni lo médico.
 */
function productOf(producto: FullEncounter["producto"]): { profile: DictationProfile; dictation: ProductDictation; catalog: string } {
  const product = producto === "medico" ? "medical" : "dental"
  const profile = dictationProfileFor(product)
  const dictation = dictationFor(product)
  if (!profile || !dictation) throw new Error(`Clío no dicta en ${product}`)
  return { profile, dictation, catalog: dictation.catalogText() }
}
/** Lo último ya ordenado que acompaña a cada pausa, como en la pantalla (`CONTEXT_CHARS`). */
const CONTEXT_CHARS = 600
/** Palabras por minuto de una conversación en consulta: para decir cuánto se habla. */
const WORDS_PER_MINUTE = 140

interface Result {
  encounter: FullEncounter
  palabras: number
  sinHerramienta: number
  entrada: number
  leidoDeCache: number
  salida: number
  micros: number
  sinPrecio: number
  /** Lo que quedó al final, por clase: lo que el profesional confirmaría. */
  quedo: Record<string, number>
  tipo: keyof typeof PRICE_USD
}

async function run(encounter: FullEncounter): Promise<Result> {
  const { profile, dictation, catalog } = productOf(encounter.producto)
  const model = await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) })
  const result = { encounter, palabras: encounter.pausas.join(" ").split(/\s+/).length, sinHerramienta: 0, entrada: 0, leidoDeCache: 0, salida: 0, micros: 0, sinPrecio: 0 }
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
    pending.push(...read.drafts)
  }
  const quedo: Record<string, number> = {}
  for (const item of pending) quedo[item.kind] = (quedo[item.kind] ?? 0) + 1
  return { ...result, quedo, tipo: consultationTierOf(new Set(Object.keys(quedo))) }
}

const chosen = bank.atenciones.filter((item) => only.length === 0 || only.includes(item.id))
if (chosen.length === 0) throw new Error(`Ninguna atención se llama ${only.join(", ")}: mira los id de ${arg("file", "eval/atenciones-completas.json")}`)
const results = await Promise.all(chosen.map((encounter) => run(encounter)))
const usd = (micros: number) => micros / 1_000_000
const money = (value: number) => `USD ${value.toFixed(4)}`
const pct = (part: number, whole: number) => `${((part / whole) * 100).toFixed(1)} %`

for (const item of results) {
  const calls = item.encounter.pausas.length
  const price = PRICE_USD[item.tipo]
  const cost = usd(item.micros)
  console.log(
    [
      `${item.encounter.id} (${item.encounter.producto}, cita de ${item.encounter.minutos} min, ${(item.palabras / WORDS_PER_MINUTE).toFixed(0)} min de habla)`,
      `  ${calls} pausas · ${item.entrada} tokens de entrada (${item.leidoDeCache} leídos de la caché) · ${item.salida} de salida`,
      `  costo ${money(cost)}${item.sinPrecio ? ` (+${item.sinPrecio} llamadas sin precio)` : ""} · por pausa ${money(cost / calls)}`,
      `  se cobra «${item.tipo}»: ${money(price)} (Fundadores ${money(price / 2)}) · el costo es el ${pct(cost, price)} (${pct(cost, price / 2)} con Fundadores)`,
      `  quedó: ${Object.entries(item.quedo).map(([kind, count]) => `${kind} ${count}`).join(", ") || "nada"}${item.sinHerramienta ? ` · ${item.sinHerramienta} pausas sin herramienta` : ""}`,
    ].join("\n"),
  )
}
const total = results.reduce((sum, item) => sum + usd(item.micros), 0)
const calls = results.reduce((sum, item) => sum + item.encounter.pausas.length, 0)
const charged = results.reduce((sum, item) => sum + PRICE_USD[item.tipo], 0)
console.log(
  `\nTotal: ${results.length} atenciones, ${calls} pausas · cuesta ${money(total)} · se cobra ${money(charged)} (Fundadores ${money(charged / 2)}) · el costo es el ${pct(total, charged)} (${pct(total, charged / 2)} con Fundadores) · por pausa ${money(total / calls)} (modelo ${spec.modelName})`,
)
