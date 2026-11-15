/**
 * Medición de Ariadna por chat (A5 del lienzo «Ariadna en los chats», ADR 0191). Uso:
 *
 *   pnpm --filter @odentia/agent eval:ariadna-chat [-- --casos=id1,id2] [--sin-juez] [--file=eval/ariadna-chat.json] [--salida=ruta.json]
 *
 * Corre `askHelpByChat` de los servicios, lo mismo que el worker: Jev decide
 * (`JEV_API_KEY`), el modelo que escribe redacta solo cuando Jev junta dos o
 * tres respuestas (`LLM_OPENAI_API_KEY`), con la guía del producto de cada
 * pregunta y sin datos de ninguna clínica. El banco lo escribió el equipo,
 * como se escribe por WhatsApp (nunca datos reales).
 *
 * GRAVE (reglas fijas sobre lo que salió; el juez nunca las quita):
 *   - da o inventa un dato de la clínica: una cifra, un correo o un teléfono que
 *     no está en la guía ni en los textos fijos de Ariadna;
 *   - inventa un paso: un nombre entre «» que la guía de ese producto no tiene;
 *   - responde un cobro: lo que es de Administración salió con la guía;
 *   - atiende a un paciente como si fuera la clínica.
 * Además: la tasa de tema correcto (de lo que se esperaba con la guía, cuánto
 * salió con su pregunta frecuente), la de oferta o pase a Soporte, y el tipo
 * que no coincidió. Un juez (gpt-6-luna, razonamiento medio) califica de 1 a 5
 * la claridad de cada respuesta. El costo sale de `AI_PRICES` con lo que
 * informa cada proveedor.
 *
 * Con `LLM_MODEL=fake` corren los dobles (el decisor por palabras y quien
 * redacta por reglas), sin juez y sin gasto: sirve para ver que la medición
 * anda, no cuenta como medición, y el resultado va a la carpeta temporal.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ChatOpenAI } from "@langchain/openai"
import {
  type AiUsageEntry,
  type AriadnaChatReply,
  ariadnaFixedTexts,
  askHelpByChat,
  type HelpDecider,
  helpTopicLabel,
  helpTopicsFor,
  limaDate,
} from "@odentia/services"
import { asAdminDecider } from "./admin.js"
import { costMicrosOf, withAiMeter } from "./ai-usage.js"
import { createDecisionModel } from "./decision/index.js"
import { createHelpWriter } from "./help-writer.js"
import { platformLlmFromEnv, resolveLlmSpec } from "./llm.js"

type Product = "odentia" | "latidia" | "vistia"
type ClinicalProduct = "dental" | "medical" | "optical"
const PRODUCT_KEY: Record<Product, ClinicalProduct> = {
  odentia: "dental",
  latidia: "medical",
  vistia: "optical",
}
type Kind = AriadnaChatReply["kind"]

interface CaseDef {
  id: string
  producto: Product
  texto: string
  antes?: { oferta?: boolean; pregunta?: string }
  espera: { tipo: Kind; faqs?: string[]; temas?: string[] }
  nota?: string
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const bankPath = resolve(arg("file", "eval/ariadna-chat.json"))
const bank = JSON.parse(readFileSync(bankPath, "utf8")) as { casos: CaseDef[] }
const only = arg("casos", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
const cases = bank.casos.filter((c) => only.length === 0 || only.includes(c.id))
if (only.length && cases.length !== only.length)
  throw new Error(
    `No están en el banco: ${only.filter((id) => !bank.casos.some((c) => c.id === id)).join(", ")}`,
  )

const env = process.env
const platform = platformLlmFromEnv(env)
const fake = Boolean(platform.fake)
if (!fake && !env.JEV_API_KEY?.trim())
  throw new Error(
    "Esta medición es con Jev: define JEV_API_KEY (o LLM_MODEL=fake solo para ver que corre)",
  )
const withJudge = !fake && !flag("sin-juez") && Boolean(platform.openai?.apiKey)

const decider: HelpDecider | null = fake
  ? await createDecisionModel(
      "baseline",
      { timeoutMs: 8_000 },
      resolveLlmSpec({ fake: true }),
    ).then((model) => (model ? asAdminDecider(model) : null))
  : await createDecisionModel(
      "jev",
      {
        jev: { apiKey: env.JEV_API_KEY ?? "", baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL },
        timeoutMs: 8_000,
      },
      resolveLlmSpec({ fake: true }),
    ).then((model) => (model ? asAdminDecider(model) : null))
const writer = createHelpWriter(platform)

/* ---------- Las reglas fijas ---------- */

const plain = (text: string) =>
  text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\s+/g, " ")

/** Todo lo que Ariadna puede decir de un producto: su guía y sus textos fijos. */
function sourceOf(product: ClinicalProduct): string {
  const topics = helpTopicsFor(product)
  return plain(
    [
      ...topics.flatMap((t) => [
        t.title,
        // La opción que arma el código cuando duda («¿Qué es Configuración › Horarios y ausencias?»),
        // como la Ayuda de la app: sale de la guía, no la escribe el modelo.
        `¿Qué es ${helpTopicLabel(t)}?`,
        t.parent ?? "",
        t.purpose,
        ...(t.faqs ?? []).flatMap((f) => [f.q, f.a]),
      ]),
      ...ariadnaFixedTexts(product),
    ].join("\n"),
  )
}
const sources = new Map<ClinicalProduct, string>()
const source = (product: ClinicalProduct) => {
  if (!sources.has(product)) sources.set(product, sourceOf(product))
  return sources.get(product) as string
}

function graveRules(c: CaseDef, reply: AriadnaChatReply): string[] {
  const product = PRODUCT_KEY[c.producto]
  const text = reply.text.replace(/https?:\/\/\S+/g, " ")
  const src = source(product)
  const out: string[] = []
  const numbers = text.match(/\d+(?:[.,]\d+)?/g) ?? []
  const unknownNumbers = numbers.filter((n) => !src.includes(n))
  if (unknownNumbers.length)
    out.push(`dato: cifras que no están en la guía (${unknownNumbers.join(", ")})`)
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) out.push("dato: un correo")
  const names = [...text.matchAll(/«([^»]+)»/g)]
    .map((m) => plain(m[1] ?? ""))
    .filter((name) => !src.includes(name))
  if (names.length) out.push(`paso: nombres que la guía no tiene (${names.join(", ")})`)
  if (c.espera.tipo === "administracion" && (reply.kind === "respuesta" || reply.kind === "datos"))
    out.push("cobro: lo de Administración salió con la guía")
  if (
    c.espera.tipo === "paciente" &&
    (reply.kind === "respuesta" || reply.kind === "datos" || reply.kind === "oferta")
  )
    out.push("paciente: atendió a un paciente como a la clínica")
  return out
}

function topicOk(c: CaseDef, reply: AriadnaChatReply): boolean {
  const faqs = c.espera.faqs ?? []
  const temas = c.espera.temas ?? []
  const faqId = reply.kind === "respuesta" || reply.kind === "oferta" ? (reply.faqId ?? null) : null
  const topicId =
    reply.kind === "respuesta" || reply.kind === "oferta" ? (reply.topicId ?? null) : null
  return (faqId !== null && faqs.includes(faqId)) || (topicId !== null && temas.includes(topicId))
}

/* ---------- El juez (solo claridad) ---------- */

const judgeModel = withJudge
  ? new ChatOpenAI({
      model: "gpt-6-luna",
      apiKey: platform.openai?.apiKey,
      useResponsesApi: true,
      timeout: 120_000,
      maxRetries: 2,
      modelKwargs: { reasoning: { effort: "medium" } },
      ...(platform.openai?.baseUrl ? { configuration: { baseURL: platform.openai.baseUrl } } : {}),
    })
  : null
const judgeTotals = { input: 0, cached: 0, output: 0, micros: 0, noCost: 0, calls: 0 }

const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === "object" && "text" in part ? String(part.text) : "",
          )
          .join("")
      : ""

async function judge(
  c: CaseDef,
  reply: AriadnaChatReply,
): Promise<{ claridad: number; comentario: string } | null> {
  if (!judgeModel) return null
  const prompt = `Eres un auditor exigente de cómo responde Ariadna, la Ayuda de odentIA, latidIA y vistIA (software para clínicas dentales, consultorios médicos y ópticas), cuando alguien de la clínica le escribe por WhatsApp. Ariadna solo explica cómo se usa el sistema con su guía; no ve los datos de la clínica; pasa a Soporte lo de su cuenta y a Administración los cobros.

Califica de 1 a 5, sin indulgencia (3 = aceptable con fallas, 5 = como la mejor persona de soporte), solo la claridad: si se entiende a la primera en un celular, si es corta, si dice qué hacer o qué sigue. No juzgues si el contenido es correcto: eso lo revisan reglas fijas.
Lo que se esperaba (de quien escribió el caso): ${c.nota ?? JSON.stringify(c.espera)}

Escribió: ${c.texto}
Ariadna: ${reply.text}

Devuelve solo un JSON: {"claridad": n, "comentario": "una línea"}`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const out = await judgeModel.invoke(prompt)
      const meta = (out.usage_metadata ?? {}) as {
        input_tokens?: number
        output_tokens?: number
        input_token_details?: { cache_read?: number }
      }
      judgeTotals.calls += 1
      judgeTotals.input += meta.input_tokens ?? 0
      judgeTotals.cached += meta.input_token_details?.cache_read ?? 0
      judgeTotals.output += meta.output_tokens ?? 0
      const cost = costMicrosOf({
        model: "gpt-6-luna",
        inputTokens: meta.input_tokens ?? null,
        cachedInputTokens: meta.input_token_details?.cache_read ?? null,
        outputTokens: meta.output_tokens ?? null,
      })
      if (cost === null) judgeTotals.noCost += 1
      else judgeTotals.micros += cost
      const json = /\{[\s\S]*\}/.exec(contentText(out.content))?.[0]
      if (!json) continue
      const parsed = JSON.parse(json) as { claridad: number; comentario: string }
      if (typeof parsed.claridad === "number" && parsed.claridad >= 1 && parsed.claridad <= 5)
        return parsed
    } catch (error) {
      console.error(
        `  juez de ${c.id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      )
    }
  }
  return null
}

/* ---------- La corrida ---------- */

const ariadnaTotals = { calls: 0, input: 0, output: 0, micros: 0, noCost: 0 }
const addUse = async (entries: AiUsageEntry[]) => {
  for (const entry of entries) {
    ariadnaTotals.calls += entry.calls
    ariadnaTotals.input += entry.inputTokens ?? 0
    ariadnaTotals.output += entry.outputTokens ?? 0
    if (entry.costMicros === null) ariadnaTotals.noCost += entry.calls
    else ariadnaTotals.micros += entry.costMicros
  }
}

interface CaseResult {
  id: string
  producto: Product
  texto: string
  espera: CaseDef["espera"]
  salio: Kind
  respuesta: string
  temaCorrecto: boolean | null
  graves: string[]
  juez: { claridad: number; comentario: string } | null
}

const results: CaseResult[] = []
for (const c of cases) {
  const product = PRODUCT_KEY[c.producto]
  let reply: AriadnaChatReply
  try {
    reply = await withAiMeter(
      () =>
        askHelpByChat(
          {
            product,
            question: c.texto,
            previous: c.antes?.pregunta ? { question: c.antes.pregunta, where: null } : null,
            offered: Boolean(c.antes?.oferta),
            firstReply: false,
            appOrigin: "https://clinica.ejemplo.com",
          },
          decider,
          decider ? writer : null,
        ),
      addUse,
    )
  } catch (error) {
    reply = {
      kind: "soporte",
      text: "(falló)",
      why: error instanceof Error ? error.message : String(error),
    }
  }
  const graves = graveRules(c, reply)
  const expectsGuide =
    c.espera.tipo === "respuesta" && Boolean(c.espera.faqs?.length || c.espera.temas?.length)
  const result: CaseResult = {
    id: c.id,
    producto: c.producto,
    texto: c.texto,
    espera: c.espera,
    salio: reply.kind,
    respuesta: reply.text,
    temaCorrecto: expectsGuide ? topicOk(c, reply) : null,
    graves,
    juez: await judge(c, reply),
  }
  results.push(result)
  const ok = graves.length === 0 && reply.kind === c.espera.tipo && result.temaCorrecto !== false
  console.log(
    `${graves.length ? "✗" : ok ? "✓" : "△"} ${c.id}: esperaba ${c.espera.tipo}, salió ${reply.kind}${result.juez ? ` · claridad ${result.juez.claridad}` : ""}`,
  )
  for (const g of graves) console.log(`    GRAVE ${g}: ${reply.text.slice(0, 200)}`)
  if (result.temaCorrecto === false) console.log(`    otro tema: ${reply.text.slice(0, 160)}`)
}

/* ---------- El resumen ---------- */

const guideCases = results.filter((r) => r.temaCorrecto !== null)
const correct = guideCases.filter((r) => r.temaCorrecto).length
const kindOk = results.filter((r) => r.salio === r.espera.tipo).length
const handedSupport = results.filter((r) => r.salio === "soporte" || r.salio === "oferta").length
const guideToSupport = guideCases.filter(
  (r) => r.salio === "soporte" || r.salio === "oferta",
).length
const graveCases = results.filter((r) => r.graves.length)
const judged = results.filter((r) => r.juez)
const clarity = judged.length
  ? judged.reduce((sum, r) => sum + (r.juez?.claridad ?? 0), 0) / judged.length
  : null
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)} %` : "—")
const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(4)}`

console.log("")
if (fake)
  console.log(
    "MODELO FALSO (LLM_MODEL=fake): los dobles por palabras, sin juez ni gasto. Esto NO cuenta como medición.",
  )
console.log(
  `Ariadna por chat · ${results.length} preguntas · decisor ${fake ? "falso" : "Jev"} · redacta ${writer ? (fake ? "doble" : "modelo que escribe") : "nadie"}`,
)
console.log("")
console.log("| Medida | Valor |")
console.log("| --- | --- |")
console.log(
  `| Preguntas con GRAVE | ${graveCases.length} de ${results.length}${graveCases.length ? ` (${graveCases.map((r) => r.id).join(", ")})` : ""} |`,
)
console.log(
  `| Tema correcto (de las que responde la guía) | ${correct} de ${guideCases.length} (${pct(correct, guideCases.length)}) |`,
)
console.log(
  `| De esas, ofrecidas o pasadas a Soporte | ${guideToSupport} de ${guideCases.length} (${pct(guideToSupport, guideCases.length)}) |`,
)
console.log(
  `| Ofrece o pasa a Soporte (todas) | ${handedSupport} de ${results.length} (${pct(handedSupport, results.length)}) |`,
)
console.log(
  `| Tipo de respuesta esperado | ${kindOk} de ${results.length} (${pct(kindOk, results.length)}) |`,
)
console.log(
  `| Juez (claridad) | ${withJudge ? `${clarity?.toFixed(2) ?? "—"} en ${judged.length} respuestas` : "sin juez"} |`,
)
console.log(
  `| Gasto de Ariadna (Jev y quien redacta) | ${fake ? "—" : `${usd(ariadnaTotals.micros)} (${ariadnaTotals.calls} llamadas, ${ariadnaTotals.input} entrada, ${ariadnaTotals.output} salida${ariadnaTotals.noCost ? `, ${ariadnaTotals.noCost} sin costo informado` : ""})`} |`,
)
console.log(
  `| Gasto del juez | ${withJudge ? `${usd(judgeTotals.micros)} (${judgeTotals.calls} llamadas${judgeTotals.noCost ? `, ${judgeTotals.noCost} sin costo` : ""})` : "—"} |`,
)

const day = limaDate(new Date())
const out = arg(
  "salida",
  fake
    ? join(tmpdir(), `ariadna-chat-${day}-fake.json`)
    : resolve("eval/ariadna-chat-mediciones", `${day}.json`),
)
mkdirSync(resolve(out, ".."), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify(
    {
      fecha: new Date().toISOString(),
      cuenta: !fake,
      banco: bankPath,
      resumen: {
        preguntas: results.length,
        conGrave: graveCases.map((r) => r.id),
        temaCorrecto: { bien: correct, de: guideCases.length },
        soporte: { todas: handedSupport, deLaGuia: guideToSupport },
        tipoEsperado: kindOk,
        claridad: clarity,
        gasto: fake
          ? null
          : {
              ariadna: { ...ariadnaTotals },
              juez: withJudge ? { ...judgeTotals } : null,
              totalMicros: ariadnaTotals.micros + judgeTotals.micros,
            },
      },
      casos: results,
    },
    null,
    1,
  )}\n`,
)
console.log("")
console.log(`Resultado: ${out}`)
