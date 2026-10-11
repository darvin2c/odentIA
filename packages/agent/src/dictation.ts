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
})
type Extraction = z.infer<typeof extraction>

const TOOL_NAME = "registrar_dictado"

function systemPrompt(input: { services: string[]; today: string; timezone: string }): string {
  return [
    "Eres el asistente clínico de una clínica dental. El odontólogo dicta mientras atiende y tú ordenas lo dictado en registros para que él los revise.",
    `Principios que no cambian: ${AGENT_BASE_PRINCIPLES.join(" ")}`,
    "Registra solo lo que el odontólogo dijo. No añadas diagnósticos, piezas, superficies ni tratamientos que no nombró, ni completes lo que falta con lo que sería habitual.",
    "Si se corrige («en la veinticinco… no, es la veintiséis»), vale lo último que dijo. Si pide quitar algo («quita la endodoncia»), no lo registres.",
    "Las piezas van en numeración FDI como número (dieciséis = 16, cuarenta y seis = 46).",
    "En las indicaciones, pon en `service` la prestación con las palabras del odontólogo: el sistema la busca en los servicios de la clínica. No inventes precios.",
    input.services.length
      ? `Servicios de la clínica, para reconocer de qué prestación habla: ${input.services.slice(0, 200).join("; ")}.`
      : "La clínica aún no tiene servicios en su tarifario.",
    `Hoy es ${input.today} (zona ${input.timezone}). Un control «en seis meses» se cuenta desde hoy.`,
    `Responde únicamente llamando a ${TOOL_NAME}, una sola vez, con todo lo dictado.`,
  ].join("\n")
}

function toDrafts(result: Extraction): DictationDraft[] {
  const drafts: DictationDraft[] = []
  const split = <T extends { dicho?: string | undefined }>(item: T) => {
    const { dicho, ...payload } = item
    return { payload: payload as Record<string, unknown>, sourceText: dicho ?? "" }
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

export interface DictationExtraction {
  drafts: DictationDraft[]
  model: string
}

/**
 * Ordena un dictado en sugerencias. Lee la configuración y el tarifario de la
 * clínica; no escribe nada. El texto del dictado viaja al proveedor del modelo
 * que la clínica tenga configurado.
 */
export async function extractDictation(
  db: Db,
  deps: Pick<AgentRuntime, "platform" | "secretsKey" | "createModel">,
  input: { orgId: string; transcript: string },
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
  if (spec.modelName === "fake" && !deps.createModel) return { drafts: demoExtraction(transcript, services, now), model: spec.modelName }

  const record = tool(async () => "registrado", {
    name: TOOL_NAME,
    description: "Registra, de una sola vez, todo lo que el odontólogo dictó, ordenado por bloques de la atención.",
    schema: extraction,
  })
  const model = deps.createModel ? await deps.createModel(spec) : await createConfiguredChatModel(spec)
  const bound = (model as unknown as { bindTools?: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools
    ? (model as unknown as { bindTools: (tools: unknown[]) => { invoke: (messages: BaseMessage[]) => Promise<AIMessage> } }).bindTools([record])
    : model
  const today = new Intl.DateTimeFormat("es-PE", { timeZone: zone.timezone, dateStyle: "full" }).format(now)
  const reply = await bound.invoke([
    new SystemMessage({ content: systemPrompt({ services, today: `${today}, ${now.toISOString()}`, timezone: zone.timezone }) }),
    new HumanMessage({ content: transcript }),
  ])
  const call = reply instanceof AIMessage || "tool_calls" in reply ? (reply as AIMessage).tool_calls?.find((item) => item.name === TOOL_NAME) : undefined
  const parsed = call ? extraction.safeParse(call.args) : null
  if (!parsed?.success) {
    // El proveedor respondió, pero no con algo que se pueda ordenar: no se inventa nada.
    throw new ServiceError("DICTATION_UNREADABLE", 502, "El asistente no pudo ordenar ese dictado. Vuelve a intentarlo o regístralo a mano.")
  }
  return { drafts: toDrafts(parsed.data), model: spec.modelName }
}
