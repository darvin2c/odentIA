import { AIMessage, type BaseMessage, HumanMessage, SystemMessage } from "@langchain/core/messages"
import { tool } from "@langchain/core/tools"
import { type Db, withOrgContext } from "@odentia/db"
import {
  AGENT_BASE_PRINCIPLES,
  DICTATION_CHARS,
  type DictationDraft,
  getAgentConfig,
  getDictationCatalog,
  getOrgLocale,
  operationAgentSchema,
  ServiceError,
} from "@odentia/services"
import { z } from "zod"
import { createConfiguredChatModel } from "./llm.js"
import { type AgentRuntime, resolveOrgLlm } from "./run.js"

/**
 * Asistente clínico: convierte lo que el odontólogo dicta en sugerencias para
 * la atención. No guarda nada ni decide nada: devuelve borradores de registros
 * que el servicio valida y que solo entran a la historia si el odontólogo los
 * confirma. El esquema de lo que puede llenar sale de la declaración de campos
 * de cada operación de la atención: un campo nuevo ahí aparece aquí solo.
 */
const said = z.string().max(600).optional().describe("El fragmento del dictado, tal cual, del que sale este registro.")

const extraction = z.object({
  nota: operationAgentSchema("atencion.nota")
    .extend({ dicho: said })
    .optional()
    .describe("Los textos de la consulta que se dictaron. Omite los que no se dijeron."),
  diagnosticos: z
    .array(operationAgentSchema("atencion.diagnostico").extend({ dicho: said }))
    .max(10)
    .default([])
    .describe("Un elemento por cada diagnóstico que nombró el odontólogo."),
  indicaciones: z
    .array(operationAgentSchema("plan.indicacion").extend({ dicho: said }))
    .max(20)
    .default([])
    .describe("Un elemento por cada tratamiento que indicó para el plan."),
  controles: z
    .array(operationAgentSchema("control.crear").extend({ dicho: said }))
    .max(5)
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
    .max(10)
    .default([])
    .describe("Correcciones que dijo sobre sugerencias pendientes ya numeradas. Vacío si no corrigió ninguna."),
  quitar: z
    .array(z.object({ sugerencia: z.number().int().min(1).describe("El número de la sugerencia pendiente que pidió quitar."), dicho: said }))
    .max(10)
    .default([])
    .describe("Sugerencias pendientes que pidió quitar. Vacío si no pidió quitar ninguna."),
})
type Extraction = z.infer<typeof extraction>

const TOOL_NAME = "registrar_dictado"

function systemPrompt(input: { services: string[]; today: string; timezone: string }): string {
  return [
    "Eres el asistente clínico de una clínica dental. El odontólogo dicta mientras atiende y tú ordenas lo dictado en registros para que él los revise.",
    `Principios que no cambian: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    "Registra solo lo que el odontólogo dijo. No añadas diagnósticos, piezas, superficies ni tratamientos que no nombró, ni completes lo que falta con lo que sería habitual.",
    "Si se corrige («en la veinticinco… no, es la veintiséis»), vale lo último que dijo. Si pide quitar algo («quita la endodoncia»), no lo registres.",
    "Si recibes sugerencias pendientes numeradas y lo nuevo corrige o quita una de ellas, usa `correcciones` o `quitar` con su número en vez de registrarla otra vez. Lo marcado como ya ordenado sirve para entender lo nuevo: no lo registres de nuevo.",
    "Las piezas van en numeración FDI como número (dieciséis = 16, cuarenta y seis = 46).",
    "En las indicaciones, pon en `service` la prestación con las palabras del odontólogo: el sistema la busca en los servicios de la clínica. No inventes precios.",
    input.services.length
      ? `Servicios de la clínica, para reconocer de qué prestación habla: ${input.services.slice(0, 200).join("; ")}.`
      : "La clínica aún no tiene servicios.",
    `Hoy es ${input.today} (zona ${input.timezone}). Un control «en seis meses» se cuenta desde hoy.`,
    `Responde únicamente llamando a ${TOOL_NAME}, una sola vez, con todo lo dictado.`,
  ].join("\n")
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

function toDrafts(result: Extraction, transcript: string): DictationDraft[] {
  const drafts: DictationDraft[] = []
  const split = <T extends { dicho?: string | undefined }>(item: T) => {
    const { dicho, ...payload } = item
    return { payload: payload as Record<string, unknown>, sourceText: groundSource(dicho, transcript) }
  }
  if (result.nota) {
    const { payload, sourceText } = split(result.nota)
    if (Object.values(payload).some((value) => typeof value === "string" && value.trim())) drafts.push({ kind: "nota", payload, sourceText })
  }
  for (const item of result.diagnosticos) drafts.push({ kind: "diagnostico", ...split(item) })
  for (const item of result.indicaciones) drafts.push({ kind: "plan", ...split(item) })
  for (const item of result.controles) drafts.push({ kind: "control", ...split(item) })
  return drafts
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
export function demoExtraction(transcript: string, services: string[], now: Date): DictationDraft[] {
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
        payload: { cie10Code: /dentina/.test(text) ? "K02.1" : "K02.9", diagnosisType: "presuntivo", ...(tooth ? { toothNumber: tooth } : {}) },
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
  model: string
}

/**
 * Lo mismo que `demoExtraction` cuando el odontólogo sigue dictando: además
 * reconoce «no, es la veintiséis» (cambia la pieza de la última sugerencia) y
 * «quita la endodoncia» (descarta la pendiente que lleva esa palabra).
 */
export function demoSegment(transcript: string, services: string[], now: Date, pending: DictationPending[]): Omit<DictationExtraction, "model"> {
  // Una frase que corrige o quita algo no es, además, un registro nuevo («quita la endodoncia»).
  const order = (sentence: string) => /^(no,? es |quita)/.test(plain(sentence))
  const drafts = demoExtraction(transcript, services, now).filter((draft) => !order(draft.sourceText ?? ""))
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
  return { drafts, corrections, removals }
}

/**
 * Ordena un dictado en sugerencias. Lee la configuración y el tarifario de la
 * clínica; no escribe nada. El texto del dictado viaja al proveedor del modelo
 * que la clínica tenga configurado.
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
  const { spec, services, zone } = await withOrgContext(db, input.orgId, async (tx) => {
    const cfg = await getAgentConfig(tx, input.orgId)
    return {
      spec: await resolveOrgLlm(tx, input.orgId, cfg, deps),
      services: (await getDictationCatalog(tx, input.orgId)).services.map((service) => service.name),
      zone: await getOrgLocale(tx, input.orgId),
    }
  })
  const now = new Date()
  const pending = (input.pending ?? []).slice(0, 40)
  if (spec.modelName === "fake" && !deps.createModel) return { ...demoSegment(transcript, services, now, pending), model: spec.modelName }
  // Con dictado en curso, lo nuevo va al final y separado de lo que solo da contexto.
  const context = (input.context ?? "").trim().slice(-600)
  const human =
    context || pending.length
      ? [
          context ? `Ya ordenado antes en este dictado (no lo registres otra vez):\n«${context}»` : "",
          pending.length ? `Sugerencias pendientes de este dictado:\n${pending.map((item, index) => `${index + 1}. ${item.label}`).join("\n")}` : "",
          `Lo nuevo que dictó:\n«${transcript}»`,
        ]
          .filter(Boolean)
          .join("\n\n")
      : transcript

  const record = tool(async () => "registrado", {
    name: TOOL_NAME,
    description: "Registra, de una sola vez, todo lo que el odontólogo dictó, ordenado por bloques de la atención.",
    schema: extraction,
  })
  const model = deps.createModel ? await deps.createModel(spec) : await createConfiguredChatModel(spec)
  const bound = (model as unknown as { bindTools?: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools
    ? (model as unknown as { bindTools: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools([record])
    : model
  const today = new Intl.DateTimeFormat(zone.locale, { timeZone: zone.timezone, dateStyle: "full" }).format(now)
  const reply = await bound.invoke([
    new SystemMessage({ content: systemPrompt({ services, today: `${today}, ${now.toISOString()}`, timezone: zone.timezone }) }),
    new HumanMessage({ content: human }),
  ])
  const call = reply instanceof AIMessage || "tool_calls" in reply ? (reply as AIMessage).tool_calls?.find((item) => item.name === TOOL_NAME) : undefined
  const parsed = call ? extraction.safeParse(call.args) : null
  if (!parsed?.success) {
    // El proveedor respondió, pero no con algo que se pueda ordenar: no se inventa nada.
    throw new ServiceError("DICTATION_UNREADABLE", 502, "El asistente no pudo ordenar ese dictado. Vuelve a intentarlo o regístralo a mano.")
  }
  // Un número que no corresponde a ninguna pendiente se ignora: no se adivina a cuál se refería.
  const known = <T extends { sugerencia: number }>(item: T) => item.sugerencia <= pending.length
  return {
    drafts: toDrafts(parsed.data, transcript),
    corrections: parsed.data.correcciones.filter(known).map((item) => ({ index: item.sugerencia - 1, changes: item.cambios, sourceText: groundSource(item.dicho, transcript) })),
    removals: parsed.data.quitar.filter(known).map((item) => ({ index: item.sugerencia - 1, sourceText: groundSource(item.dicho, transcript) })),
    model: spec.modelName,
  }
}
