import type { Db } from "@odentia/db"
import { agentConfig } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { eq } from "drizzle-orm"
import { AGENT_ROLES, switchableFunctions } from "./agent-roles.js"
import { validation } from "./errors.js"
import { normalizeLlmBaseUrl } from "./llm-endpoint.js"
import { decryptJson, encryptJson } from "./secrets.js"

export interface AgentConfig {
  organizationId: string
  enabled: boolean
  model: string | null
  /** URL base del proveedor propio; null = el de la plataforma. */
  llmBaseUrl: string | null
  /** La clave existe; su valor nunca sale del servidor. */
  hasLlmApiKey: boolean
  dailyRunLimit: number
  /** Modelo de decisión en sombra: none | baseline | jev | openai_decisions. */
  decisionProvider: DecisionProvider
  systemPrompt: string
  handoffKeywords: string[]
  maxTurns: number
  /** Comprueba precios, fechas y horas de cada respuesta contra lo consultado antes de enviarla. */
  replyCheckEnabled: boolean
  /** Con modelo de decisión, este elige el camino del turno antes de que escriba el otro. */
  decisionRoutingEnabled: boolean
  /** Asistente clínico: dictado en la atención. */
  clinicalAssistantEnabled: boolean
  /** La voz de la clínica: nombre con que se presenta, trato, tono y quiénes son. */
  personaName: string | null
  treatment: AgentTreatment | null
  tone: AgentTone
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
}

export const AGENT_TREATMENTS = ["tu", "usted"] as const
export type AgentTreatment = (typeof AGENT_TREATMENTS)[number]
export const AGENT_TONES = ["cercano", "neutro", "formal"] as const
export type AgentTone = (typeof AGENT_TONES)[number]
const ABOUT_CHARS = 600
const PERSONA_CHARS = 40
const FUNCTION_NOTE_CHARS = 300

export const DECISION_PROVIDERS = ["none", "baseline", "jev", "openai_decisions"] as const
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number]

const DEFAULTS = {
  enabled: false,
  model: null as string | null,
  llmBaseUrl: null as string | null,
  llmApiKeyEncrypted: null as string | null,
  dailyRunLimit: 500,
  decisionProvider: "none" as DecisionProvider,
  systemPrompt: "",
  handoffKeywords: [] as string[],
  maxTurns: 10,
  replyCheckEnabled: true,
  decisionRoutingEnabled: true,
  clinicalAssistantEnabled: false,
  personaName: null as string | null,
  treatment: null as AgentTreatment | null,
  tone: "cercano" as AgentTone,
  about: "",
  disabledFunctions: [] as string[],
  functionNotes: {} as Record<string, string>,
  activeFromMin: null as number | null,
  activeUntilMin: null as number | null,
  channels: null as string[] | null,
}

function toConfig(row: typeof agentConfig.$inferSelect): AgentConfig {
  return {
    organizationId: row.organizationId,
    enabled: row.enabled,
    model: row.model,
    llmBaseUrl: row.llmBaseUrl,
    hasLlmApiKey: row.llmApiKeyEncrypted !== null,
    dailyRunLimit: row.dailyRunLimit,
    decisionProvider: (DECISION_PROVIDERS as readonly string[]).includes(row.decisionProvider)
      ? (row.decisionProvider as DecisionProvider)
      : "none",
    systemPrompt: row.systemPrompt,
    handoffKeywords: row.handoffKeywords,
    maxTurns: row.maxTurns,
    replyCheckEnabled: row.replyCheckEnabled,
    decisionRoutingEnabled: row.decisionRoutingEnabled,
    clinicalAssistantEnabled: row.clinicalAssistantEnabled,
    personaName: row.personaName,
    treatment: (AGENT_TREATMENTS as readonly string[]).includes(row.treatment ?? "") ? (row.treatment as AgentTreatment) : null,
    tone: (AGENT_TONES as readonly string[]).includes(row.tone) ? (row.tone as AgentTone) : "cercano",
    about: row.about,
    disabledFunctions: row.disabledFunctions,
    functionNotes: row.functionNotes,
    activeFromMin: row.activeFromMin,
    activeUntilMin: row.activeUntilMin,
    channels: row.channels,
  }
}

export async function getAgentConfig(tx: Db, orgId: string): Promise<AgentConfig> {
  const [row] = await tx
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  if (!row) {
    const { llmApiKeyEncrypted: _sealed, ...defaults } = DEFAULTS
    return { organizationId: orgId, ...defaults, hasLlmApiKey: false, handoffKeywords: [] }
  }
  return toConfig(row)
}

/** Proveedor propio descifrado: solo worker y API (nunca a la UI). */
export async function getAgentLlmSecrets(
  tx: Db,
  orgId: string,
  secretsKey: Buffer,
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const [row] = await tx
    .select({ baseUrl: agentConfig.llmBaseUrl, sealed: agentConfig.llmApiKeyEncrypted })
    .from(agentConfig)
    .where(eq(agentConfig.organizationId, orgId))
    .limit(1)
  if (!row?.baseUrl || !row.sealed) return null
  const value = decryptJson(secretsKey, row.sealed)
  if (!value || typeof value !== "object" || typeof (value as { apiKey?: unknown }).apiKey !== "string") {
    throw new Error("La clave del proveedor LLM tiene un formato inválido")
  }
  return { baseUrl: row.baseUrl, apiKey: (value as { apiKey: string }).apiKey }
}

/** Validación sintáctica de la URL base (sin red); devuelve la forma canónica. */
export function validateLlmBaseUrl(raw: string, opts: { allowInsecure?: boolean } = {}): string {
  return normalizeLlmBaseUrl(raw, opts)
}

export interface UpsertAgentConfigInput {
  enabled?: boolean
  model?: string | null
  /** null (o vacío) retira el proveedor propio junto con su clave. */
  llmBaseUrl?: string | null
  /** Texto nuevo reemplaza la clave; null retira el proveedor propio; ausente la conserva. */
  llmApiKey?: string | null
  dailyRunLimit?: number
  decisionProvider?: DecisionProvider
  systemPrompt?: string
  handoffKeywords?: string[]
  maxTurns?: number
  replyCheckEnabled?: boolean
  decisionRoutingEnabled?: boolean
  clinicalAssistantEnabled?: boolean
  personaName?: string | null
  treatment?: AgentTreatment | null
  tone?: AgentTone
  about?: string
  disabledFunctions?: string[]
  functionNotes?: Record<string, string>
  /** Ambos o ninguno: `null` en los dos = a toda hora. */
  activeFromMin?: number | null
  activeUntilMin?: number | null
  channels?: string[] | null
}

export interface UpsertAgentConfigOpts {
  /** Obligatoria para guardar una clave de proveedor. */
  secretsKey?: Buffer
  actorUserId?: string | null
  allowInsecureBaseUrl?: boolean
}

/**
 * Guarda la configuración. URL base y clave del proveedor propio van juntas:
 * no se admite una sin la otra, cambiar la URL exige volver a escribir la
 * clave (la anterior nunca viaja a un host nuevo) y el proveedor propio
 * necesita modelo. Los cambios de proveedor o modelo quedan auditados sin
 * el valor de la clave.
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
  if (input.decisionProvider !== undefined && !(DECISION_PROVIDERS as readonly string[]).includes(input.decisionProvider)) {
    throw validation("decisionProvider inválido")
  }
  if (input.treatment !== undefined && input.treatment !== null && !(AGENT_TREATMENTS as readonly string[]).includes(input.treatment)) {
    throw validation("El trato debe ser de tú o de usted")
  }
  if (input.tone !== undefined && !(AGENT_TONES as readonly string[]).includes(input.tone)) {
    throw validation("El tono debe ser cercano, neutro o formal")
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
  const { llmBaseUrl: baseUrlInput, llmApiKey: apiKeyInput, ...rest } = input
  const patch: Partial<typeof agentConfig.$inferInsert> = { ...rest }
  if (rest.model !== undefined) patch.model = rest.model?.trim() || null
  if (rest.personaName !== undefined) patch.personaName = rest.personaName?.trim() || null
  if (rest.about !== undefined) patch.about = rest.about.trim()
  if (rest.disabledFunctions !== undefined) patch.disabledFunctions = [...new Set(rest.disabledFunctions)]
  if (rest.functionNotes !== undefined) {
    patch.functionNotes = Object.fromEntries(
      Object.entries(rest.functionNotes)
        .map(([id, note]) => [id, note.trim()] as const)
        .filter(([, note]) => note !== ""),
    )
  }
  if (rest.channels !== undefined) patch.channels = rest.channels && rest.channels.length > 0 ? [...new Set(rest.channels)] : null

  const touchesProvider = baseUrlInput !== undefined || apiKeyInput !== undefined
  if (touchesProvider) {
    const previousUrl = current?.llmBaseUrl ?? null
    const removing = baseUrlInput === null || baseUrlInput === "" || apiKeyInput === null
    let baseUrl: string | null
    let sealed: string | null
    if (removing) {
      baseUrl = null
      sealed = null
      if (apiKeyInput?.trim()) throw validation("Para usar una clave propia indica también la URL base del proveedor")
      // El modelo se eligió para ese proveedor: al volver al incluido con
      // odentIA no viaja a otro que quizá no lo tiene. Quien quiera conservarlo
      // lo indica en la misma petición.
      if (previousUrl !== null && rest.model === undefined) patch.model = null
    } else {
      baseUrl =
        baseUrlInput === undefined
          ? previousUrl
          : validateLlmBaseUrl(baseUrlInput, { allowInsecure: opts.allowInsecureBaseUrl })
      if (apiKeyInput === undefined) {
        sealed = current?.llmApiKeyEncrypted ?? null
        if (baseUrl !== null && baseUrl !== previousUrl && sealed !== null) {
          throw validation("Al cambiar la URL del proveedor vuelve a indicar su clave de API")
        }
      } else if (!apiKeyInput.trim()) {
        sealed = current?.llmApiKeyEncrypted ?? null
      } else {
        if (!opts.secretsKey) throw new Error("Falta la clave de cifrado para guardar la clave del proveedor")
        sealed = encryptJson(opts.secretsKey, { apiKey: apiKeyInput.trim() })
      }
      if (baseUrl === null) throw validation("Para usar una clave propia indica también la URL base del proveedor")
      if (sealed === null) throw validation("Para usar un proveedor propio indica también su clave de API")
      const model = patch.model !== undefined ? patch.model : (current?.model ?? null)
      if (!model) throw validation("Con proveedor propio indica el modelo que espera ese endpoint")
    }
    patch.llmBaseUrl = baseUrl
    patch.llmApiKeyEncrypted = sealed
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

  // El destino de los datos de pacientes cambia: quién, cuándo y qué campo,
  // nunca el valor de la clave.
  const changed: string[] = []
  if (patch.model !== undefined && patch.model !== (current?.model ?? null)) changed.push("model")
  if (patch.llmBaseUrl !== undefined && patch.llmBaseUrl !== (current?.llmBaseUrl ?? null)) changed.push("llmBaseUrl")
  if (patch.llmApiKeyEncrypted !== undefined && patch.llmApiKeyEncrypted !== (current?.llmApiKeyEncrypted ?? null)) {
    changed.push("llmApiKey")
  }
  if (patch.dailyRunLimit !== undefined && patch.dailyRunLimit !== (current?.dailyRunLimit ?? DEFAULTS.dailyRunLimit)) {
    changed.push("dailyRunLimit")
  }
  if (patch.decisionProvider !== undefined && patch.decisionProvider !== (current?.decisionProvider ?? "none")) {
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
    "about",
    "disabledFunctions",
    "functionNotes",
    "activeFromMin",
    "activeUntilMin",
    "channels",
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
      metadata: { changed, llmBaseUrl: row.llmBaseUrl, model: row.model, dailyRunLimit: row.dailyRunLimit, decisionProvider: row.decisionProvider, replyCheckEnabled: row.replyCheckEnabled },
    })
  }
  return toConfig(row)
}
