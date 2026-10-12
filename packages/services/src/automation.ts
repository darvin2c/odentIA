import { createHash, randomBytes } from "node:crypto"
import { sendAgentRun, type Db, withOrgContext } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { member, organization } from "@odentia/db/schema/auth"
import { commercialFollowUpCoordination } from "@odentia/db/schema/agent"
import type {
  AutomationChannel,
  AutomationJobStatus,
  AutomationKind,
  ConsentPurpose,
} from "@odentia/db/schema/automation"
import {
  AUTOMATION_CHANNELS,
  AUTOMATION_JOB_STATUSES,
  AUTOMATION_KINDS,
  automationConsent,
  automationJob,
  automationLinkToken,
  automationRule,
  CONSENT_PURPOSES,
} from "@odentia/db/schema/automation"
import { clinicalFollowUp, patientContact, treatmentBudget } from "@odentia/db/schema/clinical"
import { agentConfig, channelConnection, contact, contactIdentity, conversation, crmTask } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import {
  and,
  arrayOverlaps,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm"
import { createProposal, getAutonomyPolicy } from "./agent-operations.js"
import { reconcileProposedCoordinations } from "./commercial-coordination.js"
import { getConnectionTemplates } from "./connections.js"
import { sendOutbound, sendTemplateOutbound, startContactConversation } from "./conversations.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { findOrgLocale, NEUTRAL_TIMEZONE } from "./locale.js"
import { createWorkspaceNotification } from "./workspace.js"

/**
 * Automatizaciones: reglas, trabajos durables en DB, consentimientos y
 * enlaces públicos seguros. Todo envío automático exige opt-in explícito
 * vigente (finalidad + canal); sin él el trabajo se marca `omitido`.
 *
 * Convención: funciones reciben `tx: Db` ya dentro de `withOrgContext`.
 * El worker (`tickAutomations`) programa (sync) y entrega (deliver) en
 * transacciones separadas: estado + encolado son atómicos en cada paso.
 */

// ---------------------------------------------------------------- reglas ---

export type RuleRow = typeof automationRule.$inferSelect

export interface RuleConfig {
  hoursBefore?: number[]
  delayHours?: number
  inactiveDays?: number
  quietStart?: string
  quietEnd?: string
  /** Segmento de campaña: etiquetas y/o etapas de oportunidad abiertas. */
  segment?: { tags?: string[]; opportunityStageIds?: string[]; inactiveDays?: number }
  startsAt?: string
  endsAt?: string
}

function assertKind(kind: string): AutomationKind {
  if (!(AUTOMATION_KINDS as readonly string[]).includes(kind))
    throw validation("Tipo de automatización inválido")
  return kind as AutomationKind
}

function assertChannel(channel: string): AutomationChannel {
  if (!(AUTOMATION_CHANNELS as readonly string[]).includes(channel))
    throw validation("Canal inválido")
  return channel as AutomationChannel
}

function assertPurpose(purpose: string): ConsentPurpose {
  if (!(CONSENT_PURPOSES as readonly string[]).includes(purpose))
    throw validation("Finalidad inválida")
  return purpose as ConsentPurpose
}

/** Finalidad de consentimiento que exige cada kind antes de enviar. */
export function purposeOfKind(kind: string): ConsentPurpose {
  if (kind === "campana") return "marketing"
  if (kind === "recordatorio_cita" || kind === "recordatorio_control") return "recordatorio"
  return "seguimiento"
}

/** Lee la config JSONB de una regla campo por campo (sin casts ciegos). */
function configOf(value: unknown): RuleConfig {
  const config: RuleConfig = {}
  if (typeof value !== "object" || value === null) return config
  if ("hoursBefore" in value && Array.isArray(value.hoursBefore)) {
    const hours = value.hoursBefore.filter((h): h is number => typeof h === "number")
    if (hours.length > 0) config.hoursBefore = hours
  }
  if ("delayHours" in value && typeof value.delayHours === "number")
    config.delayHours = value.delayHours
  if ("inactiveDays" in value && typeof value.inactiveDays === "number") {
    config.inactiveDays = value.inactiveDays
  }
  if ("quietStart" in value && typeof value.quietStart === "string")
    config.quietStart = value.quietStart
  if ("quietEnd" in value && typeof value.quietEnd === "string") config.quietEnd = value.quietEnd
  if ("startsAt" in value && typeof value.startsAt === "string") config.startsAt = value.startsAt
  if ("endsAt" in value && typeof value.endsAt === "string") config.endsAt = value.endsAt
  if ("segment" in value && typeof value.segment === "object" && value.segment !== null) {
    const raw = value.segment
    const segment: NonNullable<RuleConfig["segment"]> = {}
    if ("tags" in raw && Array.isArray(raw.tags)) {
      const tags = raw.tags.filter((t): t is string => typeof t === "string")
      if (tags.length > 0) segment.tags = tags
    }
    if ("opportunityStageIds" in raw && Array.isArray(raw.opportunityStageIds)) {
      const stages = raw.opportunityStageIds.filter((s): s is string => typeof s === "string")
      if (stages.length > 0) segment.opportunityStageIds = stages
    }
    if ("inactiveDays" in raw && typeof raw.inactiveDays === "number") {
      segment.inactiveDays = raw.inactiveDays
    }
    config.segment = segment
  }
  return config
}

export interface JobPayload {
  text?: string
  templateName?: string | null
  templateLanguage?: string
  quietStart?: string
  quietEnd?: string
  timeZone?: string
  controlId?: string
  campaign?: string
}

/** Lee el payload JSONB de un trabajo campo por campo (sin casts ciegos). */
function payloadOf(value: unknown): JobPayload {
  const payload: JobPayload = {}
  if (typeof value !== "object" || value === null) return payload
  if ("text" in value && typeof value.text === "string") payload.text = value.text
  if (
    "templateName" in value &&
    (typeof value.templateName === "string" || value.templateName === null)
  ) {
    payload.templateName = value.templateName
  }
  if ("templateLanguage" in value && typeof value.templateLanguage === "string") {
    payload.templateLanguage = value.templateLanguage
  }
  if ("quietStart" in value && typeof value.quietStart === "string")
    payload.quietStart = value.quietStart
  if ("quietEnd" in value && typeof value.quietEnd === "string") payload.quietEnd = value.quietEnd
  if ("timeZone" in value && typeof value.timeZone === "string") payload.timeZone = value.timeZone
  if ("controlId" in value && typeof value.controlId === "string")
    payload.controlId = value.controlId
  if ("campaign" in value && typeof value.campaign === "string") payload.campaign = value.campaign
  return payload
}

export async function listRules(tx: Db, orgId: string): Promise<RuleRow[]> {
  return tx
    .select()
    .from(automationRule)
    .where(eq(automationRule.organizationId, orgId))
    .orderBy(asc(automationRule.kind), asc(automationRule.name))
}

export interface CreateRuleInput {
  name: string
  kind: string
  channel?: string
  enabled?: boolean
  templateName?: string | null
  templateLanguage?: string
  /** JSON validado en ruta; se normaliza con configOf antes de persistir. */
  config?: unknown
}

export async function createRule(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateRuleInput,
): Promise<RuleRow> {
  const name = input.name?.trim()
  if (!name || name.length > 120) throw validation("El nombre debe tener 1–120 caracteres")
  const kind = assertKind(input.kind)
  const channel = assertChannel(input.channel ?? "whatsapp")
  if (
    input.templateName !== undefined &&
    input.templateName !== null &&
    input.templateName.trim() === ""
  ) {
    throw validation("El nombre de la plantilla no puede estar vacío")
  }
  const [row] = await tx
    .insert(automationRule)
    .values({
      organizationId: orgId,
      name,
      kind,
      channel,
      enabled: input.enabled ?? true,
      templateName: input.templateName?.trim() || null,
      templateLanguage: input.templateLanguage?.trim() || "es_PE",
      config: configOf(input.config),
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw new Error("No se pudo crear la regla")
  await audit(tx, orgId, actorUserId, "automation_rule.created", row.id, { kind, channel })
  return row
}

export async function updateRule(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: Partial<CreateRuleInput>,
): Promise<RuleRow> {
  const [existing] = await tx
    .select()
    .from(automationRule)
    .where(and(eq(automationRule.id, id), eq(automationRule.organizationId, orgId)))
    .limit(1)
  if (!existing) throw notFound("Regla de automatización")
  const patch: Partial<typeof automationRule.$inferInsert> = { updatedAt: new Date() }
  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name || name.length > 120) throw validation("El nombre debe tener 1–120 caracteres")
    patch.name = name
  }
  if (input.kind !== undefined) patch.kind = assertKind(input.kind)
  if (input.channel !== undefined) patch.channel = assertChannel(input.channel)
  if (input.enabled !== undefined) patch.enabled = input.enabled
  if (input.templateName !== undefined) patch.templateName = input.templateName?.trim() || null
  if (input.templateLanguage !== undefined)
    patch.templateLanguage = input.templateLanguage.trim() || "es_PE"
  if (input.config !== undefined) patch.config = configOf(input.config)
  const [row] = await tx
    .update(automationRule)
    .set(patch)
    .where(and(eq(automationRule.id, id), eq(automationRule.organizationId, orgId)))
    .returning()
  if (!row) throw notFound("Regla de automatización")
  await audit(tx, orgId, actorUserId, "automation_rule.updated", row.id, { enabled: row.enabled })
  return row
}

// ---------------------------------------------------------- consentimiento ---

export type ConsentRow = typeof automationConsent.$inferSelect

export async function listConsents(
  tx: Db,
  orgId: string,
  contactId: string,
): Promise<ConsentRow[]> {
  return tx
    .select()
    .from(automationConsent)
    .where(
      and(eq(automationConsent.organizationId, orgId), eq(automationConsent.contactId, contactId)),
    )
    .orderBy(asc(automationConsent.purpose), asc(automationConsent.channel))
}

/** Registra o actualiza el opt-in/opt-out de un contacto (idempotente). */
export async function setConsent(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  contactId: string,
  input: { purpose: string; channel: string; granted: boolean; source?: string },
): Promise<ConsentRow> {
  const purpose = assertPurpose(input.purpose)
  const channel = assertChannel(input.channel)
  const [contactRow] = await tx
    .select({ id: contact.id })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!contactRow) throw notFound("Contacto")
  const status = input.granted ? "granted" : "revoked"
  const [row] = await tx
    .insert(automationConsent)
    .values({
      organizationId: orgId,
      contactId,
      purpose,
      channel,
      status,
      source: input.source?.trim() || (actorUserId ? "recepcion" : "enlace"),
      createdBy: actorUserId,
    })
    .onConflictDoUpdate({
      target: [
        automationConsent.organizationId,
        automationConsent.contactId,
        automationConsent.purpose,
        automationConsent.channel,
      ],
      set: { status, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error("No se pudo registrar el consentimiento")
  await audit(tx, orgId, actorUserId, "automation_consent.set", row.id, {
    contactId,
    purpose,
    channel,
    status,
  })
  if (!input.granted) {
    // Baja verificable: cancela lo pendiente de esa finalidad/canal.
    await tx
      .update(automationJob)
      .set({ status: "cancelado", lastError: "Baja del contacto", updatedAt: new Date() })
      .where(
        and(
          eq(automationJob.organizationId, orgId),
          eq(automationJob.contactId, contactId),
          eq(automationJob.channel, channel),
          eq(automationJob.status, "pendiente"),
        ),
      )
  }
  return row
}

/** true solo con opt-in explícito vigente para finalidad + canal. */
export async function hasConsent(
  tx: Db,
  orgId: string,
  contactId: string,
  purpose: ConsentPurpose,
  channel: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: automationConsent.status })
    .from(automationConsent)
    .where(
      and(
        eq(automationConsent.organizationId, orgId),
        eq(automationConsent.contactId, contactId),
        eq(automationConsent.purpose, purpose),
        eq(automationConsent.channel, channel),
      ),
    )
    .limit(1)
  return row?.status === "granted"
}

// ------------------------------------------------------------------ trabajos ---

export type JobRow = typeof automationJob.$inferSelect

export async function listJobs(
  tx: Db,
  orgId: string,
  input: { status?: string; kind?: string; limit?: number },
): Promise<JobRow[]> {
  const conditions = [eq(automationJob.organizationId, orgId)]
  if (input.status) {
    if (!(AUTOMATION_JOB_STATUSES as readonly string[]).includes(input.status)) {
      throw validation("Estado inválido")
    }
    conditions.push(eq(automationJob.status, input.status))
  }
  if (input.kind) conditions.push(eq(automationJob.kind, assertKind(input.kind)))
  return tx
    .select()
    .from(automationJob)
    .where(and(...conditions))
    .orderBy(desc(automationJob.scheduledFor))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200))
}

export async function cancelJob(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
): Promise<JobRow> {
  const [row] = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: "Cancelado manualmente", updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.id, id),
        eq(automationJob.organizationId, orgId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .returning()
  if (!row) throw notFound("Trabajo pendiente")
  await audit(tx, orgId, actorUserId, "automation_job.cancelled", row.id, { kind: row.kind })
  return row
}

/**
 * Destinatario del aviso de fallo: creador de la regla si sigue en la
 * organización; si no, el primer owner/admin. Null si nadie califica.
 */
export async function failureRecipient(
  tx: Db,
  orgId: string,
  createdBy: string | null,
): Promise<string | null> {
  if (createdBy) {
    const [creator] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, orgId), eq(member.userId, createdBy)))
      .limit(1)
    if (creator) return creator.userId
  }
  const [admin] = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])))
    .limit(1)
  return admin?.userId ?? null
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string | null,
  action: string,
  entityId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "automation",
    entityId,
    metadata: metadata ?? {},
  })
}

async function notify(tx: Db, payload: Record<string, unknown>): Promise<void> {
  await tx.execute(sql`select pg_notify('org_events', ${JSON.stringify(payload)})`)
}

// ------------------------------------------------- programación (dedupe) ---

export interface EnqueueInput {
  ruleId?: string | null
  kind: string
  channel: string
  dedupeKey: string
  scheduledFor: Date
  contactId?: string | null
  appointmentId?: string | null
  patientId?: string | null
  budgetId?: string | null
  /** Oportunidad origen (campañas por etapa, cierres exactos). */
  opportunityId?: string | null
  payload?: Record<string, unknown>
}

/**
 * Inserta un trabajo durable; el unique (org, dedupe_key) evita duplicados
 * aunque el tick o el evento se repitan. Devuelve null si ya existía.
 */
export async function enqueueJob(
  tx: Db,
  orgId: string,
  input: EnqueueInput,
): Promise<JobRow | null> {
  assertKind(input.kind)
  assertChannel(input.channel)
  const [row] = await tx
    .insert(automationJob)
    .values({
      organizationId: orgId,
      ruleId: input.ruleId ?? null,
      kind: input.kind,
      channel: input.channel,
      status: "pendiente",
      dedupeKey: input.dedupeKey,
      scheduledFor: input.scheduledFor,
      contactId: input.contactId ?? null,
      appointmentId: input.appointmentId ?? null,
      patientId: input.patientId ?? null,
      budgetId: input.budgetId ?? null,
      opportunityId: input.opportunityId ?? null,
      payload: input.payload ?? {},
    })
    .onConflictDoNothing({
      target: [automationJob.organizationId, automationJob.dedupeKey],
    })
    .returning()
  return row ?? null
}

/** Contacto preferido del paciente (self/preferido) para dirigir el mensaje. */
async function preferredContact(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const rows = await tx
    .select({ contactId: patientContact.contactId, isPreferred: patientContact.isPreferred })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, orgId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(contact.isActive, true),
      ),
    )
    .limit(5)
  if (rows.length === 0) return null
  return (rows.find((r) => r.isPreferred) ?? rows[0])!.contactId
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Crea un enlace seguro de un solo uso lógico (se marca usedAt al usarlo). */
async function createLinkToken(
  tx: Db,
  orgId: string,
  input: {
    purpose: string
    jobId?: string | null
    appointmentId?: string | null
    contactId?: string | null
    ttlHours: number
    now: Date
  },
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await tx.insert(automationLinkToken).values({
    tokenHash: hashToken(token),
    organizationId: orgId,
    purpose: input.purpose,
    jobId: input.jobId ?? null,
    appointmentId: input.appointmentId ?? null,
    contactId: input.contactId ?? null,
    expiresAt: new Date(input.now.getTime() + input.ttlHours * 3_600_000),
  })
  return token
}

/** Enlace amable de la plataforma (origen público, sin sesión): /c/ o /baja/. */
function publicLink(baseUrl: string, path: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/${path}/${token}`
}

/**
 * Cancela lo pendiente de un contacto (gancho para Oportunidades al
 * ganar/perder, o baja manual). Devuelve trabajos cancelados.
 */
export async function cancelPendingJobsForContact(
  tx: Db,
  orgId: string,
  contactId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.contactId, contactId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .returning({ id: automationJob.id })
  return rows.length
}

export interface CampaignPreview {
  total: number
  consentidos: number
  sinConsentimiento: number
  /** Muestra explícita (20 primeros por id) para inspección, no para conteo. */
  sample: Array<{ id: string; displayName: string }>
}

export interface SegmentInput {
  tags?: string[]
  opportunityStageIds?: string[]
  channel?: string
}

/**
 * Condiciones SQL del segmento sobre contact: etiquetas (overlap) y etapas
 * de oportunidad abierta (EXISTS correlacionado, sin paginación silenciosa).
 */
function segmentConditions(
  tx: Db,
  orgId: string,
  segment: { tags?: string[]; opportunityStageIds?: string[] },
) {
  const conds = [eq(contact.organizationId, orgId), eq(contact.isActive, true)]
  if (segment.tags?.length) conds.push(arrayOverlaps(contact.tags, segment.tags))
  if (segment.opportunityStageIds?.length) {
    conds.push(
      exists(
        tx
          .select({ one: sql`1` })
          .from(opportunity)
          .where(
            and(
              eq(opportunity.organizationId, orgId),
              eq(opportunity.contactId, contact.id),
              eq(opportunity.status, "open"),
              inArray(opportunity.stageId, segment.opportunityStageIds),
            ),
          ),
      ),
    )
  }
  return conds
}

function marketingConsentCondition(tx: Db, orgId: string, channel: string) {
  return exists(
    tx
      .select({ one: sql`1` })
      .from(automationConsent)
      .where(
        and(
          eq(automationConsent.organizationId, orgId),
          eq(automationConsent.contactId, contact.id),
          eq(automationConsent.purpose, "marketing"),
          eq(automationConsent.channel, channel),
          eq(automationConsent.status, "granted"),
        ),
      ),
  )
}

/**
 * Oportunidad abierta más reciente del contacto en las etapas dadas.
 * Da el linkage exacto oportunidad→trabajo en campañas por etapa.
 */
async function matchingOpportunity(
  tx: Db,
  orgId: string,
  contactId: string,
  stageIds: string[],
): Promise<string | null> {
  const [opp] = await tx
    .select({ id: opportunity.id })
    .from(opportunity)
    .where(
      and(
        eq(opportunity.organizationId, orgId),
        eq(opportunity.contactId, contactId),
        eq(opportunity.status, "open"),
        inArray(opportunity.stageId, stageIds),
      ),
    )
    .orderBy(desc(opportunity.updatedAt))
    .limit(1)
  return opp?.id ?? null
}

/**
 * Vista previa de campaña: conteos SQL totales (sin caps silenciosos) más
 * muestra explícita de 20. El conteo de consentidos usa la misma base.
 */
export async function previewCampaignSegment(
  tx: Db,
  orgId: string,
  input: SegmentInput,
): Promise<CampaignPreview> {
  const channel = input.channel ? assertChannel(input.channel) : "whatsapp"
  const base = segmentConditions(tx, orgId, input)
  const [t] = await tx
    .select({ n: count() })
    .from(contact)
    .where(and(...base))
  const [c] = await tx
    .select({ n: count() })
    .from(contact)
    .where(and(...base, marketingConsentCondition(tx, orgId, channel)))
  const sample = await tx
    .select({ id: contact.id, displayName: contact.displayName })
    .from(contact)
    .where(and(...base))
    .orderBy(asc(contact.id))
    .limit(20)
  const total = Number(t?.n ?? 0)
  const consentidos = Number(c?.n ?? 0)
  return { total, consentidos, sinConsentimiento: total - consentidos, sample }
}

async function timezoneOf(tx: Db, orgId: string, branchId?: string | null): Promise<string> {
  if (branchId) {
    const [b] = await tx
      .select({ timezone: branch.timezone })
      .from(branch)
      .where(and(eq(branch.id, branchId), eq(branch.organizationId, orgId)))
      .limit(1)
    if (b?.timezone) return b.timezone
  }
  const [profile] = await tx
    .select({ timezone: orgProfile.timezone })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return profile?.timezone ?? NEUTRAL_TIMEZONE
}

/** true si `now` cae en la ventana de silencio (regla de horarios por sede). */
export function inQuietHours(now: Date, timeZone: string, start?: string, end?: string): boolean {
  const s = start ?? "21:00"
  const e = end ?? "08:00"
  // Lectura técnica de la hora (HH:mm) para comparar, no un texto para personas.
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now)
  const [h, m] = parts.split(":").map(Number)
  const cur = (h ?? 0) * 60 + (m ?? 0)
  const toMin = (v: string) => {
    const [hh, mm] = v.split(":").map(Number)
    return (hh ?? 0) * 60 + (mm ?? 0)
  }
  const from = toMin(s)
  const to = toMin(e)
  if (from === to) return false
  if (from < to) return cur >= from && cur < to
  return cur >= from || cur < to
}

/** Pospone al primer instante fuera de la ventana de silencio (pasos de 15 min, máx. 24 h). */
function afterQuietEnd(now: Date, timeZone: string, start?: string, end?: string): Date {
  let candidate = new Date(now.getTime() + 15 * 60_000)
  for (let i = 0; i < 96; i++) {
    if (!inQuietHours(candidate, timeZone, start, end)) return candidate
    candidate = new Date(candidate.getTime() + 15 * 60_000)
  }
  return candidate
}

// ------------------------------------------------------- sincronización ---

export interface SyncSummary {
  programados: number
  omitidos: number
}

const COMMERCIAL_QUIET_START = "20:00"
const COMMERCIAL_QUIET_END = "08:00"

export interface TemplateChannel {
  identityId: string
  connectionId: string
  channel: string
  template: { name: string; language: string }
}

/**
 * Convención: la plantilla con la que se retoma un seguimiento en frío es la
 * aprobada cuyo nombre lo dice («seguimiento…», «follow_up…») y no lleva
 * variables (se envía sin parámetros). Sin una así no se propone nada: jamás
 * se sustituye por otra plantilla de la conexión.
 */
const FOLLOW_UP_TEMPLATE = /seguimiento|follow[-_ ]?up/i

/**
 * Canal por el que la clínica puede iniciar un hilo en frío con este contacto:
 * contacto activo con identidad de WhatsApp (el único canal que abre
 * conversación sin mensaje previo, siempre con plantilla), consentimiento
 * vigente para la finalidad, conexión activa con una plantilla de seguimiento
 * aprobada y ningún hilo previo con esa persona en la conexión (si ya conversa,
 * no es un inicio en frío: decide una persona). No crea nada.
 */
export async function findTemplateChannel(
  tx: Db,
  orgId: string,
  contactId: string,
  purpose: ConsentPurpose,
  secretsKey: Buffer,
): Promise<TemplateChannel | null> {
  const [person] = await tx
    .select({ isActive: contact.isActive })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  if (!person?.isActive) return null
  const [identity] = await tx
    .select()
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.contactId, contactId),
        eq(contactIdentity.channel, "whatsapp"),
      ),
    )
    .orderBy(desc(contactIdentity.isPrimary), asc(contactIdentity.createdAt), asc(contactIdentity.id))
    .limit(1)
  if (!identity) return null
  if (!(await hasConsent(tx, orgId, contactId, purpose, identity.channel))) return null
  const connections = await tx
    .select({ id: channelConnection.id })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, identity.channel),
        eq(channelConnection.status, "active"),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
    .limit(5)
  for (const connection of connections) {
    const [thread] = await tx
      .select({ id: conversation.id })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.contactId, contactId),
          eq(conversation.contactIdentityId, identity.id),
          eq(conversation.channelConnectionId, connection.id),
        ),
      )
      .limit(1)
    if (thread) return null
    let templates: { name: string; language: string }[]
    try {
      templates = await getConnectionTemplates(tx, orgId, connection.id, secretsKey)
    } catch {
      // Configuración ilegible (clave rotada, dato corrupto): esa conexión no
      // sirve, pero no puede tumbar el tick de la organización.
      continue
    }
    const template = templates.find((t) => FOLLOW_UP_TEMPLATE.test(t.name))
    if (template) {
      return { identityId: identity.id, connectionId: connection.id, channel: identity.channel, template }
    }
  }
  return null
}

/**
 * Convierte una próxima acción comercial vencida en una sola decisión durable.
 * No agenda otra reiteración: una nueva coordinación exige que una persona
 * vuelva a fijar `nextActionAt`.
 *
 * Sin conversación vinculada, el agente no conversa: si existe un canal con
 * plantillas y consentimiento, propone al equipo abrir el hilo con la plantilla
 * aprobada (sin modelo, determinista) y la propuesta espera en el panel; si no,
 * deriva a una persona como siempre.
 */
export async function syncOverdueCommercialFollowUps(
  tx: Db,
  orgId: string,
  now: Date,
  opts: { secretsKey?: Buffer } = {},
): Promise<SyncSummary> {
  await reconcileProposedCoordinations(tx, orgId)
  const rows = await tx
    .select({
      taskId: crmTask.id,
      opportunityId: crmTask.opportunityId,
      conversationId: crmTask.conversationId,
      contactId: crmTask.contactId,
      assigneeUserId: crmTask.assigneeUserId,
      dueAt: crmTask.dueAt,
      agentStatus: conversation.agentStatus,
      channel: channelConnection.channel,
      connectionStatus: channelConnection.status,
      agentEnabled: agentConfig.enabled,
    })
    .from(crmTask)
    .innerJoin(
      opportunity,
      and(
        eq(opportunity.id, crmTask.opportunityId),
        eq(opportunity.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(
      conversation,
      and(
        eq(conversation.id, crmTask.conversationId),
        eq(conversation.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(
      channelConnection,
      and(
        eq(channelConnection.id, conversation.channelConnectionId),
        eq(channelConnection.organizationId, crmTask.organizationId),
      ),
    )
    .leftJoin(agentConfig, eq(agentConfig.organizationId, crmTask.organizationId))
    .where(
      and(
        eq(crmTask.organizationId, orgId),
        eq(crmTask.kind, "opportunity_follow_up"),
        eq(crmTask.status, "open"),
        lte(crmTask.dueAt, now),
        eq(opportunity.status, "open"),
        sql`${opportunity.nextActionAt} = ${crmTask.dueAt}`,
        // Lo ya coordinado para este vencimiento no vuelve a ocupar el lote:
        // con atraso acumulado, los 25 más antiguos taparían a los nuevos.
        sql`not exists (
          select 1 from commercial_follow_up_coordination c
          where c.organization_id = ${crmTask.organizationId} and c.task_id = ${crmTask.id}
            and c.trigger_due_at = date_trunc('milliseconds', ${crmTask.dueAt}))`,
      ),
    )
    .orderBy(asc(crmTask.dueAt), asc(crmTask.id))
    .limit(25)
  const timeZone = await timezoneOf(tx, orgId)
  let programados = 0
  let omitidos = 0
  // Sin hilo no hay interlocutor que confirme: con esa política se deriva.
  let coldAllowed: boolean | null = null
  for (const row of rows) {
    if (!row.opportunityId || !row.dueAt) continue
    if (
      row.conversationId &&
      row.channel &&
      row.agentStatus === "on" &&
      row.connectionStatus === "active" &&
      row.agentEnabled &&
      inQuietHours(now, timeZone, COMMERCIAL_QUIET_START, COMMERCIAL_QUIET_END)
    ) {
      continue
    }
    let reason: string | null = null
    let cold: TemplateChannel | null = null
    if (!row.conversationId) {
      reason = "La próxima acción no tiene una conversación vinculada"
      if (row.contactId && row.agentEnabled && opts.secretsKey) {
        coldAllowed ??= (await getAutonomyPolicy(tx, orgId)).enviar_mensaje !== "confirmar_usuario"
        if (coldAllowed) {
          cold = await findTemplateChannel(tx, orgId, row.contactId, "seguimiento", opts.secretsKey)
        }
      }
    } else if (row.agentStatus !== "on") reason = "El agente está desactivado en la conversación"
    else if (!row.agentEnabled) reason = "El agente está desactivado en la organización"
    else if (!row.channel || row.connectionStatus !== "active") reason = "El canal no está disponible"
    else if (!row.contactId || !(await hasConsent(tx, orgId, row.contactId, "seguimiento", row.channel))) {
      reason = "No existe consentimiento vigente para seguimiento en el canal"
    }
    const derive = reason !== null && cold === null
    const recipient = derive ? await failureRecipient(tx, orgId, row.assigneeUserId) : null
    const [created] = await tx
      .insert(commercialFollowUpCoordination)
      .values({
        organizationId: orgId,
        taskId: row.taskId,
        opportunityId: row.opportunityId,
        conversationId: row.conversationId,
        triggerDueAt: row.dueAt,
        status: derive ? "derivada" : cold ? "propuesta" : "pendiente",
        reason: derive ? reason : null,
        result: derive ? { code: "HUMAN_REQUIRED" } : null,
        nextResponsibleKind: derive ? (recipient ? "user" : "team") : cold ? "team" : "agent",
        nextResponsibleUserId: recipient,
        decidedAt: derive ? now : null,
      })
      .onConflictDoNothing()
      .returning({ id: commercialFollowUpCoordination.id })
    if (!created) continue
    const deriveCreated = async (why: string) => {
      omitidos++
      const who = recipient ?? (await failureRecipient(tx, orgId, row.assigneeUserId))
      await tx
        .update(commercialFollowUpCoordination)
        .set({
          status: "derivada",
          reason: why,
          result: { code: "HUMAN_REQUIRED" },
          nextResponsibleKind: who ? "user" : "team",
          nextResponsibleUserId: who,
          decidedAt: now,
          updatedAt: now,
        })
        .where(eq(commercialFollowUpCoordination.id, created.id))
      if (who) {
        await createWorkspaceNotification(tx, orgId, {
          userId: who,
          dedupeKey: `commercial-coordination:${created.id}`,
          title: "Seguimiento comercial requiere intervención",
          body: why,
          href: `/tasks?task=${row.taskId}`,
          permission: "tasks.read",
        })
      }
      await audit(tx, orgId, null, "commercial_follow_up.derived", created.id, {
        taskId: row.taskId,
        opportunityId: row.opportunityId,
        reason: why,
      })
    }
    if (derive) {
      await deriveCreated(reason as string)
      continue
    }
    if (cold) {
      // Propuesta determinista al equipo: nada sale hasta que una persona la aprueba.
      const [opp] = await tx
        .select({ title: opportunity.title, note: opportunity.nextActionNote })
        .from(opportunity)
        .where(and(eq(opportunity.id, row.opportunityId), eq(opportunity.organizationId, orgId)))
        .limit(1)
      try {
        const proposal = await createProposal(tx, orgId, {
          contactId: row.contactId as string,
          action: "enviar_mensaje",
          payload: {
            kind: "template",
            name: cold.template.name,
            language: cold.template.language,
            connectionId: cold.connectionId,
            identityId: cold.identityId,
            opportunityId: row.opportunityId,
            followUpDueAt: row.dueAt.toISOString(),
          },
          reason: `Seguimiento vencido sin conversación (${opp?.title ?? "oportunidad"}${opp?.note ? `: ${opp.note}` : ""}). Abrir WhatsApp con la plantilla aprobada «${cold.template.name}».`,
          idempotencyKey: `commercial-coordination:${created.id}`,
          requireTeamDecision: true,
        })
        await tx
          .update(commercialFollowUpCoordination)
          .set({
            reason: proposal.reason,
            result: { proposalId: proposal.id, proposalStatus: proposal.status },
            updatedAt: now,
          })
          .where(eq(commercialFollowUpCoordination.id, created.id))
        await audit(tx, orgId, null, "commercial_follow_up.proposed", created.id, {
          taskId: row.taskId,
          opportunityId: row.opportunityId,
          proposalId: proposal.id,
        })
        programados++
      } catch (error) {
        // Regla de dominio (p. ej. otra propuesta proactiva pendiente para el
        // contacto): deriva. Un conflicto de clave nace de un error SQL que ya
        // abortó la transacción: se propaga y el siguiente tick lo reintenta.
        if (!(error instanceof ServiceError) || error.code === "PROPOSAL_CONFLICT") throw error
        await deriveCreated(`${reason}. ${error.message}`)
      }
      continue
    }
    if (!row.conversationId) throw new Error("La coordinación encolable perdió su conversación")
    await sendAgentRun(tx, {
      kind: "overdue_opportunity_follow_up",
      orgId,
      conversationId: row.conversationId,
      coordinationId: created.id,
    })
    programados++
    await audit(tx, orgId, null, "commercial_follow_up.queued", created.id, {
      taskId: row.taskId,
      opportunityId: row.opportunityId,
    })
  }
  return { programados, omitidos }
}

/**
 * Programa recordatorios de citas próximas (ventana 72 h). Idempotente por
 * dedupe `recordatorio_cita:<cita>:<horas>`. El texto incluye enlaces seguros
 * de confirmar/cancelar (token de 72 h, sin exponer al paciente).
 */
export async function syncAppointmentReminders(
  tx: Db,
  orgId: string,
  now: Date,
  publicBaseUrl: string,
): Promise<SyncSummary> {
  const rules = await tx
    .select()
    .from(automationRule)
    .where(
      and(
        eq(automationRule.organizationId, orgId),
        eq(automationRule.kind, "recordatorio_cita"),
        eq(automationRule.enabled, true),
      ),
    )
  let programados = 0
  let omitidos = 0
  if (rules.length === 0) return { programados, omitidos }
  const horizon = new Date(now.getTime() + 72 * 3_600_000)
  const upcoming = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gte(appointment.startsAt, now),
        lte(appointment.startsAt, horizon),
      ),
    )
    .limit(200)
  for (const rule of rules) {
    const config = configOf(rule.config)
    const hoursList = config.hoursBefore?.length ? config.hoursBefore : [24, 3]
    const tz = await timezoneOf(tx, orgId, null)
    for (const appt of upcoming) {
      const contactId = await preferredContact(tx, orgId, appt.patientId)
      if (!contactId) {
        omitidos++
        continue
      }
      for (const h of hoursList) {
        const scheduledFor = new Date(appt.startsAt.getTime() - h * 3_600_000)
        if (scheduledFor.getTime() < now.getTime() - 30 * 60_000) continue
        const dedupeKey = `recordatorio_cita:${appt.id}:${h}`
        const job = await enqueueJob(tx, orgId, {
          ruleId: rule.id,
          kind: "recordatorio_cita",
          channel: rule.channel,
          dedupeKey,
          scheduledFor: scheduledFor < now ? now : scheduledFor,
          contactId,
          appointmentId: appt.id,
          patientId: appt.patientId,
          payload: {},
        })
        if (!job) continue
        // Enlaces seguros creados junto al trabajo (un par por cita).
        const confirmToken = await createLinkToken(tx, orgId, {
          purpose: "confirm",
          jobId: job.id,
          appointmentId: appt.id,
          contactId,
          ttlHours: 72,
          now,
        })
        const cancelToken = await createLinkToken(tx, orgId, {
          purpose: "cancel",
          jobId: job.id,
          appointmentId: appt.id,
          contactId,
          ttlHours: 72,
          now,
        })
        const apptTz = await timezoneOf(tx, orgId, appt.branchId)
        const { locale: apptLocale } = await findOrgLocale(tx, orgId)
        const when = new Intl.DateTimeFormat(apptLocale, {
          timeZone: apptTz,
          weekday: "long",
          day: "numeric",
          month: "long",
          hour: "2-digit",
          minute: "2-digit",
        }).format(appt.startsAt)
        const text =
          `Hola, le recordamos su cita odontológica del ${when}. ` +
          `Confirme aquí: ${publicLink(publicBaseUrl, "c", confirmToken)} ` +
          `Si no puede asistir, cancele aquí: ${publicLink(publicBaseUrl, "c", cancelToken)}`
        await tx
          .update(automationJob)
          .set({
            payload: {
              text,
              templateName: rule.templateName,
              templateLanguage: rule.templateLanguage,
              quietStart: config.quietStart,
              quietEnd: config.quietEnd,
              timeZone: tz,
            },
            updatedAt: new Date(),
          })
          .where(eq(automationJob.id, job.id))
        programados++
      }
    }
  }
  return { programados, omitidos }
}

/** Seguimiento de presupuestos presentados sin decisión tras delayHours (48 h). */
export async function syncBudgetFollowUps(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rules = await tx
    .select()
    .from(automationRule)
    .where(
      and(
        eq(automationRule.organizationId, orgId),
        eq(automationRule.kind, "seguimiento_presupuesto"),
        eq(automationRule.enabled, true),
      ),
    )
  let programados = 0
  let omitidos = 0
  for (const rule of rules) {
    const config = configOf(rule.config)
    const delayHours = config.delayHours ?? 48
    const cutoff = new Date(now.getTime() - delayHours * 3_600_000)
    const pending = await tx
      .select()
      .from(treatmentBudget)
      .where(
        and(
          eq(treatmentBudget.organizationId, orgId),
          eq(treatmentBudget.status, "presentado"),
          lte(treatmentBudget.presentedAt, cutoff),
        ),
      )
      .limit(100)
    for (const budget of pending) {
      const contactId =
        budget.decisionContactId ?? (await preferredContact(tx, orgId, budget.patientId))
      if (!contactId) {
        omitidos++
        continue
      }
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "seguimiento_presupuesto",
        channel: rule.channel,
        dedupeKey: `seguimiento_presupuesto:${budget.id}`,
        scheduledFor: now,
        contactId,
        patientId: budget.patientId,
        budgetId: budget.id,
        payload: {
          text: `Hola, su presupuesto "${budget.title}" sigue pendiente de decisión. Responda a este mensaje si desea retomarlo o ajustar opciones.`,
          templateName: rule.templateName,
          templateLanguage: rule.templateLanguage,
          quietStart: config.quietStart,
          quietEnd: config.quietEnd,
        },
      })
      if (job) programados++
    }
  }
  return { programados, omitidos }
}

/** Seguimiento post-cita (atendida) y de no asistencia. */
export async function syncVisitFollowUps(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  let programados = 0
  let omitidos = 0
  const kinds = ["seguimiento_cita", "seguimiento_no_asistencia"] as const
  for (const kind of kinds) {
    const rules = await tx
      .select()
      .from(automationRule)
      .where(
        and(
          eq(automationRule.organizationId, orgId),
          eq(automationRule.kind, kind),
          eq(automationRule.enabled, true),
        ),
      )
    for (const rule of rules) {
      const config = configOf(rule.config)
      const delayHours = config.delayHours ?? 24
      const cutoff = new Date(now.getTime() - delayHours * 3_600_000)
      const wanted = kind === "seguimiento_cita" ? "atendida" : "no_asistio"
      const visits = await tx
        .select()
        .from(appointment)
        .where(
          and(
            eq(appointment.organizationId, orgId),
            eq(appointment.status, wanted),
            lte(appointment.updatedAt, cutoff),
          ),
        )
        .limit(100)
      for (const appt of visits) {
        const contactId = await preferredContact(tx, orgId, appt.patientId)
        if (!contactId) {
          omitidos++
          continue
        }
        const text =
          kind === "seguimiento_cita"
            ? "Hola, ¿cómo se siente tras su atención? Si tiene molestias o dudas, responda a este mensaje y le ayudamos."
            : "Hola, notamos que no pudo asistir a su cita. Responda a este mensaje para reprogramarla sin costo de gestión."
        const job = await enqueueJob(tx, orgId, {
          ruleId: rule.id,
          kind,
          channel: rule.channel,
          dedupeKey: `${kind}:${appt.id}`,
          scheduledFor: now,
          contactId,
          appointmentId: appt.id,
          patientId: appt.patientId,
          payload: {
            text,
            templateName: rule.templateName,
            templateLanguage: rule.templateLanguage,
            quietStart: config.quietStart,
            quietEnd: config.quietEnd,
          },
        })
        if (job) programados++
      }
    }
  }
  return { programados, omitidos }
}

/** Recuperación de pacientes inactivos (sin citas recientes ni futuras). */
export async function syncInactiveRecall(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rules = await tx
    .select()
    .from(automationRule)
    .where(
      and(
        eq(automationRule.organizationId, orgId),
        eq(automationRule.kind, "recuperacion_inactivo"),
        eq(automationRule.enabled, true),
      ),
    )
  let programados = 0
  let omitidos = 0
  for (const rule of rules) {
    const config = configOf(rule.config)
    const inactiveDays = config.inactiveDays ?? 180
    const cutoff = new Date(now.getTime() - inactiveDays * 86_400_000)
    const month = now.toISOString().slice(0, 7)
    // Pacientes cuya última cita es anterior al corte y sin citas futuras.
    const rows = await tx.execute<{ patient_id: string }>(sql`
      select a.patient_id from appointment a
      where a.organization_id = ${orgId}
      group by a.patient_id
      having max(a.starts_at) < ${cutoff.toISOString()}::timestamptz
      limit 50`)
    const list = Array.isArray(rows) ? rows : []
    for (const r of list) {
      const future = await tx
        .select({ id: appointment.id })
        .from(appointment)
        .where(
          and(
            eq(appointment.organizationId, orgId),
            eq(appointment.patientId, r.patient_id),
            gte(appointment.startsAt, now),
            inArray(appointment.status, ["programada", "confirmada"]),
          ),
        )
        .limit(1)
      if (future.length > 0) continue
      const contactId = await preferredContact(tx, orgId, r.patient_id)
      if (!contactId) {
        omitidos++
        continue
      }
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "recuperacion_inactivo",
        channel: rule.channel,
        dedupeKey: `recuperacion_inactivo:${r.patient_id}:${month}`,
        scheduledFor: now,
        contactId,
        patientId: r.patient_id,
        payload: {
          text: "Hola, hace tiempo no nos visita. Su control preventivo es importante: responda a este mensaje y le reservamos un horario.",
          templateName: rule.templateName,
          templateLanguage: rule.templateLanguage,
          quietStart: config.quietStart,
          quietEnd: config.quietEnd,
        },
      })
      if (job) programados++
    }
  }
  return { programados, omitidos }
}

/** Ventana del recordatorio de control: avisa de los controles que vencen en estas horas. */
export const CHECKUP_REMINDER_WINDOW_HOURS = 48

/** Recordatorio de controles clínicos próximos (48 h). */
export async function syncCheckupReminders(tx: Db, orgId: string, now: Date): Promise<SyncSummary> {
  const rules = await tx
    .select()
    .from(automationRule)
    .where(
      and(
        eq(automationRule.organizationId, orgId),
        eq(automationRule.kind, "recordatorio_control"),
        eq(automationRule.enabled, true),
      ),
    )
  let programados = 0
  let omitidos = 0
  for (const rule of rules) {
    const config = configOf(rule.config)
    const horizon = new Date(now.getTime() + CHECKUP_REMINDER_WINDOW_HOURS * 3_600_000)
    const due = await tx
      .select()
      .from(clinicalFollowUp)
      .where(
        and(
          eq(clinicalFollowUp.organizationId, orgId),
          inArray(clinicalFollowUp.status, ["pendiente", "programado"]),
          gte(clinicalFollowUp.dueAt, now),
          lte(clinicalFollowUp.dueAt, horizon),
        ),
      )
      .limit(100)
    for (const control of due) {
      const contactId = await preferredContact(tx, orgId, control.patientId)
      if (!contactId) {
        omitidos++
        continue
      }
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "recordatorio_control",
        channel: rule.channel,
        dedupeKey: `recordatorio_control:${control.id}`,
        scheduledFor: now,
        contactId,
        patientId: control.patientId,
        payload: {
          text: `Hola, tiene pendiente el control "${control.title}". Responda para coordinar su atención. Este aviso no confirma una reserva.`,
          controlId: control.id,
          templateName: rule.templateName,
          templateLanguage: rule.templateLanguage,
          quietStart: config.quietStart,
          quietEnd: config.quietEnd,
        },
      })
      if (job) programados++
    }
  }
  return { programados, omitidos }
}

/**
 * Campañas segmentadas: contactos activos del segmento con marketing
 * consentido. Sin consentimiento explícito no se programa (se cuenta como
 * omitido visible en resultados). Límite 200 contactos por tick.
 */
export async function syncCampaigns(
  tx: Db,
  orgId: string,
  now: Date,
  publicBaseUrl: string,
): Promise<SyncSummary> {
  const rules = await tx
    .select()
    .from(automationRule)
    .where(
      and(
        eq(automationRule.organizationId, orgId),
        eq(automationRule.kind, "campana"),
        eq(automationRule.enabled, true),
      ),
    )
  let programados = 0
  let omitidos = 0
  for (const rule of rules) {
    const config = configOf(rule.config)
    if (config.startsAt && new Date(config.startsAt) > now) continue
    if (config.endsAt && new Date(config.endsAt) < now) {
      await tx
        .update(automationRule)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(automationRule.id, rule.id))
      continue
    }
    const segment = config.segment ?? {}
    // Progreso durable vía la tabla de trabajos: excluye contactos que ya
    // tienen un trabajo de esta regla (cualquier estado) y avanza por id.
    // Sin cursor en memoria: cada tick toma los siguientes 200 pendientes.
    const alreadyProcessed = exists(
      tx
        .select({ one: sql`1` })
        .from(automationJob)
        .where(
          and(
            eq(automationJob.organizationId, orgId),
            eq(automationJob.ruleId, rule.id),
            eq(automationJob.contactId, contact.id),
          ),
        ),
    )
    const candidates = await tx
      .select({ id: contact.id })
      .from(contact)
      .where(and(...segmentConditions(tx, orgId, segment), sql`not ${alreadyProcessed}`))
      .orderBy(asc(contact.id))
      .limit(200)
    for (const candidate of candidates) {
      const ok = await hasConsent(tx, orgId, candidate.id, "marketing", rule.channel)
      const opportunityId =
        ok && segment.opportunityStageIds?.length
          ? await matchingOpportunity(tx, orgId, candidate.id, segment.opportunityStageIds)
          : null
      const job = await enqueueJob(tx, orgId, {
        ruleId: rule.id,
        kind: "campana",
        channel: rule.channel,
        dedupeKey: `campana:${rule.id}:${candidate.id}`,
        scheduledFor: now,
        contactId: candidate.id,
        opportunityId,
        payload: {},
      })
      if (!job) continue // procesado por un tick concurrente
      if (!ok) {
        // Sin opt-in no hay envío: queda registrado como omitido (visible en
        // resultados) y no vuelve a ocupar el cupo del tick.
        await tx
          .update(automationJob)
          .set({
            status: "omitido",
            lastError: `Sin opt-in de marketing por ${rule.channel}`,
            updatedAt: new Date(),
          })
          .where(eq(automationJob.id, job.id))
        omitidos++
        continue
      }
      const bajaUrl = await createUnsubscribeLink(tx, orgId, candidate.id, publicBaseUrl)
      await tx
        .update(automationJob)
        .set({
          payload: {
            text:
              `Hola, ${rule.name}: responda a este mensaje si desea más información. ` +
              `Para no recibir más mensajes, abra este enlace: ${bajaUrl}`,
            templateName: rule.templateName,
            templateLanguage: rule.templateLanguage,
            quietStart: config.quietStart,
            quietEnd: config.quietEnd,
            campaign: rule.name,
          },
          updatedAt: new Date(),
        })
        .where(eq(automationJob.id, job.id))
      programados++
    }
  }
  return { programados, omitidos }
}

// ------------------------------------------------- resolución y entrega ---

async function resolveConversation(
  tx: Db,
  orgId: string,
  contactId: string,
  channel: string,
): Promise<{ conversationId: string } | { error: string; code?: string }> {
  const identities = await tx
    .select()
    .from(contactIdentity)
    .where(and(eq(contactIdentity.organizationId, orgId), eq(contactIdentity.contactId, contactId)))
    .limit(10)
  const identity =
    identities.find((i) => i.channel === channel && i.isPrimary) ??
    identities.find((i) => i.channel === channel)
  if (!identity) return { error: "El contacto no tiene identidad en ese canal" }
  const [connection] = await tx
    .select()
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.channel, identity.channel),
        eq(channelConnection.status, "active"),
      ),
    )
    .limit(1)
  if (!connection) return { error: "No hay conexión activa para ese canal" }
  try {
    const conv = await startContactConversation(tx, orgId, null, contactId, {
      identityId: identity.id,
      connectionId: connection.id,
    })
    return { conversationId: conv.id }
  } catch (e) {
    if (e instanceof ServiceError) return { error: e.message, code: e.code }
    return { error: "No se pudo abrir la conversación" }
  }
}

/** Verifica que el motivo del trabajo siga vigente; si se resolvió, lo cancela. */
async function stillValid(
  tx: Db,
  orgId: string,
  job: JobRow,
): Promise<{ valid: boolean; reason?: string }> {
  if (job.kind === "recordatorio_cita" && job.appointmentId) {
    const [appt] = await tx
      .select({ status: appointment.status, startsAt: appointment.startsAt })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    if (!["programada", "confirmada"].includes(appt.status)) {
      return { valid: false, reason: `La cita ya está ${appt.status}` }
    }
    if (appt.startsAt.getTime() < Date.now() - 60_000) {
      return { valid: false, reason: "La cita ya pasó" }
    }
    return { valid: true }
  }
  if (job.kind === "seguimiento_presupuesto" && job.budgetId) {
    const [budget] = await tx
      .select({ status: treatmentBudget.status })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, job.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget) return { valid: false, reason: "El presupuesto ya no existe" }
    if (budget.status !== "presentado") {
      return { valid: false, reason: `El presupuesto ya está ${budget.status}` }
    }
    return { valid: true }
  }
  if (
    (job.kind === "seguimiento_cita" || job.kind === "seguimiento_no_asistencia") &&
    job.appointmentId
  ) {
    const [appt] = await tx
      .select({ status: appointment.status })
      .from(appointment)
      .where(and(eq(appointment.id, job.appointmentId), eq(appointment.organizationId, orgId)))
      .limit(1)
    if (!appt) return { valid: false, reason: "La cita ya no existe" }
    const wanted = job.kind === "seguimiento_cita" ? "atendida" : "no_asistio"
    if (appt.status !== wanted) return { valid: false, reason: `La cita cambió a ${appt.status}` }
    return { valid: true }
  }
  if (job.kind === "recordatorio_control") {
    const { controlId } = payloadOf(job.payload)
    if (controlId) {
      const [control] = await tx
        .select({ status: clinicalFollowUp.status, appointmentStatus: appointment.status })
        .from(clinicalFollowUp)
        .leftJoin(
          appointment,
          and(
            eq(appointment.id, clinicalFollowUp.appointmentId),
            eq(appointment.organizationId, clinicalFollowUp.organizationId),
          ),
        )
        .where(and(eq(clinicalFollowUp.id, controlId), eq(clinicalFollowUp.organizationId, orgId)))
        .limit(1)
      if (!control) return { valid: false, reason: "El control ya no existe" }
      if (!["pendiente", "programado"].includes(control.status)) {
        return { valid: false, reason: `El control ya está ${control.status}` }
      }
      if (control.appointmentStatus === "atendida")
        return { valid: false, reason: "El control está pendiente de cierre clínico" }
    }
    return { valid: true }
  }
  if (job.contactId) {
    const [c] = await tx
      .select({ isActive: contact.isActive })
      .from(contact)
      .where(and(eq(contact.id, job.contactId), eq(contact.organizationId, orgId)))
      .limit(1)
    if (!c) return { valid: false, reason: "El contacto ya no existe" }
    if (!c.isActive) return { valid: false, reason: "El contacto está archivado" }
  }
  return { valid: true }
}

export interface DeliverDeps {
  secretsKey: Buffer
}

export interface DeliverResult {
  jobId: string
  outcome: "enviado" | "pospuesto" | "omitido" | "cancelado" | "fallido"
  detail?: string
}

const MAX_ATTEMPTS = 5

/**
 * Códigos definitivos (sin reintento): ventana cerrada o inbound requerido
 * en Meta/Telegram, y validaciones (p. ej. plantilla no admitida). Solo los
 * fallos transitorios del proveedor reintentan; como el reintento corre en
 * una transacción que revierte el encolado al fallar, nunca duplica envíos.
 */
const DEFINITIVE_CODES = new Set(["WINDOW_CLOSED", "CHANNEL_REQUIRES_INBOUND", "VALIDATION"])

function isDefinitiveCode(code: string | undefined): boolean {
  return !!code && DEFINITIVE_CODES.has(code)
}

/** Códigos que cierran el trabajo sin reintentos (ventana/inbound/validación). */
export function isTerminalFailureCode(code: string | undefined): boolean {
  return isDefinitiveCode(code)
}

/**
 * Entrega un trabajo vencido: reclama la fila (FOR UPDATE), verifica ventana
 * de silencio, vigencia, consentimiento y canal, envía por el servicio de
 * conversaciones y actualiza estado + mensaje en la misma transacción.
 */
export async function deliverJob(
  tx: Db,
  orgId: string,
  jobId: string,
  now: Date,
  deps: DeliverDeps,
): Promise<DeliverResult> {
  const [job] = await tx
    .select()
    .from(automationJob)
    .where(
      and(
        eq(automationJob.id, jobId),
        eq(automationJob.organizationId, orgId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .for("update")
    .limit(1)
  if (!job) return { jobId, outcome: "omitido", detail: "Ya procesado" }
  const [rule] = job.ruleId
    ? await tx
        .select()
        .from(automationRule)
        .where(and(eq(automationRule.id, job.ruleId), eq(automationRule.organizationId, orgId)))
        .limit(1)
    : []
  const fail = async (detail: string, retryable: boolean): Promise<DeliverResult> => {
    const attempts = job.attempts + 1
    const status: AutomationJobStatus =
      !retryable || attempts >= MAX_ATTEMPTS ? "fallido" : "pendiente"
    await tx
      .update(automationJob)
      .set({
        attempts,
        status,
        lastError: detail,
        scheduledFor:
          status === "pendiente" ? new Date(now.getTime() + 15 * 60_000) : job.scheduledFor,
        updatedAt: new Date(),
      })
      .where(eq(automationJob.id, job.id))
    if (status === "fallido") {
      await audit(tx, orgId, null, "automation_job.failed", job.id, { kind: job.kind, detail })
      await notify(tx, {
        orgId,
        kind: "automation.job.failed",
        jobId: job.id,
        at: now.toISOString(),
      })
      // Aviso dirigido sin datos clínicos: creador de la regla o administrador.
      const recipient = await failureRecipient(tx, orgId, rule?.createdBy ?? null)
      if (recipient) {
        const ruleName = rule?.name ?? job.kind
        await createWorkspaceNotification(tx, orgId, {
          userId: recipient,
          dedupeKey: `automation-failed-${job.id}`,
          title: "Falló un envío automático",
          body: `La regla "${ruleName}" no pudo enviar un mensaje (${job.kind}) tras ${MAX_ATTEMPTS} intentos: ${detail}`,
          href: "/automations?estado=fallido",
          permission: "crm.read",
        })
      }
    }
    return { jobId: job.id, outcome: status === "fallido" ? "fallido" : "pospuesto", detail }
  }
  if (!rule || !rule.enabled) {
    await tx
      .update(automationJob)
      .set({
        status: "cancelado",
        lastError: "Regla desactivada o eliminada",
        updatedAt: new Date(),
      })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "cancelado", detail: "Regla desactivada" }
  }
  const payload = payloadOf(job.payload)
  const tz = payload.timeZone ?? (await timezoneOf(tx, orgId, null))
  if (inQuietHours(now, tz, payload.quietStart, payload.quietEnd)) {
    const later = afterQuietEnd(now, tz, payload.quietStart, payload.quietEnd)
    await tx
      .update(automationJob)
      .set({ scheduledFor: later, updatedAt: new Date() })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "pospuesto", detail: "Fuera del horario de envío" }
  }
  const validity = await stillValid(tx, orgId, job)
  if (!validity.valid) {
    await tx
      .update(automationJob)
      .set({ status: "cancelado", lastError: validity.reason, updatedAt: new Date() })
      .where(eq(automationJob.id, job.id))
    return { jobId: job.id, outcome: "cancelado", detail: validity.reason }
  }
  if (!job.contactId) return fail("Sin contacto destinatario", false)
  const purpose = purposeOfKind(job.kind)
  if (!(await hasConsent(tx, orgId, job.contactId, purpose, job.channel))) {
    await tx
      .update(automationJob)
      .set({
        status: "omitido",
        lastError: `Sin opt-in de ${purpose} por ${job.channel}`,
        updatedAt: new Date(),
      })
      .where(eq(automationJob.id, job.id))
    await audit(tx, orgId, null, "automation_job.skipped", job.id, {
      kind: job.kind,
      reason: "sin-consentimiento",
    })
    return { jobId: job.id, outcome: "omitido", detail: "Sin consentimiento" }
  }
  const resolved = await resolveConversation(tx, orgId, job.contactId, job.channel)
  if ("error" in resolved) return fail(resolved.error, !isDefinitiveCode(resolved.code))
  try {
    const sent = payload.templateName
      ? await sendTemplateOutbound(tx, orgId, deps.secretsKey, {
          conversationId: resolved.conversationId,
          senderKind: "agent",
          name: payload.templateName,
          language: payload.templateLanguage ?? "es_PE",
          params: [],
        })
      : await sendOutbound(tx, orgId, {
          conversationId: resolved.conversationId,
          senderKind: "agent",
          content: { type: "text", text: payload.text ?? "" },
        })
    await tx
      .update(automationJob)
      .set({
        status: "enviado",
        sentMessageId: sent.id,
        attempts: job.attempts + 1,
        updatedAt: new Date(),
      })
      .where(eq(automationJob.id, job.id))
    await audit(tx, orgId, null, "automation_job.sent", job.id, {
      kind: job.kind,
      messageId: sent.id,
    })
    return { jobId: job.id, outcome: "enviado" }
  } catch (e) {
    const code = e instanceof ServiceError ? e.code : undefined
    const detail = e instanceof ServiceError ? e.message : "Error al enviar"
    return fail(detail, !isDefinitiveCode(code))
  }
}

/** Reclama hasta `limit` trabajos vencidos (SKIP LOCKED) y los entrega. */
export async function deliverDueJobs(
  tx: Db,
  orgId: string,
  now: Date,
  deps: DeliverDeps,
  limit = 25,
): Promise<DeliverResult[]> {
  const due = await tx.execute<{ id: string }>(sql`
    select id from automation_job
    where organization_id = ${orgId}
      and status = 'pendiente'
      and scheduled_for <= ${now.toISOString()}::timestamptz
    order by scheduled_for asc
    limit ${limit}
    for update skip locked`)
  const rows = Array.isArray(due) ? due : []
  const results: DeliverResult[] = []
  for (const r of rows) {
    results.push(await deliverJob(tx, orgId, r.id, now, deps))
  }
  return results
}

/** Cancela lo pendiente de una cita al resolverse (confirmada/atendida/cancelada). */
export async function cancelPendingForAppointment(
  tx: Db,
  orgId: string,
  appointmentId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.appointmentId, appointmentId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .returning({ id: automationJob.id })
  return rows.length
}

/**
 * Cancela lo pendiente ligado a UNA oportunidad (gancho exacto para
 * closeOpportunity: otras oportunidades, recordatorios y controles del
 * contacto sobreviven). Los trabajos de campaña por etapa guardan
 * opportunityId al programarse.
 */
export async function cancelPendingJobsForOpportunity(
  tx: Db,
  orgId: string,
  opportunityId: string,
  reason: string,
): Promise<number> {
  const rows = await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: reason, updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.organizationId, orgId),
        eq(automationJob.opportunityId, opportunityId),
        eq(automationJob.status, "pendiente"),
      ),
    )
    .returning({ id: automationJob.id })
  return rows.length
}

// ------------------------------------------------------- enlaces públicos ---

export type LinkPurpose = "confirm" | "cancel" | "baja"

function assertLinkPurpose(purpose: string): LinkPurpose {
  if (purpose !== "confirm" && purpose !== "cancel" && purpose !== "baja") {
    throw validation("Enlace inválido")
  }
  return purpose
}

export interface PublicLinkInfo {
  purpose: LinkPurpose
  /** Fecha/hora de la cita en zona de la sede (sin datos del paciente). */
  when: string | null
  timeZone: string
  expired: boolean
  used: boolean
}

/** Información mínima del enlace: nunca incluye paciente ni contacto. */
export async function getPublicLinkInfo(tx: Db, token: string): Promise<PublicLinkInfo> {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .limit(1)
  if (!link) throw notFound("Enlace")
  const purpose = assertLinkPurpose(link.purpose)
  const expired = link.expiresAt.getTime() < Date.now()
  let when: string | null = null
  let timeZone = NEUTRAL_TIMEZONE
  if (link.appointmentId) {
    const [appt] = await tx
      .select({
        startsAt: appointment.startsAt,
        branchId: appointment.branchId,
        orgId: appointment.organizationId,
      })
      .from(appointment)
      .where(eq(appointment.id, link.appointmentId))
      .limit(1)
    if (appt) {
      timeZone = await timezoneOf(tx, appt.orgId, appt.branchId)
      const { locale } = await findOrgLocale(tx, appt.orgId)
      when = new Intl.DateTimeFormat(locale, {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      }).format(appt.startsAt)
    }
  }
  return { purpose, when, timeZone, expired, used: link.usedAt !== null }
}

async function useLinkToken(tx: Db, token: string, expected: LinkPurpose) {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .for("update")
    .limit(1)
  if (!link) throw notFound("Enlace")
  if (link.purpose !== expected) throw validation("Enlace inválido para esta acción")
  if (link.expiresAt.getTime() < Date.now())
    throw new ServiceError("LINK_EXPIRED", 409, "El enlace venció")
  if (link.usedAt) throw new ServiceError("LINK_USED", 409, "El enlace ya fue usado")
  if (!link.appointmentId && expected !== "baja") throw notFound("Cita")
  await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(eq(automationLinkToken.tokenHash, link.tokenHash))
  return link
}

/**
 * Invalida los enlaces de cita pendientes de una cita (hermanos del par
 * confirmar/cancelar y de trabajos anteriores). Gancho para Agenda en
 * mover/cancelar/atender. Devuelve enlaces invalidados.
 */
export async function invalidateAppointmentTokens(
  tx: Db,
  orgId: string,
  appointmentId: string,
): Promise<number> {
  const rows = await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(automationLinkToken.organizationId, orgId),
        eq(automationLinkToken.appointmentId, appointmentId),
        isNull(automationLinkToken.usedAt),
      ),
    )
    .returning({ tokenHash: automationLinkToken.tokenHash })
  return rows.length
}

/**
 * Transición por enlace público con fila bloqueada: solo desde estados
 * pendientes futuros (confirmar: programada; cancelar: programada o
 * confirmada). Nunca reabre canceladas ni toca atendidas/no asistidas.
 * Incrementa `version` (bloqueo optimista de Agenda), invalida hermanos y
 * audita con actor nulo (origen enlace, sin FK inventada).
 */
async function transitionAppointmentByToken(
  tx: Db,
  token: string,
  expected: LinkPurpose,
  toStatus: "confirmada" | "cancelada",
): Promise<{ appointmentId: string; status: string }> {
  const link = await useLinkToken(tx, token, expected)
  const [appt] = await tx
    .select()
    .from(appointment)
    .where(
      and(
        eq(appointment.id, link.appointmentId!),
        eq(appointment.organizationId, link.organizationId),
      ),
    )
    .for("update")
    .limit(1)
  if (!appt) throw notFound("Cita")
  const allowed = toStatus === "confirmada" ? ["programada"] : ["programada", "confirmada"]
  if (!allowed.includes(appt.status)) {
    throw new ServiceError("APPOINTMENT_NOT_PENDING", 409, `La cita ya está ${appt.status}`)
  }
  if (appt.startsAt.getTime() < Date.now()) {
    throw new ServiceError("APPOINTMENT_PAST", 409, "La cita ya pasó")
  }
  const [updated] = await tx
    .update(appointment)
    .set({ status: toStatus, version: appt.version + 1, updatedAt: new Date() })
    .where(and(eq(appointment.id, appt.id), eq(appointment.version, appt.version)))
    .returning({ id: appointment.id, status: appointment.status })
  if (!updated) throw new ServiceError("APPOINTMENT_CONFLICT", 409, "La cita cambió mientras tanto")
  await invalidateAppointmentTokens(tx, link.organizationId, appt.id)
  await cancelPendingForAppointment(
    tx,
    link.organizationId,
    appt.id,
    toStatus === "confirmada" ? "Cita confirmada por enlace" : "Cita cancelada por enlace",
  )
  await audit(tx, link.organizationId, null, "automation_appointment.status", appt.id, {
    from: appt.status,
    to: toStatus,
    via: "enlace-publico",
  })
  return { appointmentId: updated.id, status: updated.status }
}

/** Confirma la cita desde el enlace seguro (solo programada futura). */
export async function confirmAppointmentByToken(
  tx: Db,
  token: string,
): Promise<{ appointmentId: string; status: string }> {
  return transitionAppointmentByToken(tx, token, "confirm", "confirmada")
}

/** Cancela la cita desde el enlace seguro (solo programada/confirmada futura). */
export async function cancelAppointmentByToken(
  tx: Db,
  token: string,
): Promise<{ appointmentId: string; status: string }> {
  return transitionAppointmentByToken(tx, token, "cancel", "cancelada")
}

/** Baja verificable: revoca marketing + recordatorio/seguimiento y cancela pendientes. */
export async function unsubscribeByToken(tx: Db, token: string): Promise<{ contactId: string }> {
  const [link] = await tx
    .select()
    .from(automationLinkToken)
    .where(eq(automationLinkToken.tokenHash, hashToken(token)))
    .for("update")
    .limit(1)
  if (!link || link.purpose !== "baja") throw notFound("Enlace")
  if (link.expiresAt.getTime() < Date.now())
    throw new ServiceError("LINK_EXPIRED", 409, "El enlace venció")
  if (!link.contactId) throw notFound("Contacto")
  for (const purpose of ["marketing", "recordatorio", "seguimiento"] as const) {
    for (const channel of ["whatsapp", "telegram", "messenger", "instagram"] as const) {
      await tx
        .insert(automationConsent)
        .values({
          organizationId: link.organizationId,
          contactId: link.contactId,
          purpose,
          channel,
          status: "revoked",
          source: "enlace",
          createdBy: null,
        })
        .onConflictDoUpdate({
          target: [
            automationConsent.organizationId,
            automationConsent.contactId,
            automationConsent.purpose,
            automationConsent.channel,
          ],
          set: { status: "revoked", updatedAt: new Date() },
        })
    }
  }
  await tx
    .update(automationJob)
    .set({ status: "cancelado", lastError: "Baja por enlace", updatedAt: new Date() })
    .where(
      and(
        eq(automationJob.organizationId, link.organizationId),
        eq(automationJob.contactId, link.contactId),
        eq(automationJob.status, "pendiente"),
      ),
    )
  await tx
    .update(automationLinkToken)
    .set({ usedAt: new Date() })
    .where(eq(automationLinkToken.tokenHash, link.tokenHash))
  await audit(tx, link.organizationId, null, "automation_consent.unsubscribed", link.contactId, {})
  return { contactId: link.contactId }
}

/** Crea el enlace de baja de un contacto (se incluye en campañas y seguimientos). */
export async function createUnsubscribeLink(
  tx: Db,
  orgId: string,
  contactId: string,
  publicBaseUrl: string,
  ttlHours = 24 * 30,
): Promise<string> {
  const token = await createLinkToken(tx, orgId, {
    purpose: "baja",
    contactId,
    ttlHours,
    now: new Date(),
  })
  return publicLink(publicBaseUrl, "baja", token)
}

// ------------------------------------------------------------- tick (worker) ---

export interface TickDeps {
  secretsKey: Buffer
  publicBaseUrl: string
  limit?: number
}

export interface TickSummary {
  orgs: number
  programados: number
  coordinados: number
  entregados: number
  fallidos: number
}

/**
 * Tick real de automatizaciones para el worker: por cada organización,
 * sincroniza (programa con dedupe) y entrega lo vencido. Las orgs se listan
 * de la tabla global `organization` (sin RLS de tenant), así funciona con
 * RLS normal o FORCE: el trabajo siempre corre con `appDb` dentro de
 * `withOrgContext`. Despertador durable: pg_cron → pgmq `automation_ticks`.
 */
export async function tickAutomations(
  ownerDb: Db,
  appDb: Db,
  now: Date,
  deps: TickDeps,
): Promise<TickSummary> {
  const orgRows = await ownerDb.select({ orgId: organization.id }).from(organization)
  const summary: TickSummary = { orgs: 0, programados: 0, coordinados: 0, entregados: 0, fallidos: 0 }
  for (const { orgId } of orgRows) {
    summary.orgs++
    // Secuencial: las sincronizaciones comparten la transacción del tenant.
    const synced = await withOrgContext(appDb, orgId, async (tx) => {
      let total = 0
      const commercial = await syncOverdueCommercialFollowUps(tx, orgId, now, {
        secretsKey: deps.secretsKey,
      })
      total += (await syncAppointmentReminders(tx, orgId, now, deps.publicBaseUrl)).programados
      total += (await syncBudgetFollowUps(tx, orgId, now)).programados
      total += (await syncVisitFollowUps(tx, orgId, now)).programados
      total += (await syncInactiveRecall(tx, orgId, now)).programados
      total += (await syncCheckupReminders(tx, orgId, now)).programados
      total += (await syncCampaigns(tx, orgId, now, deps.publicBaseUrl)).programados
      return { total, coordinated: commercial.programados }
    })
    summary.programados += synced.total
    summary.coordinados += synced.coordinated
    const delivered = await withOrgContext(appDb, orgId, (tx) =>
      deliverDueJobs(tx, orgId, now, { secretsKey: deps.secretsKey }, deps.limit ?? 25),
    )
    for (const r of delivered) {
      if (r.outcome === "enviado") summary.entregados++
      if (r.outcome === "fallido") summary.fallidos++
    }
  }
  return summary
}
