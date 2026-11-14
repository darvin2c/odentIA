/**
 * Medición de lo que Clío propone en una ficha de consulta empezada
 * (entrega 11, ADR 0187). Uso:
 *
 *   pnpm --filter @odentia/agent eval:dictado-fichas [-- --file=eval/dictado-fichas.json] [--producto=odentia|latidia] [--solo=<id>]
 *
 * Pasa cada dictado por el modelo real con la misma llamada que la atención
 * (`askDictationModel`), con las preguntas de sus fichas armadas con la misma
 * regla que el servicio (`formQuestionsOf`), y cada respuesta pasa por la misma
 * comprobación que al guardarla (`prepareFormAnswer`). Cuenta, por dictado:
 *   - bien: lo que quedaría listo para aceptar, con el valor esperado;
 *   - inventadas: lo que quedaría listo y no se dijo así (otra pregunta, otro
 *     valor, o algo con la ficha sin empezar). El criterio es cero;
 *   - perdidas: lo esperado que no quedó listo. Callar es el error barato;
 *   - lo que el modelo respondió y la comprobación del servidor paró.
 * No toca ninguna base ni envía nada. Es evidencia de este banco, no de cómo
 * oye un navegador.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { type DictationFormQuestion, formQuestionsOf, NO_SITE, prepareFormAnswer } from "@odentia/services"
import { DENTAL_FORMS, dentalProductSite, dictationFindingsText } from "@odentia/services/dental"
import { examSystemsText } from "@odentia/services/medical"
import { costMicrosOf } from "./ai-usage.js"
import { DENTAL_DICTATION_PROFILE } from "./dental/dictation.js"
import { askDictationModel, type DictationProfile } from "./dictation.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { MEDICAL_DICTATION_PROFILE } from "./medical/dictation.js"

interface FormCase {
  id: string
  producto?: "odentia" | "latidia"
  texto: string
  fichas: Array<{ ficha: string; respondidas?: Record<string, unknown> }>
  espera: { fichas?: Record<string, unknown>; revisar?: string[] }
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/dictado-fichas.json")), "utf8")) as {
  servicios: string[]
  fichasPropias?: Record<string, { title: string; schema: unknown }>
  dictados: FormCase[]
}
const spec = resolveLlmSpec(platformLlmFromEnv(process.env))
if (spec.provider === "fake") throw new Error("Esta medición es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor")

const PRODUCTS = {
  odentia: { profile: DENTAL_DICTATION_PROFILE, catalog: dictationFindingsText(), site: dentalProductSite },
  latidia: { profile: MEDICAL_DICTATION_PROFILE, catalog: examSystemsText(), site: NO_SITE },
} as const
const models = new Map<string, unknown>()
/** El modelo de cada producto, con su razonamiento, como en la atención. */
async function modelOf(profile: DictationProfile): Promise<unknown> {
  const key = profile.reasoning ?? "none"
  if (!models.has(key)) models.set(key, await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) }))
  return models.get(key)
}

/** La ficha por su clave: una de odentIA o una propia del banco. */
function formOf(key: string): { title: string; schema: unknown } {
  const own = bank.fichasPropias?.[key]
  if (own) return own
  const product = DENTAL_FORMS.suggestions.find((form) => form.key === key)
  if (!product) throw new Error(`El banco nombra una ficha que no existe: ${key}`)
  return { title: product.title, schema: product.schema }
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()) : JSON.stringify(a) === JSON.stringify(b)

const only = arg("producto", "")
const solo = arg("solo", "")
const totals = { esperadas: 0, bien: 0, perdidas: 0, inventadas: 0, revisarBien: 0, revisarEsperadas: 0, paradas: 0, conFichas: 0, leidas: 0, costo: 0, sinCosto: 0 }
const now = new Date()
const cases = bank.dictados.filter((item) => (!only || (item.producto ?? "odentia") === only) && (!solo || item.id === solo))

for (const dictation of cases) {
  const product = PRODUCTS[dictation.producto ?? "odentia"]
  // Cada ficha con su clave como id: así «ficha.pregunta» del banco es lo que se compara.
  const questions: DictationFormQuestion[] = formQuestionsOf(
    dictation.fichas.map((item) => ({ id: item.ficha, title: formOf(item.ficha).title, snapshot: formOf(item.ficha).schema, answers: item.respondidas ?? {} })),
  )
  if (questions.length) totals.conFichas += 1
  const { read, reply } = await askDictationModel(
    await modelOf(product.profile),
    spec,
    {
      provider: spec.provider,
      services: bank.servicios,
      diagnosisList: "CIE-10 (OMS)",
      catalog: product.catalog,
      zone: { locale: "es-PE", timezone: "America/Lima" },
      now,
      transcript: dictation.texto,
      context: "",
      pending: [],
      forms: questions,
    },
    product.profile,
  )
  const meta = (reply.usage_metadata ?? {}) as { input_tokens?: number; output_tokens?: number; input_token_details?: { cache_read?: number; cache_creation?: number } }
  const cost = costMicrosOf({
    model: spec.modelName,
    inputTokens: meta.input_tokens ?? null,
    cachedInputTokens: meta.input_token_details?.cache_read ?? null,
    cacheWriteTokens: meta.input_token_details?.cache_creation ?? null,
    outputTokens: meta.output_tokens ?? null,
  })
  if (cost === null) totals.sinCosto += 1
  else totals.costo += cost
  if (!read) {
    console.log(`✗ ${dictation.id}: el modelo no respondió con la herramienta`)
    continue
  }
  const answers = read.drafts.filter((draft) => draft.kind === "ficha")
  totals.leidas += answers.length
  const notes: string[] = []
  const listed = new Map<string, unknown>()
  const reviewed = new Set<string>()
  for (const draft of answers) {
    const prepared = prepareFormAnswer({ payload: draft.payload, sourceText: draft.sourceText }, questions, product.site)
    if (!prepared) {
      totals.paradas += 1
      continue
    }
    const key = `${String(prepared.payload["responseId"])}.${String(prepared.payload["fieldId"])}`
    if (prepared.status === "lista") listed.set(key, prepared.payload["value"])
    else reviewed.add(key)
  }
  const expected = dictation.espera.fichas ?? {}
  for (const [key, value] of Object.entries(expected)) {
    totals.esperadas += 1
    if (listed.has(key) && same(listed.get(key), value)) totals.bien += 1
    else {
      totals.perdidas += 1
      notes.push(`perdió ${key}`)
    }
  }
  for (const [key, value] of listed) {
    if (key in expected && same(expected[key], value)) continue
    totals.inventadas += 1
    notes.push(`INVENTÓ ${key} = ${JSON.stringify(value)}`)
  }
  for (const key of dictation.espera.revisar ?? []) {
    totals.revisarEsperadas += 1
    if (!listed.has(key)) totals.revisarBien += 1
  }
  const money = cost === null ? "sin costo" : `USD ${(cost / 1_000_000).toFixed(5)}`
  const shown = [...listed].map(([key, value]) => `${key.split(".").at(-1)}=${JSON.stringify(value)}`).join(", ")
  console.log(`${notes.some((note) => note.startsWith("INVENTÓ")) ? "✗" : notes.length ? "△" : "✓"} ${dictation.id} (${money}, ${meta.input_tokens ?? "?"}+${meta.output_tokens ?? "?"} tokens, caché ${meta.input_token_details?.cache_read ?? 0}) ${shown}${reviewed.size ? ` · por revisar: ${[...reviewed].join(", ")}` : ""}${notes.length ? ` — ${notes.join("; ")}` : ""}`)
  if (solo) console.log(JSON.stringify({ crudo: (reply.tool_calls ?? []).map((call) => call.args["fichas"]), fichas: answers, unused: read.unused }, null, 1))
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)} %` : "—")
console.log("")
console.log(`Modelo: ${spec.modelName} · ${cases.length} dictados`)
// La línea que cuenta que el camino nuevo corrió: sin pausas con fichas ni respuestas leídas, la medición no dice nada.
console.log(`Camino de fichas: ${totals.conFichas} pausas con fichas empezadas, ${totals.leidas} respuestas de ficha leídas del modelo, ${totals.paradas} paradas por la comprobación del servidor`)
console.log(`Respuestas: ${totals.bien} de ${totals.esperadas} bien (${pct(totals.bien, totals.esperadas)}), ${totals.perdidas} perdidas, ${totals.inventadas} inventadas`)
console.log(`Lo dicho a medias que no quedó listo: ${totals.revisarBien} de ${totals.revisarEsperadas}`)
console.log(`Costo: USD ${(totals.costo / 1_000_000).toFixed(4)} en total, USD ${(totals.costo / 1_000_000 / Math.max(1, cases.length - totals.sinCosto)).toFixed(5)} por dictado${totals.sinCosto ? ` (${totals.sinCosto} sin costo informado)` : ""}`)
