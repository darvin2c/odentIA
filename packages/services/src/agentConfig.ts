import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { AGENT_ROLES, switchableFunctions } from "./agent-roles.js"
import { ServiceError, validation } from "./errors.js"

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  /** Modelo que escribe, uno de `AGENT_LLMS`; la cuenta del proveedor es de odentIA. */
  llm: AgentLlm
  dailyRunLimit: number
  /** Modelo de decisión: none | baseline | jev | openai_decisions. Toda clínica nace con Jev (ADR 0047). */
  decisionProvider: DecisionProvider
  handoffKeywords: string[]
  maxTurns: number
  /** Comprueba precios, fechas y horas de cada respuesta contra lo consultado antes de enviarla. */
  replyCheckEnabled: boolean
  /** Con modelo de decisión, este elige el camino del turno antes de que escriba el otro. */
  decisionRoutingEnabled: boolean
  /** Asistente clínico: dictado en la atención. */
  clinicalAssistantEnabled: boolean
  /** La voz de la clínica: nombre con que se presenta, trato, tono, emojis y quiénes son. */
  personaName: string | null
  treatment: AgentTreatment | null
  tone: AgentTone
  emojis: AgentEmojis
  about: string
  /** Funciones de Recepción apagadas (ids de su ficha). */
  disabledFunctions: string[]
  /** Indicación de la clínica por función. */
  functionNotes: Record<string, string>
  /** Franja en que responde, en minutos desde medianoche de la clínica; nulos = a toda hora. */
  activeFromMin: number | null
  activeUntilMin: number | null
  /** Canales donde atiende; nulo = todos los conectados. */
  channels: string[] | null
  /** Horas de silencio del paciente tras las que el agente se despide y cierra (6 a 23; ADR 0024). */
  closeAfterHours: number
}

export const AGENT_TREATMENTS = ["tu", "usted"] as const
export type AgentTreatment = (typeof AGENT_TREATMENTS)[number]
export const AGENT_TONES = ["cercano", "neutro", "formal"] as const
export type AgentTone = (typeof AGENT_TONES)[number]
/** `no`: se quitan antes de enviar; `pocos`: uno como mucho y nunca en lo delicado. */
export const AGENT_EMOJIS = ["no", "pocos"] as const
export type AgentEmojis = (typeof AGENT_EMOJIS)[number]
const ABOUT_CHARS = 600
const PERSONA_CHARS = 40
const FUNCTION_NOTE_CHARS = 300

export const DECISION_PROVIDERS = ["none", "baseline", "jev", "openai_decisions"] as const
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number]

/**
 * Los modelos que la clínica puede elegir: odentIA los validó y pone la
 * cuenta (ADR 0022). Aquí solo el id y lo que ve la clínica; proveedor,
 * modelo exacto y opciones viven en `packages/agent/src/llm.ts`, y odentIA
 * los cambia sin que la clínica haga nada. El primero es el de toda clínica
 * y coincide con el valor por defecto de la base.
 */
export const AGENT_LLMS = [
  { id: "chatgpt_6", label: "ChatGPT 6" },
  { id: "claude_5_5", label: "Claude 5.5" },
] as const
export type AgentLlm = (typeof AGENT_LLMS)[number]["id"]
export const AGENT_LLM_IDS = AGENT_LLMS.map((option) => option.id) as [AgentLlm, ...AgentLlm[]]
export const DEFAULT_AGENT_LLM: AgentLlm = "chatgpt_6"

export function isAgentLlm(value: unknown): value is AgentLlm {
  return typeof value === "string" && (AGENT_LLM_IDS as readonly string[]).includes(value)
}

const DEFAULTS = {
  enabled: false,
  llm: DEFAULT_AGENT_LLM,
  dailyRunLimit: 500,
  // Jev elige el camino de cada mensaje: lo ajeno sale con el texto fijo y no se cobra (ADR 0047).
  // La columna de la base nace con el mismo valor: cambian juntos.
  decisionProvider: "jev" as DecisionProvider,
  handoffKeywords: [] as string[],
  maxTurns: 10,
  replyCheckEnabled: true,
  decisionRoutingEnabled: true,
  clinicalAssistantEnabled: false,
  personaName: null as string | null,
  treatment: null as AgentTreatment | null,
  tone: "cercano" as AgentTone,
  emojis: "no" as AgentEmojis,
  about: "",
  disabledFunctions: [] as string[],
  functionNotes: {} as Record<string, string>,
  activeFromMin: null as number | null,
  activeUntilMin: null as number | null,
  channels: null as string[] | null,
  closeAfterHours: 22,
}

function toConfig(row: typeof agentConfig.$inferSelect): AgentConfig {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    llm: isAgentLlm(row.llm) ? row.llm : DEFAULT_AGENT_LLM,
    dailyRunLimit: row.dailyRunLimit,
    decisionProvider: (DECISION_PROVIDERS as readonly string[]).includes(row.decisionProvider)
      ? (row.decisionProvider as DecisionProvider)
      : "none",
    handoffKeywords: row.handoffKeywords,
    maxTurns: row.maxTurns,
    replyCheckEnabled: row.replyCheckEnabled,
    decisionRoutingEnabled: row.decisionRoutingEnabled,
    clinicalAssistantEnabled: row.clinicalAssistantEnabled,
    personaName: row.personaName,
    treatment: (AGENT_TREATMENTS as readonly string[]).includes(row.treatment ?? "") ? (row.treatment as AgentTreatment) : null,
    tone: (AGENT_TONES as readonly string[]).includes(row.tone) ? (row.tone as AgentTone) : "cercano",
    emojis: row.emojis === "pocos" ? "pocos" : "no",
    about: row.about,
    disabledFunctions: row.disabledFunctions,
    functionNotes: row.functionNotes,
    activeFromMin: row.activeFromMin,
    activeUntilMin: row.activeUntilMin,
    channels: row.channels,
    closeAfterHours: row.closeAfterHours,
  }
}

export async function getAgentConfig(tx: Db, orgId: string): Promise<AgentConfig> {
  const [row] = await tx
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  if (!row) return { organizationId: orgId, ...DEFAULTS, handoffKeywords: [] }
  return toConfig(row)
}

export interface UpsertAgentConfigInput {
  enabled?: boolean
  llm?: AgentLlm
  dailyRunLimit?: number
  decisionProvider?: DecisionProvider
  handoffKeywords?: string[]
  maxTurns?: number
  replyCheckEnabled?: boolean
  decisionRoutingEnabled?: boolean
  clinicalAssistantEnabled?: boolean
  personaName?: string | null
  treatment?: AgentTreatment | null
  tone?: AgentTone
  emojis?: AgentEmojis
  about?: string
  disabledFunctions?: string[]
  functionNotes?: Record<string, string>
  /** Ambos o ninguno: `null` en los dos = a toda hora. */
  activeFromMin?: number | null
  activeUntilMin?: number | null
  channels?: string[] | null
  /** Entero de 6 a 23: después de 24 horas WhatsApp ya no deja despedirse sin mensaje aprobado. */
  closeAfterHours?: number
}

/**
 * «El modelo responde» (fase 4, tablero 3): la llamada mínima al modelo vive
 * en el agente (`createModelChecker`, 10 minutos en caché); los servicios
 * solo deciden con su resultado. La misma comprobación sirve al encendido,
 * al resumen y a Integraciones.
 */
export type AgentModelCheck = (llm: AgentLlm) => Promise<{ responds: boolean; checkedAt: string }>

export interface UpsertAgentConfigOpts {
  actorUserId?: string | null
  /**
   * Con ella, encender (o cambiar de modelo con el agente encendido) exige un
   * modelo que responda. La API la pasa siempre: ocultar el botón no basta.
   */
  modelCheck?: AgentModelCheck
}

/** Encender Recepción con un modelo que no responde: cada paciente recibiría «una persona te va a responder». */
export const MODEL_NOT_RESPONDING = "MODEL_NOT_RESPONDING"

/**
 * Guarda la configuración. El modelo solo puede ser uno de `AGENT_LLMS`; su
 * cambio, como los demás, queda auditado con quién y cuándo.
 */
export async function upsertAgentConfig(
  tx: Db,
  orgId: string,
  input: UpsertAgentConfigInput,
  opts: UpsertAgentConfigOpts = {},
): Promise<AgentConfig> {
  if (
    input.maxTurns !== undefined &&
    (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 50)
  ) {
    throw validation("maxTurns debe ser entero entre 1 y 50")
  }
  if (
    input.dailyRunLimit !== undefined &&
    (!Number.isInteger(input.dailyRunLimit) || input.dailyRunLimit < 1 || input.dailyRunLimit > 100_000)
  ) {
    throw validation("dailyRunLimit debe ser entero entre 1 y 100000")
  }
  if (
    input.handoffKeywords !== undefined &&
    input.handoffKeywords.some((k) => typeof k !== "string")
  ) {
    throw validation("handoffKeywords debe ser lista de texto")
  }
  if (
    input.closeAfterHours !== undefined &&
    (!Number.isInteger(input.closeAfterHours) || input.closeAfterHours < 6 || input.closeAfterHours > 23)
  ) {
    throw validation("Las horas para cerrar por silencio van de 6 a 23")
  }
  if (input.llm !== undefined && !isAgentLlm(input.llm)) {
    throw validation(`El modelo del agente debe ser ${AGENT_LLMS.map((option) => option.label).join(" o ")}`)
  }
  if (input.decisionProvider !== undefined && !(DECISION_PROVIDERS as readonly string[]).includes(input.decisionProvider)) {
    throw validation("decisionProvider inválido")
  }
  if (input.treatment !== undefined && input.treatment !== null && !(AGENT_TREATMENTS as readonly string[]).includes(input.treatment)) {
    throw validation("El trato debe ser de tú o de usted")
  }
  if (input.tone !== undefined && !(AGENT_TONES as readonly string[]).includes(input.tone)) {
    throw validation("El tono debe ser cercano, neutro o formal")
  }
  if (input.emojis !== undefined && !(AGENT_EMOJIS as readonly string[]).includes(input.emojis)) {
    throw validation("Los emojis son «No usar» o «Pocos»")
  }
  if (input.about !== undefined && input.about.trim().length > ABOUT_CHARS) {
    throw validation(`«Quiénes somos» admite hasta ${ABOUT_CHARS} caracteres`)
  }
  if (input.personaName && input.personaName.trim().length > PERSONA_CHARS) {
    throw validation(`El nombre con que se presenta admite hasta ${PERSONA_CHARS} caracteres`)
  }
  const switchable = switchableFunctions("recepcion")
  if (input.disabledFunctions !== undefined && input.disabledFunctions.some((id) => !switchable.includes(id))) {
    throw validation("Solo se pueden apagar las funciones que la ficha del agente permite")
  }
  if (input.functionNotes !== undefined) {
    const known = AGENT_ROLES.recepcion.functions.map((fn) => fn.id)
    for (const [id, note] of Object.entries(input.functionNotes)) {
      if (!known.includes(id)) throw validation("Indicación para una función que no existe")
      if (typeof note !== "string" || note.trim().length > FUNCTION_NOTE_CHARS) {
        throw validation(`Cada indicación admite hasta ${FUNCTION_NOTE_CHARS} caracteres`)
      }
    }
  }
  const [current] = await tx
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  const staysOn = input.enabled === true || (input.enabled === undefined && input.llm !== undefined && current?.enabled === true)
  if (staysOn && opts.modelCheck) {
    const currentLlm = current?.llm
    const llm = input.llm ?? (isAgentLlm(currentLlm) ? currentLlm : DEFAULTS.llm)
    if (!(await opts.modelCheck(llm)).responds) {
      throw new ServiceError(MODEL_NOT_RESPONDING, 409, "El modelo no responde ahora, así que Recepción no se puede encender. Ya avisamos a odentIA.")
    }
  }
  if (input.activeFromMin !== undefined || input.activeUntilMin !== undefined) {
    const from = input.activeFromMin === undefined ? (current?.activeFromMin ?? null) : input.activeFromMin
    const until = input.activeUntilMin === undefined ? (current?.activeUntilMin ?? null) : input.activeUntilMin
    const valid =
      (from === null && until === null) ||
      (from !== null &&
        until !== null &&
        Number.isInteger(from) &&
        Number.isInteger(until) &&
        from >= 0 &&
        from <= 1439 &&
        until >= 1 &&
        until <= 1440 &&
        from !== until)
    if (!valid) throw validation("El horario necesita una hora de inicio y una de fin distintas, o ninguna")
  }
  if (input.channels !== undefined && input.channels !== null && input.channels.some((c) => typeof c !== "string" || !c.trim())) {
    throw validation("channels debe ser una lista de canales")
  }
  const patch: Partial<typeof agentConfig.$inferInsert> = { ...input }
  if (input.personaName !== undefined) patch.personaName = input.personaName?.trim() || null
  if (input.about !== undefined) patch.about = input.about.trim()
  if (input.disabledFunctions !== undefined) patch.disabledFunctions = [...new Set(input.disabledFunctions)]
  if (input.functionNotes !== undefined) {
    patch.functionNotes = Object.fromEntries(
      Object.entries(input.functionNotes)
        .map(([id, note]) => [id, note.trim()] as const)
        .filter(([, note]) => note !== ""),
    )
  }
  if (input.channels !== undefined) patch.channels = input.channels && input.channels.length > 0 ? [...new Set(input.channels)] : null

  const [row] = await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, ...DEFAULTS, ...patch })
    .onConflictDoUpdate({
      target: agentConfig.organizationId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la configuración del agente")

  // Con el modelo cambia adónde viajan los datos de pacientes: quién, cuándo y qué campo.
  const changed: string[] = []
  if (patch.llm !== undefined && patch.llm !== (current?.llm ?? DEFAULTS.llm)) changed.push("llm")
  if (patch.dailyRunLimit !== undefined && patch.dailyRunLimit !== (current?.dailyRunLimit ?? DEFAULTS.dailyRunLimit)) {
    changed.push("dailyRunLimit")
  }
  if (patch.decisionProvider !== undefined && patch.decisionProvider !== (current?.decisionProvider ?? DEFAULTS.decisionProvider)) {
    changed.push("decisionProvider")
  }
  if (
    patch.replyCheckEnabled !== undefined &&
    patch.replyCheckEnabled !== (current?.replyCheckEnabled ?? DEFAULTS.replyCheckEnabled)
  ) {
    changed.push("replyCheckEnabled")
  }
  if (
    patch.decisionRoutingEnabled !== undefined &&
    patch.decisionRoutingEnabled !== (current?.decisionRoutingEnabled ?? DEFAULTS.decisionRoutingEnabled)
  ) {
    changed.push("decisionRoutingEnabled")
  }
  if (
    patch.clinicalAssistantEnabled !== undefined &&
    patch.clinicalAssistantEnabled !== (current?.clinicalAssistantEnabled ?? DEFAULTS.clinicalAssistantEnabled)
  ) {
    changed.push("clinicalAssistantEnabled")
  }
  // Lo que cambia qué hace el agente o cómo se presenta también se audita.
  for (const field of [
    "enabled",
    "personaName",
    "treatment",
    "tone",
    "emojis",
    "about",
    "disabledFunctions",
    "functionNotes",
    "activeFromMin",
    "activeUntilMin",
    "channels",
    "closeAfterHours",
  ] as const) {
    if (patch[field] !== undefined && JSON.stringify(patch[field]) !== JSON.stringify(current?.[field] ?? DEFAULTS[field])) {
      changed.push(field)
    }
  }
  if (changed.length > 0) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId: opts.actorUserId ?? null,
      action: "agent.config_updated",
      entity: "agent_config",
      entityId: orgId,
      metadata: { changed, llm: row.llm, dailyRunLimit: row.dailyRunLimit, decisionProvider: row.decisionProvider, replyCheckEnabled: row.replyCheckEnabled },
    })
  }
  return toConfig(row)
}
