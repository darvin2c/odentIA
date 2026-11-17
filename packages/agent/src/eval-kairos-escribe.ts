/**
 * Medición de lo que escribe Kairós para Administración (ADR 0196). Uso:
 *
 *   pnpm --filter @odentia/agent eval:kairos-escribe [-- --casos=id1,id2] [--repeticiones=N] [--sin-juez] [--file=eval/kairos-escribe.json] [--salida=ruta.json]
 *
 * Parte A, «Mejorar con Kairós»: corre el escritor real (`createKairosWriter`, con
 * `AGENT_MODEL` y la clave `LLM_OPENAI_API_KEY`) sobre los mensajes del banco, con
 * su misma red antes de proponer (`checkImprovedText`, dentro de `improveText`), y
 * cuenta por reglas fijas sobre lo que propuso:
 *   - un dato que no estaba (`improveInventions`, la misma red: no debería pasar nunca);
 *   - las marcas (*negrita*, _cursiva_, ~tachado~, listas con «- »), los enlaces y los
 *     correos que se perdieron, y los números del original que ya no están;
 *   - lo que creció más de una quinta parte (lo que pide el prompt) y lo que no cabe en
 *     su canal (WhatsApp 4096 caracteres, Messenger 2000, Instagram 1000 bytes);
 *   - lo que el caso pide conservar o no decir, y si cambió un texto que ya estaba bien.
 * Como sospecha, sin quitar puntos: un nombre propio nuevo (una palabra con mayúscula en
 * medio de la frase que no está en el original ni en el nombre de la clínica: la
 * conversación la escribieron otros y no sustenta nada, como en `improveSources`).
 * Después, un juez (gpt-6-luna, razonamiento medio) califica de 1 a 5 el mismo
 * significado, la claridad y el tono de cada propuesta; nunca quita una regla.
 *
 * Parte B, «Lo que hay que saber»: cada caso se resume dos veces con el mismo modelo
 * y la misma llamada que el escritor (`summaryHuman`, `readSummary`): con los hechos y
 * el prompt de antes (el cuerpo de lo que le escribimos como un hecho más y
 * `SUMMARY_SYSTEM` sin `SUMMARY_FACT_KINDS`) y con los de ahora
 * (`summaryActivityFact`: de un correo o un chat, de ida o de vuelta, solo quién y por
 * dónde, y de lo nuestro el asunto). Cuenta, por reglas, cada frase que repite el texto
 * de algo que le escribimos (comparte con él varias palabras con contenido, o dice una
 * de las expresiones `noAfirma` del caso) sin decir que se lo escribimos: así se contaba
 * como un hecho de la clínica; y cada frase que trae el texto de una conversación, que
 * no puede estar porque el resumen lo lee también Soporte, que no ve las conversaciones
 * (ADR 0196). Son aproximaciones por palabras, no una lectura. El juez califica de 1 a 5
 * la fidelidad contra la bitácora completa del caso y dice si alguna frase atribuye a la
 * clínica lo que le escribimos.
 *
 * Gasto: tokens y USD del escritor y del juez por parte y en total (de `AI_PRICES`, con
 * lo que reportó el proveedor; sin uso reportado, null), y lo que cuesta cada
 * «Mejorar». Con `LLM_MODEL=fake` corren los dobles por reglas (`fakeKairosWriter`)
 * por el mismo recorrido, sin juez y sin gasto: sirve para ver que la medición anda,
 * no cuenta como medición; su resultado va a la carpeta temporal e imprime cuánto
 * costaría una corrida real, estimado por el largo de lo que leería el modelo.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import {
  INSTAGRAM_TEXT_BYTES,
  KAIROS_IMPROVE_TEXT_MAX,
  type KairosImproveAsk,
  type KairosImproveChannel,
  type KairosImproveResult,
  kairosAllowedFact,
  limaDate,
} from "@odentia/services"
import { AI_PRICES, costMicrosOf } from "./ai-usage.js"
import {
  createKairosWriter,
  fakeKairosWriter,
  IMPROVE_SYSTEM,
  improveHuman,
  improveInventions,
  improveSources,
  type KairosActivityEntry,
  type KairosClientFacts,
  readSummary,
  SUMMARY_FACT_KINDS,
  SUMMARY_SYSTEM,
  summaryActivityFact,
  summaryHuman,
} from "./kairos.js"
import {
  cachedPrompt,
  createConfiguredChatModel,
  platformLlmFromEnv,
  resolveLlmSpec,
} from "./llm.js"

/* ---------- El banco ---------- */

type Product = "dental" | "medical" | "optical"

interface ImproveCase {
  id: string
  canal: KairosImproveChannel
  texto: string
  conversacion?: Array<{ quien: "ellos" | "nosotros"; texto: string }>
  cliente?: string
  producto?: Product
  nota?: string
  /** Trozos que deben quedar tal cual en la propuesta. */
  conserva?: string[]
  /** Expresiones (sin mayúsculas ni tildes) que la propuesta no puede traer. */
  noDice?: string[]
  /** Ya está bien escrito: lo mejor es «igual». */
  igual?: boolean
}

interface Activity {
  tipo: string
  direccion?: "salio" | "entro"
  /** Salió por Sallca (un correo o un chat que enviamos): su texto no es un hecho de la clínica. */
  enviado?: boolean
  /** Llegó o salió por una conversación de WhatsApp, Instagram o Messenger. */
  chat?: boolean
  asunto?: string
  texto: string
  resultado?: string
  dia: string
  contacto?: string
}

interface SummaryCase {
  id: string
  nota?: string
  cliente: { nombre: string; producto: Product; cuenta: boolean; paga?: boolean }
  otros?: string[]
  contactos?: string[]
  actividades: Activity[]
  /** Expresiones (sin mayúsculas ni tildes) que ninguna frase puede afirmar como de la clínica. */
  noAfirma?: string[]
}

interface Bank {
  mejorar: ImproveCase[]
  resumen: SummaryCase[]
}

function arg(name: string, fallback: string): string {
  const found = process.argv.find((a) => a.startsWith(`--${name}=`))
  return found ? found.slice(name.length + 3) : fallback
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const bankPath = resolve(arg("file", "eval/kairos-escribe.json"))
const bank = JSON.parse(readFileSync(bankPath, "utf8")) as Bank
const platform = platformLlmFromEnv(process.env)
const fake = Boolean(platform.fake)
if (!fake && !platform.openai?.apiKey)
  throw new Error(
    "Esta medición es con el modelo real: define LLM_OPENAI_API_KEY (o LLM_MODEL=fake solo para ver que corre)",
  )
const only = arg("casos", "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
const repetitions = Math.max(1, Number(arg("repeticiones", "1")) || 1)
const withJudge = !fake && !flag("sin-juez")
const improveCases = bank.mejorar.filter((c) => only.length === 0 || only.includes(c.id))
const summaryCases = bank.resumen.filter((c) => only.length === 0 || only.includes(c.id))
const missing = only.filter(
  (id) => !bank.mejorar.some((c) => c.id === id) && !bank.resumen.some((c) => c.id === id),
)
if (missing.length) throw new Error(`No están en el banco: ${missing.join(", ")}`)

/* ---------- Lo común ---------- */

const MODEL = "gpt-6-luna"
/** Con cinco decimales: un «Mejorar» cuesta centésimas de centavo. */
const usd = (micros: number | null) =>
  micros === null ? "—" : `USD ${(micros / 1_000_000).toFixed(5)}`

/** Sin tildes ni mayúsculas, para buscar expresiones. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

interface Totals {
  calls: number
  input: number
  cached: number
  output: number
  micros: number
  /** Llamadas que no informaron su uso o sin precio: su costo no se suma (nunca un estimado). */
  noCost: number
}
const totals = (): Totals => ({ calls: 0, input: 0, cached: 0, output: 0, micros: 0, noCost: 0 })

/** Lo que reportó una respuesta de LangChain, sumado a `into`. */
function addUsage(into: Totals, reply: { usage_metadata?: unknown }): void {
  const meta = (reply.usage_metadata ?? {}) as {
    input_tokens?: number
    output_tokens?: number
    input_token_details?: { cache_read?: number; cache_creation?: number }
  }
  into.calls += 1
  into.input += meta.input_tokens ?? 0
  into.cached += meta.input_token_details?.cache_read ?? 0
  into.output += meta.output_tokens ?? 0
  const cost = costMicrosOf({
    model: MODEL,
    inputTokens: meta.input_tokens ?? null,
    cachedInputTokens: meta.input_token_details?.cache_read ?? null,
    cacheWriteTokens: meta.input_token_details?.cache_creation ?? null,
    outputTokens: meta.output_tokens ?? null,
  })
  if (cost === null) into.noCost += 1
  else into.micros += cost
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join("")
  return ""
}

const judgeModel = withJudge
  ? new ChatOpenAI({
      model: MODEL,
      apiKey: platform.openai?.apiKey,
      useResponsesApi: true,
      timeout: 120_000,
      maxRetries: 2,
      modelKwargs: { reasoning: { effort: "medium" } },
      ...(platform.openai?.baseUrl ? { configuration: { baseURL: platform.openai.baseUrl } } : {}),
    })
  : null

/** Pide al juez un JSON con esas notas de 1 a 5; dos intentos, y null si no responde bien. */
async function judge<T extends Record<string, unknown>>(
  prompt: string,
  scores: Array<keyof T>,
  into: Totals,
  id: string,
): Promise<T | null> {
  if (!judgeModel) return null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await judgeModel.invoke(prompt)
      addUsage(into, reply)
      const json = /\{[\s\S]*\}/.exec(contentText(reply.content))?.[0]
      if (!json) continue
      const parsed = JSON.parse(json) as T
      if (
        scores.every(
          (key) =>
            typeof parsed[key] === "number" &&
            (parsed[key] as number) >= 1 &&
            (parsed[key] as number) <= 5,
        )
      )
        return parsed
    } catch (error) {
      console.error(
        `  juez de ${id}: ${error instanceof Error ? error.message.slice(0, 160) : String(error)}`,
      )
    }
  }
  return null
}

const CHANNEL_WORDS: Record<KairosImproveChannel, string> = {
  correo: "correo",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
}

/**
 * Lo que cabe en cada canal, como lo dice el servidor al enviar (ADR 0196): WhatsApp 4096
 * caracteres, Messenger 2000, Instagram 1000 bytes y un correo lo que cabe en un envío.
 */
function overChannel(channel: KairosImproveChannel, text: string): boolean {
  if (channel === "instagram") return Buffer.byteLength(text, "utf8") > INSTAGRAM_TEXT_BYTES
  if (channel === "messenger") return text.length > 2000
  if (channel === "whatsapp") return text.length > 4096
  return text.length > KAIROS_IMPROVE_TEXT_MAX
}

/* ---------- Parte A: «Mejorar con Kairós» ---------- */

const MARKS: Array<[string, RegExp]> = [
  ["negrita", /\*[^*\n]+\*/g],
  ["cursiva", /(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}])/gu],
  ["tachado", /~[^~\n]+~/g],
  ["lista", /^\s*- /gm],
]
const ADDRESS =
  /\bhttps?:\/\/[^\s"<>«»]+|\bwww\.[^\s"<>«»]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu
const addressesOf = (text: string) =>
  (text.match(ADDRESS) ?? []).map((found) => found.replace(/[.,;:!?)\]»"']+$/u, ""))

/** Marcas y nombres de Sallca que pueden ir con mayúscula aunque el original no los traiga así. */
const BRANDS = new Set([
  "whatsapp",
  "instagram",
  "messenger",
  "facebook",
  "meta",
  "sallca",
  "odentia",
  "latidia",
  "vistia",
  "kairos",
  "sofi",
  "clio",
  "argos",
  "ariadna",
  "fundadores",
  "fundador",
  "excel",
  "google",
  "meet",
  "zoom",
  "configuracion",
  "agenda",
  "equipo",
  "dra",
  "dr",
  "doctora",
  "doctor",
])

/** Palabras con mayúscula en medio de una frase que no están en lo que se le dio: un nombre nuevo. */
function newNames(proposal: string, sources: string[]): string[] {
  const known = new Set(
    plain(sources.join(" "))
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  )
  const out: string[] = []
  for (const match of proposal.matchAll(/(?<=[\p{L}\p{N},;)»"*_]\s+)(\p{Lu}\p{L}+)/gu)) {
    const word = plain(match[1] ?? "")
    if (word && !known.has(word) && !BRANDS.has(word) && !out.includes(match[1] ?? ""))
      out.push(match[1] ?? "")
  }
  return out
}

interface ImproveVerdict {
  significado: number
  claridad: number
  tono: number
  comentario: string
}

interface ImproveRun {
  id: string
  canal: KairosImproveChannel
  repeticion: number
  resultado: "propuso" | KairosImproveResultWhy | "error"
  original: string
  propuesta: string | null
  /** Largo de la propuesta sobre el original. */
  largo: number | null
  problemas: string[]
  sospechas: string[]
  juez: ImproveVerdict | null
  error?: string
}
type KairosImproveResultWhy = Exclude<KairosImproveResult, { ok: true }>["why"]

const improveUse = totals()
const improveJudge = totals()
let improveAsks = 0
const writer = createKairosWriter({
  platform,
  onUse: (use) => {
    // Una por pedido: las dos llamadas de un pedido con segunda vuelta llegan sumadas.
    improveUse.calls += 1
    improveUse.input += use.inputTokens
    improveUse.cached += use.cachedTokens
    improveUse.output += use.outputTokens
    if (use.costMicros === null) improveUse.noCost += 1
    else improveUse.micros += use.costMicros
  },
})

function askOf(c: ImproveCase): KairosImproveAsk {
  return {
    text: c.texto,
    channel: c.canal,
    context: {
      conversation: (c.conversacion ?? []).map((line) => ({ who: line.quien, text: line.texto })),
      ...(c.cliente ? { clientName: c.cliente } : {}),
      ...(c.producto ? { product: c.producto } : {}),
    },
  }
}

function improveProblems(c: ImproveCase, ask: KairosImproveAsk, proposal: string): string[] {
  const out: string[] = []
  // La misma red: lo que escribió la persona y el nombre de la clínica, nunca la conversación.
  const invented = improveInventions(proposal, improveSources(ask))
  if (invented.length) out.push(`agregó datos: ${invented.join(", ")}`)
  for (const [name, re] of MARKS) {
    const before = (ask.text.match(re) ?? []).length
    const after = (proposal.match(re) ?? []).length
    if (before !== after) out.push(`${name}: ${before} en el original, ${after} en la propuesta`)
  }
  for (const address of addressesOf(ask.text))
    if (!proposal.includes(address)) out.push(`perdió o cambió ${address}`)
  // Una cifra del original que la propuesta ya no trae, ni suelta ni junto a otras
  // («999 888 777» escrito «999888777» es la misma).
  const strip = (n: string) => n.replace(/^0+(?=\d)/, "")
  const kept = new Set((proposal.match(/\d+/g) ?? []).map(strip))
  const runs = (proposal.match(/\d[\d\s.-]*\d/g) ?? []).map((n) => n.replace(/\D/g, ""))
  const lost = [...new Set((ask.text.match(/\d+/g) ?? []).map(strip))].filter(
    (n) => !kept.has(n) && !runs.some((run) => run.includes(n)),
  )
  if (lost.length) out.push(`perdió cifras: ${lost.join(", ")}`)
  const ratio = proposal.length / Math.max(1, ask.text.trim().length)
  if (ratio > 1.2)
    out.push(`creció ${Math.round((ratio - 1) * 100)} % (el prompt pide como mucho 20 %)`)
  if (overChannel(c.canal, proposal)) out.push(`no cabe en ${CHANNEL_WORDS[c.canal]}`)
  for (const piece of c.conserva ?? [])
    if (!proposal.includes(piece)) out.push(`no conservó «${piece}»`)
  for (const said of c.noDice ?? [])
    if (new RegExp(said).test(plain(proposal))) out.push(`dijo /${said}/`)
  if (c.igual) out.push("cambió un texto que ya estaba bien")
  return out
}

async function runImprove(c: ImproveCase, repetition: number): Promise<ImproveRun> {
  const ask = askOf(c)
  const base = { id: c.id, canal: c.canal, repeticion: repetition, original: c.texto }
  let result: KairosImproveResult
  improveAsks += 1
  try {
    result = await writer.improveText(ask)
  } catch (error) {
    return {
      ...base,
      resultado: "error",
      propuesta: null,
      largo: null,
      problemas: ["el modelo no respondió con la herramienta"],
      sospechas: [],
      juez: null,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    }
  }
  if (!result.ok) {
    // «igual» en un texto que lo necesitaba, o «inventaba»: no mejoró; en uno que ya estaba bien, lo esperado.
    const problems =
      result.why === "igual" && c.igual
        ? []
        : [result.why === "igual" ? "no lo mejoró (igual)" : `no propuso nada (${result.why})`]
    return {
      ...base,
      resultado: result.why,
      propuesta: null,
      largo: null,
      problemas: problems,
      sospechas: [],
      juez: null,
    }
  }
  const proposal = result.text
  // Un nombre que solo trae la conversación también es un dato copiado de ella.
  const names = newNames(proposal, improveSources(ask))
  const conversation = (ask.context?.conversation ?? [])
    .map((l) => `[${l.who}] ${l.text}`)
    .join("\n")
  const verdict = await judge<ImproveVerdict & Record<string, unknown>>(
    `Eres un corrector exigente de español de Perú. Una persona del equipo de Sallca (hace software para clínicas dentales, consultorios médicos y ópticas) escribió un mensaje para una clínica y Kairós le propuso una versión mejorada. Debía corregir la ortografía y la puntuación, hacerlo más claro y cordial y decir lo mismo con su misma voz (en primera persona, con el mismo trato de tú o de usted), conservar las marcas (*negrita*, _cursiva_, ~tachado~, listas con «- »), los enlaces y los datos, no agregar nada, tener un largo parecido y, por WhatsApp, Instagram o Messenger, ser corto como un chat.

Califica de 1 a 5, sin indulgencia (3 = aceptable con fallas, 5 = como el mejor corrector humano):
- significado: dice exactamente lo mismo que el original, sin agregar ni quitar nada, con la misma voz y el mismo trato.
- claridad: se entiende mejor que el original; ortografía, tildes y puntuación correctas.
- tono: cordial y profesional, natural para el canal.
No juzgues si los datos son verdaderos: solo si son los mismos.
Lo que se esperaba (de quien escribió el caso): ${c.nota ?? "—"}

Canal: ${CHANNEL_WORDS[c.canal]}
Conversación a la que responde (lo último al final):
${conversation || "(ninguna)"}

Original:
---
${ask.text}
---
Propuesta:
---
${proposal}
---

Devuelve solo un JSON: {"significado": n, "claridad": n, "tono": n, "comentario": "una línea"}`,
    ["significado", "claridad", "tono"],
    improveJudge,
    c.id,
  )
  return {
    ...base,
    resultado: "propuso",
    propuesta: proposal,
    largo: Number((proposal.length / Math.max(1, ask.text.trim().length)).toFixed(2)),
    problemas: improveProblems(c, ask, proposal),
    sospechas: names.length ? [`nombre nuevo: ${names.join(", ")}`] : [],
    juez: verdict,
  }
}

/* ---------- Parte B: «Lo que hay que saber», antes y ahora ---------- */

const DAY_WORDS = new Intl.DateTimeFormat("es-PE", {
  timeZone: "UTC",
  day: "numeric",
  month: "long",
  year: "numeric",
})
const dayWords = (iso: string) => DAY_WORDS.format(new Date(`${iso}T00:00:00Z`))

/** Las etiquetas de antes (`ACTIVITY_WORDS` del worker hasta el 16 nov): sin Instagram ni Messenger. */
const OLD_LABELS: Record<string, string> = {
  llamada: "Llamada",
  whatsapp: "WhatsApp",
  correo: "Correo",
  reunion: "Reunión",
  presentacion: "Presentación",
  propuesta: "Propuesta",
  nota: "Nota",
}

/** El cuerpo de la actividad como lo guarda el envío (`outreachWentOut`: el asunto y el texto). */
const storedBody = (a: Activity) => (a.asunto ? `${a.asunto}\n\n${a.texto}` : a.texto)

/** El hecho de antes (`clientSummaryFacts` hasta el 16 nov): lo que le escribimos, con su texto. */
function oldActivityFact(a: Activity): string {
  const label = OLD_LABELS[a.tipo] ?? "Actividad"
  const day = dayWords(a.dia)
  if (a.tipo === "correo" && a.direccion === "entro") return `${label} de la clínica el ${day}`
  const by = a.direccion === "entro" ? " de la clínica" : ""
  return `${label}${by} del ${day}: ${storedBody(a)}${a.resultado ? ` · quedó en: ${a.resultado}` : ""}`
}

/** El hecho de ahora, como lo arma el worker (`summaryActivityEntry` y `summaryActivityFact`). */
function newActivityFact(a: Activity): string {
  const entry: KairosActivityEntry = {
    kind: a.tipo,
    direction: a.direccion ?? null,
    outcome: a.resultado ?? null,
    body: storedBody(a),
    day: dayWords(a.dia),
    sent: a.enviado ? { subject: a.asunto ?? null } : null,
    fromChat: Boolean(a.chat),
    contactName: a.contacto ?? null,
  }
  return summaryActivityFact(entry)
}

/** Los hechos de un caso, con su fuente, por el mismo filtro que el worker (`kairosAllowedFact`). */
function factsOf(c: SummaryCase, version: "antes" | "ahora"): { text: string; source: string }[] {
  const facts: { text: string; source: string }[] = []
  const add = (text: string, source: string) => {
    const told = kairosAllowedFact(text, { adminOnly: false })
    if (told) facts.push({ text: told, source })
  }
  for (const [i, text] of (c.otros ?? []).entries()) add(text, `cliente:${i}`)
  if (c.cliente.cuenta)
    add(
      version === "antes"
        ? "Ya tiene su cuenta abierta"
        : c.cliente.paga
          ? "Ya tiene su cuenta abierta y está activa: tiene un pago confirmado"
          : "Ya tiene su cuenta abierta y está en alta: aún no tiene su primer pago confirmado",
      "cliente:cuenta",
    )
  for (const [i, text] of (c.contactos ?? []).entries()) add(text, `contacto:${i}`)
  const recent = [...c.actividades].sort((a, b) => b.dia.localeCompare(a.dia))
  for (const [i, a] of recent.entries())
    add(version === "antes" ? oldActivityFact(a) : newActivityFact(a), `actividad:${i}`)
  return facts
}

/** El prompt de antes: el de ahora sin la regla de las tres clases de hechos. */
const OLD_SUMMARY_SYSTEM = SUMMARY_SYSTEM.replace(`${SUMMARY_FACT_KINDS}\n`, "")
if (OLD_SUMMARY_SYSTEM === SUMMARY_SYSTEM)
  throw new Error(
    "No se pudo armar el prompt de antes: SUMMARY_FACT_KINDS ya no está en SUMMARY_SYSTEM",
  )

/** Decir que se lo escribimos: así una frase sobre lo nuestro no es un hecho de la clínica. */
const WE_WROTE =
  /\b(?:le|les)\s+(?:escribimos|enviamos|mandamos|contamos|avisamos|dijimos|respondimos|comentamos|informamos|pedimos|recordamos|ofrecimos|propusimos|compartimos|explicamos|anunciamos|recomendamos)\b|\b(?:sallca|nosotros|nuestro|nuestra)\b.{0,40}\b(?:escrib|envi|mand|cont|avis|anunci|inform|respond|explic)/

const STOPWORDS = new Set(
  "para desde porque cuando donde puede pueden puedes tiene tienen ahora nuestro nuestra sobre entre hasta estos estas todos todas tambien cliente clinica clinicas sallca odentia latidia vistia correo whatsapp instagram messenger mensaje escribimos escribio noviembre diciembre octubre quiere quieres hacer hacemos tienes hola gracias".split(
    " ",
  ),
)
const contentWords = (text: string) =>
  new Set(
    plain(text)
      .split(/[^\p{L}]+/u)
      .filter((w) => w.length >= 5 && !STOPWORDS.has(w)),
  )
/** Cuántas palabras de `words` comparte con el conjunto que más comparte. */
const overlap = (words: Set<string>, sets: Set<string>[]) =>
  Math.max(0, ...sets.map((set) => [...words].filter((w) => set.has(w)).length))

/**
 * Las frases del resumen que cuentan lo que le escribimos como si fuera de la clínica, sin decir
 * que se lo escribimos: dicen una expresión `noAfirma` del caso, o repiten varias palabras con
 * contenido de un mensaje nuestro (tres, o dos si la frase es corta) y no tantas de otro hecho
 * (lo que escribió la clínica, una nota del equipo, sus datos). Por palabras: una aproximación.
 */
function restatesOurs(c: SummaryCase, sentences: string[]): string[] {
  const isOurs = (a: Activity) => a.direccion === "salio" && Boolean(a.enviado)
  const ours = c.actividades.filter(isOurs).map((a) => contentWords(storedBody(a)))
  const others = [
    ...c.actividades.filter((a) => !isOurs(a)).map((a) => `${a.texto} ${a.resultado ?? ""}`),
    ...(c.otros ?? []),
    ...(c.contactos ?? []),
  ].map(contentWords)
  const flagged: string[] = []
  for (const sentence of sentences) {
    const text = plain(sentence)
    if (WE_WROTE.test(text)) continue
    const words = contentWords(sentence)
    const shared = overlap(words, ours)
    const said = (c.noAfirma ?? []).some((expression) => text.includes(expression))
    if (said || (shared >= (words.size <= 6 ? 2 : 3) && shared > overlap(words, others)))
      flagged.push(sentence)
  }
  return flagged
}

/** Un correo o un chat, de ida o de vuelta: lo que no es una nota del equipo. */
const isConversation = (a: Activity) =>
  Boolean(a.chat) || (a.tipo === "correo" && (a.direccion === "entro" || Boolean(a.enviado)))

/**
 * Las frases del resumen que traen el texto de una conversación (un correo o un chat, de ida o de
 * vuelta): el resumen lo lee también Soporte, que no ve las conversaciones (ADR 0196). Repiten
 * varias palabras con contenido de un mensaje (sin las de su asunto, que de lo nuestro sí llega;
 * tres, o dos si la frase es corta) y no tantas de lo demás. Decir que se lo escribimos no la
 * salva: el texto igual está ahí. Por palabras: una aproximación.
 */
function quotesConversation(c: SummaryCase, sentences: string[]): string[] {
  const withoutSubject = (a: Activity) => {
    const subject = contentWords(a.asunto ?? "")
    return new Set([...contentWords(a.texto)].filter((w) => !subject.has(w)))
  }
  const talks = c.actividades.filter(isConversation).map(withoutSubject)
  const others = [
    ...c.actividades
      .filter((a) => !isConversation(a))
      .map((a) => `${a.texto} ${a.resultado ?? ""}`),
    ...(c.otros ?? []),
    ...(c.contactos ?? []),
  ].map(contentWords)
  return sentences.filter((sentence) => {
    const words = contentWords(sentence)
    const shared = overlap(words, talks)
    return shared >= (words.size <= 6 ? 2 : 3) && shared > overlap(words, others)
  })
}

/** La bitácora completa del caso, con de quién es cada cosa: lo que lee el juez. */
function logbook(c: SummaryCase): string {
  return [...c.actividades]
    .sort((a, b) => a.dia.localeCompare(b.dia))
    .map((a) => {
      const day = dayWords(a.dia)
      const channel = a.tipo === "correo" ? "por correo" : `por ${OLD_LABELS[a.tipo] ?? a.tipo}`
      if (a.direccion === "salio" && a.enviado)
        return `- [le escribimos nosotros (Sallca), ${channel}, el ${day}]${a.asunto ? ` Asunto «${a.asunto}»:` : ""} ${a.texto.replace(/\s+/g, " ")}`
      if (a.direccion === "entro" && (a.tipo === "correo" || a.chat))
        return `- [nos escribió la clínica${a.contacto ? ` (${a.contacto})` : ""}, ${channel}, el ${day}] ${a.texto.replace(/\s+/g, " ")}`
      return `- [lo anotó el equipo, el ${day}] ${OLD_LABELS[a.tipo] ?? a.tipo}${a.direccion === "entro" ? " de la clínica" : ""}: ${a.texto}${a.resultado ? ` · quedó en: ${a.resultado}` : ""}`
    })
    .join("\n")
}

interface SummaryVerdict {
  fidelidad: number
  atribuyeMal: boolean
  comentario: string
}

interface SummaryVariant {
  resumen: string | null
  frases: string[]
  repiteLoNuestro: string[]
  /** Frases con el texto de un correo o un chat: Soporte lee el resumen (ADR 0196). */
  citaConversacion: string[]
  juez: SummaryVerdict | null
  error?: string
}

interface SummaryRun {
  id: string
  repeticion: number
  antes: SummaryVariant
  ahora: SummaryVariant
}

const summaryUse = totals()
const summaryJudge = totals()
const spec = fake ? null : { ...resolveLlmSpec(platform), maxRetries: 1 }
const summaryModel = spec
  ? await createConfiguredChatModel(spec, { temperature: 0, explicitCache: true })
  : null

function clientOf(c: SummaryCase): KairosClientFacts {
  return { name: c.cliente.nombre, product: c.cliente.producto, stage: "—" }
}

/**
 * Un resumen con los hechos y el prompt dados: la misma llamada que `summarizeClient` del
 * escritor (el modelo de la plataforma a temperatura 0, lo fijo marcado para la caché,
 * `summaryHuman` y `readSummary`), con el prompt cambiado para comparar.
 */
async function summarize(
  c: SummaryCase,
  facts: { text: string; source: string }[],
  system: string,
): Promise<{ summary: string; sentences: string[] }> {
  const client = clientOf(c)
  if (!summaryModel || !spec) {
    const read = await fakeKairosWriter.summarizeClient({ client, facts })
    return { summary: read.summary, sentences: [...new Set(read.sources.map((s) => s.text))] }
  }
  const reply = await summaryModel.invoke([
    new SystemMessage({ content: cachedPrompt(spec.provider, system, false) }),
    new HumanMessage({ content: summaryHuman({ client, facts }) }),
  ])
  addUsage(summaryUse, reply)
  const read = readSummary(contentText(reply.content).trim(), facts)
  return { summary: read.summary, sentences: [...new Set(read.sources.map((s) => s.text))] }
}

async function runVariant(c: SummaryCase, version: "antes" | "ahora"): Promise<SummaryVariant> {
  const facts = factsOf(c, version)
  let read: { summary: string; sentences: string[] }
  try {
    read = await summarize(c, facts, version === "antes" ? OLD_SUMMARY_SYSTEM : SUMMARY_SYSTEM)
  } catch (error) {
    return {
      resumen: null,
      frases: [],
      repiteLoNuestro: [],
      citaConversacion: [],
      juez: null,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    }
  }
  const verdict = await judge<SummaryVerdict & Record<string, unknown>>(
    `Eres un auditor exigente. Kairós escribió «Lo que hay que saber» de un cliente de Sallca (hace software para clínicas dentales, consultorios médicos y ópticas) para quien lo atiende, solo con los hechos que se le dieron. Abajo está la bitácora del cliente con de quién es cada cosa: lo que anotó el equipo, lo que nos escribió la clínica y lo que le escribimos nosotros. Lo que le escribimos cuenta qué le dijimos o pedimos; no es un hecho de la clínica. De los correos y chats Kairós recibe solo que existieron (quién, por dónde y cuándo, y de lo nuestro el asunto), nunca su texto, porque el resumen lo lee también Soporte: que no diga de qué trataron no es una falta.

Califica de 1 a 5 la fidelidad, sin indulgencia: 5 = cada frase es cierta según la bitácora y atribuye bien quién hizo o dijo qué; 1 = afirma cosas falsas o cuenta como de la clínica lo que solo le escribimos nosotros.
Di también si alguna frase cuenta como hecho de la clínica algo que solo le escribimos nosotros (atribuyeMal).

Cliente: ${c.cliente.nombre}
Bitácora (lo más viejo primero):
${logbook(c)}

Resumen de Kairós:
${read.summary}

Devuelve solo un JSON: {"fidelidad": n, "atribuyeMal": true o false, "comentario": "una línea"}`,
    ["fidelidad"],
    summaryJudge,
    `${c.id} (${version})`,
  )
  return {
    resumen: read.summary,
    frases: read.sentences,
    repiteLoNuestro: restatesOurs(c, read.sentences),
    citaConversacion: quotesConversation(c, read.sentences),
    juez: verdict,
  }
}

/* ---------- La corrida ---------- */

const improveRuns: ImproveRun[] = []
const summaryRuns: SummaryRun[] = []
for (let rep = 1; rep <= repetitions; rep++) {
  for (const c of improveCases) {
    const run = await runImprove(c, rep)
    improveRuns.push(run)
    const mark = run.problemas.length ? "✗" : run.sospechas.length ? "△" : "✓"
    const judged = run.juez
      ? ` · juez ${run.juez.significado}/${run.juez.claridad}/${run.juez.tono}`
      : ""
    console.log(`${mark} ${c.id}${repetitions > 1 ? ` #${rep}` : ""}: ${run.resultado}${judged}`)
    if (run.propuesta) console.log(`    «${run.propuesta.replace(/\n/g, "⏎").slice(0, 200)}»`)
    for (const problem of run.problemas) console.log(`    ${problem}`)
    for (const suspicion of run.sospechas) console.log(`    sospecha ${suspicion}`)
    if (run.error) console.log(`    error: ${run.error}`)
  }
  for (const c of summaryCases) {
    const run: SummaryRun = {
      id: c.id,
      repeticion: rep,
      antes: await runVariant(c, "antes"),
      ahora: await runVariant(c, "ahora"),
    }
    summaryRuns.push(run)
    const mark =
      run.ahora.repiteLoNuestro.length || run.ahora.citaConversacion.length || run.ahora.error
        ? "✗"
        : "✓"
    const score = (v: SummaryVariant) =>
      v.juez ? ` juez ${v.juez.fidelidad}${v.juez.atribuyeMal ? " (atribuye mal)" : ""}` : ""
    console.log(
      `${mark} ${c.id}${repetitions > 1 ? ` #${rep}` : ""}: antes ${run.antes.repiteLoNuestro.length} frase(s) con lo nuestro y ${run.antes.citaConversacion.length} con una conversación${score(run.antes)} → ahora ${run.ahora.repiteLoNuestro.length} y ${run.ahora.citaConversacion.length}${score(run.ahora)}`,
    )
    for (const sentence of run.ahora.repiteLoNuestro)
      console.log(`    ahora repite lo nuestro: ${sentence.slice(0, 200)}`)
    for (const sentence of run.ahora.citaConversacion)
      console.log(`    ahora trae el texto de una conversación: ${sentence.slice(0, 200)}`)
    for (const v of [run.antes, run.ahora]) if (v.error) console.log(`    error: ${v.error}`)
  }
}

/* ---------- El resumen ---------- */

const avg = <T>(items: T[], pick: (item: T) => number | null) => {
  const values = items.map(pick).filter((v): v is number => v !== null)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}
const fmt = (n: number | null) => (n === null ? "—" : n.toFixed(2))
const proposed = improveRuns.filter((r) => r.resultado === "propuso")
const byResult = (result: ImproveRun["resultado"]) =>
  improveRuns.filter((r) => r.resultado === result).length
const judgedA = improveRuns.filter((r) => r.juez)
const variants = (pick: (r: SummaryRun) => SummaryVariant) => summaryRuns.map(pick)
const flaggedOf = (vs: SummaryVariant[]) => vs.reduce((sum, v) => sum + v.repiteLoNuestro.length, 0)
const quotedOf = (vs: SummaryVariant[]) => vs.reduce((sum, v) => sum + v.citaConversacion.length, 0)
const fidelity = (vs: SummaryVariant[]) => avg(vs, (v) => v.juez?.fidelidad ?? null)
const misattributed = (vs: SummaryVariant[]) => vs.filter((v) => v.juez?.atribuyeMal).length
const before = variants((r) => r.antes)
const after = variants((r) => r.ahora)
const microsOf = (t: Totals) => (fake ? null : t.micros)
const totalMicros = fake
  ? null
  : improveUse.micros + improveJudge.micros + summaryUse.micros + summaryJudge.micros
const perImprove = fake || improveAsks === 0 ? null : improveUse.micros / improveAsks
const totalsLine = (t: Totals) =>
  fake
    ? "—"
    : `${usd(t.micros)} (${t.calls} llamadas, ${t.input} entrada, ${t.cached} de caché, ${t.output} salida${t.noCost ? `, ${t.noCost} sin costo informado` : ""})`

console.log("")
if (fake)
  console.log(
    "MODELO FALSO (LLM_MODEL=fake): los dobles por reglas, sin juez ni gasto. Esto NO cuenta como medición.",
  )
console.log(
  `Escritor: ${writer.drafter === "plantilla" ? "plantilla (fakeKairosWriter)" : `${MODEL} (AGENT_MODEL)`} · A: ${improveCases.length} mensajes × ${repetitions} · B: ${summaryCases.length} clientes × ${repetitions}, antes y ahora`,
)
console.log("")
console.log("| Medida | Valor |")
console.log("| --- | --- |")
console.log(
  `| A · Resultado | ${byResult("propuso")} propuso, ${byResult("igual")} igual, ${byResult("inventaba")} inventaba, ${byResult("vacio")} vacío, ${byResult("error")} error |`,
)
console.log(
  `| A · Con algún problema | ${improveRuns.filter((r) => r.problemas.length).length} de ${improveRuns.length} |`,
)
console.log(
  `| A · Agregó un dato (después de la red) | ${proposed.filter((r) => r.problemas.some((p) => p.startsWith("agregó datos"))).length} |`,
)
console.log(
  `| A · Perdió marcas, enlaces o cifras | ${proposed.filter((r) => r.problemas.some((p) => /^(negrita|cursiva|tachado|lista|perdió)/.test(p))).length} |`,
)
console.log(
  `| A · Creció más de 20 % | ${proposed.filter((r) => r.problemas.some((p) => p.startsWith("creció"))).length} (largo medio ${fmt(avg(proposed, (r) => r.largo))}) |`,
)
console.log(
  `| A · Sospechas (nombres nuevos) | ${improveRuns.filter((r) => r.sospechas.length).length} |`,
)
console.log(
  `| A · Juez (significado / claridad / tono) | ${withJudge ? `${fmt(avg(judgedA, (r) => r.juez?.significado ?? null))} / ${fmt(avg(judgedA, (r) => r.juez?.claridad ?? null))} / ${fmt(avg(judgedA, (r) => r.juez?.tono ?? null))} en ${judgedA.length} propuestas` : "sin juez"} |`,
)
console.log(
  `| B · Frases que repiten lo nuestro como de la clínica | antes ${flaggedOf(before)} → ahora ${flaggedOf(after)} |`,
)
console.log(
  `| B · Frases con el texto de una conversación (lo lee Soporte) | antes ${quotedOf(before)} → ahora ${quotedOf(after)} |`,
)
console.log(
  `| B · Juez (fidelidad; atribuye mal) | ${withJudge ? `antes ${fmt(fidelity(before))}; ${misattributed(before)} → ahora ${fmt(fidelity(after))}; ${misattributed(after)}` : "sin juez"} |`,
)
console.log(`| A · Gasto de «Mejorar» | ${totalsLine(improveUse)} |`)
console.log(`| A · Costo por «Mejorar» | ${perImprove === null ? "—" : usd(perImprove)} |`)
console.log(`| A · Gasto del juez | ${withJudge ? totalsLine(improveJudge) : "—"} |`)
console.log(`| B · Gasto de los resúmenes (antes y ahora) | ${totalsLine(summaryUse)} |`)
console.log(`| B · Gasto del juez | ${withJudge ? totalsLine(summaryJudge) : "—"} |`)
console.log(`| Gasto total | ${usd(totalMicros)} |`)

/* ---------- Lo que costaría una corrida real (solo con el doble) ---------- */

/** Unos 3,6 caracteres por token en español, como estima `eval:kairos-vende` el largo de su prompt. */
const CHARS_PER_TOKEN = 3.6
/** La herramienta «proponer_texto» y el armado de los mensajes, en tokens. */
const TOOL_TOKENS = 80
/** Lo que escribe el juez de razonamiento medio por llamada (medido en `eval:kairos-vende` del 16 nov: ~230). */
const JUDGE_OUTPUT = 300
const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN)

function estimate() {
  const price = AI_PRICES[MODEL]
  const cost = (input: number, output: number) =>
    Math.round(input * (price?.input ?? 0) + output * (price?.output ?? 0))
  let aIn = 0
  let aOut = 0
  let aJudgeIn = 0
  for (const c of improveCases) {
    const ask = askOf(c)
    // Una vuelta, más una segunda en uno de cada diez pedidos (lo que agrega un dato).
    const input = tokensOf(IMPROVE_SYSTEM.length + improveHuman(ask).length) + TOOL_TOKENS
    const output = tokensOf(c.texto.length * 1.15) + 20
    aIn += Math.round(input * 1.1)
    aOut += Math.round(output * 1.1)
    aJudgeIn += tokensOf(1_400 + 2 * c.texto.length + improveHuman(ask).length)
  }
  let bIn = 0
  let bOut = 0
  let bJudgeIn = 0
  for (const c of summaryCases)
    for (const version of ["antes", "ahora"] as const) {
      const facts = factsOf(c, version)
      const system = version === "antes" ? OLD_SUMMARY_SYSTEM : SUMMARY_SYSTEM
      bIn += tokensOf(system.length + summaryHuman({ client: clientOf(c), facts }).length)
      bOut += 160
      bJudgeIn += tokensOf(900 + logbook(c).length + 400)
    }
  const n = repetitions
  const aJudgeOut = improveCases.length * JUDGE_OUTPUT
  const bJudgeOut = summaryCases.length * 2 * JUDGE_OUTPUT
  const parts = {
    mejorar: { entrada: aIn * n, salida: aOut * n, micros: cost(aIn, aOut) * n },
    juezMejorar: {
      entrada: aJudgeIn * n,
      salida: aJudgeOut * n,
      micros: cost(aJudgeIn, aJudgeOut) * n,
    },
    resumen: { entrada: bIn * n, salida: bOut * n, micros: cost(bIn, bOut) * n },
    juezResumen: {
      entrada: bJudgeIn * n,
      salida: bJudgeOut * n,
      micros: cost(bJudgeIn, bJudgeOut) * n,
    },
  }
  const total = Object.values(parts).reduce((sum, part) => sum + part.micros, 0)
  return {
    partes: parts,
    totalMicros: total,
    porMejorar: improveCases.length ? Math.round(cost(aIn, aOut) / improveCases.length) : null,
  }
}

const estimated = fake ? estimate() : null
if (estimated) {
  console.log("")
  console.log(
    "Estimado de una corrida real con estos casos (sin caché, que la abarata; por el largo de lo que leería el modelo):",
  )
  for (const [name, part] of Object.entries(estimated.partes))
    console.log(
      `  ${name}: ~${part.entrada} tokens de entrada y ~${part.salida} de salida, ~${usd(part.micros)}`,
    )
  console.log(
    `  total: ~${usd(estimated.totalMicros)} · por «Mejorar»: ~${usd(estimated.porMejorar)}`,
  )
}

const day = limaDate(new Date())
const out = arg(
  "salida",
  fake
    ? join(tmpdir(), `kairos-escribe-${day}-fake.json`)
    : resolve("eval/kairos-escribe-mediciones", `${day}.json`),
)
mkdirSync(resolve(out, ".."), { recursive: true })
writeFileSync(
  out,
  `${JSON.stringify(
    {
      fecha: new Date().toISOString(),
      escritor: writer.drafter ?? "modelo",
      cuenta: !fake,
      banco: bankPath,
      repeticiones: repetitions,
      resumen: {
        mejorar: {
          pedidos: improveRuns.length,
          propuso: byResult("propuso"),
          igual: byResult("igual"),
          inventaba: byResult("inventaba"),
          vacio: byResult("vacio"),
          error: byResult("error"),
          conProblemas: improveRuns
            .filter((r) => r.problemas.length)
            .map((r) => `${r.id}#${r.repeticion}`),
          juez: withJudge
            ? {
                significado: avg(judgedA, (r) => r.juez?.significado ?? null),
                claridad: avg(judgedA, (r) => r.juez?.claridad ?? null),
                tono: avg(judgedA, (r) => r.juez?.tono ?? null),
                propuestas: judgedA.length,
              }
            : null,
        },
        resumen: {
          frasesConLoNuestro: { antes: flaggedOf(before), ahora: flaggedOf(after) },
          juez: withJudge
            ? {
                antes: { fidelidad: fidelity(before), atribuyeMal: misattributed(before) },
                ahora: { fidelidad: fidelity(after), atribuyeMal: misattributed(after) },
              }
            : null,
        },
        gasto: {
          mejorar: fake ? null : { ...improveUse, micros: microsOf(improveUse) },
          porMejorarMicros: perImprove,
          juezMejorar: withJudge ? { ...improveJudge } : null,
          resumen: fake ? null : { ...summaryUse },
          juezResumen: withJudge ? { ...summaryJudge } : null,
          totalMicros,
        },
        estimadoReal: estimated,
      },
      mejorar: improveRuns,
      resumenes: summaryRuns,
    },
    null,
    1,
  )}\n`,
)
console.log("")
console.log(`Resultado: ${out}`)
