/**
 * Medición de Clío en una consulta conversada (mesa del 20 nov 2026, P7). Uso:
 *
 *   pnpm --filter @odentia/agent eval:dictado-conversado [-- --file=eval/dictado-conversado.json] [--producto=odentia|latidia] [--solo=<id>[,<id>…]] [--paralelo=4] [--crudo=<archivo>]
 *
 * Cada caso es una consulta en varias pausas, como llega de la voz de Chrome: la pregunta y su
 * respuesta en pausas distintas, charla, correcciones del paciente, quien lo acompaña, una recarga
 * a media consulta y una ficha abierta. Se pasa como la atención: pausa por pausa, con la misma
 * llamada (`askDictationModel`), lo último dicho como contexto y lo pendiente nombrado como lo nombra
 * el servicio (`dictationModelLabel`); lo que devuelve se aplica con la lógica del servidor
 * (`applyPause`, con sus funciones puras) y, si la rama lo tiene, al final va el repaso
 * (`askDictationReview`). Cuenta por caso y en total: lo dicho que llegó a su lugar, lo que se avisó
 * («No lo usé» o por revisar), lo perdido sin aviso, el ruido que se coló, quién habló por frase y el
 * costo, con los precios de `ai-usage.ts`.
 *
 * Corre igual sobre `main` (el antes): lo que esa rama no tiene se mide con lo que tenía y se dice al
 * empezar (`missingParts`). Con `LLM_MODEL=fake` usa un proveedor de prueba local que responde por
 * reglas fijas: sirve para ver que el recorrido funciona, no para medir (sus números no valen).
 * No toca ninguna base ni envía nada: es evidencia de este banco, no de clínicas reales.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { once } from "node:events"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { type AiUsageEntry, type DictationFormQuestion, dictationFor, dictationModelLabel, formNetMisses, formQuestionsOf, pendingFormValues, productHooksFor } from "@odentia/services"
import { withAiMeter } from "./ai-usage.js"
import * as dictationModule from "./dictation.js"
import { askDictationModel, type DictationProfile, rereadFormSentences } from "./dictation.js"
import {
  applyPause,
  type CaseScore,
  type ExpectedCase,
  missingParts,
  newState,
  pauseContext,
  pendingOf,
  SERVER,
  type SimProduct,
  type SimState,
  scoreCase,
  sumScores,
} from "./eval-dictado-conversado-cuenta.js"
import { createConfiguredChatModel, type LlmSpec, platformLlmFromEnv, resolveLlmSpec } from "./llm.js"
import { dictationProfileFor } from "./products.js"

interface ConversedCase {
  id: string
  producto: "odentia" | "latidia"
  descripcion?: string
  /** Lo que oye el micrófono hasta cada pausa, sin decir quién habla. */
  pausas: string[]
  /** La página se recarga antes de esta pausa (desde 1): la pestaña pierde lo dicho. */
  recargaAntesDe?: number
  /** Fichas ya empezadas en la atención, por su clave. */
  fichas?: Array<{ ficha: string; respondidas?: Record<string, unknown> }>
  espera: ExpectedCase
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}

const file = arg("file", "eval/dictado-conversado.json")
const bank = JSON.parse(readFileSync(resolve(file), "utf8")) as { servicios: { dental: string[]; medico: string[] }; casos: ConversedCase[] }

/* ---------- El proveedor de prueba (`LLM_MODEL=fake`) ---------- */

/**
 * Un proveedor de OpenAI local que responde por reglas fijas, como el de las pruebas
 * (`test-provider.ts`, que no se importa aquí porque trae vitest): a la pausa, todo lo dicho como
 * relato; al repaso, un solo turno de no se sabe quién; a la segunda lectura de las fichas, nada.
 * Informa un uso inventado (los caracteres de la petición, con la herramienta, entre cuatro) para que el costo se calcule de punta a punta.
 */
async function testProvider() {
  let said = ""
  const server = createServer(async (request, response) => {
    let raw = ""
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { tools?: unknown[] }
    const tools = JSON.stringify(body.tools ?? [])
    const name = tools.includes("registrar_fichas") ? "registrar_fichas" : "registrar_dictado"
    const args =
      name === "registrar_fichas"
        ? { fichas: [] }
        : tools.includes("turnos")
          ? { turnos: [{ desde: 1, quien: "no_se_sabe" }], sin_lugar: [] }
          : { nota: { presentIllness: said, dicho: said } }
    reply(response, request.url, name, JSON.stringify(args), Math.ceil(raw.length / 4))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("El proveedor de prueba no abrió un puerto")
  return {
    origin: `http://127.0.0.1:${address.port}`,
    say: (text: string) => {
      said = text
    },
    close: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

function reply(response: ServerResponse, url: string | undefined, name: string, args: string, inputTokens: number) {
  const outputTokens = Math.ceil(args.length / 4)
  const body =
    url === "/v1/responses"
      ? {
          id: "resp_1",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-6-luna",
          output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: args, status: "completed" }],
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }
      : {
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 1,
          model: "gpt-6-luna",
          choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: args } }] }, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
        }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const envSpec = resolveLlmSpec(platformLlmFromEnv(process.env))
const fake = envSpec.provider === "fake"
const double = fake ? await testProvider() : null
const spec: LlmSpec = double ? resolveLlmSpec({ openai: { apiKey: "clave-sintetica", baseUrl: `${double.origin}/v1` }, maxRetries: 0 }) : envSpec

/* ---------- Cada producto, como en la atención ---------- */

function productOf(name: ConversedCase["producto"]) {
  const product = name === "latidia" ? "medical" : "dental"
  const hooks = productHooksFor(product)
  const profile = dictationProfileFor(product)
  const dictation = dictationFor(product)
  if (!profile || !dictation) throw new Error(`${name} no dicta`)
  const sim: SimProduct = { dictation, site: hooks.site, formDiagnoses: hooks.forms.diagnoses }
  return { profile, dictation, sim, catalog: dictation.catalogText(), forms: hooks.forms.suggestions, services: name === "latidia" ? bank.servicios.medico : bank.servicios.dental }
}
const PRODUCTS = { odentia: productOf("odentia"), latidia: productOf("latidia") }
const models = new Map<string, unknown>()
async function modelOf(profile: DictationProfile): Promise<unknown> {
  const key = profile.reasoning ?? "none"
  if (!models.has(key)) models.set(key, await createConfiguredChatModel(spec, { explicitCache: true, ...(profile.reasoning ? { reasoning: profile.reasoning } : {}) }))
  return models.get(key)
}

/** El repaso, si la rama lo tiene: en `main` no existe y se mide sin él. */
const askReview = (dictationModule as Partial<typeof dictationModule>).askDictationReview

/* ---------- Lo que cuesta ---------- */

interface Usage {
  pausas: number
  relecturas: number
  repasos: number
  sinHerramienta: number
  entrada: number
  cache: number
  salida: number
  micros: number
  /** Lo del repaso, aparte: es la llamada nueva. */
  microsRepaso: number
  sinCosto: number
}
const newUsage = (): Usage => ({ pausas: 0, relecturas: 0, repasos: 0, sinHerramienta: 0, entrada: 0, cache: 0, salida: 0, micros: 0, microsRepaso: 0, sinCosto: 0 })

/** Una llamada, medida como la atención mide el dictado (`reportAiUse` dentro, `withAiMeter` aquí). */
async function metered<T>(usage: Usage, what: "pausas" | "relecturas" | "repasos", run: () => Promise<T>): Promise<T> {
  return withAiMeter(run, async (entries: AiUsageEntry[]) => {
    for (const entry of entries) {
      usage[what] += entry.calls
      usage.entrada += entry.inputTokens ?? 0
      usage.cache += entry.cachedInputTokens ?? 0
      usage.salida += entry.outputTokens ?? 0
      if (entry.costMicros === null) usage.sinCosto += entry.calls
      else {
        usage.micros += entry.costMicros
        if (what === "repasos") usage.microsRepaso += entry.costMicros
      }
    }
  })
}

/* ---------- Una consulta ---------- */

interface Result {
  item: ConversedCase
  state: SimState
  score: CaseScore
  usage: Usage
}

const now = new Date()
const ZONE = { locale: "es-PE", timezone: "America/Lima" }

async function runCase(item: ConversedCase): Promise<Result> {
  const product = PRODUCTS[item.producto]
  const model = await modelOf(product.profile)
  const questions: DictationFormQuestion[] = formQuestionsOf(
    (item.fichas ?? []).map((entry) => {
      const form = product.forms.find((one) => one.key === entry.ficha)
      if (!form) throw new Error(`${item.id}: la ficha ${entry.ficha} no existe en ${item.producto}`)
      return { id: entry.ficha, title: form.title, snapshot: form.schema, answers: entry.respondidas ?? {} }
    }),
  )
  const state = newState()
  const usage = newUsage()
  const label = (row: { kind: string; payload: Record<string, unknown> }) => dictationModelLabel(row as Parameters<typeof dictationModelLabel>[0], product.dictation)
  /** Lo guardado en el servidor (la rama nueva) y lo que recuerda la pestaña desde la última recarga (`main`). */
  const said: string[] = []
  let sinceReload: string[] = []
  for (const [index, pause] of item.pausas.entries()) {
    if (item.recargaAntesDe === index + 1) sinceReload = []
    const pending = pendingOf(state)
    double?.say(pause)
    const { read, heard } = await metered(usage, "pausas", () =>
      askDictationModel(
        model,
        spec,
        {
          provider: spec.provider,
          services: product.services,
          diagnosisList: "CIE-10 (OMS)",
          catalog: product.catalog,
          zone: ZONE,
          now,
          transcript: pause,
          context: pauseContext(said, sinceReload),
          pending: pending.map((row) => ({ label: label(row) })),
          forms: questions,
        },
        product.profile,
      ),
    )
    said.push(pause)
    sinceReload.push(pause)
    if (!read) {
      usage.sinHerramienta += 1
      continue
    }
    let drafts = read.drafts
    // Como la atención (`extractDictation`): lo que la red de las fichas avisaría se lee una vez más.
    if (questions.length) {
      const misses = formNetMisses(read.drafts, questions, product.sim.site, heard, pendingFormValues(pending, questions))
      if (misses.length) drafts = [...drafts, ...(await metered(usage, "relecturas", () => rereadFormSentences(model, spec, misses, questions).catch(() => [])))]
    }
    applyPause(state, { ...read, drafts }, { transcript: heard, at: `pausa ${index + 1}`, questions }, product.sim)
  }
  if (askReview) {
    const segments = item.pausas.map((transcript, index) => ({ number: index + 1, saidAt: new Date(now.getTime() - (item.pausas.length - index) * 20_000), transcript, needsTurns: true }))
    const { read } = await metered(usage, "repasos", () =>
      askReview(
        model,
        spec,
        {
          provider: spec.provider,
          services: product.services,
          diagnosisList: "CIE-10 (OMS)",
          catalog: product.catalog,
          zone: ZONE,
          now,
          segments,
          earlierLeftOut: false,
          pending: pendingOf(state).map(label),
          confirmed: [],
          discarded: state.suggestions.filter((row) => row.status === "descartada").map(label),
          forms: questions,
        },
        product.profile,
      ),
    )
    if (!read) usage.sinHerramienta += 1
    else {
      applyPause(
        state,
        { drafts: read.drafts, corrections: [], removals: [], omitted: read.omitted, unused: read.unused },
        { transcript: segments.map((segment) => segment.transcript).join("\n"), at: "repaso", questions, review: true },
        product.sim,
      )
      for (const item2 of read.outOfPlace) state.unused.push({ said: item2.said, why: item2.why, at: "repaso" })
      state.turns = read.turns.flatMap((entry) => entry.turns)
    }
  }
  return { item, state, score: scoreCase(item.espera, state), usage }
}

/* ---------- La corrida ---------- */

const only = arg("producto", "")
const solo = arg("solo", "").split(",").filter(Boolean)
const cases = bank.casos.filter((item) => (!only || item.producto === only) && (!solo.length || solo.includes(item.id)))
if (!cases.length) throw new Error(`Ningún caso de ${file} con esos filtros`)
const missing = missingParts(SERVER, !!askReview)
console.log(`Modelo: ${fake ? "proveedor de prueba local (LLM_MODEL=fake): sirve para ver el recorrido, sus números no valen" : spec.modelName} · ${cases.length} casos de ${file}`)
console.log(missing.length ? `Esta rama no tiene: ${missing.join("; ")}. Se mide con lo que tiene: lo que no tiene dónde ir cuenta como perdido.` : "Esta rama tiene la consulta que se suma, lo de su salud, el contexto guardado y el repaso.")

/** Unos pocos casos a la vez (cada uno, pausa por pausa); con el proveedor de prueba, de a uno. */
const parallel = fake ? 1 : Math.max(1, Number(arg("paralelo", "4")) || 4)
const results: Result[] = []
for (let start = 0; start < cases.length; start += parallel) results.push(...(await Promise.all(cases.slice(start, start + parallel).map(runCase))))
double?.close()

const rawFile = resolve(arg("crudo", join(tmpdir(), "odentia-eval", `dictado-conversado-${now.toISOString().replace(/[:.]/g, "-")}.jsonl`)))
mkdirSync(dirname(rawFile), { recursive: true })
const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(4)}`
const pct = (part: number, whole: number) => (whole ? `${Math.round((100 * part) / whole)} %` : "—")
const calls = (usage: Usage) => usage.pausas + usage.relecturas + usage.repasos

for (const { item, state, score, usage } of results) {
  const mark = score.perdidoSinAviso || score.ruido ? "✗" : score.avisado || score.quien.bien < score.quien.total ? "△" : "✓"
  console.log(
    `${mark} ${item.id} (${item.producto}, ${item.pausas.length} pausas${usage.repasos ? " + repaso" : ""}${usage.relecturas ? ` + ${usage.relecturas} relecturas` : ""} · ${usd(usage.micros)}${usage.sinCosto ? `, ${usage.sinCosto} sin costo` : ""}) llegó ${score.llego} de ${score.esperado} · avisado ${score.avisado} · perdido sin aviso ${score.perdidoSinAviso} · ruido ${score.ruido} (${score.ruidoComprobado} comprobaciones) · quién ${score.quien.bien} de ${score.quien.total} · «No lo usé» ${score.noLoUse.bien} de ${score.noLoUse.total} · ${score.consultas} ${score.consultas === 1 ? "consulta" : "consultas"}${usage.sinHerramienta ? ` · ${usage.sinHerramienta} sin herramienta` : ""}`,
  )
  for (const note of score.notas) console.log(`    ${note}`)
  appendFileSync(
    rawFile,
    `${JSON.stringify({ id: item.id, notas: score.notas, sugerencias: state.suggestions, noLoUse: state.unused, turnos: state.turns })}\n`,
  )
}

function summary(label: string, list: readonly Result[]) {
  if (!list.length) return
  const total = sumScores(list.map((result) => result.score))
  const usage = list.reduce((sum, { usage: one }) => {
    for (const key of Object.keys(sum) as Array<keyof Usage>) sum[key] += one[key]
    return sum
  }, newUsage())
  console.log(
    [
      `${label} (${list.length} consultas):`,
      `  lo dicho que llegó a su lugar: ${total.llego} de ${total.esperado} (${pct(total.llego, total.esperado)}) · avisado ${total.avisado} · perdido sin aviso ${total.perdidoSinAviso}`,
      `  ruido que se coló: ${total.ruido} en ${total.ruidoComprobado} comprobaciones · consultas de más: ${total.consultasDeMas}`,
      `  quién habló: ${total.quien.bien} de ${total.quien.total} (${pct(total.quien.bien, total.quien.total)}) · en «No lo usé» lo que debía: ${total.noLoUse.bien} de ${total.noLoUse.total}`,
      `  ${calls(usage)} llamadas (${usage.pausas} pausas, ${usage.relecturas} relecturas, ${usage.repasos} repasos) · ${usage.entrada} tokens de entrada (${usage.cache} de la caché) · ${usage.salida} de salida`,
      `  costo ${usd(usage.micros)}${usage.sinCosto ? ` (+${usage.sinCosto} llamadas sin costo)` : ""} · por consulta ${usd(usage.micros / list.length)} · el repaso ${usd(usage.microsRepaso)} (${pct(usage.microsRepaso, usage.micros - usage.microsRepaso)} sobre las pausas)`,
    ].join("\n"),
  )
}
console.log("")
summary("odentIA", results.filter((result) => result.item.producto === "odentia"))
summary("latidIA", results.filter((result) => result.item.producto === "latidia"))
summary("Total", results)
console.log(`Lo que quedó de cada consulta (sugerencias, «No lo usé» y turnos): ${rawFile}`)
