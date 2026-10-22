import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  AGENT_BASE_PRINCIPLES,
  DICTATION_CHARS,
  DICTATION_MAX_SUGGESTIONS,
  DICTATION_OPERATION,
  DICTATION_SOURCE_CHARS,
  type DiagnosisSystemKey,
  type DictationDraft,
  findingDiagnosisCode,
  getDictationCatalog,
  getOrgLocale,
  operationAgentSchema,
  ServiceError,
} from "@odentia/services"
import { z } from "zod"
import { reportReplyUse } from "../ai-usage.js"
import { createConfiguredChatModel, type LlmSpec, resolveLlmSpec } from "../llm.js"
import type { AgentRuntime } from "../run.js"

/**
 * Clío, el asistente clínico: convierte lo que el odontólogo dicta en sugerencias para
 * la atención. No guarda nada ni decide nada: devuelve borradores de registros
 * que el servicio valida y que solo entran a la historia si el odontólogo los
 * confirma. El esquema de lo que puede llenar sale de la declaración de campos
 * de cada operación de la atención: un campo nuevo ahí aparece aquí solo.
 *
 * El esquema es lo que se le pide al modelo y es fijo, porque va en la parte
 * que el proveedor guarda en caché. Sus topes son los del servicio (lo que
 * guarda de un tramo y de cada cita) y le sirven de guía: si el modelo se pasa,
 * la pausa no se rechaza entera, porque `readDictation` lee cada parte por
 * separado.
 */
const said = z.string().max(DICTATION_SOURCE_CHARS).optional().describe("El fragmento del dictado, tal cual, del que sale este registro.")
/**
 * Corregir y quitar cambian sugerencias que ya estaban: la guía es de 10 por
 * pausa. Con 40, ChatGPT 6 llegó a corregir las 40 pendientes en un
 * odontograma y su salida subió de unos 1 500 a 6 000 tokens (medido el
 * 2026-10-17). Más que esto en una pausa no se aplica (`readDictation`).
 */
const VOICE_EDITS_HINT = 10

export const extraction = z.object({
  nota: operationAgentSchema("atencion.nota")
    .extend({ dicho: said })
    .optional()
    .describe("Los textos de la consulta que se dictaron. Omite los que no se dijeron."),
  diagnosticos: z
    .array(operationAgentSchema("atencion.diagnostico").extend({ dicho: said }))
    .max(DICTATION_MAX_SUGGESTIONS)
    .default([])
    .describe("Un elemento por cada diagnóstico que nombró el odontólogo."),
  indicaciones: z
    .array(operationAgentSchema("plan.indicacion").extend({ dicho: said }))
    .max(DICTATION_MAX_SUGGESTIONS)
    .default([])
    .describe("Un elemento por cada tratamiento que indicó para el plan."),
  controles: z
    .array(operationAgentSchema("control.crear").extend({ dicho: said }))
    .max(DICTATION_MAX_SUGGESTIONS)
    .default([])
    .describe("Un elemento por cada control que pidió."),
  // Los campos de una corrección son los de la operación de esa sugerencia: el servicio los valida, aquí no se declaran.
  correcciones: z
    .array(
      z.object({
        sugerencia: z.number().int().min(1).describe("El número de la sugerencia pendiente que corrige."),
        cambios: z.record(z.string(), z.unknown()).describe("Solo los campos que cambian, con los mismos nombres que al registrarla (por ejemplo, toothNumber)."),
        dicho: said,
      }),
    )
    .max(VOICE_EDITS_HINT)
    .default([])
    .describe("Correcciones que dijo sobre sugerencias pendientes ya numeradas. Vacío si no corrigió ninguna."),
  quitar: z
    .array(z.object({ sugerencia: z.number().int().min(1).describe("El número de la sugerencia pendiente que pidió quitar."), dicho: said }))
    .max(VOICE_EDITS_HINT)
    .default([])
    .describe("Sugerencias pendientes que pidió quitar. Vacío si no pidió quitar ninguna."),
})

const TOOL_NAME = "registrar_dictado"

export function systemPrompt(input: { services: string[]; diagnosisList: string }): string {
  return [
    "Eres el asistente clínico de una clínica dental. El odontólogo dicta mientras atiende y tú ordenas lo dictado en registros para que él los revise.",
    `Principios que no cambian: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    "Registra solo lo que el odontólogo dijo. No añadas diagnósticos, piezas, superficies ni tratamientos que no nombró, ni completes lo que falta con lo que sería habitual.",
    "Si se corrige («en la veinticinco… no, es la veintiséis»), vale lo último que dijo. Si pide quitar algo («quita la endodoncia»), no lo registres.",
    "Si recibes sugerencias pendientes numeradas y lo nuevo corrige o quita una de ellas, usa `correcciones` o `quitar` con su número en vez de registrarla otra vez. Lo marcado como ya ordenado sirve para entender lo nuevo: no lo registres de nuevo.",
    "Las piezas van en numeración FDI como número (dieciséis = 16, cuarenta y seis = 46).",
    `Los diagnósticos van con su código de la lista de la clínica, la ${input.diagnosisList}. No uses códigos de otra lista ni los conviertas de una a otra.`,
    "En las indicaciones, pon en `service` la prestación con las palabras del odontólogo: el sistema la busca en los servicios de la clínica. No inventes precios.",
    input.services.length
      ? `Servicios de la clínica, para reconocer de qué prestación habla: ${input.services.slice(0, 200).join("; ")}.`
      : "La clínica aún no tiene servicios.",
    "La fecha de hoy llega con lo dictado. Un control «en seis meses» se cuenta desde esa fecha.",
    `Responde únicamente llamando a ${TOOL_NAME}, una sola vez, con todo lo dictado.`,
  ].join("\n")
}

/**
 * Cómo se marca el fin de la parte fija para la caché del proveedor. OpenAI
 * admite el corte en Chat Completions; con `explicitCache`
 * (`createConfiguredChatModel`) guarda solo hasta ahí y no escribe, además, lo
 * de cada pausa, que nunca se vuelve a leer.
 */
const CACHE_MARK: Partial<Record<LlmSpec["provider"], Record<string, unknown>>> = {
  openai: { prompt_cache_breakpoint: { mode: "explicit" } },
}

/** Lo que se le pregunta al modelo en una pausa del dictado, con lo de la clínica ya leído. */
export interface DictationAsk {
  provider: LlmSpec["provider"]
  services: string[]
  diagnosisList: string
  zone: { locale: string; timezone: string }
  now: Date
  transcript: string
  /** Lo último ya ordenado de este dictado: ayuda a entender lo nuevo y no se registra otra vez. */
  context: string
  pending: DictationPending[]
}

/**
 * Los mensajes de una pausa. La parte fija (instrucciones y servicios; las
 * herramientas van antes) es igual en toda la atención y va marcada para la
 * caché del proveedor: la primera pausa la escribe y las siguientes la leen a
 * la décima parte. Lo que cambia en cada pausa (la fecha, lo ya ordenado, lo
 * pendiente y lo nuevo) va después, en el mensaje de la pausa. Con la hora en
 * las instrucciones, cada pausa escribía la caché y no la leía nunca (medido
 * el 2026-10-17, ADR 0012).
 */
export function dictationMessages(input: DictationAsk): BaseMessage[] {
  const fixed = systemPrompt({ services: input.services, diagnosisList: input.diagnosisList })
  const mark = CACHE_MARK[input.provider]
  const today = new Intl.DateTimeFormat(input.zone.locale, { timeZone: input.zone.timezone, dateStyle: "full" }).format(input.now)
  const context = input.context.trim().slice(-600)
  const human = [
    `Hoy es ${today}, ${input.now.toISOString()} (zona ${input.zone.timezone}).`,
    context ? `Ya ordenado antes en este dictado (no lo registres otra vez):\n«${context}»` : "",
    input.pending.length ? `Sugerencias pendientes de este dictado:\n${input.pending.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}` : "",
    `Lo nuevo que dictó:\n«${input.transcript}»`,
  ]
    .filter(Boolean)
    .join("\n\n")
  return [
    new SystemMessage({ content: mark ? [{ type: "text", text: fixed, ...mark }] : fixed }),
    new HumanMessage({ content: human }),
  ]
}

const loose = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim()

/**
 * El fragmento que el modelo dice haber oído solo vale si de verdad está en lo
 * dictado: la pantalla lo muestra como «lo que dijiste» y lo resalta. Lo que no
 * aparece tal cual se descarta, frase por frase; nunca se muestra una cita
 * que el odontólogo no dijo.
 */
export function groundSource(said: string | undefined, transcript: string): string {
  const fragment = (said ?? "").trim()
  if (!fragment) return ""
  const heard = loose(transcript)
  if (heard.includes(loose(fragment))) return fragment
  return fragment
    .split(/(?<=[.;!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 3 && heard.includes(loose(sentence)))
    .join(" ")
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const blank = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim())

/** Cada bloque de registros de la respuesta, en el orden en que se guardan. */
const DRAFT_PARTS = [
  { key: "diagnosticos", kind: "diagnostico" },
  { key: "indicaciones", kind: "plan" },
  { key: "controles", kind: "control" },
] as const

/**
 * Lee la respuesta del modelo parte por parte, para que lo que no cabe en el
 * esquema no bote la pausa entera:
 * - «lo que dijiste» se acepta aunque sea largo si de verdad se dijo
 *   (`groundSource`); el servicio guarda sus primeros caracteres;
 * - un registro con un dato que no encaja en su operación llega igual, solo
 *   con los campos de esa operación, y el servicio lo deja por revisar;
 * - lo que no se puede usar se cuenta en `omitted` para avisar al odontólogo:
 *   un registro sin ningún dato, una corrección o un «quita» con un número que
 *   no está entre las pendientes (no se adivina a cuál se refería) y lo que
 *   pasa de lo que el servicio guarda de un tramo.
 * Corregir y quitar cambian lo que ya estaba, así que se les cree menos: un
 * «quita» sin lo que el odontólogo dijo para pedirlo no se aplica, y si en una
 * pausa llegan más correcciones o «quita» que los que pide el esquema, no se
 * aplica ninguno. Medido el 2026-10-17: las cuatro veces que llegaron más de
 * 10 «quita» (20, 20, 30 y 40; los 40, en una pausa de charla y sin cita)
 * eran sugerencias que nadie pidió quitar. Lo que no se aplica se queda
 * pendiente, a la vista, y se cuenta.
 * Solo una respuesta que no es un objeto no se puede leer: `null`.
 */
export function readDictation(args: unknown, transcript: string, pendingCount: number): Omit<DictationExtraction, "model"> | null {
  if (!isRecord(args)) return null
  let omitted = 0
  const items = (value: unknown): unknown[] => {
    if (blank(value)) return []
    if (Array.isArray(value)) return value
    omitted += 1
    return []
  }
  const quote = (item: Record<string, unknown>) => groundSource(typeof item["dicho"] === "string" ? item["dicho"] : undefined, transcript)
  /** Solo los campos de su operación: la cita y lo que el modelo agregue de más no llegan al servicio. */
  const fields = (kind: DictationDraft["kind"], item: Record<string, unknown>): Record<string, unknown> => {
    const schema = operationAgentSchema(DICTATION_OPERATION[kind])
    const parsed = schema.safeParse(item)
    if (parsed.success) return parsed.data as Record<string, unknown>
    return Object.fromEntries(Object.entries(item).filter(([key, value]) => key in schema.shape && !blank(value)))
  }
  // El modelo a veces escribe el número entre comillas («"3"»): es el mismo número.
  const pendingIndex = (value: unknown): number | null => {
    const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value
    return typeof number === "number" && Number.isInteger(number) && number >= 1 && number <= pendingCount ? number - 1 : null
  }

  const drafts: DictationDraft[] = []
  const nota = args["nota"]
  if (isRecord(nota)) {
    const payload = fields("nota", nota)
    if (Object.values(payload).some((value) => typeof value === "string" && value.trim())) drafts.push({ kind: "nota", payload, sourceText: quote(nota) })
    else if (Object.values(payload).some((value) => !blank(value))) omitted += 1
  } else if (!blank(nota)) omitted += 1
  for (const part of DRAFT_PARTS) {
    for (const item of items(args[part.key])) {
      const payload = isRecord(item) ? fields(part.kind, item) : {}
      if (!isRecord(item) || Object.keys(payload).length === 0) omitted += 1
      else drafts.push({ kind: part.kind, payload, sourceText: quote(item) })
    }
  }

  const corrections: DictationExtraction["corrections"] = []
  for (const item of items(args["correcciones"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    if (!isRecord(item) || index === null || !isRecord(item["cambios"])) omitted += 1
    else corrections.push({ index, changes: item["cambios"], sourceText: quote(item) })
  }
  const removals: DictationExtraction["removals"] = []
  for (const item of items(args["quitar"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    const sourceText = isRecord(item) ? quote(item) : ""
    // Quitar es lo único que descarta: sin lo que dijo para pedirlo, la sugerencia se queda.
    if (index === null || !sourceText) omitted += 1
    else removals.push({ index, sourceText })
  }

  const voice = <T>(list: T[]) => {
    if (list.length <= VOICE_EDITS_HINT) return list
    omitted += list.length
    return []
  }
  const kept = drafts.slice(0, DICTATION_MAX_SUGGESTIONS)
  omitted += drafts.length - kept.length
  return { drafts: kept, corrections: voice(corrections), removals: voice(removals), omitted }
}

/* ---------- Modo de demostración: sin proveedor real ---------- */

const UNITS: Record<string, number> = { uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8 }
const TENS: Record<string, number> = { diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80 }
const TEENS: Record<string, number> = { once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18 }
const SURFACES = ["oclusal", "mesial", "distal", "vestibular", "palatina", "lingual"]

const plain = (text: string) => text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")

/** Pieza FDI nombrada en una frase, en cifras o en palabras («veintiséis», «cuarenta y seis»). */
function toothIn(sentence: string): number | null {
  const text = plain(sentence)
  const digits = /\b([1-8][1-8])\b/.exec(text)
  if (digits) return Number(digits[1])
  for (const [word, value] of Object.entries(TEENS)) if (text.includes(word)) return value
  const joined = /\bveinti(uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\b/.exec(text)
  if (joined?.[1]) return 20 + (UNITS[joined[1]] ?? 0)
  const spaced = /\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta) y (uno|una|dos|tres|cuatro|cinco|seis|siete|ocho)\b/.exec(text)
  if (spaced?.[1] && spaced[2]) return (TENS[spaced[1]] ?? 0) + (UNITS[spaced[2]] ?? 0)
  return null
}

/**
 * Extracción por reglas para `LLM_MODEL=fake`: reconoce prestaciones de la
 * clínica por su nombre, «caries», un control «en N meses» y poco más. Sirve
 * para ver el recorrido completo sin proveedor; no acredita cómo entiende un
 * dictado un modelo real.
 */
export function demoExtraction(
  transcript: string,
  services: string[],
  now: Date,
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): DictationDraft[] {
  const sentences = transcript.split(/(?<=[.;!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)
  const drafts: DictationDraft[] = []
  const nota: Record<string, string> = {}
  const noteSource: string[] = []
  for (const sentence of sentences) {
    const text = plain(sentence)
    if (!nota["reason"] && /\b(motivo|viene por|refiere|acude por|dolor)\b/.test(text)) {
      nota["reason"] = sentence
      noteSource.push(sentence)
    } else if (!nota["evolution"] && /\b(se realizo|se realiza|evolucion|se coloco|tolero)\b/.test(text)) {
      nota["evolution"] = sentence
      noteSource.push(sentence)
    }
    if (/\bcaries\b/.test(text)) {
      const tooth = toothIn(sentence)
      drafts.push({
        kind: "diagnostico",
        payload: {
          diagnosisCode: findingDiagnosisCode(diagnosisSystem, "caries", /dentina/.test(text) ? "dentin" : null) ?? "",
          diagnosisType: "provisional",
          ...(tooth ? { toothNumber: tooth } : {}),
        },
        sourceText: sentence,
      })
    }
    for (const name of services) {
      const key = plain(name).split(" ").filter((word) => word.length >= 4)[0]
      if (!key || !text.includes(key)) continue
      const tooth = toothIn(sentence)
      const surfaces = SURFACES.filter((surface) => text.includes(surface))
      drafts.push({
        kind: "plan",
        payload: { service: name, ...(tooth ? { toothNumber: tooth } : {}), ...(surfaces.length ? { surfaces } : {}) },
        sourceText: sentence,
      })
    }
    const control = /control en (\d+|un|una|dos|tres|cuatro|cinco|seis) (meses|mes|semanas|semana)/.exec(text)
    if (control?.[1] && control[2]) {
      const amount = /^\d+$/.test(control[1]) ? Number(control[1]) : (UNITS[control[1]] ?? (control[1] === "un" ? 1 : 1))
      const due = new Date(now)
      if (control[2].startsWith("mes")) due.setMonth(due.getMonth() + amount)
      else due.setDate(due.getDate() + amount * 7)
      drafts.push({
        kind: "control",
        payload: { title: `Control en ${amount} ${control[2]}`, dueAt: due.toISOString() },
        sourceText: sentence,
      })
    }
  }
  if (Object.keys(nota).length) drafts.unshift({ kind: "nota", payload: nota, sourceText: noteSource.join(" ") })
  return drafts
}

/** Una sugerencia que sigue sin decidir, como se le nombra al asistente; su posición es su número. */
export interface DictationPending {
  label: string
}

export interface DictationExtraction {
  drafts: DictationDraft[]
  /** Correcciones dichas sobre sugerencias pendientes; `index` es la posición en `pending`. */
  corrections: Array<{ index: number; changes: Record<string, unknown>; sourceText: string }>
  /** Sugerencias pendientes que pidió quitar, por su posición en `pending`. */
  removals: Array<{ index: number; sourceText: string }>
  /** Partes de la respuesta que no se pudieron usar (`readDictation`): se le avisa al odontólogo. */
  omitted: number
  model: string
}

/**
 * Lo mismo que `demoExtraction` cuando el odontólogo sigue dictando: además
 * reconoce «no, es la veintiséis» (cambia la pieza de la última sugerencia) y
 * «quita la endodoncia» (descarta la pendiente que lleva esa palabra).
 */
export function demoSegment(
  transcript: string,
  services: string[],
  now: Date,
  pending: DictationPending[],
  diagnosisSystem: DiagnosisSystemKey = "ICD-10",
): Omit<DictationExtraction, "model"> {
  // Una frase que corrige o quita algo no es, además, un registro nuevo («quita la endodoncia»).
  const order = (sentence: string) => /^(no,? es |quita)/.test(plain(sentence))
  const drafts = demoExtraction(transcript, services, now, diagnosisSystem).filter((draft) => !order(draft.sourceText ?? ""))
  const corrections: DictationExtraction["corrections"] = []
  const removals: DictationExtraction["removals"] = []
  for (const sentence of transcript.split(/(?<=[.;!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean)) {
    const text = plain(sentence)
    const fix = /^no,? es (?:en )?la\b/.test(text) ? toothIn(sentence) : null
    if (fix) {
      // Lo último que se dijo: una sugerencia de este mismo tramo o, si no hay, la última pendiente.
      const last = [...drafts].reverse().find((draft) => draft.kind === "plan" || draft.kind === "diagnostico")
      if (last) last.payload = { ...last.payload, toothNumber: fix }
      else if (pending.length) corrections.push({ index: pending.length - 1, changes: { toothNumber: fix }, sourceText: sentence })
      continue
    }
    const drop = /^quita(?:r)? (?:la |el |los |las )?([a-z]{4,})/.exec(text)
    if (drop?.[1]) {
      const word = drop[1]
      const index = pending.findIndex((item) => plain(item.label).includes(word))
      if (index >= 0) removals.push({ index, sourceText: sentence })
    }
  }
  return { drafts, corrections, removals, omitted: 0 }
}

/**
 * Ordena un dictado en sugerencias. Lee la configuración y el tarifario de la
 * clínica; no escribe nada. El texto del dictado viaja al proveedor del modelo
 * que la clínica eligió, con la cuenta de odentIA.
 */
export async function extractDictation(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel">,
  input: {
    orgId: string
    transcript: string
    /** Lo último que ya se ordenó de este dictado: ayuda a entender lo nuevo y no se registra otra vez. */
    context?: string | undefined
    /** Sugerencias de este dictado que el odontólogo aún no decide, para corregirlas o quitarlas por voz. */
    pending?: DictationPending[] | undefined
  },
): Promise<DictationExtraction> {
  const transcript = input.transcript.trim()
  if (transcript.length < 3) throw new ServiceError("VALIDATION", 400, "Dicta o escribe algo para ordenar")
  if (transcript.length > DICTATION_CHARS) {
    throw new ServiceError("VALIDATION", 400, `El dictado admite hasta ${DICTATION_CHARS} caracteres por vez; termina y sigue con otro`)
  }
  const { spec, services, diagnosisSystem, zone } = await withOrgContext(db, input.orgId, async (tx) => {
    const catalog = await getDictationCatalog(tx, input.orgId)
    return {
      spec: resolveLlmSpec(deps.platform),
      services: catalog.services.map((service) => service.name),
      diagnosisSystem: catalog.diagnosisSystem,
      zone: await getOrgLocale(tx, input.orgId),
    }
  })
  const now = new Date()
  const pending = (input.pending ?? []).slice(0, 40)
  if (spec.provider === "fake" && !deps.createModel) return { ...demoSegment(transcript, services, now, pending, diagnosisSystem.key), model: spec.modelName }

  const record = tool(async () => "registrado", {
    name: TOOL_NAME,
    description: "Registra, de una sola vez, todo lo que el odontólogo dictó, ordenado por bloques de la atención.",
    schema: extraction,
  })
  const model = deps.createModel ? await deps.createModel(spec) : await createConfiguredChatModel(spec, { explicitCache: true })
  const bound = (model as unknown as { bindTools?: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools
    ? (model as unknown as { bindTools: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools([record])
    : model
  const reply = await bound.invoke(
    dictationMessages({
      provider: spec.provider,
      services,
      diagnosisList: diagnosisSystem.title,
      zone,
      now,
      transcript,
      context: input.context ?? "",
      pending,
    }),
  )
  reportReplyUse(spec.provider, spec.modelName, reply)
  const call = reply instanceof AIMessage || "tool_calls" in reply ? (reply as AIMessage).tool_calls?.find((item) => item.name === TOOL_NAME) : undefined
  const read = call ? readDictation(call.args, transcript, pending.length) : null
  if (!read) {
    // El proveedor respondió, pero no con algo que se pueda ordenar: no se inventa nada.
    throw new ServiceError("DICTATION_UNREADABLE", 502, "El asistente no pudo ordenar ese dictado. Vuelve a intentarlo o regístralo a mano.")
  }
  return { ...read, model: spec.modelName }
}
