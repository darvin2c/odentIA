import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import {
  DICTATION_MAX_SUGGESTIONS,
  DICTATION_OPERATION,
  DICTATION_SOURCE_CHARS,
  type DiagnosisSystemKey,
  type DictationDraft,
  operationAgentSchema,
} from "@odentia/services"
import { z } from "zod"
import { reportReplyUse } from "./ai-usage.js"
import type { LlmSpec } from "./llm.js"

/**
 * Clío, el asistente clínico: convierte lo que el profesional dicta en
 * sugerencias para la atención. No guarda nada ni decide nada: devuelve
 * borradores de registros que el servicio valida y que solo entran a la
 * historia si el profesional los confirma. El esquema de lo que puede llenar
 * sale de la declaración de campos de cada operación de la atención: un campo
 * nuevo ahí aparece aquí solo.
 *
 * Esto es lo común (ADR 0079): los mensajes de cada pausa, la lectura de la
 * respuesta y la llamada al modelo. El prompt, el esquema y el doble de
 * demostración son de cada producto (`DictationProfile`; odentIA:
 * `dental/dictation.ts`), y `extract-dictation.ts` elige el de la clínica.
 *
 * El esquema es lo que se le pide al modelo y es fijo, porque va en la parte
 * que el proveedor guarda en caché. Sus topes son los del servicio (lo que
 * guarda de un tramo y de cada cita) y le sirven de guía: si el modelo se pasa,
 * la pausa no se rechaza entera, porque `readDictation` lee cada parte por
 * separado.
 */
export const dictationSaid = z
  .string()
  .max(DICTATION_SOURCE_CHARS)
  .optional()
  .describe("El fragmento del dictado, tal cual, del que sale este registro.")
/**
 * Corregir y quitar cambian sugerencias que ya estaban: la guía es de 10 por
 * pausa. Con 40, ChatGPT 6 llegó a corregir las 40 pendientes en un
 * odontograma y su salida subió de unos 1 500 a 6 000 tokens (medido el
 * 2026-10-17). Más que esto en una pausa no se aplica (`readDictation`).
 */
const VOICE_EDITS_HINT = 10

/** Una lista de registros de una operación, con la frase de la que sale cada uno. */
export function dictationList(
  operation: Parameters<typeof operationAgentSchema>[0],
  describe: string,
  words?: Parameters<typeof operationAgentSchema>[1],
) {
  return dictationItems(operationAgentSchema(operation, words), describe)
}

/** Lo mismo con el esquema ya armado (latidIA: un diagnóstico sin pieza ni caras). */
export function dictationItems(schema: z.ZodObject, describe: string) {
  return z.array(schema.extend({ dicho: dictationSaid })).max(DICTATION_MAX_SUGGESTIONS).default([]).describe(describe)
}

/**
 * Corregir y quitar sugerencias pendientes, igual en todo producto. Los campos
 * de una corrección son los de la operación de esa sugerencia: el servicio los
 * valida, aquí no se declaran. `example`: un campo del producto para el ejemplo.
 */
export function dictationEdits(example: string) {
  return {
    correcciones: z
      .array(
        z.object({
          sugerencia: z
            .number()
            .int()
            .min(1)
            .describe("El número de la sugerencia pendiente que corrige."),
          cambios: z
            .record(z.string(), z.unknown())
            .describe(
              `Solo los campos que cambian, con los mismos nombres que al registrarla (por ejemplo, ${example}).`,
            ),
          dicho: dictationSaid,
        }),
      )
      .max(VOICE_EDITS_HINT)
      .default([])
      .describe(
        "Correcciones que dijo sobre sugerencias pendientes ya numeradas. Vacío si no corrigió ninguna.",
      ),
    quitar: z
      .array(
        z.object({
          sugerencia: z
            .number()
            .int()
            .min(1)
            .describe("El número de la sugerencia pendiente que pidió quitar."),
          dicho: dictationSaid,
        }),
      )
      .max(VOICE_EDITS_HINT)
      .default([])
      .describe("Sugerencias pendientes que pidió quitar. Vacío si no pidió quitar ninguna."),
  }
}

export const DICTATION_TOOL = "registrar_dictado"

/**
 * El dictado de un producto: qué le pide al modelo y cómo se ordena sin él.
 * La consulta (`nota`), las correcciones y los «quita» son de todos; cada
 * producto suma sus listas (odentIA: el odontograma, los diagnósticos, el
 * plan, la receta y los controles).
 */
export interface DictationProfile {
  /** El esquema de la herramienta: `nota`, las listas de `parts` y `dictationEdits`. */
  extraction: z.ZodObject
  /**
   * Cada parte de la respuesta y su clase de sugerencia, en el orden en que se
   * guardan. Una parte es una lista; con `single`, una sola entrada (latidIA:
   * los signos vitales, el descanso).
   */
  parts: ReadonlyArray<{ key: string; kind: DictationDraft["kind"]; single?: true }>
  /** Lo que dice la herramienta al modelo. */
  toolDescription: string
  /** Las instrucciones fijas, con lo de la clínica que no cambia en la atención. */
  systemPrompt(input: { services: string[]; diagnosisList: string; catalog: string }): string
  /** Si el modelo piensa antes de ordenar (`createConfiguredChatModel`); sin él, responde de inmediato. */
  reasoning?: "low" | "medium" | "high"
  /** El doble de `LLM_MODEL=fake`: por reglas, para ver el recorrido sin proveedor; no mide nada. */
  demoSegment(
    transcript: string,
    services: string[],
    now: Date,
    pending: DictationPending[],
    diagnosisSystem: DiagnosisSystemKey,
  ): Omit<DictationExtraction, "model">
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
  /** Lo que el producto le da al asistente (odentIA: los hallazgos que se dictan). */
  catalog: string
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
export function dictationMessages(input: DictationAsk, profile: DictationProfile): BaseMessage[] {
  const fixed = profile.systemPrompt({
    services: input.services,
    diagnosisList: input.diagnosisList,
    catalog: input.catalog,
  })
  const mark = CACHE_MARK[input.provider]
  const today = new Intl.DateTimeFormat(input.zone.locale, {
    timeZone: input.zone.timezone,
    dateStyle: "full",
  }).format(input.now)
  const context = input.context.trim().slice(-600)
  const human = [
    `Hoy es ${today}, ${input.now.toISOString()} (zona ${input.zone.timezone}).`,
    context ? `Ya ordenado antes en este dictado (no lo registres otra vez):\n«${context}»` : "",
    input.pending.length
      ? `Sugerencias pendientes de este dictado:\n${input.pending.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}`
      : "",
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
 * que el profesional no dijo.
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const blank = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && !value.trim())

/**
 * Lee la respuesta del modelo parte por parte, para que lo que no cabe en el
 * esquema no bote la pausa entera:
 * - «lo que dijiste» se acepta aunque sea largo si de verdad se dijo
 *   (`groundSource`); el servicio guarda sus primeros caracteres;
 * - un registro con un dato que no encaja en su operación llega igual, solo
 *   con los campos de esa operación, y el servicio lo deja por revisar;
 * - lo que no se puede usar se cuenta en `omitted` para avisar al profesional:
 *   un registro sin ningún dato, una corrección o un «quita» con un número que
 *   no está entre las pendientes (no se adivina a cuál se refería) y lo que
 *   pasa de lo que el servicio guarda de un tramo. La frase que lo pidió, si
 *   de verdad se dijo, va en `unused`: la pantalla la muestra tal cual.
 * Corregir y quitar cambian lo que ya estaba, así que se les cree menos: un
 * «quita» sin lo que el profesional dijo para pedirlo no se aplica, y si en una
 * pausa llegan más correcciones o «quita» que los que pide el esquema, no se
 * aplica ninguno. Medido el 2026-10-17: las cuatro veces que llegaron más de
 * 10 «quita» (20, 20, 30 y 40; los 40, en una pausa de charla y sin cita)
 * eran sugerencias que nadie pidió quitar. Lo que no se aplica se queda
 * pendiente, a la vista, y se cuenta.
 * Solo una respuesta que no es un objeto no se puede leer: `null`.
 */
export function readDictation(
  args: unknown,
  transcript: string,
  pendingCount: number,
  parts: DictationProfile["parts"],
): Omit<DictationExtraction, "model"> | null {
  if (!isRecord(args)) return null
  let omitted = 0
  const unused: string[] = []
  const items = (value: unknown): unknown[] => {
    if (blank(value)) return []
    if (Array.isArray(value)) return value
    omitted += 1
    return []
  }
  const quote = (item: Record<string, unknown>) =>
    groundSource(typeof item["dicho"] === "string" ? item["dicho"] : undefined, transcript)
  /** Algo que no se pudo usar: se cuenta y, si se sabe qué frase lo pidió, se guarda para mostrarla. */
  const skip = (item: unknown) => {
    omitted += 1
    const said = isRecord(item) ? quote(item) : ""
    if (said && !unused.includes(said)) unused.push(said)
  }
  /** Solo los campos de su operación: la cita y lo que el modelo agregue de más no llegan al servicio. */
  const fields = (
    kind: DictationDraft["kind"],
    item: Record<string, unknown>,
  ): Record<string, unknown> => {
    const schema = operationAgentSchema(DICTATION_OPERATION[kind])
    const parsed = schema.safeParse(item)
    if (parsed.success) return parsed.data as Record<string, unknown>
    return Object.fromEntries(
      Object.entries(item).filter(([key, value]) => key in schema.shape && !blank(value)),
    )
  }
  // El modelo a veces escribe el número entre comillas («"3"»): es el mismo número.
  const pendingIndex = (value: unknown): number | null => {
    const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value
    return typeof number === "number" &&
      Number.isInteger(number) &&
      number >= 1 &&
      number <= pendingCount
      ? number - 1
      : null
  }

  const drafts: DictationDraft[] = []
  const nota = args["nota"]
  if (isRecord(nota)) {
    const payload = fields("nota", nota)
    if (Object.values(payload).some((value) => typeof value === "string" && value.trim()))
      drafts.push({ kind: "nota", payload, sourceText: quote(nota) })
    else if (Object.values(payload).some((value) => !blank(value))) skip(nota)
  } else if (!blank(nota)) omitted += 1
  for (const part of parts) {
    const value = args[part.key]
    for (const item of part.single && isRecord(value) ? [value] : items(value)) {
      const payload = isRecord(item) ? fields(part.kind, item) : {}
      if (!isRecord(item) || Object.keys(payload).length === 0) skip(item)
      else drafts.push({ kind: part.kind, payload, sourceText: quote(item) })
    }
  }

  const corrections: DictationExtraction["corrections"] = []
  for (const item of items(args["correcciones"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    if (!isRecord(item) || index === null || !isRecord(item["cambios"])) skip(item)
    else corrections.push({ index, changes: item["cambios"], sourceText: quote(item) })
  }
  const removals: DictationExtraction["removals"] = []
  for (const item of items(args["quitar"])) {
    const index = isRecord(item) ? pendingIndex(item["sugerencia"]) : null
    const sourceText = isRecord(item) ? quote(item) : ""
    // Quitar es lo único que descarta: sin lo que dijo para pedirlo, la sugerencia se queda.
    if (index === null || !sourceText) skip(item)
    else removals.push({ index, sourceText })
  }

  const voice = <T extends { sourceText: string }>(list: T[]) => {
    if (list.length <= VOICE_EDITS_HINT) return list
    for (const item of list) skip({ dicho: item.sourceText })
    return []
  }
  const kept = drafts.slice(0, DICTATION_MAX_SUGGESTIONS)
  for (const item of drafts.slice(DICTATION_MAX_SUGGESTIONS)) skip({ dicho: item.sourceText })
  return {
    drafts: kept,
    corrections: voice(corrections),
    removals: voice(removals),
    omitted,
    unused,
  }
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
  /** Partes de la respuesta que no se pudieron usar (`readDictation`): se le avisa al profesional. */
  omitted: number
  /** Lo que dijo para pedir lo que no se pudo usar, tal cual está en lo dictado: la pantalla lo muestra. */
  unused: string[]
  model: string
}

/**
 * Una llamada al modelo con una pausa del dictado y su lectura parte por
 * parte. La usan el dictado de la atención y su medición (`eval:dictado`),
 * para que se mida lo mismo que corre.
 */
export async function askDictationModel(
  model: unknown,
  spec: Pick<LlmSpec, "provider" | "modelName">,
  ask: DictationAsk,
  profile: DictationProfile,
): Promise<{ read: Omit<DictationExtraction, "model"> | null; reply: AIMessage }> {
  const record = tool(async () => "registrado", {
    name: DICTATION_TOOL,
    description: profile.toolDescription,
    schema: profile.extraction,
  })
  const bound = (
    model as {
      bindTools?: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> }
    }
  ).bindTools
    ? (
        model as {
          bindTools: (tools: unknown[]) => {
            invoke: (messages: BaseMessage[]) => Promise<AIMessage>
          }
        }
      ).bindTools([record])
    : (model as { invoke: (messages: BaseMessage[]) => Promise<AIMessage> })
  const reply = await bound.invoke(dictationMessages(ask, profile))
  reportReplyUse(spec.provider, spec.modelName, reply)
  const call =
    reply instanceof AIMessage || "tool_calls" in reply
      ? (reply as AIMessage).tool_calls?.find((item) => item.name === DICTATION_TOOL)
      : undefined
  return {
    read: call ? readDictation(call.args, ask.transcript, ask.pending.length, profile.parts) : null,
    reply,
  }
}
