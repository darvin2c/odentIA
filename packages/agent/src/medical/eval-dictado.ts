/**
 * Medición de Clío médica con dictados de práctica de un consultorio (issue
 * 229, entrega 10). Uso:
 *
 *   pnpm --filter @odentia/agent eval:dictado-medico [-- --file=eval/dictado-medico.json]
 *
 * Pasa cada dictado por el modelo real con la misma llamada que la atención
 * (`askDictationModel` con el perfil de latidIA) y cuenta, por dictado: las
 * medidas de los signos vitales que salieron con su cifra, los sistemas del
 * examen con su estado, lo que agregó sin que se dijera, y lo demás que se
 * esperaba (nota, diagnósticos, indicaciones, recetas, controles, descanso,
 * correcciones y «quita»). Imprime el costo de cada llamada con los precios de
 * `ai-usage.ts`. No toca ninguna base ni envía nada. Es evidencia de este
 * conjunto, no un benchmark del proveedor.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { examSystemsText } from "@odentia/services/medical"
import { costMicrosOf } from "../ai-usage.js"
import { askDictationModel } from "../dictation.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "../llm.js"
import { MEDICAL_DICTATION_PROFILE } from "./dictation.js"

interface PracticeDictation {
  id: string
  texto: string
  pendientes?: string[]
  /** Lo ya ordenado antes en el mismo dictado, que llega como contexto. */
  contexto?: string
  espera: {
    nota?: boolean
    /** Las medidas dichas, con su cifra. */
    signos?: Record<string, number>
    /** Los sistemas nombrados y cómo los dijo. */
    examen?: Array<{ sistema: string; estado: "sin_alteraciones" | "con_hallazgos" }>
    /** Códigos (o su comienzo) de los diagnósticos que nombró. */
    diagnosticos?: string[]
    /** Las prestaciones indicadas, por una palabra de cada una. */
    indicaciones?: string[]
    /** Medicamentos recetados: DCI, cifras de la concentración y días (null: no dijo la duración). */
    recetas?: Array<{ dci: string; concentracion: string; duracion: string | null }>
    controles?: number
    /** Los días de descanso que indicó. */
    descanso?: number
    correcciones?: number
    quitar?: number
    /** Lo que la corrección pone, por una palabra o cifra. */
    corrige?: string
    /** Registros nuevos: una corrección no vuelve a registrar lo que corrige. */
    nuevos?: number
  }
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const bank = JSON.parse(readFileSync(resolve(arg("file", "eval/dictado-medico.json")), "utf8")) as {
  servicios: string[]
  dictados: PracticeDictation[]
}
const spec = resolveLlmSpec(platformLlmFromEnv(process.env))
if (spec.provider === "fake")
  throw new Error(
    "Esta medición es con un modelo real: quita LLM_MODEL=fake y define la clave del proveedor",
  )
const model = await createConfiguredChatModel(spec, { explicitCache: true })

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim()
// Las cifras dichas en palabras («siete días») valen igual: el servicio las lee.
const WORDS: Record<string, string> = {
  uno: "1",
  una: "1",
  dos: "2",
  tres: "3",
  cinco: "5",
  siete: "7",
  diez: "10",
  catorce: "14",
  treinta: "30",
}
const digits = (value: unknown) =>
  plain(String(value ?? ""))
    .replace(/[a-z]+/g, (word) => WORDS[word] ?? " ")
    .replace(/[^\d.]/g, "")

const totals = {
  esperados: 0,
  bien: 0,
  perdidos: 0,
  inventados: 0,
  otrosBien: 0,
  otrosEsperados: 0,
  costo: 0,
  sinCosto: 0,
}
const now = new Date()

for (const dictation of bank.dictados) {
  const pending = (dictation.pendientes ?? []).map((label) => ({ label }))
  const { read, reply } = await askDictationModel(
    model,
    spec,
    {
      provider: spec.provider,
      services: bank.servicios,
      diagnosisList: "CIE-10 (OMS)",
      catalog: examSystemsText(),
      zone: { locale: "es-PE", timezone: "America/Lima" },
      now,
      transcript: dictation.texto,
      context: dictation.contexto ?? "",
      pending,
    },
    MEDICAL_DICTATION_PROFILE,
  )
  const meta = (reply.usage_metadata ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    input_token_details?: { cache_read?: number; cache_creation?: number }
  }
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
  const notes: string[] = []

  // Los signos vitales: cada medida dicha con su cifra; una que no se dijo, agregada.
  const vitals = read.drafts
    .filter((draft) => draft.kind === "signos")
    .reduce<Record<string, unknown>>((all, draft) => ({ ...all, ...draft.payload }), {})
  for (const [key, value] of Object.entries(dictation.espera.signos ?? {})) {
    totals.esperados += 1
    const got = vitals[key]
    if (typeof got === "number" && Math.abs(got - value) < 0.05) totals.bien += 1
    else {
      totals.perdidos += 1
      notes.push(`${key} ${String(got ?? "—")} en vez de ${value}`)
    }
  }
  for (const key of Object.keys(vitals)) {
    if (dictation.espera.signos && key in dictation.espera.signos) continue
    totals.inventados += 1
    notes.push(`agregó ${key} ${String(vitals[key])}`)
  }
  // El examen: cada sistema nombrado con su estado; uno que no se nombró, agregado.
  const exam = read.drafts.filter((draft) => draft.kind === "examen").map((draft) => draft.payload)
  for (const expected of dictation.espera.examen ?? []) {
    totals.esperados += 1
    const found = exam.find((payload) => payload["system"] === expected.sistema)
    if (found && found["state"] === expected.estado) totals.bien += 1
    else {
      totals.perdidos += 1
      notes.push(
        found
          ? `${expected.sistema}: ${String(found["state"])} en vez de ${expected.estado}`
          : `perdió ${expected.sistema}`,
      )
    }
  }
  for (const payload of exam) {
    if ((dictation.espera.examen ?? []).some((expected) => expected.sistema === payload["system"]))
      continue
    totals.inventados += 1
    notes.push(`agregó el sistema ${String(payload["system"])}`)
  }

  const other = (label: string, ok: boolean) => {
    totals.otrosEsperados += 1
    if (ok) totals.otrosBien += 1
    else notes.push(`falló: ${label}`)
  }
  if (dictation.espera.nota)
    other(
      "nota",
      read.drafts.some((draft) => draft.kind === "nota"),
    )
  const codes = read.drafts
    .filter((draft) => draft.kind === "diagnostico")
    .map((draft) => String(draft.payload["diagnosisCode"] ?? "").toUpperCase())
  for (const code of dictation.espera.diagnosticos ?? [])
    other(
      `diagnóstico ${code}`,
      codes.some((item) => item.startsWith(code)),
    )
  const indicated = read.drafts
    .filter((draft) => draft.kind === "plan")
    .map((draft) => plain(String(draft.payload["service"] ?? "")))
  for (const word of dictation.espera.indicaciones ?? [])
    other(
      `indicación ${word}`,
      indicated.some((service) => service.includes(plain(word))),
    )
  const recipes = read.drafts
    .filter((draft) => draft.kind === "receta")
    .map((draft) => draft.payload)
  for (const expected of dictation.espera.recetas ?? []) {
    const found = recipes.find((payload) =>
      plain(String(payload["genericName"] ?? "")).includes(plain(expected.dci)),
    )
    other(`receta ${expected.dci}`, Boolean(found))
    if (!found) continue
    if (expected.concentracion)
      other(
        `${expected.dci}: concentración ${expected.concentracion}`,
        digits(found["strength"]).startsWith(expected.concentracion),
      )
    other(
      `${expected.dci}: duración ${expected.duracion ?? "sin decir"}`,
      expected.duracion === null
        ? !found["duration"]
        : digits(found["duration"]) === expected.duracion,
    )
  }
  if (dictation.espera.recetas)
    other("ningún medicamento de más", recipes.length === dictation.espera.recetas.length)
  if (dictation.espera.controles !== undefined)
    other(
      "control",
      read.drafts.filter((draft) => draft.kind === "control").length === dictation.espera.controles,
    )
  const leave = read.drafts.find((draft) => draft.kind === "descanso")
  if (dictation.espera.descanso !== undefined)
    other(
      `descanso de ${dictation.espera.descanso} días`,
      leave?.payload["days"] === dictation.espera.descanso,
    )
  else if (leave) other("sin descanso: no lo indicó", false)
  if (dictation.espera.correcciones !== undefined)
    other("corrección", read.corrections.length === dictation.espera.correcciones)
  if (dictation.espera.quitar !== undefined)
    other("quitar", read.removals.length === dictation.espera.quitar)
  const corrige = dictation.espera.corrige
  if (corrige)
    other(
      `corrige a ${corrige}`,
      read.corrections.some((item) => plain(JSON.stringify(item.changes)).includes(plain(corrige))),
    )
  if (dictation.espera.nuevos !== undefined)
    other("nada registrado de más", read.drafts.length === dictation.espera.nuevos)
  // Lo que no debía tocar nada pendiente («la tercera» sin tercera): no se aplica.
  if (
    dictation.espera.correcciones === undefined &&
    dictation.espera.quitar === undefined &&
    pending.length
  ) {
    other("no tocar lo pendiente", read.corrections.length === 0 && read.removals.length === 0)
  }
  const unused = read.unused.length
    ? ` · no usó: ${read.unused.map((phrase) => `«${phrase}»`).join(", ")}`
    : ""
  const money = cost === null ? "sin costo" : `USD ${(cost / 1_000_000).toFixed(5)}`
  console.log(
    `${notes.length ? "△" : "✓"} ${dictation.id} (${money}, ${meta.input_tokens ?? "?"}+${meta.output_tokens ?? "?"} tokens, caché ${meta.input_token_details?.cache_read ?? 0})${notes.length ? ` — ${notes.join("; ")}` : ""}${unused}`,
  )
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)} %` : "—")
console.log("")
console.log(`Modelo: ${spec.modelName} · ${bank.dictados.length} dictados`)
console.log(
  `Signos y examen: ${totals.bien} de ${totals.esperados} bien (${pct(totals.bien, totals.esperados)}), ${totals.perdidos} perdidos o mal, ${totals.inventados} agregados que no se dijeron`,
)
console.log(
  `Lo demás (nota, diagnósticos, indicaciones, recetas, controles, descanso, correcciones, quitar): ${totals.otrosBien} de ${totals.otrosEsperados} (${pct(totals.otrosBien, totals.otrosEsperados)})`,
)
console.log(
  `Costo: USD ${(totals.costo / 1_000_000).toFixed(4)} en total, USD ${(totals.costo / 1_000_000 / Math.max(1, bank.dictados.length - totals.sinCosto)).toFixed(5)} por dictado${totals.sinCosto ? ` (${totals.sinCosto} sin costo informado)` : ""}`,
)
