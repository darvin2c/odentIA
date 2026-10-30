import { orgProductName } from "./locale.js"
import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { RECEPTION_DEFAULT_NAME, receptionName } from "./agent-names.js"
import { AGENT_ROLES, switchableFunctions } from "./agent-roles.js"
import { invalidField, ServiceError, validation } from "./errors.js"

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  /** Modelo de decisión: none | baseline | jev. Toda clínica nace con Jev (ADR 0047). */
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
  /** Sin nombre elegido es Sofi (`receptionName`): el nombre vale solo para esta clínica. */
  personaName: string
  treatment: AgentTreatment | null
  tone: AgentTone
  emojis: AgentEmojis
  about: string
  /** Funciones de Recepción apagadas (ids de su ficha). */
  disabledFunctions: string[]
  /** Indicación de la clínica por función. */
  functionNotes: Record<string, string>
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

export const DECISION_PROVIDERS = ["none", "baseline", "jev"] as const
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number]

/**
 * Nombre en pantalla del modelo que escribe. Es uno solo y lo elige odentIA,
 * no la clínica (ADR 0052); el modelo exacto y sus opciones viven en
 * `packages/agent/src/llm.ts`.
 */
export const AGENT_MODEL_LABEL = "ChatGPT 6"

const DEFAULTS = {
  enabled: false,
  // Jev elige el camino de cada mensaje: lo ajeno sale con el texto fijo y no se cobra (ADR 0047).
  // La columna de la base nace con el mismo valor: cambian juntos.
  decisionProvider: "jev" as DecisionProvider,
  handoffKeywords: [] as string[],
  maxTurns: 10,
  replyCheckEnabled: true,
  decisionRoutingEnabled: true,
  clinicalAssistantEnabled: false,
  personaName: RECEPTION_DEFAULT_NAME,
  treatment: null as AgentTreatment | null,
  tone: "cercano" as AgentTone,
  emojis: "no" as AgentEmojis,
  about: "",
  disabledFunctions: [] as string[],
  functionNotes: {} as Record<string, string>,
  closeAfterHours: 22,
}

function toConfig(row: typeof agentConfig.$inferSelect): AgentConfig {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    decisionProvider: (DECISION_PROVIDERS as readonly string[]).includes(row.decisionProvider)
      ? (row.decisionProvider as DecisionProvider)
      : "none",
    handoffKeywords: row.handoffKeywords,
    maxTurns: row.maxTurns,
    replyCheckEnabled: row.replyCheckEnabled,
    decisionRoutingEnabled: row.decisionRoutingEnabled,
    clinicalAssistantEnabled: row.clinicalAssistantEnabled,
    personaName: receptionName(row.personaName),
    treatment: (AGENT_TREATMENTS as readonly string[]).includes(row.treatment ?? "") ? (row.treatment as AgentTreatment) : null,
    tone: (AGENT_TONES as readonly string[]).includes(row.tone) ? (row.tone as AgentTone) : "cercano",
    emojis: row.emojis === "pocos" ? "pocos" : "no",
    about: row.about,
    disabledFunctions: row.disabledFunctions,
    functionNotes: row.functionNotes,
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
  /** Entero de 6 a 23: después de 24 horas WhatsApp ya no deja despedirse sin mensaje aprobado. */
  closeAfterHours?: number
}

/**
 * «El modelo responde» (fase 4, tablero 3): la llamada mínima al modelo vive
 * en el agente (`createModelChecker`, 10 minutos en caché); los servicios
 * solo deciden con su resultado. La misma comprobación sirve al encendido,
 * al resumen y a Integraciones.
 */
export type AgentModelCheck = () => Promise<{ responds: boolean; checkedAt: string }>

export interface UpsertAgentConfigOpts {
  actorUserId?: string | null
  /** Con ella, encender exige un modelo que responda. La API la pasa siempre: ocultar el botón no basta. */
  modelCheck?: AgentModelCheck
}

/** Encender a Sofi con un modelo que no responde: cada paciente recibiría «una persona te va a responder». */
export const MODEL_NOT_RESPONDING = "MODEL_NOT_RESPONDING"

/** Guarda la configuración; cada cambio queda auditado con quién y cuándo. */
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
    input.handoffKeywords !== undefined &&
    input.handoffKeywords.some((k) => typeof k !== "string")
  ) {
    throw validation("handoffKeywords debe ser lista de texto")
  }
  if (
    input.closeAfterHours !== undefined &&
    (!Number.isInteger(input.closeAfterHours) || input.closeAfterHours < 6 || input.closeAfterHours > 23)
  ) {
    throw invalidField("closeAfterHours", "Escribe un número de horas entre 6 y 23.")
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
    throw invalidField("about", `«Quiénes somos» admite hasta ${ABOUT_CHARS} caracteres`)
  }
  if (input.personaName && input.personaName.trim().length > PERSONA_CHARS) {
    throw invalidField("personaName", `El nombre con que se presenta admite hasta ${PERSONA_CHARS} caracteres`)
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
        throw invalidField(`functionNotes.${id}`, `Cada indicación admite hasta ${FUNCTION_NOTE_CHARS} caracteres`)
      }
    }
  }
  const [current] = await tx
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  if (input.enabled === true && opts.modelCheck) {
    if (!(await opts.modelCheck()).responds) {
      throw new ServiceError(MODEL_NOT_RESPONDING, 409, `El modelo no responde ahora, así que Sofi no se puede encender. Ya avisamos a ${await orgProductName(tx, orgId)}.`)
    }
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

  const [row] = await tx
    .insert(agentConfig)
    .values({ organizationId: orgId, ...DEFAULTS, ...patch })
    .onConflictDoUpdate({
      target: agentConfig.organizationId,
      set: { ...patch, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error("No se pudo guardar la configuración del agente")

  const changed: string[] = []
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
      metadata: { changed, decisionProvider: row.decisionProvider, replyCheckEnabled: row.replyCheckEnabled },
    })
  }
  return toConfig(row)
}
