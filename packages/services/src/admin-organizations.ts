import { randomUUID } from "node:crypto"
import { ROLE_LABELS } from "@odentia/auth/permissions"
import type { Db } from "@odentia/db"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import {
  accountLifecycleNotice,
  accountRecoveryCase,
  userGlobalBlock,
} from "@odentia/db/schema/admin-organizations"
import { account, invitation, member, organization, session, user } from "@odentia/db/schema/auth"
import { patient } from "@odentia/db/schema/clinical"
import { channelConnection, contact, message } from "@odentia/db/schema/crm"
import { auditEvent, branch, orgProfile } from "@odentia/db/schema/org"
import { saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm"
import { z } from "zod"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { ServiceError } from "./errors.js"

/**
 * Administración de organizaciones y usuarios.
 *
 * Todo recibe `tx: Db` con conexión owner (bypasea RLS) tras el guard de
 * staff; jamás se entrega al cliente. El rol de la clínica (`member.role`)
 * nunca concede staff: solo la tabla `admin_staff` decide. La suspensión
 * comercial vive en `saas_subscription`; aquí solo se muestra su resumen y
 * se distingue del bloqueo de seguridad/manual.
 */

// ---------------------------------------------------------------------------
// Tipos públicos (explícitos; sin ReturnType en el contrato)
// ---------------------------------------------------------------------------

import { initialOrgRegion } from "./organization-profile.js"
import { ensureLibrarySpecialties } from "./specialties.js"
import { type OrganizationBillingSummary, usageMonthBounds } from "./saas-billing.js"
import { type AiCostByOrigin, getAiCostByOrigin } from "./ai-usage.js"

/**
 * Resumen de suscripción visible para soporte: sin importes, sin comisiones
 * y sin precio del plan. Los datos de uso agregado no son sensibles y se
 * permiten. Solo admin ve el resumen completo.
 */
export interface RedactedBillingSummary {
  plan: { code: string; name: string; currency: string } | null
  status: OrganizationBillingSummary["status"]
  isDemo: boolean
  currency: string | null
  trialEndsAt: Date | null
  graceEndsAt: Date | null
  currentPeriodEnd: Date | null
  restricted: boolean
  restrictReason: string | null
  pauseReason: string | null
  proofExtensionUntil: Date | null
  usage30d: { agentRuns: number; llmCalls: number }
}

export type VisibleBillingSummary = OrganizationBillingSummary | RedactedBillingSummary

function redactBillingSummary(
  summary: OrganizationBillingSummary,
  actor: AdminActor | null,
): VisibleBillingSummary {
  if (!actor || actor.role === "admin") return summary
  return {
    plan: summary.plan
      ? { code: summary.plan.code, name: summary.plan.name, currency: summary.plan.currency }
      : null,
    status: summary.status,
    isDemo: summary.isDemo,
    currency: summary.currency,
    trialEndsAt: summary.trialEndsAt,
    graceEndsAt: summary.graceEndsAt,
    currentPeriodEnd: summary.currentPeriodEnd,
    restricted: summary.restricted,
    restrictReason: summary.restrictReason,
    pauseReason: summary.pauseReason,
    proofExtensionUntil: summary.proofExtensionUntil,
    usage30d: { agentRuns: summary.usage30d.agentRuns, llmCalls: summary.usage30d.llmCalls },
  }
}

export interface OrganizationBillingLoaders {
  getBillingSummary?: (tx: Db, organizationId: string) => Promise<OrganizationBillingSummary | null>
  startTrial?: (
    tx: Db,
    organizationId: string,
    opts: {
      planCode?: string
      sellerId?: string
      isDemo?: boolean
      billingStart?: "trial" | "now"
    },
  ) => Promise<unknown>
}

export interface OrganizationListItem {
  id: string
  name: string
  slug: string
  createdAt: Date
  memberCount: number
  ownerCount: number
  pendingInvitations: number
  hasProfile: boolean
  hasBranch: boolean
  billingStatus: OrganizationBillingSummary["status"] | null
  restricted: boolean
  /** Precio negociado vigente (issue 168): para la etiqueta «20 % negociado · vence 30 abr». */
  negotiated: { discountBps: number; endsAt: Date | null } | null
}

export interface OrganizationList {
  items: OrganizationListItem[]
  total: number
}

export interface OrgMemberItem {
  userId: string
  name: string
  email: string
  emailVerified: boolean
  role: string
  memberSince: Date
  blocked: boolean
}

export interface OrgInvitationItem {
  id: string
  organizationId: string
  email: string
  role: string | null
  status: string
  expiresAt: Date
  createdAt: Date
}

export interface OrgBranchItem {
  id: string
  name: string
  isActive: boolean
  timezone: string | null
}

export interface OrgActivityItem {
  action: string
  actorRole: string | null
  createdAt: Date
}

export interface OrgChannelStatus {
  channel: string
  status: string
}

export interface OrganizationDetail {
  id: string
  name: string
  slug: string
  createdAt: Date
  profile: {
    legalName: string
    tradeName: string | null
    countryCode: string
    currency: string
    timezone: string
    locale: string
  } | null
  provisioning: { hasProfile: boolean; hasBranch: boolean; complete: boolean }
  members: OrgMemberItem[]
  invitations: OrgInvitationItem[]
  branches: OrgBranchItem[]
  usage: {
    members: number
    branches: number
    patients: number
    contacts: number
    pendingInvitations: number
    messages30d: number
    channels: OrgChannelStatus[]
    lastSessionActivityAt: Date | null
  }
  activity: OrgActivityItem[]
  billing: VisibleBillingSummary | null
  /**
   * Costo real de IA del mes calendario de la clínica, por origen (ADR 0031),
   * en millonésimas de USD. Solo para el rol admin: null para soporte.
   */
  aiCost: { periodLabel: string; totalMicros: number | null; unpricedCalls: number; byOrigin: AiCostByOrigin[] } | null
}
/**
 * Subdominios reservados: nunca son slugs de tenant (colisionarían con las
 * apps/infra). La API la reutiliza; el alta del panel la repite porque el panel
 * no depende de ningún paquete del dominio (y el servidor vuelve a validarla).
 */
export const RESERVED_ORG_SLUGS: Record<string, true> = {
  api: true,
  app: true,
  admin: true,
  www: true,
  storage: true,
}
export interface AssistedOrganizationInput {
  orgName: string
  slug: string
  email: string
  countryCode: string
  currency?: string
  timezone?: string
  billingStart?: "trial" | "now"
  planCode?: string
  sellerId?: string
  isDemo?: boolean
}

export interface AssistedOrganizationResult {
  organizationId: string
  slug: string
  status: "invitada"
  /** Cuenta existente con ese correo, si la hay (solo informativo). */
  userId: string | null
  invitationId: string
}

export interface AdminUserItem {
  id: string
  name: string
  email: string
  emailVerified: boolean
  createdAt: Date
  blocked: boolean
  blockReason: string | null
  providers: string[]
  lastSessionActivityAt: Date | null
  organizationCount: number
}
export interface AdminUserList {
  items: AdminUserItem[]
  total: number
}

export interface AdminUserSession {
  id: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  updatedAt: Date
  activeOrganizationId: string | null
  current: boolean
}

export interface AdminUserDetail extends AdminUserItem {
  firstName: string
  lastName: string
  image: string | null
  sessions: AdminUserSession[]
  memberships: { organizationId: string; organizationName: string; slug: string; role: string }[]
  invitations: {
    id: string
    organizationId: string
    organizationName: string
    role: string | null
    status: string
    expiresAt: Date
  }[]
  block: { reason: string; blockedAt: Date; expiresAt: Date | null } | null
  recoveryCases: { id: string; kind: string; status: string; createdAt: Date }[]
}

export interface PendingInvitation {
  id: string
  organizationId: string
  organizationName: string
  slug: string
  role: string | null
  roleLabel: string
  expiresAt: Date
  provisioning: { hasProfile: boolean; hasBranch: boolean }
}

export interface MyOrganization {
  organizationId: string
  organizationName: string
  slug: string
  /** Dirección pública del logo de la clínica, si subió uno en «Datos de la clínica». */
  logo: string | null
  role: string
  roleLabel: string
  /** false cuando es la única propietaria (el servidor también lo rechaza). */
  canLeave: boolean
  provisioning: { hasProfile: boolean; hasBranch: boolean }
}

export interface RecoveryEvidence {
  description: string
  verifiedBy: string
  verifiedAt: string
  method: string
  organizationId?: string
}

export interface RecoveryApproval {
  staffId: string
  role: string
  decision: "aprobar" | "rechazar"
  note?: string
  at: string
}

export interface RecoveryCaseDetail {
  id: string
  subjectUserId: string | null
  email: string
  kind: "acceso" | "propiedad"
  status: "pendiente" | "aprobada" | "rechazada" | "ejecutada"
  evidence: RecoveryEvidence
  requestedBy: string | null
  approvals: RecoveryApproval[]
  decidedBy: string | null
  decidedAt: Date | null
  executedAt: Date | null
  createdAt: Date
}

export interface RecoveryEffect {
  kind: "acceso" | "propiedad"
  email: string
  subjectUserId: string | null
  organizationId: string | null
}

export interface LifecycleCandidate {
  userId: string
  email: string
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Validación de borde (zod) y guards de rol interno
// ---------------------------------------------------------------------------

const emailSchema = z.string().trim().toLowerCase().email("Correo inválido").max(320)

const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, "Slug muy corto")
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug inválido (minúsculas, números y guiones)")

const reasonSchema = z.string().trim().min(10, "El motivo necesita al menos 10 caracteres").max(500)

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function conflict(message: string): ServiceError {
  return new ServiceError("CONFLICT", 409, message)
}

function gone(message: string): ServiceError {
  return new ServiceError("NOT_FOUND", 404, message)
}

function invalid(message: string): ServiceError {
  return new ServiceError("VALIDATION", 400, message)
}

/** Staff activo verificado por el guard; el worker (sistema) pasa null. */
function requireStaff(actor: AdminActor | null): AdminActor {
  if (!actor) throw forbidden("Se requiere personal de administración")
  return actor
}

function requireAdmin(actor: AdminActor | null): AdminActor {
  const staff = requireStaff(actor)
  if (staff.role !== "admin") throw forbidden("Solo un administrador puede hacer esto")
  return staff
}

function auditInput(
  action: string,
  organizationId: string | null,
  entityId: string | null,
  metadata: Record<string, unknown>,
): {
  action: string
  organizationId?: string | null
  entityId?: string | null
  metadata?: Record<string, unknown>
} {
  return { action, organizationId, entityId, metadata }
}

// ---------------------------------------------------------------------------
// Organizaciones: lista y ficha
// ---------------------------------------------------------------------------

export async function listOrganizations(
  tx: Db,
  actor: AdminActor | null,
  opts: { q?: string; limit?: number; offset?: number; negotiated?: boolean },
  loaders: OrganizationBillingLoaders = {},
): Promise<OrganizationList> {
  requireStaff(actor)
  const q = (opts.q ?? "").trim().slice(0, 120)
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const negotiatedSql = sql`${organization.id} in (select ${saasSubscription.organizationId} from ${saasSubscription}
    where ${saasSubscription.discountBps} > 0 and (${saasSubscription.discountEndsAt} is null or ${saasSubscription.discountEndsAt} > now()))`
  const filters = [
    ...(q ? [or(ilike(organization.name, `%${q}%`), ilike(organization.slug, `%${q}%`))] : []),
    ...(opts.negotiated ? [negotiatedSql] : []),
  ]
  const where = filters.length ? and(...filters) : undefined

  const rows = await tx
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .where(where)
    .orderBy(desc(organization.createdAt))
    .limit(limit)
    .offset(offset)
  const [{ n: total }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(organization)
    .where(where)
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))

  const items: OrganizationListItem[] = []
  for (const row of rows) {
    const [members] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(member)
      .where(eq(member.organizationId, row.id))
      .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
    const [owners] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(member)
      .where(and(eq(member.organizationId, row.id), eq(member.role, "owner")))
      .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(invitation)
      .where(and(eq(invitation.organizationId, row.id), eq(invitation.status, "pending")))
      .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
    const [profile] = await tx
      .select({ id: orgProfile.organizationId })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, row.id))
      .limit(1)
    const [sede] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.organizationId, row.id))
      .limit(1)
    let billingStatus: OrganizationListItem["billingStatus"] = null
    let restricted = false
    if (loaders.getBillingSummary) {
      // Sin fallback nulo: un fallo de Billing es error, jamás "sin dato".
      const summary = await loaders.getBillingSummary(tx, row.id)
      billingStatus = summary?.status ?? null
      restricted = summary?.restricted ?? false
    }
    const [deal] = await tx
      .select({ discountBps: saasSubscription.discountBps, endsAt: saasSubscription.discountEndsAt })
      .from(saasSubscription)
      .where(eq(saasSubscription.organizationId, row.id))
      .limit(1)
    const now = new Date()
    const negotiated =
      deal && deal.discountBps > 0 && (!deal.endsAt || deal.endsAt > now) ? { discountBps: deal.discountBps, endsAt: deal.endsAt } : null
    items.push({
      negotiated,
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      memberCount: members?.n ?? 0,
      ownerCount: owners?.n ?? 0,
      pendingInvitations: pending?.n ?? 0,
      hasProfile: Boolean(profile),
      hasBranch: Boolean(sede),
      billingStatus,
      restricted,
    })
  }
  return { items, total: total ?? 0 }
}

export async function getOrganizationDetail(
  tx: Db,
  actor: AdminActor | null,
  organizationId: string,
  loaders: OrganizationBillingLoaders = {},
): Promise<OrganizationDetail> {
  requireStaff(actor)
  const [org] = await tx
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  if (!org) throw gone("Organización no encontrada")

  const [profile] = await tx
    .select()
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, organizationId))
    .limit(1)
  const branches = await tx
    .select()
    .from(branch)
    .where(eq(branch.organizationId, organizationId))
    .orderBy(branch.name)
  const memberships = await tx
    .select({
      userId: member.userId,
      role: member.role,
      memberSince: member.createdAt,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
    .orderBy(member.createdAt)
  const memberIds = memberships.map((m) => m.userId)
  const blocks =
    memberIds.length > 0
      ? await tx
          .select({ userId: userGlobalBlock.userId })
          .from(userGlobalBlock)
          .where(and(eq(userGlobalBlock.active, true), inArray(userGlobalBlock.userId, memberIds)))
          .then((rows) => new Set(rows.map((r) => r.userId)))
      : new Set<string>()
  const invites = await tx
    .select()
    .from(invitation)
    .where(eq(invitation.organizationId, organizationId))
    .orderBy(desc(invitation.createdAt))
    .limit(50)
  const counts = await countUsage(tx, organizationId)
  // Solo traza del personal (admin_audit): jamás el audit_event clínico,
  // que expone operación de la clínica al rol support.
  const activity = await tx
    .select({
      action: adminAudit.action,
      actorRole: adminAudit.actorRole,
      createdAt: adminAudit.createdAt,
    })
    .from(adminAudit)
    .where(eq(adminAudit.organizationId, organizationId))
    .orderBy(desc(adminAudit.createdAt))
    .limit(20)
  const fullBilling = loaders.getBillingSummary
    ? await loaders.getBillingSummary(tx, organizationId)
    : null
  const billing = fullBilling ? redactBillingSummary(fullBilling, actor) : null
  let aiCost: OrganizationDetail["aiCost"] = null
  if (!actor || actor.role === "admin") {
    const month = usageMonthBounds(profile?.timezone ?? "UTC", new Date())
    const byOrigin = await getAiCostByOrigin(tx, organizationId, month)
    aiCost = {
      periodLabel: month.label,
      totalMicros: byOrigin.some((item) => item.costMicros !== null)
        ? byOrigin.reduce((total, item) => total + (item.costMicros ?? 0), 0)
        : null,
      unpricedCalls: byOrigin.reduce((total, item) => total + item.unpricedCalls, 0),
      byOrigin,
    }
  }

  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt,
    profile: profile
      ? {
          legalName: profile.legalName,
          tradeName: profile.tradeName,
          countryCode: profile.countryCode,
          currency: profile.currency,
          timezone: profile.timezone,
          locale: profile.locale,
        }
      : null,
    provisioning: {
      hasProfile: Boolean(profile),
      hasBranch: branches.length > 0,
      complete: Boolean(profile) && branches.length > 0,
    },
    members: memberships.map((m) => ({
      userId: m.userId,
      name: m.name,
      email: m.email,
      emailVerified: m.emailVerified,
      role: m.role,
      memberSince: m.memberSince,
      blocked: blocks.has(m.userId),
    })),
    invitations: invites.map((i) => ({
      id: i.id,
      organizationId,
      email: i.email,
      role: i.role,
      status: i.status,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    })),
    branches: branches.map((b) => ({
      id: b.id,
      name: b.name,
      isActive: b.isActive,
      timezone: b.timezone,
    })),
    usage: {
      members: memberships.length,
      branches: branches.length,
      patients: counts.patients,
      contacts: counts.contacts,
      pendingInvitations: invites.filter((i) => i.status === "pending").length,
      messages30d: counts.messages30d,
      channels: counts.channels,
      lastSessionActivityAt: counts.lastSessionActivityAt,
    },
    activity,
    billing,
    aiCost,
  }
}

/**
 * Agregados sin contenido: conteos y estados, nunca datos clínicos ni
 * mensajes. Sin try/catch: un fallo cuenta como error, jamás como cero.
 */
async function countUsage(
  tx: Db,
  organizationId: string,
): Promise<{
  patients: number
  contacts: number
  messages30d: number
  channels: OrgChannelStatus[]
  lastSessionActivityAt: Date | null
}> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  const [p] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(patient)
    .where(eq(patient.organizationId, organizationId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const [c] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(contact)
    .where(eq(contact.organizationId, organizationId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const [m] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(message)
    .where(and(eq(message.organizationId, organizationId), gte(message.createdAt, since30d)))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const channels = await tx
    .select({ channel: channelConnection.channel, status: channelConnection.status })
    .from(channelConnection)
    .where(eq(channelConnection.organizationId, organizationId))
    .orderBy(channelConnection.channel)
  return {
    patients: p?.n ?? 0,
    contacts: c?.n ?? 0,
    messages30d: m?.n ?? 0,
    channels,
    lastSessionActivityAt: await lastMemberSessionActivity(tx, organizationId),
  }
}

/** Última actividad de sesión del conjunto de miembros (no es un login). */
async function lastMemberSessionActivity(tx: Db, organizationId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ at: sql<Date | null>`max(${session.updatedAt})` })
    .from(session)
    .innerJoin(member, eq(member.userId, session.userId))
    .where(eq(member.organizationId, organizationId))
    .then((r) => (r.length > 0 ? r : [{ at: null }]))
  return row?.at ?? null
}

// ---------------------------------------------------------------------------
// Alta asistida: crear clínica e invitar sin duplicar cuenta ni organización
// ---------------------------------------------------------------------------

const assistedInputSchema = z.object({
  orgName: z.string().trim().min(2, "Nombre de la organización").max(120),
  slug: slugSchema,
  email: emailSchema,
  countryCode: z.string().trim().length(2, "País ISO de 2 letras"),
  currency: z.string().trim().length(3, "Moneda ISO de 3 letras").optional(),
  timezone: z.string().trim().max(60).optional(),
  billingStart: z.enum(["trial", "now"]).optional(),
  planCode: z.string().trim().min(1).max(60).optional(),
  sellerId: z.string().trim().max(120).optional(),
  isDemo: z.boolean().optional(),
})

/**
 * Alta asistida por staff (admin y support): crea la clínica una sola vez y
 * siempre deja invitación pendiente de propietaria, exista o no la cuenta.
 * Entrar exige aceptación; quien ya tiene cuenta acepta sin crear contraseña
 * nueva y el panel reanuda el alta con `?continue=` en vez de crear otra.
 * Inicia el periodo de prueba vía Billing dentro de la misma transacción.
 */
export async function createAssistedOrganization(
  tx: Db,
  actor: AdminActor | null,
  raw: AssistedOrganizationInput,
  loaders: OrganizationBillingLoaders = {},
): Promise<AssistedOrganizationResult> {
  const staff = requireStaff(actor)
  const parsed = assistedInputSchema.safeParse(raw)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Datos inválidos")
  const input = parsed.data
  if (RESERVED_ORG_SLUGS[input.slug]) throw invalid("Ese subdominio está reservado")
  const [slugTaken] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, input.slug))
    .limit(1)
  if (slugTaken) throw conflict("Ese subdominio ya está en uso")

  const organizationId = randomUUID()
  const now = new Date()
  // Decisiones comerciales solo admin: soporte crea en prueba sin plan, sin
  // vendedora y sin demo. El servidor lo exige aunque la UI oculte los campos.
  if (
    staff.role !== "admin" &&
    (input.sellerId || input.isDemo || input.planCode || input.billingStart === "now")
  ) {
    throw forbidden("Solo administración decide plan, cobro, vendedora o demo")
  }
  // Región validada sin inventar: el perfil mínimo nace real (razón social =
  // nombre dado, sin fiscales ficticios) para no repetirlo al reanudar.
  const region = initialOrgRegion({
    countryCode: input.countryCode,
    currency: input.currency,
    timezone: input.timezone,
  })
  await tx.insert(organization).values({
    id: organizationId,
    name: input.orgName,
    slug: input.slug,
    createdAt: now,
  })
  await tx.insert(orgProfile).values({
    organizationId,
    legalName: input.orgName,
    countryCode: region.countryCode,
    currency: region.currency,
    timezone: region.timezone,
    locale: region.locale,
    diagnosisSystem: region.diagnosisSystem,
  })
  // La clínica nace con las especialidades de la biblioteca (ADR 0039).
  await ensureLibrarySpecialties(tx, organizationId)
  if (loaders.startTrial) {
    await loaders.startTrial(tx, organizationId, {
      planCode: input.planCode,
      sellerId: input.sellerId,
      isDemo: input.isDemo,
      billingStart: input.billingStart ?? "trial",
    })
  }

  // Exista o no la cuenta, siempre invitación de propietaria: entrar exige
  // aceptación (autoridad/consentimiento). Quien ya tiene cuenta acepta sin
  // crear contraseña nueva; el staff jamás activa sesión ajena ni membra
  // directo por coincidir el correo.
  const [existing] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, input.email))
    .limit(1)
  const invitationId = randomUUID()
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  await tx.insert(invitation).values({
    id: invitationId,
    organizationId,
    email: input.email,
    role: "owner",
    status: "pending",
    expiresAt,
    inviterId: staff.userId,
  })
  await writeAdminAudit(
    tx,
    staff,
    auditInput("org.assisted_create_invited", organizationId, invitationId, {
      email: input.email,
      slug: input.slug,
      isDemo: input.isDemo ?? false,
      existingAccount: Boolean(existing),
    }),
  )
  // El correo lo envía la ruta tras el commit (nunca dentro de la tx).
  return {
    organizationId,
    slug: input.slug,
    status: "invitada",
    userId: existing?.id ?? null,
    invitationId,
  }
}

/**
 * Reenvío idempotente: si la invitación sigue pendiente y vigente, se
 * devuelve la misma fila (la ruta reenvía el correo con el mismo enlace);
 * si venció, se renueva el vencimiento sobre la misma fila para no duplicar.
 */
export async function resendOrganizationInvitation(
  tx: Db,
  actor: AdminActor | null,
  invitationId: string,
): Promise<OrgInvitationItem> {
  const staff = requireStaff(actor)
  const [row] = await tx.select().from(invitation).where(eq(invitation.id, invitationId)).limit(1)
  if (!row) throw gone("Invitación no encontrada")
  if (row.status !== "pending") throw conflict("La invitación ya fue resuelta")
  const now = new Date()
  const needsRenewal = row.expiresAt.getTime() <= now.getTime()
  const [updated] = needsRenewal
    ? await tx
        .update(invitation)
        .set({ expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000) })
        .where(eq(invitation.id, invitationId))
        .returning()
    : [row]
  await writeAdminAudit(
    tx,
    staff,
    auditInput("org.invitation_resend", row.organizationId, invitationId, {
      email: row.email,
      renewed: needsRenewal,
    }),
  )
  const done = updated ?? row
  return {
    id: done.id,
    organizationId: done.organizationId,
    email: done.email,
    role: done.role,
    status: done.status,
    expiresAt: done.expiresAt,
    createdAt: done.createdAt,
  }
}

export async function cancelOrganizationInvitation(
  tx: Db,
  actor: AdminActor | null,
  invitationId: string,
): Promise<void> {
  const staff = requireStaff(actor)
  const [row] = await tx.select().from(invitation).where(eq(invitation.id, invitationId)).limit(1)
  if (!row) throw gone("Invitación no encontrada")
  if (row.status !== "pending") throw conflict("La invitación ya fue resuelta")
  await tx.update(invitation).set({ status: "cancelled" }).where(eq(invitation.id, invitationId))
  await writeAdminAudit(
    tx,
    staff,
    auditInput("org.invitation_cancel", row.organizationId, invitationId, {
      email: row.email,
    }),
  )
}

// ---------------------------------------------------------------------------
// Usuarios: búsqueda, ficha, sesiones, roles, bloqueo, cierre
// ---------------------------------------------------------------------------

export async function searchUsers(
  tx: Db,
  actor: AdminActor | null,
  opts: {
    q?: string
    status?: "todos" | "activos" | "bloqueados" | "sin_verificar" | "sin_clinica"
    limit?: number
    offset?: number
  },
): Promise<AdminUserList> {
  requireStaff(actor)
  const q = (opts.q ?? "").trim().slice(0, 120)
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const status = opts.status ?? "todos"

  const conditions = []
  if (q) conditions.push(or(ilike(user.email, `%${q}%`), ilike(user.name, `%${q}%`)))
  if (status === "sin_verificar") conditions.push(eq(user.emailVerified, false))
  const where = conditions.length > 0 ? and(...conditions) : undefined

  const rows = await tx
    .select()
    .from(user)
    .where(where)
    .orderBy(desc(user.createdAt))
    .limit(limit)
    .offset(offset)
  const [{ n: total }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(where)
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))

  const items: AdminUserItem[] = []
  for (const row of rows) {
    const summary = await summarizeUser(tx, row.id)
    const blocked = summary.blocked
    if (status === "bloqueados" && !blocked) continue
    if (status === "activos" && (blocked || !row.emailVerified)) continue
    if (status === "sin_clinica" && summary.organizationCount > 0) continue
    items.push({
      id: row.id,
      name: row.name,
      email: row.email,
      emailVerified: row.emailVerified,
      createdAt: row.createdAt,
      blocked,
      blockReason: summary.blockReason,
      providers: summary.providers,
      lastSessionActivityAt: summary.lastSessionActivityAt,
      organizationCount: summary.organizationCount,
    })
  }
  return { items, total: total ?? 0 }
}

async function summarizeUser(
  tx: Db,
  userId: string,
): Promise<{
  blocked: boolean
  blockReason: string | null
  providers: string[]
  lastSessionActivityAt: Date | null
  organizationCount: number
}> {
  const [block] = await tx
    .select()
    .from(userGlobalBlock)
    .where(and(eq(userGlobalBlock.userId, userId), eq(userGlobalBlock.active, true)))
    .limit(1)
  const accounts = await tx
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId))
  const sessions = await tx
    .select({ updatedAt: session.updatedAt })
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt))
    .limit(1)
  const [memberships] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(eq(member.userId, userId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  return {
    blocked: Boolean(block),
    blockReason: block?.reason ?? null,
    providers: [...new Set(accounts.map((a) => a.providerId))],
    lastSessionActivityAt: sessions[0]?.updatedAt ?? null,
    organizationCount: memberships?.n ?? 0,
  }
}

export async function getUserDetail(
  tx: Db,
  actor: AdminActor | null,
  userId: string,
  opts: { currentToken?: string } = {},
): Promise<AdminUserDetail> {
  requireStaff(actor)
  const [row] = await tx.select().from(user).where(eq(user.id, userId)).limit(1)
  if (!row) throw gone("Usuario no encontrado")
  const summary = await summarizeUser(tx, userId)
  const sessions = await tx
    .select()
    .from(session)
    .where(eq(session.userId, userId))
    .orderBy(desc(session.updatedAt))
    .limit(50)
  const memberships = await tx
    .select({
      organizationId: member.organizationId,
      role: member.role,
      organizationName: organization.name,
      slug: organization.slug,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
  const invites = await tx
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(eq(invitation.email, row.email))
    .orderBy(desc(invitation.createdAt))
    .limit(20)
  const [block] = await tx
    .select()
    .from(userGlobalBlock)
    .where(and(eq(userGlobalBlock.userId, userId), eq(userGlobalBlock.active, true)))
    .limit(1)
  const cases = await tx
    .select({
      id: accountRecoveryCase.id,
      kind: accountRecoveryCase.kind,
      status: accountRecoveryCase.status,
      createdAt: accountRecoveryCase.createdAt,
    })
    .from(accountRecoveryCase)
    .where(
      or(eq(accountRecoveryCase.subjectUserId, userId), eq(accountRecoveryCase.email, row.email)),
    )
    .orderBy(desc(accountRecoveryCase.createdAt))
    .limit(10)
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    createdAt: row.createdAt,
    blocked: summary.blocked,
    blockReason: summary.blockReason,
    providers: summary.providers,
    lastSessionActivityAt: summary.lastSessionActivityAt,
    organizationCount: memberships.length,
    firstName: row.firstName,
    lastName: row.lastName,
    image: row.image,
    sessions: sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      activeOrganizationId: s.activeOrganizationId,
      current: opts.currentToken ? s.token === opts.currentToken : false,
    })),
    memberships,
    invitations: invites,
    block: block
      ? { reason: block.reason, blockedAt: block.blockedAt, expiresAt: block.expiresAt }
      : null,
    recoveryCases: cases,
  }
}

/** Corta sesiones sin borrar autoría: la fila de `user` se conserva siempre. */
export async function revokeUserSessions(
  tx: Db,
  actor: AdminActor | null,
  userId: string,
  token?: string,
): Promise<{ revoked: number }> {
  const staff = requireStaff(actor)
  const [exists] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1)
  if (!exists) throw gone("Usuario no encontrado")
  const removed =
    token !== undefined
      ? await tx
          .delete(session)
          .where(and(eq(session.userId, userId), eq(session.token, token)))
          .returning({ id: session.id })
      : await tx.delete(session).where(eq(session.userId, userId)).returning({ id: session.id })
  await writeAdminAudit(
    tx,
    staff,
    auditInput("user.sessions_revoke", null, userId, {
      single: token !== undefined,
      revoked: removed.length,
    }),
  )
  return { revoked: removed.length }
}

/** La clínica siempre conserva al menos un propietario: filas bloqueadas en orden estable + recheck. */
async function assertKeepsOwner(tx: Db, organizationId: string, userId: string): Promise<void> {
  const owners = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")))
    .orderBy(member.userId)
    .for("update")
  const others = owners.filter((o) => o.userId !== userId)
  if (others.length === 0) {
    throw conflict(
      "La clínica necesita al menos un Propietario: nombra otro antes de quitar a este.",
    )
  }
}

/**
 * Bloqueo global (solo admin, con motivo): corta todas las sesiones en la
 * misma transacción y conserva membresías y autoría. Difiere de quitar la
 * membresía: el bloqueo es de acceso a la cuenta, no de pertenencia.
 */
export async function setGlobalBlock(
  tx: Db,
  actor: AdminActor | null,
  args: { userId: string; reason: string; expiresAt?: Date },
): Promise<void> {
  const staff = requireAdmin(actor)
  const parsed = reasonSchema.safeParse(args.reason)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Motivo inválido")
  const [exists] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, args.userId))
    .limit(1)
  if (!exists) throw gone("Usuario no encontrado")
  await tx.delete(session).where(eq(session.userId, args.userId))
  await tx
    .insert(userGlobalBlock)
    .values({
      userId: args.userId,
      reason: parsed.data,
      blockedBy: staff.userId,
      expiresAt: args.expiresAt ?? null,
      active: true,
    })
    .onConflictDoUpdate({
      target: userGlobalBlock.userId,
      set: {
        reason: parsed.data,
        blockedBy: staff.userId,
        blockedAt: new Date(),
        expiresAt: args.expiresAt ?? null,
        active: true,
        unblockedBy: null,
        unblockedAt: null,
      },
    })
  await writeAdminAudit(
    tx,
    staff,
    auditInput("user.global_block", null, args.userId, {
      reason: parsed.data,
    }),
  )
}

export async function removeGlobalBlock(
  tx: Db,
  actor: AdminActor | null,
  userId: string,
): Promise<void> {
  const staff = requireAdmin(actor)
  await tx
    .update(userGlobalBlock)
    .set({ active: false, unblockedBy: staff.userId, unblockedAt: new Date() })
    .where(eq(userGlobalBlock.userId, userId))
  await writeAdminAudit(tx, staff, auditInput("user.global_unblock", null, userId, {}))
}

/**
 * Al cerrar una cuenta, su staff se desactiva en la misma tx. Usa la llave
 * consultiva global de `admin_staff` (misma que el núcleo: `hashtext` sobre
 * el nombre de la tabla) más filas bloqueadas en orden estable: ni cierres
 * concurrentes dejan cero admins.
 */
async function deactivateStaffOnClose(
  tx: Db,
  staff: AdminActor | null,
  userId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('admin_staff'))`)
  const [row] = await tx.select().from(adminStaff).where(eq(adminStaff.userId, userId)).limit(1)
  if (!row || !row.active) return
  if (row.role === "admin") {
    const admins = await tx
      .select({ userId: adminStaff.userId })
      .from(adminStaff)
      .where(and(eq(adminStaff.role, "admin"), eq(adminStaff.active, true)))
      .orderBy(adminStaff.userId)
      .for("update")
    if (!admins.some((a) => a.userId !== userId)) {
      throw conflict(
        "No se puede cerrar: es la última administración activa. Transfiere antes el rol.",
      )
    }
  }
  await tx.update(adminStaff).set({ active: false }).where(eq(adminStaff.userId, userId))
  await writeAdminAudit(
    tx,
    staff,
    auditInput("staff.deactivate_on_close", null, userId, { role: row.role }),
  )
}

/**
 * Cierre de cuenta (solo admin): revoca sesiones, retira membresías y deja
 * un bloqueo con el motivo del cierre. La fila de `user` nunca se borra:
 * auditoría, atenciones y comisiones conservan su autoría.
 */
export async function closeAccountByAdmin(
  tx: Db,
  actor: AdminActor | null,
  args: { userId: string; reason: string },
): Promise<void> {
  const staff = requireAdmin(actor)
  const parsed = reasonSchema.safeParse(args.reason)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Motivo inválido")
  const [exists] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, args.userId))
    .limit(1)
  if (!exists) throw gone("Usuario no encontrado")
  const memberships = await tx
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, args.userId))
  for (const m of memberships) {
    if (m.role === "owner") await assertKeepsOwner(tx, m.organizationId, args.userId)
  }
  await deactivateStaffOnClose(tx, staff, args.userId)
  await tx.delete(member).where(eq(member.userId, args.userId))
  await tx.delete(session).where(eq(session.userId, args.userId))
  await tx
    .insert(userGlobalBlock)
    .values({
      userId: args.userId,
      reason: `Cuenta cerrada: ${parsed.data}`,
      blockedBy: staff.userId,
      active: true,
    })
    .onConflictDoUpdate({
      target: userGlobalBlock.userId,
      set: {
        reason: `Cuenta cerrada: ${parsed.data}`,
        blockedBy: staff.userId,
        blockedAt: new Date(),
        expiresAt: null,
        active: true,
        unblockedBy: null,
        unblockedAt: null,
      },
    })
  await writeAdminAudit(
    tx,
    staff,
    auditInput("user.account_close", null, args.userId, {
      reason: parsed.data,
      membershipsRemoved: memberships.length,
    }),
  )
}

/**
 * Hook de AuthCore (createAuth `databaseHooks.session.create.before` y
 * `user.create.before`): con acceso owner explícito, deniega crear sesión o
 * cuenta si hay bloqueo activo. Cubre password, OAuth, verificación y
 * refresh; la recuperación no salta el bloqueo (las rutas la deniegan).
 */
export async function findActiveUserBlock(
  ownerDb: Db,
  userId: string,
): Promise<{ reason: string; expiresAt: Date | null } | null> {
  const [block] = await ownerDb
    .select({ reason: userGlobalBlock.reason, expiresAt: userGlobalBlock.expiresAt })
    .from(userGlobalBlock)
    .where(and(eq(userGlobalBlock.userId, userId), eq(userGlobalBlock.active, true)))
    .limit(1)
  if (!block) return null
  if (block.expiresAt && block.expiresAt.getTime() <= Date.now()) return null
  return { reason: block.reason, expiresAt: block.expiresAt }
}
export async function isUserBlocked(tx: Db, userId: string): Promise<boolean> {
  const [block] = await tx
    .select({ userId: userGlobalBlock.userId })
    .from(userGlobalBlock)
    .where(and(eq(userGlobalBlock.userId, userId), eq(userGlobalBlock.active, true)))
    .limit(1)
  return Boolean(block)
}

// ---------------------------------------------------------------------------
// Cuenta propia (panel): invitaciones, clínicas, salida y cierre
// ---------------------------------------------------------------------------

export async function listMyInvitations(tx: Db, email: string): Promise<PendingInvitation[]> {
  const normalized = emailSchema.safeParse(email)
  if (!normalized.success) return []
  const now = new Date()
  const rows = await tx
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      slug: organization.slug,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .where(and(eq(invitation.email, normalized.data), eq(invitation.status, "pending")))
    .orderBy(desc(invitation.createdAt))
    .limit(20)
  const live = rows.filter((r) => r.expiresAt.getTime() > now.getTime())
  const out: PendingInvitation[] = []
  for (const row of live) {
    const [profile] = await tx
      .select({ id: orgProfile.organizationId })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, row.organizationId))
      .limit(1)
    const [sede] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.organizationId, row.organizationId))
      .limit(1)
    out.push({
      id: row.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      slug: row.slug,
      role: row.role,
      roleLabel: roleLabelOf(row.role),
      expiresAt: row.expiresAt,
      provisioning: { hasProfile: Boolean(profile), hasBranch: Boolean(sede) },
    })
  }
  return out
}

export async function listMyOrganizations(tx: Db, userId: string): Promise<MyOrganization[]> {
  const rows = await tx
    .select({
      organizationId: member.organizationId,
      organizationName: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, userId))
    .orderBy(organization.name)
  const out: MyOrganization[] = []
  for (const row of rows) {
    const [profile] = await tx
      .select({ id: orgProfile.organizationId })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, row.organizationId))
      .limit(1)
    const [sede] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.organizationId, row.organizationId))
      .limit(1)
    out.push({
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      slug: row.slug,
      logo: row.logo ?? null,
      role: row.role,
      roleLabel: roleLabelOf(row.role),
      canLeave: await canLeaveOrganization(tx, userId, row.organizationId, row.role),
      provisioning: { hasProfile: Boolean(profile), hasBranch: Boolean(sede) },
    })
  }
  return out
}

/** Etiqueta canónica del rol (misma que la plataforma; el panel no duplica). */
function roleLabelOf(role: string | null): string {
  if (!role) return "Por asignar"
  const labels: Record<string, string> = { ...ROLE_LABELS }
  return labels[role] ?? role
}

/** false si es la única propietaria (el servidor también rechaza la salida). */
async function canLeaveOrganization(
  tx: Db,
  userId: string,
  organizationId: string,
  role: string,
): Promise<boolean> {
  if (role !== "owner") return true
  const owners = await tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.role, "owner")))
  return owners.some((o) => o.userId !== userId)
}

/** Salida voluntaria: el último propietario no puede salir. */
export async function leaveOrganization(
  tx: Db,
  userId: string,
  organizationId: string,
): Promise<void> {
  if (await isUserBlocked(tx, userId))
    throw forbidden("Tu cuenta está bloqueada: contacta a soporte")
  const [membership] = await tx
    .select()
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1)
  if (!membership) throw gone("No eres miembro de esa clínica")
  if (membership.role === "owner") await assertKeepsOwner(tx, organizationId, userId)
  await tx
    .delete(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
  await tx
    .update(session)
    .set({ activeOrganizationId: null })
    .where(and(eq(session.userId, userId), eq(session.activeOrganizationId, organizationId)))
  await tx.insert(auditEvent).values({
    organizationId,
    actorUserId: userId,
    action: "member.leave",
    entity: "member",
    entityId: userId,
    metadata: { role: membership.role },
  })
}

/** Cierre voluntario: persiste bloqueo (sin relogin), desactiva staff y audita. */
export async function closeMyAccount(tx: Db, userId: string): Promise<void> {
  if (await isUserBlocked(tx, userId))
    throw forbidden("Tu cuenta está bloqueada: contacta a soporte")
  await deactivateStaffOnClose(tx, null, userId)
  const memberships = await tx
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
  for (const m of memberships) {
    if (m.role === "owner") await assertKeepsOwner(tx, m.organizationId, userId)
  }
  await tx.delete(member).where(eq(member.userId, userId))
  await tx.delete(session).where(eq(session.userId, userId))
  await tx
    .insert(userGlobalBlock)
    .values({ userId, reason: "Cuenta cerrada por su titular", active: true })
    .onConflictDoUpdate({
      target: userGlobalBlock.userId,
      set: {
        reason: "Cuenta cerrada por su titular",
        blockedAt: new Date(),
        expiresAt: null,
        active: true,
        unblockedBy: null,
        unblockedAt: null,
      },
    })
  for (const m of memberships) {
    await tx.insert(auditEvent).values({
      organizationId: m.organizationId,
      actorUserId: userId,
      action: "member.account_close",
      entity: "member",
      entityId: userId,
      metadata: { role: m.role },
    })
  }
  await writeAdminAudit(
    tx,
    null,
    auditInput("user.account_close_self", null, userId, {
      membershipsRemoved: memberships.length,
    }),
  )
}

// ---------------------------------------------------------------------------
// Recuperación de correo y propiedad: doble control, evidencia verificada
// ---------------------------------------------------------------------------

const evidenceSchema = z.object({
  description: z
    .string()
    .trim()
    .min(10, "Describe la evidencia con al menos 10 caracteres")
    .max(2000),
  verifiedBy: z.string().trim().min(1, "Indica quién verificó la autoridad"),
  verifiedAt: z.string().trim().min(1, "Indica cuándo se verificó"),
  method: z
    .string()
    .trim()
    .min(5, "Indica cómo se verificó la autoridad (un adjunto solo no basta)")
    .max(500),
  organizationId: z.string().trim().max(120).optional(),
})

const openCaseSchema = z.object({
  email: emailSchema,
  kind: z.enum(["acceso", "propiedad"]),
  evidence: evidenceSchema,
})

function parseEvidence(raw: unknown): RecoveryEvidence {
  const parsed = evidenceSchema.safeParse(raw)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Evidencia incompleta")
  return parsed.data
}

function isApprovalDecision(value: unknown): value is RecoveryApproval["decision"] {
  return value === "aprobar" || value === "rechazar"
}

function parseApprovals(raw: unknown): RecoveryApproval[] {
  if (!Array.isArray(raw)) return []
  const out: RecoveryApproval[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    if (!("staffId" in item) || typeof item.staffId !== "string") continue
    if (!("decision" in item) || !isApprovalDecision(item.decision)) continue
    // Rol conservador: sin rol legible no suma como admin en el doble control.
    const role = "role" in item && typeof item.role === "string" ? item.role : "support"
    const note = "note" in item && typeof item.note === "string" ? item.note : undefined
    const at = "at" in item && typeof item.at === "string" ? item.at : new Date().toISOString()
    out.push({ staffId: item.staffId, role, decision: item.decision, note, at })
  }
  return out
}

function parseCaseStatus(raw: string): RecoveryCaseDetail["status"] {
  if (raw === "pendiente" || raw === "aprobada" || raw === "rechazada" || raw === "ejecutada")
    return raw
  throw invalid("Estado de caso desconocido")
}

function parseCaseKind(raw: string): RecoveryCaseDetail["kind"] {
  if (raw === "acceso" || raw === "propiedad") return raw
  throw invalid("Tipo de caso desconocido")
}

/** Abrir caso (admin y support): la autoría es el actor, nunca un texto autoafirmado. */
export async function openRecoveryCase(
  tx: Db,
  actor: AdminActor | null,
  raw: { email: string; kind: "acceso" | "propiedad"; evidence: RecoveryEvidence },
): Promise<RecoveryCaseDetail> {
  const staff = requireStaff(actor)
  const parsed = openCaseSchema.safeParse(raw)
  if (!parsed.success) throw invalid(parsed.error.issues[0]?.message ?? "Datos inválidos")
  const [subject] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, parsed.data.email))
    .limit(1)
  // verifiedBy lo firma el servidor con el actor autenticado: un adjunto o un
  // nombre escrito no basta ni se autoafirma.
  const evidence: RecoveryEvidence = { ...parsed.data.evidence, verifiedBy: staff.userId }
  const [row] = await tx
    .insert(accountRecoveryCase)
    .values({
      subjectUserId: subject?.id ?? null,
      email: parsed.data.email,
      kind: parsed.data.kind,
      status: "pendiente",
      evidence,
      requestedBy: staff.userId,
      approvals: [],
    })
    .returning()
  if (!row) throw new ServiceError("INTERNAL", 500, "No se pudo abrir el caso")
  await writeAdminAudit(
    tx,
    staff,
    auditInput("recovery.case_open", null, row.id, {
      email: parsed.data.email,
      kind: parsed.data.kind,
    }),
  )
  return toCaseDetail(row)
}

/**
 * Decidir (solo admin, doble control): dos aprobaciones de admins distintos
 * → aprobada; un rechazo → rechazada. Soporte abre casos pero no decide.
 */
export async function approveRecoveryCase(
  tx: Db,
  actor: AdminActor | null,
  args: { id: string; decision: "aprobar" | "rechazar"; note?: string },
): Promise<RecoveryCaseDetail> {
  const staff = requireAdmin(actor)
  const [row] = await tx
    .select()
    .from(accountRecoveryCase)
    .where(eq(accountRecoveryCase.id, args.id))
    .limit(1)
    .for("update")
  if (!row) throw gone("Caso no encontrado")
  if (row.status !== "pendiente") throw conflict("El caso ya fue decidido")
  const approvals = parseApprovals(row.approvals)
  if (approvals.some((a) => a.staffId === staff.userId)) {
    throw conflict("Ya registraste tu decisión en este caso")
  }
  approvals.push({
    staffId: staff.userId,
    role: staff.role,
    decision: args.decision,
    note: args.note?.trim().slice(0, 500) || undefined,
    at: new Date().toISOString(),
  })
  const approvers = new Set(
    approvals.filter((a) => a.decision === "aprobar" && a.role === "admin").map((a) => a.staffId),
  )
  const rejected = approvals.some((a) => a.decision === "rechazar")
  let status = row.status
  let decidedBy: string | null = null
  if (approvers.size >= 2) {
    status = "aprobada"
    decidedBy = staff.userId
  } else if (rejected) {
    status = "rechazada"
    decidedBy = staff.userId
  }
  const [updated] = await tx
    .update(accountRecoveryCase)
    .set({
      approvals,
      status,
      decidedBy,
      decidedAt: decidedBy ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(accountRecoveryCase.id, args.id))
    .returning()
  await writeAdminAudit(
    tx,
    staff,
    auditInput("recovery.case_decide", null, args.id, {
      decision: args.decision,
      status,
    }),
  )
  if (!updated) throw new ServiceError("INTERNAL", 500, "No se pudo registrar la decisión")
  return toCaseDetail(updated)
}

export async function listRecoveryCases(
  tx: Db,
  actor: AdminActor | null,
  opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<RecoveryCaseDetail[]> {
  requireStaff(actor)
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const where = opts.status ? eq(accountRecoveryCase.status, opts.status) : undefined
  const rows = await tx
    .select()
    .from(accountRecoveryCase)
    .where(where)
    .orderBy(desc(accountRecoveryCase.createdAt))
    .limit(limit)
    .offset(offset)
  return rows.map(toCaseDetail)
}

/**
 * Ejecutar (solo admin, caso aprobado): acceso → la ruta envía el flujo
 * existente de restablecimiento al correo verificado; propiedad → otorga
 * owner en la organización de la evidencia (nunca por el correo solo).
 */
export async function executeRecoveryCase(
  tx: Db,
  actor: AdminActor | null,
  id: string,
): Promise<RecoveryEffect> {
  const staff = requireAdmin(actor)
  const [row] = await tx
    .select()
    .from(accountRecoveryCase)
    .where(eq(accountRecoveryCase.id, id))
    .limit(1)
    .for("update")
  if (!row) throw gone("Caso no encontrado")
  if (row.status !== "aprobada") throw conflict("El caso debe estar aprobado para ejecutarse")
  if (row.subjectUserId && (await isUserBlocked(tx, row.subjectUserId))) {
    throw conflict("La cuenta está bloqueada: retira el bloqueo antes de ejecutar la recuperación")
  }
  const evidence = parseEvidence(row.evidence)
  const kind = parseCaseKind(row.kind)
  let organizationId: string | null = null
  if (kind === "propiedad") {
    if (!evidence.organizationId)
      throw invalid("El caso de propiedad exige la organización verificada en la evidencia")
    if (!row.subjectUserId) throw invalid("El caso no tiene usuario sujeto")
    organizationId = evidence.organizationId
    const [org] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.id, organizationId))
      .limit(1)
    if (!org) throw gone("Organización de la evidencia no encontrada")
    const [existing] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, row.subjectUserId)))
      .limit(1)
    if (existing) {
      await tx
        .update(member)
        .set({ role: "owner" })
        .where(and(eq(member.organizationId, organizationId), eq(member.userId, row.subjectUserId)))
    } else {
      await tx.insert(member).values({
        id: randomUUID(),
        organizationId,
        userId: row.subjectUserId,
        role: "owner",
        createdAt: new Date(),
      })
    }
  } else {
    await tx.delete(session).where(eq(session.userId, row.subjectUserId ?? "__sin_usuario__"))
  }
  await tx
    .update(accountRecoveryCase)
    .set({ status: "ejecutada", executedAt: new Date(), updatedAt: new Date() })
    .where(eq(accountRecoveryCase.id, id))
  await writeAdminAudit(
    tx,
    staff,
    auditInput("recovery.case_execute", organizationId, id, {
      kind,
      email: row.email,
    }),
  )
  return { kind, email: row.email, subjectUserId: row.subjectUserId, organizationId }
}

function toCaseDetail(row: typeof accountRecoveryCase.$inferSelect): RecoveryCaseDetail {
  return {
    id: row.id,
    subjectUserId: row.subjectUserId,
    email: row.email,
    kind: parseCaseKind(row.kind),
    status: parseCaseStatus(row.status),
    evidence: parseEvidence(row.evidence),
    requestedBy: row.requestedBy,
    approvals: parseApprovals(row.approvals),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    executedAt: row.executedAt,
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Ciclo de vida: recordatorio 3d y limpieza 30d (solo sin verificar y sin datos)
// ---------------------------------------------------------------------------

export interface LifecycleCandidates {
  reminders: LifecycleCandidate[]
  cleanups: LifecycleCandidate[]
  /** Verificadas sin clínica: solo aviso de onboarding, jamás limpieza. */
  nudges: LifecycleCandidate[]
}

/**
 * Candidatos del ciclo de cuenta: no verificadas, sin membresías, sin
 * invitaciones pendientes, sin actividad registrada y sin casos/bloqueos.
 * El registro nunca se usa como permiso comercial: los avisos son solo
 * informativos y la limpieza retira la cuenta, no la contacta. Las
 * verificadas sin clínica solo reciben un aviso de onboarding (nunca se
 * borran) y sin llamadas comerciales ni marketing supuesto.
 */
export async function findLifecycleCandidates(
  tx: Db,
  opts: { now?: Date; reminderDays?: number; cleanupDays?: number; limit?: number } = {},
): Promise<LifecycleCandidates> {
  const now = opts.now ?? new Date()
  const reminderDays = opts.reminderDays ?? 3
  const cleanupDays = opts.cleanupDays ?? 30
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const reminderCutoff = new Date(now.getTime() - reminderDays * 24 * 60 * 60 * 1000)
  const cleanupCutoff = new Date(now.getTime() - cleanupDays * 24 * 60 * 60 * 1000)

  const stale = await tx
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(and(eq(user.emailVerified, false), lt(user.createdAt, reminderCutoff)))
    .orderBy(user.createdAt)
    .limit(limit * 2)
  const reminders: LifecycleCandidate[] = []
  const cleanups: LifecycleCandidate[] = []
  for (const candidate of stale) {
    if (!(await isDormantUnverified(tx, candidate.id))) continue
    if (candidate.createdAt.getTime() > cleanupCutoff.getTime()) {
      const [notice] = await tx
        .select({ userId: accountLifecycleNotice.userId })
        .from(accountLifecycleNotice)
        .where(eq(accountLifecycleNotice.userId, candidate.id))
        .limit(1)
      if (!notice) {
        reminders.push({
          userId: candidate.id,
          email: candidate.email,
          createdAt: candidate.createdAt,
        })
      }
    } else {
      cleanups.push({
        userId: candidate.id,
        email: candidate.email,
        createdAt: candidate.createdAt,
      })
    }
    if (reminders.length + cleanups.length >= limit) break
  }
  const nudges: LifecycleCandidate[] = []
  const settled = await tx
    .select({ id: user.id, email: user.email, createdAt: user.createdAt })
    .from(user)
    .where(and(eq(user.emailVerified, true), lt(user.createdAt, reminderCutoff)))
    .orderBy(user.createdAt)
    .limit(limit)
  for (const candidate of settled) {
    if (nudges.length >= limit) break
    const [membership] = await tx
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.userId, candidate.id))
      .limit(1)
    if (membership) continue
    // Con invitación pendiente ya tiene camino: el aviso sobra.
    const [invited] = await tx
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.email, candidate.email), eq(invitation.status, "pending")))
      .limit(1)
    if (invited) continue
    const [notice] = await tx
      .select({ userId: accountLifecycleNotice.userId })
      .from(accountLifecycleNotice)
      .where(eq(accountLifecycleNotice.userId, candidate.id))
      .limit(1)
    if (notice) continue
    nudges.push({ userId: candidate.id, email: candidate.email, createdAt: candidate.createdAt })
  }
  return { reminders, cleanups, nudges }
}

/**
 * Datos propios que la limpieza borra junto a la cuenta: nunca cuentan como
 * relación (sesiones, identidades externas y aviso de ciclo).
 */
const DORMANT_OWN_DATA: ReadonlySet<string> = new Set([
  "session.user_id",
  "account.user_id",
  "account_lifecycle_notice.user_id",
])

const catalogReferenceSchema = z.object({ tableName: z.string(), columnName: z.string() })

/**
 * TODAS las referencias FK a `user(id)` desde el catálogo de Postgres: sin
 * lista manual que se quede vieja. Cubre cascadas silenciosas
 * (`invitation.inviter_id`, `admin_staff.user_id`), pérdidas SET NULL y
 * columnas de autoría clínicas/financieras. Sin try/catch: un fallo de
 * infraestructura propaga, el ciclo lo registra y jamás borra.
 */
async function listUserReferences(
  tx: Db,
): Promise<Array<{ tableName: string; columnName: string }>> {
  const rows = await tx.execute(sql`
    select conrelid::regclass::text as "tableName", att.attname as "columnName"
      from pg_constraint con
      join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
      join pg_class rel on rel.oid = con.confrelid
      where con.contype = 'f' and rel.relname = 'user'
  `)
  const parsed = z.array(catalogReferenceSchema).safeParse(rows)
  if (!parsed.success)
    throw new ServiceError("INTERNAL", 500, "No se pudo leer el catálogo de referencias")
  return parsed.data
}

async function hasCatalogRelation(tx: Db, userId: string): Promise<boolean> {
  const refs = await listUserReferences(tx)
  for (const ref of refs) {
    if (DORMANT_OWN_DATA.has(`${ref.tableName}.${ref.columnName}`)) continue
    const qualified = `${ref.tableName}.${ref.columnName}`
      .split(".")
      .map((part) => `"${part}"`)
      .join(".")
    const [tablePart, columnPart] = qualified.split(/\.(?=[^.]+$)/)
    const found = await tx.execute(
      sql`select 1 from ${sql.raw(tablePart ?? qualified)} where ${sql.raw(columnPart ?? qualified)} = ${userId} limit 1`,
    )
    if (Array.isArray(found) && found.length > 0) return true
  }
  return false
}

/** Sin membresías, sin actividad de autoría, sin casos ni bloqueos, sin ninguna otra referencia FK. */
async function isDormantUnverified(tx: Db, userId: string): Promise<boolean> {
  const [account] = await tx
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
  if (account) {
    // Con invitación pendiente no se toca: está en curso su entrada.
    const [invited] = await tx
      .select({ id: invitation.id })
      .from(invitation)
      .where(and(eq(invitation.email, account.email), eq(invitation.status, "pending")))
      .limit(1)
    if (invited) return false
  }
  const [memberships] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(member)
    .where(eq(member.userId, userId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  if ((memberships?.n ?? 0) > 0) return false
  const [activity] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(auditEvent)
    .where(eq(auditEvent.actorUserId, userId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  if ((activity?.n ?? 0) > 0) return false
  const [cases] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRecoveryCase)
    .where(eq(accountRecoveryCase.subjectUserId, userId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  if ((cases?.n ?? 0) > 0) return false
  const [blocks] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(userGlobalBlock)
    .where(eq(userGlobalBlock.userId, userId))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  if ((blocks?.n ?? 0) > 0) return false
  return !(await hasCatalogRelation(tx, userId))
}

/**
 * Reserva atómica del recordatorio ANTES del SMTP: el INSERT es el claim
 * durable (PK por usuario). Devuelve false si otro worker ya lo reservó:
 * dos workers nunca envían dos veces.
 */
export async function claimLifecycleReminder(
  tx: Db,
  userId: string,
  kind: "recordatorio_3d" | "onboarding_sin_clinica" = "recordatorio_3d",
): Promise<boolean> {
  const inserted = await tx
    .insert(accountLifecycleNotice)
    .values({ userId, kind, status: "claimed" })
    .onConflictDoNothing()
    .returning({ userId: accountLifecycleNotice.userId })
  return inserted.length > 0
}

/** Marca el envío confirmado tras el SMTP (claim → sent). */
export async function markLifecycleReminderSent(tx: Db, userId: string): Promise<void> {
  await tx
    .update(accountLifecycleNotice)
    .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
    .where(eq(accountLifecycleNotice.userId, userId))
}

/**
 * El SMTP falló (o el error es ambiguo): queda uncertain SIN reintento
 * automático. El recorrido excluye toda fila con aviso, así no repite.
 */
export async function markLifecycleReminderUncertain(tx: Db, userId: string): Promise<void> {
  await tx.execute(
    sql`update "account_lifecycle_notice" set "status" = 'uncertain', "attempts" = "attempts" + 1, "updated_at" = now() where "user_id" = ${userId}`,
  )
}

/**
 * Retira la cuenta dormida (worker/sistema con actor null o admin): solo si
 * sigue no verificada y sin relaciones. Borra en cascada sesiones e
 * identidades externas; la fila de usuario sale porque nunca tuvo actividad.
 */
export async function cleanupUnverifiedAccount(
  tx: Db,
  actor: AdminActor | null,
  userId: string,
  opts: { now?: Date; cleanupDays?: number } = {},
): Promise<{ deleted: boolean }> {
  if (actor) requireAdmin(actor)
  const now = opts.now ?? new Date()
  const cutoff = new Date(now.getTime() - (opts.cleanupDays ?? 30) * 24 * 60 * 60 * 1000)
  // Lock primero: la elegibilidad se evalúa sobre la fila bloqueada y el
  // DELETE lleva la condición (verificación concurrente → 0 filas, no borra).
  const [row] = await tx.select().from(user).where(eq(user.id, userId)).limit(1).for("update")
  if (!row || row.emailVerified || row.createdAt.getTime() > cutoff.getTime()) {
    return { deleted: false }
  }
  if (!(await isDormantUnverified(tx, userId))) return { deleted: false }
  await tx.delete(accountLifecycleNotice).where(eq(accountLifecycleNotice.userId, userId))
  await tx.delete(session).where(eq(session.userId, userId))
  await tx.delete(account).where(eq(account.userId, userId))
  const removed = await tx
    .delete(user)
    .where(and(eq(user.id, userId), eq(user.emailVerified, false)))
    .returning({ id: user.id })
  if (removed.length === 0) return { deleted: false }
  await writeAdminAudit(
    tx,
    actor,
    auditInput("lifecycle.cleanup_30d", null, userId, {
      email: row.email,
    }),
  )
  return { deleted: true }
}

export interface OrganizationPendingCounts {
  pendingRecoveryCases: number
  pendingInvitations: number
  incompleteProvisioning: number
  blockedUsers: number
}

/**
 * Pendientes del slice para el Inicio admin (lo agrega admin-overview):
 * casos de recuperación por decidir, invitaciones pendientes, clínicas sin
 * perfil/sede y usuarios bloqueados. Sin cálculo monetario.
 */
export async function getOrganizationPendingCounts(
  tx: Db,
  actor: AdminActor | null,
): Promise<OrganizationPendingCounts> {
  requireStaff(actor)
  const [cases] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(accountRecoveryCase)
    .where(eq(accountRecoveryCase.status, "pendiente"))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const [invites] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(invitation)
    .where(eq(invitation.status, "pending"))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const [blocked] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(userGlobalBlock)
    .where(eq(userGlobalBlock.active, true))
    .then((r) => (r.length > 0 ? r : [{ n: 0 }]))
  const orgIds = await tx.select({ id: organization.id }).from(organization).limit(500)
  let incompleteProvisioning = 0
  for (const org of orgIds) {
    const [profile] = await tx
      .select({ id: orgProfile.organizationId })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, org.id))
      .limit(1)
    if (profile) continue
    const [sede] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.organizationId, org.id))
      .limit(1)
    if (!sede) incompleteProvisioning += 1
  }
  return {
    pendingRecoveryCases: cases?.n ?? 0,
    pendingInvitations: invites?.n ?? 0,
    incompleteProvisioning,
    blockedUsers: blocked?.n ?? 0,
  }
}
