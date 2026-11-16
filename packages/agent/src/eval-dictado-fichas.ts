/**
 * Medición de lo que Clío propone en una ficha de consulta empezada
 * (entrega 11, ADR 0188). Uso:
 *
 *   pnpm --filter @odentia/agent eval:dictado-fichas [-- --file=eval/dictado-fichas.json] [--producto=odentia|latidia] [--solo=<id>[,<id>…]] [--crudo=<archivo>]
 *
 * Pasa cada dictado por el modelo real con la misma llamada que la atención
 * (`askDictationModel`), con las preguntas de sus fichas armadas con la misma
 * regla que el servicio (`formQuestionsOf`), y cada respuesta pasa por la misma
 * comprobación que al guardarla (`prepareFormAnswer`). Cuenta, por dictado:
 *   - bien: lo que quedaría listo para aceptar, con el valor esperado;
 *   - inventadas: lo que quedaría listo y no se dijo así (otra pregunta, otro
 *     valor, o algo con la ficha sin empezar). El criterio es cero;
 *   - perdidas: lo esperado que no quedó listo. Callar es el error barato;
 *   - lo que cambia una respuesta ya escrita: tiene que quedar por revisar, con
 *     el valor dicho, y nunca lista (revisión final del 15 nov, decisión 2);
 *   - lo que el modelo respondió y la comprobación del servidor paró;
 *   - de lo perdido, si el profesional lo ve en «No pude usar esto» (por el
 *     motivo de lo parado o por la red de la oración, con `formDropNotices`,
 *     la misma función del servidor) o se perdió en silencio, y cuántos
 *     avisos da la red sobre preguntas que el dictado no espera;
 *   - la segunda lectura, como en la atención (`formNetMisses` y
 *     `rereadFormSentences`): cuántas oraciones lee de nuevo, cuántas quedan por
 *     revisar con el valor esperado o con otro, y lo que cuesta aparte.
 * No toca ninguna base ni envía nada. Es evidencia de este banco, no de cómo
 * oye un navegador.
 *
 * De cada dictado que pierde o inventa algo guarda lo que respondió el modelo,
 * tal cual, y qué hizo el servidor con cada respuesta, en un archivo de la
 * corrida fuera del repositorio (`--crudo=<archivo>`, o uno nuevo en la carpeta
 * temporal): así la causa se lee, no se supone.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  type DictationFormQuestion,
  formDropNotices,
  formNetMisses,
  formQuestionsOf,
  prepareFormAnswer,
  productHooksFor,
  pendingFormValues,
  withDiagnosisFormAnswers,
  withFormTwins,
  withoutFormNotes,
} from "@odentia/services"
import { costMicrosOf, withAiMeter } from "./ai-usage.js"
import { askDictationModel, type DictationProfile, rereadFormSentences } from "./dictation.js"
import { diagnosisProposed, serverDiagnoses } from "./eval-consulta.js"
import { createConfiguredChatModel, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { dictationProfileFor } from "./products.js"

interface FormCase {
  id: string
  producto?: "odentia" | "latidia"
  texto: string
  /** Lo dictado en la pausa anterior, como lo recibe Clío («lo último ya ordenado»): una frase partida por una pausa. */
  contexto?: string
  /**
   * Lo que la pausa anterior dejó propuesto en la ficha, «ficha.pregunta»: valor, como lo ve el
   * servidor (`pendingFormValues`): la red no lo avisa otra vez y lo mismo no se propone dos veces.
   */
  previas?: Record<string, unknown>
  fichas: Array<{ ficha: string; respondidas?: Record<string, unknown> }>
  /** Preguntas que no se cuentan: lo que el reconocimiento de voz oyó mal y no se puede saber de lo oído. */
  ignora?: string[]
  /**
   * `nota`: lo que debe seguir en el texto de la consulta; `noEnNota`: lo que no debe estar (lo de la ficha, las correcciones).
   * `cambia`: lo que cambia una respuesta ya escrita, que queda por revisar con ese valor.
   */
  espera: {
    fichas?: Record<string, unknown>
    revisar?: string[]
    cambia?: Record<string, unknown>
    /**
     * Lo dicho sin nombrar su pregunta («déjame medir 7 mm» del overjet, prueba con voz del 15 nov,
     * c4): Clío lo propone por revisar con ese valor, nunca listo.
     */
    revisarCon?: Record<string, unknown>
    nota?: string[]
    noEnNota?: string[]
    /** Diagnósticos que también se proponen en Diagnóstico, por su código («K04.6|K04.7»: basta con uno). */
    diagnosticos?: string[]
    /** Diagnósticos que contradicen lo dictado («K04.7», sin fístula, con la fístula dicha): no deben quedar listos. */
    diagnosticosNo?: string[]
    /** La frase que se muestra en una respuesta: la del número que se usó (prueba con voz del 15 nov). */
    dicho?: Record<string, string>
  }
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

/** Cada producto por el registro común (ADR 0079): su perfil de Clío, su catálogo, su «dónde» y sus fichas. */
function productOf(name: "odentia" | "latidia") {
  const product = name === "odentia" ? "dental" : "medical"
  const hooks = productHooksFor(product)
  const profile = dictationProfileFor(product)
  if (!profile || !hooks.dictation) throw new Error(`${name} no dicta`)
  return { profile, catalog: hooks.dictation.catalogText(), site: hooks.site, forms: hooks.forms.suggestions }
}
const PRODUCTS = { odentia: productOf("odentia"), latidia: productOf("latidia") }
const models = new Map<string, unknown>()
/** El modelo de cada producto, con su razonamiento, como en la atención. */
async function modelOf(profile: DictationProfile): Promise<unknown> {
  const key = profile.reasoning ?? "none"
  if (!models.has(key)) models.set(key, await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) }))
  return models.get(key)
}

/** La ficha por su clave: una del producto del dictado o una propia del banco. */
function formOf(key: string, product: keyof typeof PRODUCTS): { title: string; schema: unknown } {
  const own = bank.fichasPropias?.[key]
  if (own) return own
  const found = PRODUCTS[product].forms.find((form) => form.key === key)
  if (!found) throw new Error(`El banco nombra una ficha que no existe en ${product}: ${key}`)
  return { title: found.title, schema: found.schema }
}

const same = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()) : JSON.stringify(a) === JSON.stringify(b)

const only = arg("producto", "")
const solo = arg("solo", "").split(",").filter(Boolean)
const totals = { esperadas: 0, bien: 0, perdidas: 0, perdidasAvisadas: 0, perdidasRed: 0, inventadas: 0, revisarBien: 0, revisarEsperadas: 0, cambiaEsperadas: 0, cambiaBien: 0, cambiaListas: 0, paradas: 0, conFichas: 0, leidas: 0, costo: 0, sinCosto: 0, notaEsperada: 0, notaBien: 0, notaSobra: 0, notaSobraEsperada: 0, avisosRed: 0, avisosRedDeMas: 0, relecturas: 0, releidas: 0, relecturaRevisar: 0, relecturaBien: 0, relecturaOtroValor: 0, relecturaDeMas: 0, relecturaCosto: 0, relecturaSinCosto: 0, perdidasPorRevisar: 0, diagnosticosEsperados: 0, diagnosticosBien: 0, diagnosticosNoEsperados: 0, diagnosticosNoListos: 0, dichoEsperado: 0, dichoBien: 0, revisarConEsperadas: 0, revisarConBien: 0, revisarConListas: 0 }
/** Los avisos de la red en preguntas que el dictado no espera: se imprimen para leerlos. */
const netExtra: string[] = []
const now = new Date()
const cases = bank.dictados.filter((item) => (!only || (item.producto ?? "odentia") === only) && (!solo.length || solo.includes(item.id)))
/** Lo crudo de cada dictado con algo perdido o inventado, una línea JSON por dictado. */
const rawFile = resolve(arg("crudo", join(tmpdir(), "odentia-eval", `dictado-fichas-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`)))
let rawSaved = 0
function saveRaw(entry: Record<string, unknown>) {
  if (!rawSaved) mkdirSync(dirname(rawFile), { recursive: true })
  appendFileSync(rawFile, `${JSON.stringify(entry)}\n`)
  rawSaved += 1
}
/** Lo que respondió el modelo, leído si es JSON; si no, el texto tal cual. */
function rawOf(raw: string | null, content: unknown): unknown {
  if (raw === null) return { sinHerramienta: content }
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

for (const dictation of cases) {
  const productKey = dictation.producto ?? "odentia"
  const product = PRODUCTS[productKey]
  // Cada ficha con su clave como id: así «ficha.pregunta» del banco es lo que se compara.
  const questions: DictationFormQuestion[] = formQuestionsOf(
    dictation.fichas.map((item) => {
      const form = formOf(item.ficha, productKey)
      return { id: item.ficha, title: form.title, snapshot: form.schema, answers: item.respondidas ?? {} }
    }),
  )
  if (questions.length) totals.conFichas += 1
  const model = await modelOf(product.profile)
  const { read, reply, raw, heard } = await askDictationModel(
    model,
    spec,
    {
      provider: spec.provider,
      services: bank.servicios,
      diagnosisList: "CIE-10 (OMS)",
      catalog: product.catalog,
      zone: { locale: "es-PE", timezone: "America/Lima" },
      now,
      transcript: dictation.texto,
      context: dictation.contexto ?? "",
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
    saveRaw({ id: dictation.id, texto: dictation.texto, notas: ["no respondió con la herramienta"], crudo: rawOf(raw, reply.content) })
    continue
  }
  // `heard`: como la atención y el servidor, lo nuevo que sigue la frase del tramo anterior se comprueba con su final delante.
  // Como la atención (`extractDictation`): lo que la red avisaría se lee una vez más, y su costo se cuenta aparte.
  // Lo que dejó propuesto la pausa anterior, leído como lo lee el servidor.
  const previous = dictation.previas ?? {}
  const pending = pendingFormValues(
    Object.entries(previous).map(([key, value]) => {
      const [responseId, fieldId] = key.split(".")
      return { kind: "ficha", payload: { responseId, fieldId, value } }
    }),
    questions,
  )
  const misses = formNetMisses(read.drafts, questions, product.site, heard, pending)
  let reread: typeof read.drafts = []
  if (misses.length) {
    totals.relecturas += 1
    totals.releidas += misses.length
    reread = await withAiMeter(
      () => rereadFormSentences(model, spec, misses, questions),
      async (entries) => {
        for (const entry of entries) {
          if (entry.costMicros === null) totals.relecturaSinCosto += 1
          else totals.relecturaCosto += entry.costMicros
        }
      },
    )
  }
  const dictated = [...read.drafts, ...reread]
  // Como el servidor: el diagnóstico que también pregunta una ficha va a los dos lugares, y la nota
  // pierde lo que fue para la ficha y las frases que solo corrigen.
  const all = withDiagnosisFormAnswers(dictated, questions)
  const derived = new Set(all.slice(dictated.length))
  const answers = all.filter((draft) => draft.kind === "ficha")
  const noteText = withoutFormNotes(all, questions, product.site, heard)
    .filter((draft) => draft.kind === "nota")
    .flatMap((draft) => Object.values(draft.payload).filter((value): value is string => typeof value === "string"))
    .join(" ")
    .toLowerCase()
  totals.leidas += read.drafts.filter((draft) => draft.kind === "ficha").length
  const notes: string[] = []
  const listed = new Map<string, unknown>()
  const reviewed = new Map<string, unknown>()
  /** Lo que la segunda lectura dejó por revisar, con su valor. */
  const rereadValues = new Map<string, unknown>()
  /** La frase que se mostraría en cada respuesta propuesta. */
  const shownSaid = new Map<string, string>()
  // Como el servidor (`saveDictationSegment`): la gemela de otra ficha también, y de dos respuestas a
  // la misma pregunta en una pausa vale la última.
  const { drafts: expanded, twins } = withFormTwins(answers, questions)
  for (const draft of derived) twins.add(draft)
  // La respuesta tal cual, con su marca de la segunda lectura: lo que la atención deja por revisar.
  const prepared = expanded.map((draft) => ({ draft, ready: prepareFormAnswer(draft, questions, product.site, heard) }))
  const keyOf = ({ responseId, fieldId }: { responseId?: unknown; fieldId?: unknown }) => `${String(responseId)}.${String(fieldId)}`
  const last = new Map(prepared.flatMap((item, index) => (item.ready ? [[keyOf(item.ready.payload), index] as const] : [])))
  // Lo que va a «No pude usar esto», con la misma función que el servidor: lo parado con su motivo y
  // la oración que nombra una pregunta sin propuesta ni aviso (la red).
  const notices = formDropNotices(
    prepared.map(({ draft, ready }) => ({ draft, ready: ready !== null })),
    twins,
    questions,
    { site: product.site, transcript: heard },
    pending,
  )
  const byNumber = new Map(questions.map((question) => [question.number, question]))
  const keysOf = (items: typeof notices) =>
    new Set(items.flatMap((item) => item.questions.flatMap((number) => (byNumber.has(number) ? [keyOf(byNumber.get(number) ?? {})] : []))))
  const net = notices.filter((item) => item.by === "red")
  const noticedKeys = keysOf(notices.filter((item) => item.by === "motivo"))
  const caughtKeys = keysOf(net)
  // Lo que la red nombra y el dictado no espera de esa pregunta: un aviso de más, que se lee a mano.
  const wanted = new Set([
    ...Object.keys(dictation.espera.fichas ?? {}),
    ...(dictation.espera.revisar ?? []),
    ...Object.keys(dictation.espera.cambia ?? {}),
    ...Object.keys(dictation.espera.revisarCon ?? {}),
    ...(dictation.ignora ?? []),
  ])
  totals.avisosRed += net.length
  for (const item of net) {
    if ([...keysOf([item])].some((key) => wanted.has(key))) continue
    totals.avisosRedDeMas += 1
    netExtra.push(`${dictation.id}: «${item.said}» → ${item.why}`)
  }
  for (const [index, { draft, ready }] of prepared.entries()) {
    if (!ready) {
      if (!twins.has(draft)) totals.paradas += 1
      continue
    }
    const key = keyOf(ready.payload)
    if (last.get(key) !== index) continue
    // Lo mismo que ya propuso la pausa anterior no se propone otra vez (`saveDictationSegment`).
    if (key in previous && same(previous[key], ready.payload["value"])) continue
    if (ready.status === "lista") listed.set(key, ready.payload["value"])
    else reviewed.set(key, ready.payload["value"])
    shownSaid.set(key, ready.said ?? draft.sourceText ?? "")
    if (ready.payload["reread"] === true) rereadValues.set(key, ready.payload["value"])
  }
  const expected = dictation.espera.fichas ?? {}
  for (const [key, value] of Object.entries(expected)) {
    totals.esperadas += 1
    if (listed.has(key) && same(listed.get(key), value)) totals.bien += 1
    else {
      totals.perdidas += 1
      // ¿Lo supo el profesional? Por el motivo de lo parado, por la red, o en silencio.
      let how = "en silencio"
      if (rereadValues.has(key)) {
        totals.perdidasPorRevisar += 1
        how = same(rereadValues.get(key), value) ? "por revisar con su valor, de la segunda lectura" : `por revisar con otro valor (${JSON.stringify(rereadValues.get(key))}), de la segunda lectura`
      } else if (noticedKeys.has(key)) {
        totals.perdidasAvisadas += 1
        how = "con aviso"
      } else if (caughtKeys.has(key)) {
        totals.perdidasRed += 1
        how = "con aviso de la red"
      }
      notes.push(`perdió ${key} (${how})`)
    }
  }
  const changes = dictation.espera.cambia ?? {}
  const toReview = dictation.espera.revisarCon ?? {}
  for (const [key, value] of listed) {
    if (key in expected && same(expected[key], value)) continue
    // Cambia lo escrito y quedó lista: el error de la decisión 2, contado aparte.
    if (key in changes || dictation.ignora?.includes(key)) continue
    // Lo dicho sin nombrar su pregunta y lista con ese valor: se cuenta aparte, no es inventada.
    if (key in toReview && same(toReview[key], value)) continue
    // Varias opciones, solo parte de lo esperado: se perdió una, no se inventó nada (ya cuenta como perdida).
    const want = expected[key]
    if (Array.isArray(want) && Array.isArray(value) && value.length > 0 && value.every((item) => want.includes(item))) {
      notes.push(`a medias ${key} = ${JSON.stringify(value)}`)
      continue
    }
    totals.inventadas += 1
    notes.push(`INVENTÓ ${key} = ${JSON.stringify(value)}`)
  }
  for (const [key, value] of Object.entries(toReview)) {
    totals.revisarConEsperadas += 1
    if (listed.has(key)) {
      totals.revisarConListas += 1
      notes.push(`lista sin nombrar su pregunta ${key} = ${JSON.stringify(listed.get(key))}`)
    } else if (reviewed.has(key) && same(reviewed.get(key), value)) totals.revisarConBien += 1
    else notes.push(`no propuso por revisar ${key} = ${JSON.stringify(value)}`)
  }
  for (const [key, value] of Object.entries(changes)) {
    totals.cambiaEsperadas += 1
    if (listed.has(key)) {
      totals.cambiaListas += 1
      notes.push(`LISTA SOBRE LO ESCRITO ${key} = ${JSON.stringify(listed.get(key))}`)
    } else if (reviewed.has(key) && same(reviewed.get(key), value)) totals.cambiaBien += 1
    else notes.push(`no propuso el cambio de ${key}`)
  }
  // La segunda lectura: por revisar con el valor esperado, con otro, o en una pregunta que no se espera.
  for (const [key, value] of rereadValues) {
    totals.relecturaRevisar += 1
    if (key in expected) {
      if (same(expected[key], value)) totals.relecturaBien += 1
      else {
        totals.relecturaOtroValor += 1
        notes.push(`la segunda lectura propone ${key} = ${JSON.stringify(value)} por revisar`)
      }
    } else if (!dictation.ignora?.includes(key) && !(key in changes) && !(key in toReview)) {
      totals.relecturaDeMas += 1
      notes.push(`la segunda lectura propone ${key} = ${JSON.stringify(value)} por revisar, sin esperarlo`)
    }
  }
  for (const key of dictation.espera.revisar ?? []) {
    totals.revisarEsperadas += 1
    if (!listed.has(key)) totals.revisarBien += 1
  }
  for (const want of dictation.espera.nota ?? []) {
    totals.notaEsperada += 1
    if (noteText.includes(want.toLowerCase())) totals.notaBien += 1
    else notes.push(`la nota perdió «${want}» (nota: «${noteText.slice(0, 160)}»; sin limpiar: «${read.drafts.filter((draft) => draft.kind === "nota").flatMap((draft) => Object.values(draft.payload)).join(" ").slice(0, 160)}»)`)
  }
  // Como el servidor: el diagnóstico cuyo nombre contradice lo dictado pasa al hermano que calza, por revisar.
  const diagnoses = serverDiagnoses(read.drafts, [heard, dictation.contexto ?? ""])
  const codes = diagnoses.map((item) => item.code)
  for (const code of dictation.espera.diagnosticos ?? []) {
    totals.diagnosticosEsperados += 1
    if (diagnosisProposed(code, codes)) totals.diagnosticosBien += 1
    else notes.push(`no propuso el diagnóstico ${code} (propuso: ${codes.join(", ") || "ninguno"})`)
  }
  for (const code of dictation.espera.diagnosticosNo ?? []) {
    totals.diagnosticosNoEsperados += 1
    if (!diagnosisProposed(code, diagnoses.filter((item) => item.ready).map((item) => item.code))) continue
    totals.diagnosticosNoListos += 1
    notes.push(`DIAGNÓSTICO QUE CONTRADICE LO DICTADO ${code}, listo`)
  }
  for (const [key, said] of Object.entries(dictation.espera.dicho ?? {})) {
    totals.dichoEsperado += 1
    const shown = shownSaid.get(key) ?? ""
    if (shown.toLowerCase() === said.toLowerCase()) totals.dichoBien += 1
    else notes.push(`${key} dice «${shown}» en vez de «${said}»`)
  }
  for (const unwanted of dictation.espera.noEnNota ?? []) {
    totals.notaSobraEsperada += 1
    if (noteText.includes(unwanted.toLowerCase())) {
      totals.notaSobra += 1
      notes.push(`la nota repite «${unwanted}»`)
    }
  }
  const money = cost === null ? "sin costo" : `USD ${(cost / 1_000_000).toFixed(5)}`
  const shown = [...listed].map(([key, value]) => `${key.split(".").at(-1)}=${JSON.stringify(value)}`).join(", ")
  console.log(`${notes.some((note) => note.startsWith("INVENTÓ") || note.startsWith("LISTA SOBRE") || note.startsWith("DIAGNÓSTICO QUE")) ? "✗" : notes.length ? "△" : "✓"} ${dictation.id} (${money}, ${meta.input_tokens ?? "?"}+${meta.output_tokens ?? "?"} tokens, caché ${meta.input_token_details?.cache_read ?? 0}) ${shown}${reviewed.size ? ` · por revisar: ${[...reviewed].join(", ")}` : ""}${notes.length ? ` — ${notes.join("; ")}` : ""}`)
  if (notes.length) {
    const labelOf = (number: unknown) => {
      const question = byNumber.get(Number(number))
      return question ? `${question.formTitle}: ${question.label}` : `pregunta ${String(number)} (no existe)`
    }
    saveRaw({
      id: dictation.id,
      texto: dictation.texto,
      notas: notes,
      preguntas: questions.map((item) => `${item.number}. ${item.formTitle}: ${item.label}`),
      crudo: rawOf(raw, reply.content),
      // Qué hizo el servidor con cada respuesta de ficha que leyó del modelo.
      servidor: prepared.map(({ draft, ready }) => ({
        pregunta: labelOf(draft.payload["question"]),
        respuesta: draft.payload["answers"] ?? draft.payload["answer"],
        dicho: draft.sourceText ?? "",
        ...(twins.has(draft) ? { gemela: true } : {}),
        queda: ready ? ready.status : "parada",
        ...(ready?.note ? { motivo: ready.note } : {}),
      })),
      // Lo que vería en «No pude usar esto»: por el motivo de lo parado o por la red.
      avisos: notices,
      noUsado: read.unused,
      ...(misses.length ? { segundaLectura: { oraciones: misses, respuestas: reread } } : {}),
    })
  }
  if (solo.length === 1) console.log(JSON.stringify({ crudo: (reply.tool_calls ?? []).map((call) => call.args["fichas"]), fichas: answers, otras: read.drafts.filter((draft) => draft.kind !== "ficha"), nota: noteText, unused: read.unused }, null, 1))
}

const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)} %` : "—")
console.log("")
console.log(`Modelo: ${spec.modelName} · ${cases.length} dictados`)
// La línea que cuenta que el camino nuevo corrió: sin pausas con fichas ni respuestas leídas, la medición no dice nada.
console.log(`Camino de fichas: ${totals.conFichas} pausas con fichas empezadas, ${totals.leidas} respuestas de ficha leídas del modelo, ${totals.paradas} paradas por la comprobación del servidor`)
console.log(`Respuestas: ${totals.bien} de ${totals.esperadas} bien (${pct(totals.bien, totals.esperadas)}), ${totals.perdidas} perdidas, ${totals.inventadas} inventadas`)
console.log(
  `Las perdidas, en «No pude usar esto»: ${totals.perdidasAvisadas} con el motivo de lo parado, ${totals.perdidasRed} por la red de la oración, ${totals.perdidasPorRevisar} por revisar de la segunda lectura, ${totals.perdidas - totals.perdidasAvisadas - totals.perdidasRed - totals.perdidasPorRevisar} en silencio`,
)
console.log(`La red avisó ${totals.avisosRed} oraciones; ${totals.avisosRedDeMas} de preguntas que el dictado no espera${netExtra.length ? `:\n  ${netExtra.join("\n  ")}` : ""}`)
console.log(`Lo dicho a medias que no quedó listo: ${totals.revisarBien} de ${totals.revisarEsperadas}`)
console.log(`Lo que cambia lo escrito: ${totals.cambiaBien} de ${totals.cambiaEsperadas} por revisar con el valor dicho, ${totals.cambiaListas} listas (el criterio es cero)`)
console.log(`Texto de la consulta: conserva ${totals.notaBien} de ${totals.notaEsperada}; repite lo de la ficha en ${totals.notaSobra} de ${totals.notaSobraEsperada}`)
console.log(`Diagnóstico dicho que también va a Diagnóstico: ${totals.diagnosticosBien} de ${totals.diagnosticosEsperados}; que contradice lo dictado y queda listo: ${totals.diagnosticosNoListos} de ${totals.diagnosticosNoEsperados} (el criterio es cero); frase del número usado: ${totals.dichoBien} de ${totals.dichoEsperado}`)
console.log(`Lo dicho sin nombrar su pregunta: ${totals.revisarConBien} de ${totals.revisarConEsperadas} por revisar con su valor, ${totals.revisarConListas} listas`)
console.log(
  `Segunda lectura: ${totals.relecturas} pausas, ${totals.releidas} oraciones leídas de nuevo; ${totals.relecturaRevisar} respuestas por revisar (${totals.relecturaBien} con el valor esperado, ${totals.relecturaOtroValor} con otro valor, ${totals.relecturaDeMas} donde no se esperaba); de las perdidas, ${totals.perdidasPorRevisar} quedaron por revisar`,
)
console.log(
  `Costo: USD ${((totals.costo + totals.relecturaCosto) / 1_000_000).toFixed(4)} en total, USD ${(totals.costo / 1_000_000 / Math.max(1, cases.length - totals.sinCosto)).toFixed(5)} por dictado${totals.sinCosto ? ` (${totals.sinCosto} sin costo informado)` : ""}; la segunda lectura, USD ${(totals.relecturaCosto / 1_000_000).toFixed(4)} (${totals.costo ? Math.round((100 * totals.relecturaCosto) / totals.costo) : 0} % más)${totals.relecturaSinCosto ? `, ${totals.relecturaSinCosto} sin costo informado` : ""}`,
)
if (rawSaved) console.log(`Lo que respondió el modelo en los ${rawSaved} dictados con algo perdido o inventado: ${rawFile}`)
