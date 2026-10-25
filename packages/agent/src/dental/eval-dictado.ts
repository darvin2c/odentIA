/**
 * Medición del asistente clínico con dictados de práctica (issue 109). Uso:
 *
 *   pnpm --filter @odentia/agent eval:dictado [-- --file=eval/dictado-practica.json]
 *
 * Pasa cada dictado por el modelo real con la misma llamada que la atención
 * (`askDictationModel`) y cuenta, por dictado: los hallazgos del odontograma
 * que salieron bien (pieza y hallazgo; variante y estado si se dijeron), los
 * que se perdieron, los que inventó, y lo demás que se esperaba (diagnósticos,
 * indicaciones, controles, correcciones y «quita»). Imprime el costo de cada
 * llamada con los precios de `ai-usage.ts`. No toca ninguna base ni envía
 * nada. Es evidencia de este conjunto, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DICTATION_FINDINGS, dictationFindingsText } from "@odentia/services/dental"
import { costMicrosOf } from "../ai-usage.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { askDictationModel } from "../dictation.js"
import { DENTAL_DICTATION_PROFILE } from "./dictation.js"

interface ExpectedFinding {
  pieza: number
  hallazgo: string
  variante?: string
  estado?: "good" | "poor"
}

interface PracticeDictation {
  id: string
  texto: string
  pendientes?: string[]
  /** Lo ya ordenado antes en el mismo dictado, que llega como contexto. */
  contexto?: string
  espera: {
    hallazgos?: ExpectedFinding[]
    diagnosticos?: string[]
    planes?: number[]
    controles?: number
    nota?: boolean
    correcciones?: number
    quitar?: number
    /** Lo que la corrección pone, por una palabra («clindamicina»). */
    corrige?: string
    /** Registros nuevos: una corrección no vuelve a registrar lo que corrige. */
    nuevos?: number
    /** Medicamentos recetados: DCI, cifras de la concentración y días (null: no dijo la duración). */
    recetas?: Array<{ dci: string; concentracion: string; duracion: string | null }>
    /** Elecciones del paciente: la principal y los otros caminos, por una palabra de cada uno. */
    caminos?: Array<{ pieza?: number; principal: string; otros: string[] }>
    /** El paciente ya eligió: ninguna indicación lleva otros caminos. */
    sinCaminos?: boolean
  }
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/dictado-practica.json")), "utf8")) as { servicios: string[]; dictados: PracticeDictation[] }
const spec = resolveLlmSpec(platformLlmFromEnv(process.env))
if (spec.provider === "fake") throw new Error("Esta medición es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor")
// Como en la atención, con el razonamiento del perfil; `--razonamiento=none|low|…` lo cambia para comparar.
const reasoning = arg("razonamiento", DENTAL_DICTATION_PROFILE.reasoning ?? "none")
const model = await createConfiguredChatModel(spec, {
  explicitCache: true,
  ...(reasoning === "none" ? {} : { reasoning: reasoning as "low" | "medium" | "high" }),
})

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim()
/** La variante dicha como la leería el servicio: su valor o la más justa que la nombra. */
function variantOf(condition: string, spoken: unknown): string | undefined {
  const finding = DICTATION_FINDINGS.find((item) => item.code === condition)
  if (typeof spoken !== "string" || !finding?.variants) return undefined
  const exact = finding.variants.find((item) => item.value === spoken.trim())
  if (exact) return exact.value
  return finding.variants.filter((item) => plain(item.label).includes(plain(spoken))).sort((a, b) => a.label.length - b.label.length)[0]?.value
}

const totals = { esperados: 0, bien: 0, detalleBien: 0, detalleEsperado: 0, perdidos: 0, inventados: 0, otrosBien: 0, otrosEsperados: 0, costo: 0, sinCosto: 0 }
const now = new Date()

for (const dictation of bank.dictados) {
  const pending = (dictation.pendientes ?? []).map((label) => ({ label }))
  const { read, reply } = await askDictationModel(model, spec, {
    provider: spec.provider,
    services: bank.servicios,
    diagnosisList: "CIE-10 (OMS)",
    catalog: dictationFindingsText(),
    zone: { locale: "es-PE", timezone: "America/Lima" },
    now,
    transcript: dictation.texto,
    context: dictation.contexto ?? "",
    pending,
  }, DENTAL_DICTATION_PROFILE)
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

  const findings = read.drafts.filter((draft) => draft.kind === "odontograma").map((draft) => draft.payload)
  const used = new Set<number>()
  const notes: string[] = []
  for (const expected of dictation.espera.hallazgos ?? []) {
    totals.esperados += 1
    const index = findings.findIndex((payload, at) => !used.has(at) && payload["toothNumber"] === expected.pieza && payload["condition"] === expected.hallazgo)
    if (index < 0) {
      totals.perdidos += 1
      notes.push(`perdió ${expected.pieza} ${expected.hallazgo}`)
      continue
    }
    used.add(index)
    totals.bien += 1
    const payload = findings[index] ?? {}
    if (expected.variante) {
      totals.detalleEsperado += 1
      if (variantOf(expected.hallazgo, payload["variant"]) === expected.variante) totals.detalleBien += 1
      else notes.push(`${expected.pieza}: variante ${String(payload["variant"] ?? "—")} en vez de ${expected.variante}`)
    }
    if (expected.estado) {
      totals.detalleEsperado += 1
      if (payload["quality"] === expected.estado) totals.detalleBien += 1
      else notes.push(`${expected.pieza}: estado ${String(payload["quality"] ?? "—")} en vez de ${expected.estado}`)
    }
  }
  findings.forEach((payload, at) => {
    if (used.has(at)) return
    totals.inventados += 1
    notes.push(`agregó ${String(payload["toothNumber"])} ${String(payload["condition"])}`)
  })

  const other = (label: string, ok: boolean) => {
    totals.otrosEsperados += 1
    if (ok) totals.otrosBien += 1
    else notes.push(`falló: ${label}`)
  }
  const plans = read.drafts.filter((draft) => draft.kind === "plan").map((draft) => draft.payload["toothNumber"])
  const codes = read.drafts.filter((draft) => draft.kind === "diagnostico").map((draft) => String(draft.payload["diagnosisCode"] ?? ""))
  for (const code of dictation.espera.diagnosticos ?? []) other(`diagnóstico ${code}`, codes.some((item) => item.toUpperCase().startsWith(code)))
  for (const tooth of dictation.espera.planes ?? []) other(`indicación en la ${tooth}`, plans.includes(tooth))
  if (dictation.espera.controles) other("control", read.drafts.filter((draft) => draft.kind === "control").length === dictation.espera.controles)
  if (dictation.espera.nota) other("nota", read.drafts.some((draft) => draft.kind === "nota"))
  const recipes = read.drafts.filter((draft) => draft.kind === "receta").map((draft) => draft.payload)
  for (const expected of dictation.espera.recetas ?? []) {
    const found = recipes.find((payload) => plain(String(payload["genericName"] ?? "")).includes(plain(expected.dci)))
    // Las cifras dichas en palabras («siete días») valen igual: el servicio las lee.
    const WORDS: Record<string, string> = { uno: "1", una: "1", dos: "2", tres: "3", cinco: "5", siete: "7", diez: "10", catorce: "14" }
    const digits = (value: unknown) => plain(String(value ?? "")).replace(/[a-z]+/g, (word) => WORDS[word] ?? " ").replace(/[^\d.]/g, "")
    other(`receta ${expected.dci}`, Boolean(found))
    if (!found) continue
    other(`${expected.dci}: concentración ${expected.concentracion}`, digits(found["strength"]).startsWith(expected.concentracion.replace(/[^\d.]/g, "")))
    other(
      `${expected.dci}: duración ${expected.duracion ?? "sin decir"}`,
      expected.duracion === null ? !found["duration"] : digits(found["duration"]) === expected.duracion,
    )
  }
  if (dictation.espera.recetas) other("ningún medicamento de más", recipes.length === dictation.espera.recetas.length)
  const plansWithChoice = read.drafts.filter((draft) => draft.kind === "plan").map((draft) => draft.payload)
  for (const expected of dictation.espera.caminos ?? []) {
    const found = plansWithChoice.find((payload) => Array.isArray(payload["alternatives"]) && payload["alternatives"].length > 0 && (!expected.pieza || payload["toothNumber"] === expected.pieza))
    other(`caminos para la ${expected.pieza ?? "boca"}`, Boolean(found))
    if (!found) continue
    other(`recomendada: ${expected.principal}`, plain(String(found["service"] ?? "")).includes(expected.principal))
    const others = (found["alternatives"] as string[]).map((value) => plain(value))
    other(`otros: ${expected.otros.join(", ")}`, others.length === expected.otros.length && expected.otros.every((word) => others.some((value) => value.includes(word))))
  }
  if (dictation.espera.sinCaminos) other("sin caminos: ya eligió", plansWithChoice.every((payload) => !Array.isArray(payload["alternatives"]) || payload["alternatives"].length === 0))
  if (dictation.espera.correcciones !== undefined) other("corrección", read.corrections.length === dictation.espera.correcciones)
  if (dictation.espera.quitar !== undefined) other("quitar", read.removals.length === dictation.espera.quitar)
  const corrige = dictation.espera.corrige
  if (corrige) other(`corrige a ${corrige}`, read.corrections.some((item) => plain(JSON.stringify(item.changes)).includes(plain(corrige))))
  if (dictation.espera.nuevos !== undefined) other("nada registrado otra vez", read.drafts.length === dictation.espera.nuevos)
  // Lo que no debía tocar nada pendiente («la tercera» sin tercera): no se aplica.
  if (dictation.espera.correcciones === undefined && dictation.espera.quitar === undefined && pending.length) {
    other("no tocar lo pendiente", read.corrections.length === 0 && read.removals.length === 0)
  }
  const unused = read.unused.length ? ` · no usó: ${read.unused.map((phrase) => `«${phrase}»`).join(", ")}` : ""
  const money = cost === null ? "sin costo" : `USD ${(cost / 1_000_000).toFixed(5)}`
  console.log(`${notes.length ? "△" : "✓"} ${dictation.id} (${money}, ${meta.input_tokens ?? "?"}+${meta.output_tokens ?? "?"} tokens, caché ${meta.input_token_details?.cache_read ?? 0})${notes.length ? ` — ${notes.join("; ")}` : ""}${unused}`)
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)} %` : "—")
console.log("")
console.log(`Modelo: ${spec.modelName} · ${bank.dictados.length} dictados`)
console.log(`Hallazgos: ${totals.bien} de ${totals.esperados} bien (${pct(totals.bien, totals.esperados)}), ${totals.perdidos} perdidos, ${totals.inventados} agregados que no se dijeron`)
console.log(`Variante y estado dichos: ${totals.detalleBien} de ${totals.detalleEsperado} bien (${pct(totals.detalleBien, totals.detalleEsperado)})`)
console.log(`Lo demás (diagnósticos, indicaciones, controles, nota, correcciones, quitar): ${totals.otrosBien} de ${totals.otrosEsperados} (${pct(totals.otrosBien, totals.otrosEsperados)})`)
console.log(
  `Costo: USD ${(totals.costo / 1_000_000).toFixed(4)} en total, USD ${(totals.costo / 1_000_000 / Math.max(1, bank.dictados.length - totals.sinCosto)).toFixed(5)} por dictado${totals.sinCosto ? ` (${totals.sinCosto} sin costo informado)` : ""}`,
)
