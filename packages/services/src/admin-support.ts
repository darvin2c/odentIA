import { createHash } from "node:crypto"
import type { Db } from "@odentia/db"
import { withOrgContext } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import {
  supportAccessAudit,
  supportAccessGrant,
  supportAttachment,
  supportCase,
  supportMessage,
} from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { helpAsk } from "@odentia/db/schema/workspace"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasActionReview } from "@odentia/db/schema/saas-billing"
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { helpTopic, helpTopicForScreen } from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"
import { enqueueSupportInboxNotice } from "./support-notices.js"

/* ---------- Tipos ---------- */

export type SupportStatus = "abierto" | "en_atencion" | "esperando_clinica" | "resuelto"
/** `cobro`: la clínica pidió revisar una fila de lo que se le cobró (ADR 0054). */
export type SupportKind = "pregunta" | "problema" | "acceso" | "cobro"

export const SUPPORT_STATUSES: SupportStatus[] = [
  "abierto",
  "en_atencion",
  "esperando_clinica",
  "resuelto",
]
export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

/** Tope del acceso delegado: una hora por caso. */
export const SUPPORT_GRANT_MAX_MINUTES = 60

export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export interface SupportMessageItem {
  id: string
  authorKind: "cliente" | "staff" | "sistema"
  body: string
  isInternal: boolean
  createdAt: string
}

export interface SupportCaseListItem {
  id: string
  organizationId: string | null
  organizationName: string | null
  kind: SupportKind
  question: string
  status: SupportStatus
  assigneeStaffId: string | null
  messageCount: number
  /** Hay respuesta pública del equipo que la clínica aún no abrió. */
  unread: boolean
  createdAt: string
  updatedAt: string
}

export interface SupportCaseDetail extends SupportCaseListItem {
  detail: string | null
  screen: string
  role: string
  appVersion: string | null
  dedupeKey: string
  reopenedCount: number
  resolvedAt: string | null
  messages: SupportMessageItem[]
  attachments: SupportAttachmentItem[]
  grants: SupportGrantItem[]
}

export interface SupportAttachmentItem {
  id: string
  messageId: string | null
  mimeType: string
  filename: string
  size: number
  createdAt: string
}

export interface SupportGrantItem {
  id: string
  caseId: string
  grantedBy: string
  expiresAt: string
  revokedAt: string | null
  active: boolean
  createdAt: string
}

export interface SupportDiagnostic {
  caseId: string
  organizationId: string
  organizationName: string
  scope: string
  grantExpiresAt: string
  organization: { id: string; name: string; slug: string }
  profile: { countryCode: string; currency: string; timezone: string; locale: string } | null
  branches: {
    id: string
    name: string
    isActive: boolean
    timezone: string | null
    appointmentDefaultMinutes: number
  }[]
  agent: {
    enabled: boolean
    decisionProvider: string
    decisionRoutingEnabled: boolean
    clinicalAssistantEnabled: boolean
  } | null
  channels: { channel: string; provider: string; displayName: string; status: string }[]
  services: { total: number }
  membersByRole: { role: string; total: number }[]
}

export interface SupportMetrics {
  byStatus: { status: SupportStatus; total: number }[]
  byKind: { kind: SupportKind; total: number }[]
  openWithoutAssignee: number
  activeGrants: number
  avgFirstReplyMinutes: number | null
}

/** Lo que hay que mejorar de la guía: cuántas veces y dónde, nunca qué se preguntó. */
export interface HelpGuideStats {
  days: number
  asked: number
  unanswered: number
  notHelpful: number
  /** Las pantallas donde más veces no supo responder. */
  unansweredByScreen: Array<{ name: string; total: number }>
  /** Los temas cuya respuesta más veces no sirvió. */
  notHelpfulByTopic: Array<{ name: string; total: number }>
}

export interface SupportKnowledgeGroup {
  dedupeKey: string
  question: string
  kind: string
  openCases: number
  organizations: number
  screens: string[]
  firstAt: string
}

/**
 * Alcance explícito del acceso delegado: lo que sí ve soporte y lo que nunca
 * abre. Se devuelve con cada diagnóstico y lo muestra la UI antes de consentir.
 */
export const SUPPORT_DIAGNOSTIC_SCOPE =
  "Solo configuración operacional no secreta: datos de la organización y sedes, " +
  "estado de canales y del agente, conteo de servicios y roles del equipo. " +
  "Nunca abre agenda, contactos, pacientes, historia clínica, bandeja, mensajes, " +
  "exportaciones ni secretos (claves, tokens, datos fiscales)."

/* ---------- Utilidades ---------- */

function toMessage(row: typeof supportMessage.$inferSelect): SupportMessageItem {
  return {
    id: row.id,
    authorKind: row.authorKind as SupportMessageItem["authorKind"],
    body: row.body,
    isInternal: row.isInternal,
    createdAt: row.createdAt.toISOString(),
  }
}

function toGrant(row: typeof supportAccessGrant.$inferSelect): SupportGrantItem {
  const active = row.revokedAt === null && row.expiresAt.getTime() > Date.now()
  return {
    id: row.id,
    caseId: row.caseId,
    grantedBy: row.grantedBy,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    active,
    createdAt: row.createdAt.toISOString(),
  }
}

function toAttachment(row: typeof supportAttachment.$inferSelect): SupportAttachmentItem {
  return {
    id: row.id,
    messageId: row.messageId,
    mimeType: row.mimeType,
    filename: row.filename,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
  }
}

function caseStatusOf(row: typeof supportCase.$inferSelect): SupportStatus {
  if (!(SUPPORT_STATUSES as string[]).includes(row.status))
    throw new Error("Estado de caso inválido")
  return row.status as SupportStatus
}

function requireCaseInOrg(
  row: typeof supportCase.$inferSelect | undefined,
  orgId: string | null,
): typeof supportCase.$inferSelect {
  if (!row) throw notFound("Caso")
  if ((row.organizationId ?? null) !== (orgId ?? null)) throw notFound("Caso")
  return row
}

async function activeGrantFor(
  db: Db,
  caseId: string,
): Promise<typeof supportAccessGrant.$inferSelect | undefined> {
  const [grant] = await db
    .select()
    .from(supportAccessGrant)
    .where(
      and(
        eq(supportAccessGrant.caseId, caseId),
        isNull(supportAccessGrant.revokedAt),
        gt(supportAccessGrant.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(supportAccessGrant.createdAt))
    .limit(1)
  return grant
}

const dedupeKeyOf = (question: string): string =>
  createHash("sha256").update(normalizeForSearch(question)).digest("hex").slice(0, 32)

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index)
}

/* ---------- Lado clínica: el caso nace del envío (tx con RLS de la org) ---------- */

export interface HelpRequestSeed {
  userId: string
  kind: SupportKind
  question: string
  detail: string | null
  screen: string
  role: string
  appVersion: string | null
  dedupeKey: string
}

/**
 * Abre el caso de lo que una persona decidió enviar desde la Ayuda: el caso es
 * la única fuente. Se junta solo con el suyo del mismo texto que siga abierto
 * (enviar dos veces lo mismo no abre otro hilo); una pregunta repetida después
 * de resuelta abre un caso nuevo. Abrirlo deja el aviso a soporte.
 */
export async function openSupportCaseFromHelp(
  tx: Db,
  orgId: string,
  request: HelpRequestSeed,
): Promise<SupportCaseListItem & { reused: boolean }> {
  const [open] = await tx
    .select()
    .from(supportCase)
    .where(
      and(
        eq(supportCase.organizationId, orgId),
        eq(supportCase.openedBy, request.userId),
        eq(supportCase.dedupeKey, request.dedupeKey),
        ne(supportCase.status, "resuelto"),
      ),
    )
    .orderBy(desc(supportCase.createdAt))
    .limit(1)
  if (open) return { ...toListItem(open, 0), reused: true }
  const [row] = await tx
    .insert(supportCase)
    .values({
      organizationId: orgId,
      kind: request.kind,
      question: request.question.slice(0, 500),
      detail: request.detail,
      screen: request.screen,
      role: request.role,
      appVersion: request.appVersion,
      dedupeKey: request.dedupeKey,
      openedBy: request.userId,
    })
    .returning()
  if (!row) throw new Error("No se pudo abrir el caso")
  await enqueueSupportInboxNotice(tx, { caseId: row.id, organizationId: orgId, kind: "caso_nuevo", sourceId: row.id })
  return { ...toListItem(row, 0), reused: false }
}

function toListItem(
  row: typeof supportCase.$inferSelect,
  messageCount: number,
): SupportCaseListItem {
  const lastPublic = row.lastPublicMessageAt?.getTime() ?? null
  const seen = row.clientSeenAt?.getTime() ?? null
  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: null,
    kind: (["pregunta", "problema", "acceso", "cobro"] as string[]).includes(row.kind)
      ? (row.kind as SupportKind)
      : "pregunta",
    question: row.question,
    status: caseStatusOf(row),
    assigneeStaffId: row.assigneeStaffId,
    messageCount,
    unread: lastPublic !== null && (seen === null || lastPublic > seen),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * Quién sigue un caso de la clínica: quien lo abrió. Si esa persona ya no está
 * en la clínica, lo siguen su propietario y su administrador; nadie más.
 */
async function requireCaseReader(
  tx: Db,
  kase: typeof supportCase.$inferSelect,
  orgId: string,
  userId: string,
): Promise<void> {
  if (kase.openedBy === userId) return
  // Un caso sin autor es automático de odentIA: no es de ninguna clínica.
  if (kase.openedBy === null) throw notFound("Caso")
  if (!(await isOrgOwnerOrAdmin(tx, userId, orgId))) throw notFound("Caso")
  const [opener] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, kase.openedBy), eq(member.organizationId, orgId)))
    .limit(1)
  if (opener) throw notFound("Caso")
}

/**
 * Casos que sigue la persona en su clínica, del más reciente al más viejo: los
 * suyos y, si es propietaria o administradora, los de quien ya no está.
 */
export async function listMySupportCases(
  tx: Db,
  orgId: string,
  userId: string,
): Promise<SupportCaseListItem[]> {
  const manager = await isOrgOwnerOrAdmin(tx, userId, orgId)
  const rows = await tx
    .select()
    .from(supportCase)
    .where(
      and(
        eq(supportCase.organizationId, orgId),
        manager
          ? sql`(${supportCase.openedBy} = ${userId} or not exists (select 1 from ${member} m
              where m.user_id = ${supportCase.openedBy} and m.organization_id = ${orgId}))`
          : eq(supportCase.openedBy, userId),
      ),
    )
    .orderBy(desc(supportCase.updatedAt))
    .limit(50)
  return rows.map((row) => toListItem(row, 0))
}

/** El caso con sus mensajes públicos y adjuntos: la clínica nunca ve notas internas. */
export async function getMySupportCase(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<SupportCaseDetail> {
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  await requireCaseReader(tx, kase, orgId, userId)
  const messages = await tx
    .select()
    .from(supportMessage)
    .where(and(eq(supportMessage.caseId, kase.id), eq(supportMessage.isInternal, false)))
    .orderBy(asc(supportMessage.createdAt))
  const attachments = await clientVisibleAttachments(tx, kase.id)
  const grants = await tx
    .select()
    .from(supportAccessGrant)
    .where(eq(supportAccessGrant.caseId, kase.id))
    .orderBy(desc(supportAccessGrant.createdAt))
    .limit(10)
  return toDetail(kase, messages.map(toMessage), attachments, grants.map(toGrant), null)
}

/**
 * Adjuntos visibles para la clínica: sueltos (públicos por defecto explícito)
 * o colgados de mensajes públicos. Los de notas internas nunca salen: ni
 * metadatos ni URL firmada.
 */
async function clientVisibleAttachments(tx: Db, caseId: string): Promise<SupportAttachmentItem[]> {
  const rows = await tx
    .select({ attachment: supportAttachment, internal: supportMessage.isInternal })
    .from(supportAttachment)
    .leftJoin(supportMessage, eq(supportAttachment.messageId, supportMessage.id))
    .where(eq(supportAttachment.caseId, caseId))
    .orderBy(asc(supportAttachment.createdAt))
  return rows.filter((row) => row.internal !== true).map((row) => toAttachment(row.attachment))
}

function toDetail(
  row: typeof supportCase.$inferSelect,
  messages: SupportMessageItem[],
  attachments: SupportAttachmentItem[],
  grants: SupportGrantItem[],
  organizationName: string | null,
): SupportCaseDetail {
  return {
    ...toListItem(row, messages.length),
    organizationName,
    detail: row.detail,
    screen: row.screen,
    role: row.role,
    appVersion: row.appVersion,
    dedupeKey: row.dedupeKey,
    reopenedCount: row.reopenedCount,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    messages,
    attachments,
    grants,
  }
}

function requireWritableByClient(row: typeof supportCase.$inferSelect): void {
  if (row.status === "resuelto")
    throw validation("El caso está resuelto: reábrelo para agregar adjuntos")
}

/** La clínica responde en su caso; si estaba resuelto, se reabre. */
export async function replyToMySupportCase(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
  body: unknown,
): Promise<SupportMessageItem> {
  const text = typeof body === "string" ? body.trim() : ""
  if (text.length < 1) throw invalidField("body", "Escribe tu respuesta.")
  if (text.length > 4000) throw invalidField("body", "Escribe como mucho 4000 caracteres.")
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  await requireCaseReader(tx, kase, orgId, userId)
  const reopening = kase.status === "resuelto"
  const [message] = await tx
    .insert(supportMessage)
    .values({
      caseId: kase.id,
      organizationId: orgId,
      authorKind: "cliente",
      authorUserId: userId,
      body: text,
    })
    .returning()
  if (!message) throw new Error("No se pudo enviar la respuesta")
  await enqueueSupportInboxNotice(tx, { caseId: kase.id, organizationId: orgId, kind: "clinica_respondio", sourceId: message.id })
  const now = new Date()
  await tx
    .update(supportCase)
    .set({
      status: reopening ? "en_atencion" : kase.status,
      resolvedAt: reopening ? null : kase.resolvedAt,
      reopenedCount: reopening ? kase.reopenedCount + 1 : kase.reopenedCount,
      clientSeenAt: now,
      updatedAt: now,
    })
    .where(eq(supportCase.id, kase.id))
  return toMessage(message)
}

/** Reabre un caso resuelto sin escribir todavía. */
export async function reopenMySupportCase(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<void> {
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  await requireCaseReader(tx, kase, orgId, userId)
  if (kase.status !== "resuelto") throw validation("El caso ya está abierto")
  await tx
    .update(supportCase)
    .set({
      status: "en_atencion",
      resolvedAt: null,
      reopenedCount: kase.reopenedCount + 1,
      clientSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supportCase.id, kase.id))
}

/**
 * «Ver»: la clínica abrió la conversación; lo ya respondido deja de contar
 * como no leído. Solo el autor del caso marca su propio visto.
 */
export async function markSupportCaseSeen(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<void> {
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  await requireCaseReader(tx, kase, orgId, userId)
  await tx.update(supportCase).set({ clientSeenAt: new Date() }).where(eq(supportCase.id, kase.id))
}

/**
 * Autorización previa a subir nada: pertenencia, autoría y caso escribible.
 * Las rutas la llaman ANTES de `putAttachment` para no dejar objetos huérfanos.
 */
export async function assertMySupportCaseWritable(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<typeof supportCase.$inferSelect> {
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  await requireCaseReader(tx, kase, orgId, userId)
  requireWritableByClient(kase)
  return kase
}

/** Registra un adjunto ya subido al bucket privado dentro del caso. */
export async function attachToMySupportCase(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
  input: {
    messageId?: string
    objectKey: string
    mimeType: string
    filename: string
    size: number
  },
): Promise<SupportAttachmentItem> {
  const kase = await assertMySupportCaseWritable(tx, orgId, userId, caseId)
  if (input.messageId) {
    const [message] = await tx
      .select()
      .from(supportMessage)
      .where(and(eq(supportMessage.id, input.messageId), eq(supportMessage.caseId, kase.id)))
      .limit(1)
    if (!message) throw notFound("Mensaje")
  }
  const [attachment] = await tx
    .insert(supportAttachment)
    .values({
      caseId: kase.id,
      messageId: input.messageId ?? null,
      organizationId: orgId,
      objectKey: input.objectKey,
      mimeType: input.mimeType,
      filename: input.filename.slice(0, 200),
      size: input.size,
      createdBy: userId,
    })
    .returning()
  if (!attachment) throw new Error("No se pudo registrar el adjunto")
  return toAttachment(attachment)
}

/* ---------- Consentimiento de acceso delegado (owner/admin; tx con RLS) ---------- */

/**
 * Un owner/admin autoriza a soporte a ver el diagnóstico de su organización.
 * Revoca los permisos activos previos del caso: uno vigente a la vez.
 */
export async function grantSupportAccess(
  tx: Db,
  orgId: string,
  userId: string,
  canGrant: boolean,
  caseId: string,
  minutes: unknown,
): Promise<SupportGrantItem> {
  if (!canGrant)
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Solo quien es propietario o administra la clínica puede autorizar el acceso",
    )
  const minutesNumber = typeof minutes === "number" ? Math.floor(minutes) : 30
  if (
    !Number.isInteger(minutesNumber) ||
    minutesNumber < 5 ||
    minutesNumber > SUPPORT_GRANT_MAX_MINUTES
  ) {
    throw invalidField("minutes", `El acceso se autoriza entre 5 y ${SUPPORT_GRANT_MAX_MINUTES} minutos.`)
  }
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  if (kase.status === "resuelto")
    throw validation("El caso ya está resuelto: no hace falta autorizar accesos")
  await tx
    .update(supportAccessGrant)
    .set({ revokedAt: new Date() })
    .where(and(eq(supportAccessGrant.caseId, kase.id), isNull(supportAccessGrant.revokedAt)))
  // `createdAt` explícito: `expiresAt` nace del mismo instante, así el CHECK
  // de 1 h exacta no depende del reloj de la base.
  const grantedAt = new Date()
  const [grant] = await tx
    .insert(supportAccessGrant)
    .values({
      caseId: kase.id,
      organizationId: orgId,
      grantedBy: userId,
      scope: "diagnostico",
      createdAt: grantedAt,
      expiresAt: new Date(grantedAt.getTime() + minutesNumber * 60_000),
    })
    .returning()
  if (!grant) throw new Error("No se pudo autorizar el acceso")
  return toGrant(grant)
}

/** Quien autorizó (o un owner/admin) revoca el acceso: corta la lectura de inmediato. */
export async function revokeSupportAccess(
  tx: Db,
  orgId: string,
  userId: string,
  canGrant: boolean,
  grantId: string,
): Promise<void> {
  const [grant] = await tx
    .select()
    .from(supportAccessGrant)
    .where(eq(supportAccessGrant.id, grantId))
    .limit(1)
  if (!grant || grant.organizationId !== orgId) throw notFound("Permiso")
  if (grant.grantedBy !== userId && !canGrant)
    throw new ServiceError("FORBIDDEN", 403, "No puedes revocar este acceso")
  if (grant.revokedAt !== null) return
  await tx
    .update(supportAccessGrant)
    .set({ revokedAt: new Date() })
    .where(eq(supportAccessGrant.id, grant.id))
}

/* ---------- Cuenta (panel, sin clínica): casos de acceso con ownerDb ---------- */

/** Casos de acceso: problemas para entrar sin organización (cuenta del panel). */
export async function createAccessSupportCase(
  db: Db,
  userId: string,
  input: { question: unknown; detail?: unknown; appVersion?: string | null },
): Promise<SupportCaseListItem> {
  if (typeof input.question !== "string" || input.question.trim().length < 3) {
    throw invalidField("question", "Cuenta qué pasa con al menos 3 caracteres.")
  }
  const question = input.question.trim().slice(0, 500)
  const dedupeKey = dedupeKeyOf(question)
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(supportCase)
      .values({
        organizationId: null,
        kind: "acceso",
        question,
        detail:
          typeof input.detail === "string" && input.detail.trim()
            ? input.detail.trim().slice(0, 500)
            : null,
        screen: "/panel",
        role: "Cuenta",
        appVersion: input.appVersion ?? null,
        dedupeKey,
        openedBy: userId,
      })
      .returning()
    if (!row) throw new Error("No se pudo abrir el caso")
    await enqueueSupportInboxNotice(tx as Db, { caseId: row.id, organizationId: null, kind: "caso_nuevo", sourceId: row.id })
    return toListItem(row, 0)
  })
}

/** Todos los casos propios de la cuenta: de acceso y los abiertos en sus clínicas. */
export async function listAccountSupportCases(
  db: Db,
  userId: string,
): Promise<SupportCaseListItem[]> {
  const rows = await db
    .select({ kase: supportCase, orgName: organization.name })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(eq(supportCase.openedBy, userId))
    .orderBy(desc(supportCase.updatedAt))
    .limit(50)
  return rows.map(({ kase, orgName }) => ({ ...toListItem(kase, 0), organizationName: orgName }))
}

export async function getAccountSupportCase(
  db: Db,
  userId: string,
  caseId: string,
): Promise<SupportCaseDetail> {
  const [row] = await db
    .select({ kase: supportCase, orgName: organization.name })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(eq(supportCase.id, caseId))
    .limit(1)
  if (!row || row.kase.openedBy !== userId) throw notFound("Caso")
  const messages = await db
    .select()
    .from(supportMessage)
    .where(and(eq(supportMessage.caseId, row.kase.id), eq(supportMessage.isInternal, false)))
    .orderBy(asc(supportMessage.createdAt))
  const attachments = await clientVisibleAttachments(db, row.kase.id)
  const grants = row.kase.organizationId
    ? await db
        .select()
        .from(supportAccessGrant)
        .where(eq(supportAccessGrant.caseId, row.kase.id))
        .orderBy(desc(supportAccessGrant.createdAt))
        .limit(10)
    : []
  return toDetail(row.kase, messages.map(toMessage), attachments, grants.map(toGrant), row.orgName)
}

export async function replyToAccountSupportCase(
  db: Db,
  userId: string,
  caseId: string,
  body: unknown,
): Promise<SupportMessageItem> {
  const text = typeof body === "string" ? body.trim() : ""
  if (text.length < 1) throw invalidField("body", "Escribe tu respuesta.")
  if (text.length > 4000) throw invalidField("body", "Escribe como mucho 4000 caracteres.")
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase || kase.openedBy !== userId) throw notFound("Caso")
  const reopening = kase.status === "resuelto"
  const [message] = await db
    .insert(supportMessage)
    .values({
      caseId: kase.id,
      organizationId: kase.organizationId,
      authorKind: "cliente",
      authorUserId: userId,
      body: text,
    })
    .returning()
  if (!message) throw new Error("No se pudo enviar la respuesta")
  await enqueueSupportInboxNotice(db, {
    caseId: kase.id,
    organizationId: kase.organizationId,
    kind: "clinica_respondio",
    sourceId: message.id,
  })
  const now = new Date()
  await db
    .update(supportCase)
    .set({
      status: reopening ? "en_atencion" : kase.status,
      resolvedAt: reopening ? null : kase.resolvedAt,
      reopenedCount: reopening ? kase.reopenedCount + 1 : kase.reopenedCount,
      clientSeenAt: now,
      updatedAt: now,
    })
    .where(eq(supportCase.id, kase.id))
  return toMessage(message)
}

/** ¿Es owner/admin de la organización? Lo decide la membresía, nunca el cliente. */
export async function isOrgOwnerOrAdmin(db: Db, userId: string, orgId: string): Promise<boolean> {
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, orgId)))
    .limit(1)
  return membership?.role === "owner" || membership?.role === "admin"
}

/* ---------- Lado staff (ownerDb; cada acción audita al actor real) ---------- */

export interface StaffCaseFilters {
  status?: SupportStatus
  assigneeStaffId?: string
  kind?: SupportKind
  limit?: number
  offset?: number
}

function staffListItem(
  row: typeof supportCase.$inferSelect,
  orgName: string | null,
  messageCount: number,
): SupportCaseListItem {
  return { ...toListItem(row, messageCount), organizationName: orgName }
}

/** Cola de casos para el equipo: sin cuerpos de mensajes, solo triaje. */
export async function listSupportCasesForStaff(
  db: Db,
  actor: AdminActor,
  filters: StaffCaseFilters,
): Promise<{ items: SupportCaseListItem[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 30, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)
  const conditions = [
    filters.status ? eq(supportCase.status, filters.status) : undefined,
    filters.assigneeStaffId ? eq(supportCase.assigneeStaffId, filters.assigneeStaffId) : undefined,
    filters.kind ? eq(supportCase.kind, filters.kind) : undefined,
  ]
  const rows = await db
    .select({ kase: supportCase, orgName: organization.name })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(and(...conditions))
    .orderBy(desc(supportCase.updatedAt))
    .limit(limit)
    .offset(offset)
  const [{ total }] = await db
    .select({ total: count() })
    .from(supportCase)
    .where(and(...conditions))
    .then((result) => (result.length > 0 ? result : [{ total: 0 }]))
  await writeAdminAudit(db, actor, {
    action: "support.cases.list",
    metadata: { status: filters.status ?? null },
  })
  return {
    items: rows.map(({ kase, orgName }) => staffListItem(kase, orgName, 0)),
    total: Number(total),
  }
}

/** Ficha completa del caso: conversación privada, notas internas, adjuntos y permisos. */
export async function getSupportCaseForStaff(
  db: Db,
  actor: AdminActor,
  caseId: string,
): Promise<SupportCaseDetail> {
  const [row] = await db
    .select({ kase: supportCase, orgName: organization.name })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(eq(supportCase.id, caseId))
    .limit(1)
  if (!row) throw notFound("Caso")
  const messages = await db
    .select()
    .from(supportMessage)
    .where(eq(supportMessage.caseId, row.kase.id))
    .orderBy(asc(supportMessage.createdAt))
  const attachments = await db
    .select()
    .from(supportAttachment)
    .where(eq(supportAttachment.caseId, row.kase.id))
    .orderBy(asc(supportAttachment.createdAt))
  const grants = await db
    .select()
    .from(supportAccessGrant)
    .where(eq(supportAccessGrant.caseId, row.kase.id))
    .orderBy(desc(supportAccessGrant.createdAt))
    .limit(10)
  await writeAdminAudit(db, actor, {
    action: "support.case.read",
    organizationId: row.kase.organizationId,
    entityId: row.kase.id,
  })
  return toDetail(
    row.kase,
    messages.map(toMessage),
    attachments.map(toAttachment),
    grants.map(toGrant),
    row.orgName,
  )
}

async function staffWrite(
  db: Db,
  actor: AdminActor,
  kase: typeof supportCase.$inferSelect,
  values: Partial<typeof supportCase.$inferSelect>,
  auditAction: string,
): Promise<void> {
  await db
    .update(supportCase)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(supportCase.id, kase.id))
  await writeAdminAudit(db, actor, {
    action: auditAction,
    organizationId: kase.organizationId,
    entityId: kase.id,
  })
}

async function requireStaffCase(db: Db, caseId: string): Promise<typeof supportCase.$inferSelect> {
  const [row] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!row) throw notFound("Caso")
  return row
}

function staffBodyOf(body: unknown): string {
  const text = typeof body === "string" ? body.trim() : ""
  if (text.length < 1) throw validation("Escribe el mensaje")
  if (text.length > 4000) throw validation("El mensaje no puede superar 4000 caracteres")
  return text
}

/**
 * Respuesta pública al cliente: única fuente de la conversación. Marca
 * `lastPublicMessageAt` para el no-leído de la clínica.
 */
export async function replyToSupportCase(
  db: Db,
  actor: AdminActor,
  caseId: string,
  body: unknown,
): Promise<SupportMessageItem> {
  const text = staffBodyOf(body)
  const kase = await requireStaffCase(db, caseId)
  const [message] = await db
    .insert(supportMessage)
    .values({
      caseId: kase.id,
      organizationId: kase.organizationId,
      authorKind: "staff",
      authorUserId: actor.userId,
      body: text,
    })
    .returning()
  if (!message) throw new Error("No se pudo responder")
  const currentStatus = caseStatusOf(kase)
  const next: SupportStatus =
    currentStatus === "abierto" || currentStatus === "resuelto" ? "en_atencion" : currentStatus
  await staffWrite(
    db,
    actor,
    kase,
    { status: next, resolvedAt: null, lastPublicMessageAt: new Date() },
    "support.case.reply",
  )
  return toMessage(message)
}

/** Nota interna: solo el equipo la ve; la clínica ni sabe que existe. */
export async function addSupportInternalNote(
  db: Db,
  actor: AdminActor,
  caseId: string,
  body: unknown,
): Promise<SupportMessageItem> {
  const text = staffBodyOf(body)
  const kase = await requireStaffCase(db, caseId)
  const [message] = await db
    .insert(supportMessage)
    .values({
      caseId: kase.id,
      organizationId: kase.organizationId,
      authorKind: "staff",
      authorUserId: actor.userId,
      body: text,
      isInternal: true,
    })
    .returning()
  if (!message) throw new Error("No se pudo guardar la nota")
  await staffWrite(db, actor, kase, {}, "support.case.note")
  return toMessage(message)
}

/** Asigna responsable; asignar un caso abierto lo pone en atención. */
export async function assignSupportCase(
  db: Db,
  actor: AdminActor,
  caseId: string,
  staffUserId: string | null,
): Promise<void> {
  const kase = await requireStaffCase(db, caseId)
  await staffWrite(
    db,
    actor,
    kase,
    {
      assigneeStaffId: staffUserId,
      status: kase.status === "abierto" && staffUserId ? "en_atencion" : kase.status,
    },
    "support.case.assign",
  )
}

/** Cambia el estado; resolver sella `resolvedAt`, salir de resuelto cuenta reapertura. */
export async function setSupportCaseStatus(
  db: Db,
  actor: AdminActor,
  caseId: string,
  status: SupportStatus,
): Promise<void> {
  const kase = await requireStaffCase(db, caseId)
  // Una «Revisión de cobro» se resuelve al decidirla, con su respuesta (ADR 0054).
  if (kase.kind === "cobro" && status === "resuelto") {
    const [pending] = await db
      .select({ id: saasActionReview.id })
      .from(saasActionReview)
      .where(and(eq(saasActionReview.supportCaseId, caseId), eq(saasActionReview.status, "pendiente")))
      .limit(1)
    if (pending) throw new ServiceError("REVIEW_PENDING", 409, "Decide la revisión con «Devolver» o «Mantener el cobro» antes de resolver el caso")
  }
  const leavingResolved = kase.status === "resuelto" && status !== "resuelto"
  // Pasar a «Esperando a la clínica» le pide algo: cuenta como novedad sin
  // leer en su lista y, si no lo ve, le llega «Soporte de odentIA necesita algo de ti».
  const asksClinic = status === "esperando_clinica" && kase.status !== "esperando_clinica"
  await staffWrite(
    db,
    actor,
    kase,
    {
      status,
      resolvedAt: status === "resuelto" ? new Date() : null,
      reopenedCount: leavingResolved ? kase.reopenedCount + 1 : kase.reopenedCount,
      ...(asksClinic ? { lastPublicMessageAt: new Date() } : {}),
    },
    "support.case.status",
  )
}

/**
 * Responde a varios casos con el mismo texto (p. ej. una incidencia común).
 * Exige confirmar los destinatarios: los ids de organización declarados deben
 * coincidir exactamente con los de los casos. Cada caso recibe su propio
 * mensaje privado: los hilos nunca se comparten.
 */
export async function replyToSupportCasesMany(
  db: Db,
  actor: AdminActor,
  input: { caseIds: string[]; body: unknown; confirmOrganizationIds: (string | null)[] },
): Promise<{ replied: string[] }> {
  const text = staffBodyOf(input.body)
  const uniqueIds = uniqueStrings(
    input.caseIds.filter((id) => typeof id === "string" && id.length > 0),
  )
  if (uniqueIds.length === 0) throw validation("Elige al menos un caso")
  if (uniqueIds.length > 50) throw validation("No más de 50 casos por respuesta")
  const rows = await db.select().from(supportCase).where(inArray(supportCase.id, uniqueIds))
  if (rows.length !== uniqueIds.length) throw notFound("Caso")
  const actual = uniqueStrings(rows.map((row) => String(row.organizationId))).sort()
  const confirmed = uniqueStrings(input.confirmOrganizationIds.map((org) => String(org))).sort()
  if (actual.length !== confirmed.length || actual.some((org, index) => org !== confirmed[index])) {
    throw new ServiceError(
      "CONFIRM_RECIPIENTS",
      409,
      "Confirma las organizaciones destinatarias: no coinciden con los casos elegidos",
    )
  }
  const replied: string[] = []
  for (const kase of rows) {
    await db.insert(supportMessage).values({
      caseId: kase.id,
      organizationId: kase.organizationId,
      authorKind: "staff",
      authorUserId: actor.userId,
      body: text,
    })
    await staffWrite(
      db,
      actor,
      kase,
      {
        status:
          kase.status === "abierto" || kase.status === "resuelto" ? "en_atencion" : kase.status,
        resolvedAt: null,
        lastPublicMessageAt: new Date(),
      },
      "support.case.reply_many",
    )
    replied.push(kase.id)
  }
  return { replied }
}

/**
 * Agrupación para conocimiento: preguntas iguales entre clínicas con contador.
 * Solo agregado (conteo, pantallas, fechas): sin organizaciones, sin adjuntos,
 * sin conversación. Preparar una respuesta común no mezcla datos de clientes.
 */
export async function supportKnowledgeGroups(
  db: Db,
  actor: AdminActor,
): Promise<SupportKnowledgeGroup[]> {
  const rows = await db.execute<{
    dedupe_key: string
    question: string
    kind: string
    open_cases: number
    organizations: number
    screens: string[]
    first_at: Date | string
  }>(sql`
    select dedupe_key, min(question) as question, min(kind) as kind,
           count(*)::int as open_cases,
           count(distinct organization_id)::int as organizations,
           array_agg(distinct screen) as screens, min(created_at) as first_at
    from support_case where status <> 'resuelto'
    group by dedupe_key order by count(*) desc, min(created_at) asc limit 200`)
  await writeAdminAudit(db, actor, { action: "support.knowledge.list" })
  return rows.map((row) => ({
    dedupeKey: row.dedupe_key,
    question: row.question,
    kind: row.kind,
    openCases: Number(row.open_cases),
    organizations: Number(row.organizations),
    screens: row.screens,
    firstAt: new Date(row.first_at).toISOString(),
  }))
}

/* ---------- Diagnóstico con permiso vigente (ownerDb) ---------- */

/**
 * Vista diagnóstica de la organización: solo configuración operacional no
 * secreta, nunca datos clínicos ni secretos. Exige permiso vigente del caso;
 * sin él, deniega en servidor y audita el intento. No es suplantación: el
 * actor auditado es el staff y no se abre la plataforma como owner.
 */
export async function readSupportDiagnostic(
  db: Db,
  actor: AdminActor,
  caseId: string,
): Promise<SupportDiagnostic> {
  const kase = await requireStaffCase(db, caseId)
  if (!kase.organizationId)
    throw new ServiceError("FORBIDDEN", 403, "Este caso no tiene clínica asociada")
  const orgId = kase.organizationId
  const grant = await activeGrantFor(db, kase.id)
  if (!grant) {
    await db.insert(supportAccessAudit).values({
      grantId: null,
      caseId: kase.id,
      organizationId: orgId,
      staffUserId: actor.userId,
      action: "denegado_sin_permiso",
    })
    await writeAdminAudit(db, actor, {
      action: "support.diagnostic.denied",
      organizationId: orgId,
      entityId: kase.id,
    })
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Sin permiso vigente de la clínica: pídele al owner o admin que autorice el acceso",
    )
  }
  const diagnostic = await withOrgContext(db, orgId, async (tx) => {
    const [org] = await tx
      .select({ id: organization.id, name: organization.name, slug: organization.slug })
      .from(organization)
      .where(eq(organization.id, orgId))
      .limit(1)
    if (!org) throw notFound("Organización")
    const [profile] = await tx
      .select({
        countryCode: orgProfile.countryCode,
        currency: orgProfile.currency,
        timezone: orgProfile.timezone,
        locale: orgProfile.locale,
      })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, orgId))
      .limit(1)
    const branches = await tx
      .select({
        id: branch.id,
        name: branch.name,
        isActive: branch.isActive,
        timezone: branch.timezone,
        appointmentDefaultMinutes: branch.appointmentDefaultMinutes,
      })
      .from(branch)
      .where(eq(branch.organizationId, orgId))
      .orderBy(asc(branch.name))
    const [agent] = await tx
      .select({
        enabled: agentConfig.enabled,
        decisionProvider: agentConfig.decisionProvider,
        decisionRoutingEnabled: agentConfig.decisionRoutingEnabled,
        clinicalAssistantEnabled: agentConfig.clinicalAssistantEnabled,
      })
      .from(agentConfig)
      .where(eq(agentConfig.organizationId, orgId))
      .limit(1)
    const channels = await tx
      .select({
        channel: channelConnection.channel,
        provider: channelConnection.provider,
        displayName: channelConnection.displayName,
        status: channelConnection.status,
      })
      .from(channelConnection)
      .where(eq(channelConnection.organizationId, orgId))
      .orderBy(asc(channelConnection.displayName))
    const [services] = await tx
      .select({ total: count() })
      .from(serviceCatalog)
      .where(eq(serviceCatalog.organizationId, orgId))
    const membersByRole = await tx
      .select({ role: member.role, total: count() })
      .from(member)
      .where(eq(member.organizationId, orgId))
      .groupBy(member.role)
    return {
      organization: org,
      profile: profile ?? null,
      branches,
      agent: agent ?? null,
      channels,
      services: { total: Number(services?.total ?? 0) },
      membersByRole: membersByRole.map((row) => ({ role: row.role, total: Number(row.total) })),
    }
  })
  await db.insert(supportAccessAudit).values({
    grantId: grant.id,
    caseId: kase.id,
    organizationId: orgId,
    staffUserId: actor.userId,
    action: "vista_diagnostica",
  })
  await writeAdminAudit(db, actor, {
    action: "support.diagnostic.read",
    organizationId: orgId,
    entityId: kase.id,
  })
  const [orgRow] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1)
  return {
    caseId: kase.id,
    organizationId: orgId,
    organizationName: orgRow?.name ?? diagnostic.organization.name,
    scope: SUPPORT_DIAGNOSTIC_SCOPE,
    grantExpiresAt: grant.expiresAt.toISOString(),
    ...diagnostic,
  }
}

/** El equipo también puede revocar: queda auditado quién lo hizo. */
export async function revokeSupportGrantAsStaff(
  db: Db,
  actor: AdminActor,
  grantId: string,
): Promise<void> {
  const [grant] = await db
    .select()
    .from(supportAccessGrant)
    .where(eq(supportAccessGrant.id, grantId))
    .limit(1)
  if (!grant) throw notFound("Permiso")
  if (grant.revokedAt !== null) return
  await db
    .update(supportAccessGrant)
    .set({ revokedAt: new Date() })
    .where(eq(supportAccessGrant.id, grant.id))
  await db.insert(supportAccessAudit).values({
    grantId: grant.id,
    caseId: grant.caseId,
    organizationId: grant.organizationId,
    staffUserId: actor.userId,
    action: "revocado",
  })
  await writeAdminAudit(db, actor, {
    action: "support.grant.revoke",
    organizationId: grant.organizationId,
    entityId: grant.caseId,
  })
}

/** Historial de accesos del caso: quién vio el diagnóstico y cuándo. */
export async function listSupportAccessAudit(
  db: Db,
  actor: AdminActor,
  caseId: string,
): Promise<{ id: string; staffUserId: string; action: string; createdAt: string }[]> {
  await requireStaffCase(db, caseId)
  const rows = await db
    .select()
    .from(supportAccessAudit)
    .where(eq(supportAccessAudit.caseId, caseId))
    .orderBy(desc(supportAccessAudit.createdAt))
    .limit(100)
  return rows.map((row) => ({
    id: row.id,
    staffUserId: row.staffUserId,
    action: row.action,
    createdAt: row.createdAt.toISOString(),
  }))
}

/* ---------- Métricas: conteos y tiempos, nunca preguntas sin enviar ---------- */

export async function supportMetrics(db: Db, actor: AdminActor): Promise<SupportMetrics> {
  const byStatus = await db
    .select({ status: supportCase.status, total: count() })
    .from(supportCase)
    .groupBy(supportCase.status)
  const byKind = await db
    .select({ kind: supportCase.kind, total: count() })
    .from(supportCase)
    .groupBy(supportCase.kind)
  const [withoutAssignee] = await db
    .select({ total: count() })
    .from(supportCase)
    .where(and(isNull(supportCase.assigneeStaffId), ne(supportCase.status, "resuelto")))
  const [grants] = await db
    .select({ total: count() })
    .from(supportAccessGrant)
    .where(and(isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, new Date())))
  const [timing] = await db.execute<{ avg_minutes: number | null }>(sql`
    select avg(extract(epoch from (first_reply - opened)) / 60) as avg_minutes from (
      select c.id, c.created_at as opened, min(m.created_at) as first_reply
      from support_case c join support_message m on m.case_id = c.id
      where m.author_kind = 'staff' and m.is_internal = false
      group by c.id
    ) replied`)
  await writeAdminAudit(db, actor, { action: "support.metrics.read" })
  const validStatuses = byStatus.filter((row) =>
    (SUPPORT_STATUSES as string[]).includes(row.status),
  )
  const validKinds = byKind.filter(
    (row) => row.kind === "pregunta" || row.kind === "problema" || row.kind === "acceso" || row.kind === "cobro",
  )
  return {
    byStatus: validStatuses.map((row) => ({
      status: row.status as SupportStatus,
      total: Number(row.total),
    })),
    byKind: validKinds.map((row) => ({ kind: row.kind as SupportKind, total: Number(row.total) })),
    openWithoutAssignee: Number(withoutAssignee?.total ?? 0),
    activeGrants: Number(grants?.total ?? 0),
    avgFirstReplyMinutes:
      timing?.avg_minutes === null || timing?.avg_minutes === undefined
        ? null
        : Number(timing.avg_minutes),
  }
}

const HELP_STATS_DAYS = 30
const HELP_STATS_ROWS = 10

/**
 * Lo que Ariadna no supo responder y lo que respondió sin servir, en todas las
 * clínicas: la lista de trabajo para mejorar la guía. Son conteos por pantalla
 * y por tema; lo que se preguntó no se guarda, salvo que la persona lo envíe.
 */
export async function supportHelpStats(db: Db, actor: AdminActor, now: Date = new Date()): Promise<HelpGuideStats> {
  // Sin el identificador: «/people/<id>» de cada persona es la misma pantalla.
  const screen = sql<string>`regexp_replace(${helpAsk.screen}, '/[0-9a-f-]{36}.*$', '')`
  const rows = await db
    .select({ screen, topicId: helpAsk.topicId, helpful: helpAsk.helpful, total: count() })
    .from(helpAsk)
    .where(gte(helpAsk.createdAt, new Date(now.getTime() - HELP_STATS_DAYS * 86_400_000)))
    .groupBy(screen, helpAsk.topicId, helpAsk.helpful)
  await writeAdminAudit(db, actor, { action: "support.help_stats.read" })
  const unanswered = new Map<string, number>()
  const notHelpful = new Map<string, number>()
  let asked = 0
  for (const row of rows) {
    const total = Number(row.total)
    asked += total
    if (row.topicId === null) {
      const name = helpTopicForScreen(row.screen)?.title ?? row.screen
      unanswered.set(name, (unanswered.get(name) ?? 0) + total)
    }
    if (row.helpful === false && row.topicId !== null) {
      const name = helpTopic(row.topicId)?.title ?? row.topicId
      notHelpful.set(name, (notHelpful.get(name) ?? 0) + total)
    }
  }
  const ranked = (counts: Map<string, number>) =>
    [...counts].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total).slice(0, HELP_STATS_ROWS)
  const sum = (counts: Map<string, number>) => [...counts.values()].reduce((all, total) => all + total, 0)
  return {
    days: HELP_STATS_DAYS,
    asked,
    unanswered: sum(unanswered),
    notHelpful: sum(notHelpful),
    unansweredByScreen: ranked(unanswered),
    notHelpfulByTopic: ranked(notHelpful),
  }
}

/* ---------- Adjuntos: URLs firmadas tras comprobar permiso ---------- */

export interface SupportStorage {
  attachmentUrl(objectKey: string, ttlSeconds?: number): Promise<string>
}

/**
 * La clínica descarga adjuntos de sus propios casos. Pertenencia y visibilidad
 * se comprueban antes de firmar: lo colgado de una nota interna no existe
 * para el cliente (ni metadatos ni URL).
 */
export async function clientSupportAttachmentUrl(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
  attachmentId: string,
  storage: SupportStorage,
): Promise<string> {
  const [kase] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const row = requireCaseInOrg(kase, orgId)
  await requireCaseReader(tx, row, orgId, userId)
  const [found] = await tx
    .select({ attachment: supportAttachment, internal: supportMessage.isInternal })
    .from(supportAttachment)
    .leftJoin(supportMessage, eq(supportAttachment.messageId, supportMessage.id))
    .where(and(eq(supportAttachment.id, attachmentId), eq(supportAttachment.caseId, row.id)))
    .limit(1)
  if (!found || found.internal === true) throw notFound("Adjunto")
  return storage.attachmentUrl(found.attachment.objectKey, 900)
}

/** El equipo descarga adjuntos de cualquier caso (sesión staff verificada en ruta). */
export async function staffSupportAttachmentUrl(
  db: Db,
  actor: AdminActor,
  caseId: string,
  attachmentId: string,
  storage: SupportStorage,
): Promise<string> {
  const kase = await requireStaffCase(db, caseId)
  const [attachment] = await db
    .select()
    .from(supportAttachment)
    .where(and(eq(supportAttachment.id, attachmentId), eq(supportAttachment.caseId, kase.id)))
    .limit(1)
  if (!attachment) throw notFound("Adjunto")
  await writeAdminAudit(db, actor, {
    action: "support.attachment.read",
    organizationId: kase.organizationId,
    entityId: kase.id,
  })
  return storage.attachmentUrl(attachment.objectKey, 900)
}

/* ---------- Aislamiento entre tenants (invariante de regresión) ---------- */

/**
 * ¿Puede este usuario ver este caso? Misma organización y (autor del caso o
 * staff con permiso): la ruta la usa antes de servir adjuntos y diagnósticos.
 */
export async function canAccessSupportCase(
  tx: Db,
  orgId: string,
  userId: string,
  caseId: string,
): Promise<boolean> {
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!row || (row.organizationId ?? null) !== (orgId ?? null)) return false
  try {
    await requireCaseReader(tx, row, orgId, userId)
    return true
  } catch {
    return false
  }
}

/** Reabre un caso de acceso resuelto desde la cuenta (panel, sin clínica). */
export async function reopenAccountSupportCase(
  db: Db,
  userId: string,
  caseId: string,
): Promise<void> {
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase || kase.openedBy !== userId) throw notFound("Caso")
  if (kase.status !== "resuelto") throw validation("El caso ya está abierto")
  await db
    .update(supportCase)
    .set({
      status: "en_atencion",
      resolvedAt: null,
      reopenedCount: kase.reopenedCount + 1,
      clientSeenAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(supportCase.id, kase.id))
}

/** «Ver» desde la cuenta: solo el autor marca su propio visto. */
export async function markAccountSupportCaseSeen(
  db: Db,
  userId: string,
  caseId: string,
): Promise<void> {
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase || kase.openedBy !== userId) throw notFound("Caso")
  await db.update(supportCase).set({ clientSeenAt: new Date() }).where(eq(supportCase.id, kase.id))
}

/**
 * El equipo adjunta archivos al caso (capturas, documentos de seguimiento).
 * Semántica explícita: sin `messageId` el adjunto es público (la clínica lo
 * ve); para material interno hay que colgarlo de una nota interna.
 */
export async function assertStaffAttachmentTarget(
  db: Db,
  caseId: string,
  messageId?: string,
): Promise<void> {
  const kase = await requireStaffCase(db, caseId)
  if (messageId) {
    const [message] = await db
      .select()
      .from(supportMessage)
      .where(and(eq(supportMessage.id, messageId), eq(supportMessage.caseId, kase.id)))
      .limit(1)
    if (!message) throw notFound("Mensaje")
  }
}

export async function staffAttachToSupportCase(
  db: Db,
  actor: AdminActor,
  caseId: string,
  input: {
    messageId?: string
    objectKey: string
    mimeType: string
    filename: string
    size: number
  },
): Promise<SupportAttachmentItem> {
  await assertStaffAttachmentTarget(db, caseId, input.messageId)
  const kase = await requireStaffCase(db, caseId)
  const [attachment] = await db
    .insert(supportAttachment)
    .values({
      caseId: kase.id,
      messageId: input.messageId ?? null,
      organizationId: kase.organizationId,
      objectKey: input.objectKey,
      mimeType: input.mimeType,
      filename: input.filename.slice(0, 200),
      size: input.size,
      createdBy: actor.userId,
    })
    .returning()
  if (!attachment) throw new Error("No se pudo registrar el adjunto")
  await writeAdminAudit(db, actor, {
    action: "support.attachment.add",
    organizationId: kase.organizationId,
    entityId: kase.id,
  })
  return toAttachment(attachment)
}

/**
 * Atención pendiente de soporte para el Inicio admin: solo agregados
 * (conteos y fecha del más antiguo sin resolver), sin textos de clientes.
 * Sin auditoría: es un conteo, no una lectura de datos de clínicas.
 */
export async function getAdminSupportAttention(
  ownerTx: Db,
): Promise<{ openCount: number; waitingClinicCount: number; oldestOpenAt: string | null }> {
  const [row] = await ownerTx.execute<{
    open_count: number
    waiting_clinic_count: number
    oldest_open_at: Date | string | null
  }>(sql`
    select count(*) filter (where status in ('abierto', 'en_atencion'))::int as open_count,
           count(*) filter (where status = 'esperando_clinica')::int as waiting_clinic_count,
           min(created_at) filter (where status <> 'resuelto') as oldest_open_at
    from support_case`)
  return {
    openCount: Number(row?.open_count ?? 0),
    waitingClinicCount: Number(row?.waiting_clinic_count ?? 0),
    oldestOpenAt: row?.oldest_open_at ? new Date(row.oldest_open_at).toISOString() : null,
  }
}

export interface ActiveSupportGrant {
  id: string
  caseId: string
  scope: string
  expiresAt: string
  grantedBy: string
  createdAt: string
}

/**
 * Permisos diagnóstico vigentes de la clínica: solo metadatos (alcance,
 * vencimiento, quién autorizó), sin textos del caso. Cualquier miembro puede
 * verlos; revocar sigue siendo owner/admin en servidor.
 */
export async function listActiveSupportGrants(
  tx: Db,
  orgId: string,
): Promise<ActiveSupportGrant[]> {
  const rows = await tx
    .select()
    .from(supportAccessGrant)
    .where(
      and(
        eq(supportAccessGrant.organizationId, orgId),
        isNull(supportAccessGrant.revokedAt),
        gt(supportAccessGrant.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(supportAccessGrant.expiresAt))
    .limit(20)
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    scope: row.scope,
    expiresAt: row.expiresAt.toISOString(),
    grantedBy: row.grantedBy,
    createdAt: row.createdAt.toISOString(),
  }))
}

export interface SupportAssignee {
  userId: string
  name: string
  role: "admin" | "support"
}

/**
 * Equipo asignable: staff activo con nombre para mostrar. Solo id y nombre:
 * el picker asigna sin exponer credenciales ni auditoría.
 */
export async function listSupportAssignees(db: Db): Promise<SupportAssignee[]> {
  const rows = await db
    .select({ userId: adminStaff.userId, name: user.name, role: adminStaff.role })
    .from(adminStaff)
    .innerJoin(user, eq(adminStaff.userId, user.id))
    .where(eq(adminStaff.active, true))
    .orderBy(asc(user.name))
    .limit(100)
  return rows.flatMap((row): SupportAssignee[] =>
    row.role === "admin" || row.role === "support"
      ? [{ userId: row.userId, name: row.name, role: row.role }]
      : [],
  )
}

/**
 * La cuenta registra un adjunto ya subido en su caso: solo el autor y con el
 * caso escribible. Lo colgado de notas internas sigue oculto al listar.
 */
export async function attachToAccountSupportCase(
  db: Db,
  userId: string,
  caseId: string,
  input: { objectKey: string; mimeType: string; filename: string; size: number },
): Promise<SupportAttachmentItem> {
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase || kase.openedBy !== userId) throw notFound("Caso")
  if (kase.status === "resuelto")
    throw validation("El caso está resuelto: reábrelo para agregar adjuntos")
  const [attachment] = await db
    .insert(supportAttachment)
    .values({
      caseId: kase.id,
      messageId: null,
      organizationId: kase.organizationId,
      objectKey: input.objectKey,
      mimeType: input.mimeType,
      filename: input.filename.slice(0, 200),
      size: input.size,
      createdBy: userId,
    })
    .returning()
  if (!attachment) throw new Error("No se pudo registrar el adjunto")
  return toAttachment(attachment)
}

/**
 * La cuenta descarga adjuntos de sus casos: autoría y visibilidad antes de
 * firmar, igual que en la clínica.
 */
export async function accountSupportAttachmentUrl(
  db: Db,
  userId: string,
  caseId: string,
  attachmentId: string,
  storage: SupportStorage,
): Promise<string> {
  const [kase] = await db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  if (!kase || kase.openedBy !== userId) throw notFound("Caso")
  const [found] = await db
    .select({ attachment: supportAttachment, internal: supportMessage.isInternal })
    .from(supportAttachment)
    .leftJoin(supportMessage, eq(supportAttachment.messageId, supportMessage.id))
    .where(and(eq(supportAttachment.id, attachmentId), eq(supportAttachment.caseId, kase.id)))
    .limit(1)
  if (!found || found.internal === true) throw notFound("Adjunto")
  return storage.attachmentUrl(found.attachment.objectKey, 900)
}
