import { createHash } from "node:crypto"
import { ORG_ROLES, type OrgRole, PRODUCT_ROLES, roleLabel } from "@odentia/auth/permissions"
import { type ClinicalProduct, isClinicalProduct } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { withOrgContext } from "@odentia/db"
import { adminStaff } from "@odentia/db/schema/admin-core"
import {
  supportAccessAudit,
  supportAccessGrant,
  supportAttachment,
  supportCase,
  supportGuideGap,
  supportMessage,
} from "@odentia/db/schema/admin-support"
import { member, organization, user } from "@odentia/db/schema/auth"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { helpAsk } from "@odentia/db/schema/workspace"
import { agentConfig, channelConnection } from "@odentia/db/schema/crm"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { saasActionReview } from "@odentia/db/schema/saas-billing"
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, ne, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { helpTopic, helpTopicForScreen } from "./help-guide.js"
import { normalizeForSearch } from "./knowledge.js"
import { helpTopicsFor } from "./products.js"
import { addBusinessDays, saasTermsAt } from "./saas-commercial-terms.js"
import { accessRequestPendingSql, clinicActsSinceSql } from "./support-case-rules.js"
import { claimSupportGrant } from "./support-session.js"
import { enqueueSupportInboxNotice, SUPPORT_ANSWER_BUSINESS_DAYS } from "./support-notices.js"

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
  /** Cuándo pidió soporte el acceso de diagnóstico (el último pedido). */
  accessRequestedAt: string | null
  /** Lo que pidió soporte: el rol con que mirar (nulo = solo la configuración) y cuántos minutos. */
  accessRequestedRole: string | null
  accessRequestedMinutes: number | null
  /** Hay un pedido de acceso y la clínica todavía no hizo nada después. */
  accessRequestPending: boolean
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
  /**
   * En la clínica, a quien lee un caso que no abrió (la propietaria que lo ve
   * por el pedido de acceso): quién lo abrió y con qué rol. Nulo para quien lo
   * abrió y en la administración, que tiene `opener`.
   */
  openedByOther?: { name: string; roleLabel: string } | null
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
  /** `diagnostico` (solo la configuración) o `rol` (la clínica en solo lectura con `viewRole`). */
  scope: "diagnostico" | "rol"
  viewRole: string | null
  reason: string | null
  /** La persona de soporte a quien se dio; nula hasta que alguien tome el caso. */
  staffUserId: string | null
  staffName: string | null
  expiresAt: string
  revokedAt: string | null
  /** Por qué terminó antes de tiempo: lo quitaron, lo reemplazó otro, se resolvió el caso… */
  endReason: string | null
  revokedBy: string | null
  active: boolean
  createdAt: string
  /** Las fichas que soporte abrió con este permiso: persona, parte y hora (solo en la clínica). */
  reads: { patientName: string; resource: string; at: string }[]
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
  /** Cuántos hay de cada rol; `label`, el nombre del rol en el producto de la clínica («Recepción», «Odontólogo»). */
  membersByRole: { role: string; label: string; total: number }[]
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
    scope: row.scope === "rol" ? "rol" : "diagnostico",
    viewRole: row.viewRole,
    reason: row.reason,
    staffUserId: row.staffUserId,
    staffName: null,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    endReason: row.endReason,
    revokedBy: row.revokedBy,
    active,
    createdAt: row.createdAt.toISOString(),
    reads: [],
  }
}

/**
 * Lo que la clínica ve de cada permiso en su caso: el nombre de quien de soporte
 * lo tuvo y las fichas que abrió mientras valía (de `clinical_access_log`, la
 * misma bitácora que «Consultas a la historia»).
 */
async function grantsSeenByClinic(tx: Db, orgId: string, rows: (typeof supportAccessGrant.$inferSelect)[]): Promise<SupportGrantItem[]> {
  const out: SupportGrantItem[] = []
  for (const row of rows) {
    const item = toGrant(row)
    if (row.staffUserId) {
      const [staff] = await tx.select({ name: user.name }).from(user).where(eq(user.id, row.staffUserId)).limit(1)
      item.staffName = staff?.name ?? null
      const until = row.revokedAt ?? row.expiresAt
      const reads = await tx.execute<{ name: string; resource: string; at: Date | string }>(sql`
        select c.display_name as name,
               l.resource, l.first_at as at
        from clinical_access_log l
        join patient p on p.organization_id = l.organization_id and p.id = l.patient_id
        join contact c on c.organization_id = p.organization_id and c.id = p.person_id
        where l.organization_id = ${orgId} and l.user_id = ${row.staffUserId}
          and l.first_at >= ${row.createdAt} and l.first_at <= ${until}
        order by l.first_at asc
        limit 200
      `)
      item.reads = [...reads].map((read) => ({
        patientName: read.name,
        resource: read.resource,
        at: new Date(read.at).toISOString(),
      }))
    }
    out.push(item)
  }
  return out
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

const kindOf = (kind: string): SupportKind =>
  (["pregunta", "problema", "acceso", "cobro"] as string[]).includes(kind) ? (kind as SupportKind) : "pregunta"

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
    kind: kindOf(row.kind),
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
 * en la clínica, lo siguen su propietario y su administrador. Desde que
 * soporte pide el acceso de diagnóstico, también lo leen la propietaria y los
 * administradores: son quienes pueden autorizarlo (ADR 0181). Nadie más.
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
  if (kase.accessRequestedAt !== null) return
  if (await openerStillMember(tx, kase.openedBy, orgId)) throw notFound("Caso")
}

async function openerStillMember(tx: Db, openedBy: string, orgId: string): Promise<boolean> {
  const [opener] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, openedBy), eq(member.organizationId, orgId)))
    .limit(1)
  return opener !== undefined
}

/**
 * ¿Lo que ve esta persona cuenta como visto del caso? El visto
 * (`clientSeenAt`) es uno por caso y es de quien lo abrió: lo marca esa
 * persona o, si ya no está en la clínica, quien lo sigue por ella. Quien solo
 * lo lee porque soporte pidió el acceso no lo marca por quien preguntó: si no,
 * quien preguntó perdería su no leído y su correo.
 */
async function seesForOpener(
  tx: Db,
  kase: typeof supportCase.$inferSelect,
  orgId: string,
  userId: string,
): Promise<boolean> {
  if (kase.openedBy === userId) return true
  if (kase.openedBy === null) return false
  return !(await openerStillMember(tx, kase.openedBy, orgId))
}

/**
 * Casos que sigue la persona en su clínica, del más reciente al más viejo: los
 * suyos y, si es propietaria o administradora, los de quien ya no está y
 * aquellos en que soporte pidió el acceso de diagnóstico.
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
          ? sql`(${supportCase.openedBy} = ${userId}
              or (${supportCase.openedBy} is not null and ${supportCase.accessRequestedAt} is not null)
              or not exists (select 1 from ${member} m
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
  // La propietaria que lo lee por el pedido de acceso ve quién lo abrió: el correo se lo nombra.
  const [opener] =
    kase.openedBy && kase.openedBy !== userId
      ? await tx.select({ name: user.name }).from(user).where(eq(user.id, kase.openedBy)).limit(1)
      : []
  return {
    ...toDetail(kase, messages.map(toMessage), attachments, await grantsSeenByClinic(tx, orgId, grants), null, await accessRequestPendingOf(tx, kase)),
    openedByOther: opener ? { name: opener.name, roleLabel: kase.role } : null,
  }
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
  accessRequestPending: boolean,
): SupportCaseDetail {
  return {
    ...toListItem(row, messages.length),
    organizationName,
    accessRequestedAt: row.accessRequestedAt?.toISOString() ?? null,
    accessRequestedRole: row.accessRequestedRole,
    accessRequestedMinutes: row.accessRequestedMinutes,
    accessRequestPending,
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

/**
 * La clínica hizo algo en su caso (escribió, adjuntó o autorizó el acceso) y
 * el caso vuelve a nosotros: si esperaba a la clínica o estaba resuelto, pasa
 * a «En atención» (desde resuelto cuenta la reapertura) y avisa al buzón de
 * soporte. `sourceId` identifica el hecho para no avisar dos veces. `seen`:
 * quien actuó vio el caso por quien lo abrió (`seesForOpener`).
 */
async function clinicActed(
  tx: Db,
  kase: typeof supportCase.$inferSelect,
  sourceId: string,
  seen: boolean,
): Promise<void> {
  const reopening = kase.status === "resuelto"
  const now = new Date()
  await tx
    .update(supportCase)
    .set({
      status: reopening || kase.status === "esperando_clinica" ? "en_atencion" : kase.status,
      resolvedAt: reopening ? null : kase.resolvedAt,
      reopenedCount: reopening ? kase.reopenedCount + 1 : kase.reopenedCount,
      ...(seen ? { clientSeenAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(supportCase.id, kase.id))
  await enqueueSupportInboxNotice(tx, {
    caseId: kase.id,
    organizationId: kase.organizationId,
    kind: "clinica_respondio",
    sourceId,
  })
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
  await clinicActed(tx, kase, message.id, await seesForOpener(tx, kase, orgId, userId))
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
  const now = new Date()
  await tx
    .update(supportCase)
    .set({
      status: "en_atencion",
      resolvedAt: null,
      reopenedCount: kase.reopenedCount + 1,
      ...((await seesForOpener(tx, kase, orgId, userId)) ? { clientSeenAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(supportCase.id, kase.id))
}

/**
 * «Ver»: la clínica abrió la conversación; lo ya respondido deja de contar
 * como no leído. Solo el autor del caso marca su propio visto (o quien lo
 * sigue si el autor ya no está): la propietaria que lo lee por el pedido de
 * acceso no lo marca por él.
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
  if (!(await seesForOpener(tx, kase, orgId, userId))) return
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
  // Con un mensaje, el mensaje ya avisó; suelto, el adjunto es la respuesta.
  if (!input.messageId) await clinicActed(tx, kase, attachment.id, await seesForOpener(tx, kase, orgId, userId))
  return toAttachment(attachment)
}

/* ---------- Consentimiento de acceso delegado (owner/admin; tx con RLS) ---------- */

/** Los roles con que soporte puede mirar una clínica: los de su producto, menos propietario y «miembro». */
export function supportViewRolesOf(product: ClinicalProduct): OrgRole[] {
  return PRODUCT_ROLES[product].filter((role) => role !== "owner" && role !== "member")
}

/** El producto de la clínica (sin perfil, odentIA). */
async function productOfOrg(tx: Db, orgId: string): Promise<ClinicalProduct> {
  const [profile] = await tx
    .select({ product: orgProfile.product })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return isClinicalProduct(profile?.product) ? profile.product : "dental"
}

/** «Para qué», opcional: hasta 500 caracteres, vacío = nulo. */
function supportReasonOf(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null
  if (typeof reason !== "string") throw invalidField("reason", "Escribe para qué en texto.")
  const text = reason.trim()
  if (!text) return null
  if (text.length > 500) throw invalidField("reason", "Escríbelo en 500 caracteres o menos.")
  return text
}

function supportMinutesOf(minutes: unknown): number {
  const value = minutes === undefined || minutes === null ? 30 : typeof minutes === "number" ? Math.floor(minutes) : Number.NaN
  if (!Number.isInteger(value) || value < 5 || value > SUPPORT_GRANT_MAX_MINUTES) {
    throw invalidField("minutes", `El acceso se autoriza entre 5 y ${SUPPORT_GRANT_MAX_MINUTES} minutos.`)
  }
  return value
}

/**
 * Cierra el permiso abierto de la clínica antes de dar otro: uno solo vigente
 * por clínica (`support_access_grant_one_open_uidx`), así el tope de 1 hora no se
 * encadena abriendo casos. El vencido se cierra a su hora, como vencido; el
 * vigente, ahora y como reemplazado. Corre con la clínica bloqueada.
 */
async function closeOpenGrantsOf(tx: Db, orgId: string, actorUserId: string, now: Date): Promise<void> {
  const open = await tx
    .select()
    .from(supportAccessGrant)
    .where(and(eq(supportAccessGrant.organizationId, orgId), isNull(supportAccessGrant.revokedAt)))
  for (const grant of open) {
    const expired = grant.expiresAt.getTime() <= now.getTime()
    await tx
      .update(supportAccessGrant)
      .set(
        expired
          ? { revokedAt: grant.expiresAt, endReason: "vencido" }
          : { revokedAt: now, endReason: "reemplazado", revokedBy: actorUserId },
      )
      .where(eq(supportAccessGrant.id, grant.id))
  }
}

/** Dos autorizaciones a la vez (doble clic, dos pestañas) se ordenan por clínica. */
async function lockSupportGrantsOf(tx: Db, orgId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`support_grant:${orgId}`}))`)
}

/**
 * Un owner/admin autoriza a soporte, ligado a un caso que puede leer: solo la
 * configuración (`viewRole` nulo, el diagnóstico) o la app de la clínica en solo
 * lectura con lo que ve `viewRole`. Uno vigente por clínica: el anterior se
 * cierra. Si soporte lo había pedido, el permiso es de quien lo pidió; si no, de
 * quien tome el caso. Queda en la auditoría con quien lo dio.
 */
export async function grantSupportAccess(
  tx: Db,
  orgId: string,
  userId: string,
  canGrant: boolean,
  caseId: string,
  minutes: unknown,
  access: { viewRole?: unknown; reason?: unknown } = {},
): Promise<SupportGrantItem> {
  if (!canGrant)
    throw new ServiceError(
      "FORBIDDEN",
      403,
      "Solo quien es propietario o administra la clínica puede autorizar el acceso",
    )
  const minutesNumber = supportMinutesOf(minutes)
  const reason = supportReasonOf(access.reason)
  let viewRole: OrgRole | null = null
  if (access.viewRole !== undefined && access.viewRole !== null) {
    const product = await productOfOrg(tx, orgId)
    if (typeof access.viewRole !== "string" || !(supportViewRolesOf(product) as string[]).includes(access.viewRole))
      throw invalidField("viewRole", "Elige un rol de la clínica.")
    viewRole = access.viewRole as OrgRole
  }
  await lockSupportGrantsOf(tx, orgId)
  const [row] = await tx.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const kase = requireCaseInOrg(row, orgId)
  // Solo se autoriza en un caso que esta persona puede leer.
  await requireCaseReader(tx, kase, orgId, userId)
  if (kase.status === "resuelto")
    throw validation("El caso ya está resuelto: no hace falta autorizar accesos")
  // `createdAt` explícito: `expiresAt` nace del mismo instante, así el CHECK
  // de 1 h exacta no depende del reloj de la base.
  const grantedAt = new Date()
  await closeOpenGrantsOf(tx, orgId, userId, grantedAt)
  const [grant] = await tx
    .insert(supportAccessGrant)
    .values({
      caseId: kase.id,
      organizationId: orgId,
      grantedBy: userId,
      scope: viewRole ? "rol" : "diagnostico",
      viewRole,
      // Lo pidió alguien de soporte: el permiso es suyo. Si no, de quien tome el caso.
      staffUserId: kase.accessRequestedBy ?? kase.assigneeStaffId ?? null,
      reason,
      createdAt: grantedAt,
      expiresAt: new Date(grantedAt.getTime() + minutesNumber * 60_000),
    })
    .returning()
  if (!grant) throw new Error("No se pudo autorizar el acceso")
  await tx.insert(supportAccessAudit).values({
    grantId: grant.id,
    caseId: kase.id,
    organizationId: orgId,
    staffUserId: userId,
    action: "autorizado",
  })
  // Autorizar es la respuesta de la clínica: el caso vuelve a nosotros.
  await clinicActed(tx, kase, grant.id, await seesForOpener(tx, kase, orgId, userId))
  return toGrant(grant)
}

/**
 * Quita un permiso: quien lo dio, o la propietaria o un administrador. Queda
 * quién lo quitó y que fue a mano; quitar uno ya cerrado no hace nada.
 */
export async function revokeSupportAccess(
  tx: Db,
  orgId: string,
  userId: string,
  canGrant: boolean,
  grantId: string,
  caseId?: string,
): Promise<void> {
  await lockSupportGrantsOf(tx, orgId)
  const [grant] = await tx
    .select()
    .from(supportAccessGrant)
    .where(eq(supportAccessGrant.id, grantId))
    .limit(1)
  if (!grant || grant.organizationId !== orgId) throw notFound("Permiso")
  // La dirección nombra el caso: el permiso tiene que ser de ese caso.
  if (caseId !== undefined && grant.caseId !== caseId) throw notFound("Permiso")
  if (grant.grantedBy !== userId && !canGrant)
    throw new ServiceError("FORBIDDEN", 403, "No puedes quitar este acceso")
  if (grant.revokedAt !== null) return
  const now = new Date()
  const expired = grant.expiresAt.getTime() <= now.getTime()
  await tx
    .update(supportAccessGrant)
    .set(expired ? { revokedAt: grant.expiresAt, endReason: "vencido" } : { revokedAt: now, endReason: "quitado", revokedBy: userId })
    .where(eq(supportAccessGrant.id, grant.id))
  if (!expired)
    await tx.insert(supportAccessAudit).values({
      grantId: grant.id,
      caseId: grant.caseId,
      organizationId: orgId,
      staffUserId: userId,
      action: "revocado",
    })

}

/**
 * «Dar acceso a soporte» desde Ayuda, sin que soporte lo haya pedido: abre el
 * caso (el contrato liga el permiso a un caso) con el «para qué» como pregunta y
 * da el permiso en la misma transacción.
 */
export async function giveSupportAccessFromHelp(
  tx: Db,
  orgId: string,
  userId: string,
  canGrant: boolean,
  input: { minutes?: unknown; viewRole?: unknown; reason?: unknown; screen: string; role: string; appVersion: string | null },
): Promise<{ caseId: string; grant: SupportGrantItem }> {
  if (!canGrant)
    throw new ServiceError("FORBIDDEN", 403, "Solo quien es propietario o administra la clínica puede autorizar el acceso")
  const reason = supportReasonOf(input.reason)
  const question = reason ?? "Doy acceso a soporte para que revise la clínica"
  const kase = await openSupportCaseFromHelp(tx, orgId, {
    userId,
    kind: "problema",
    question,
    detail: null,
    screen: input.screen,
    role: input.role,
    appVersion: input.appVersion,
    // Cada acceso dado es su propio caso: no se junta con otro igual.
    dedupeKey: createHash("sha256").update(`acceso:${userId}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 32),
  })
  const grant = await grantSupportAccess(tx, orgId, userId, canGrant, kase.id, input.minutes, {
    viewRole: input.viewRole,
    reason,
  })
  return { caseId: kase.id, grant }
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
  // Un caso de la cuenta no es de una clínica: no hay acceso de diagnóstico que pedir.
  return toDetail(row.kase, messages.map(toMessage), attachments, grants.map(toGrant), row.orgName, false)
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
  // En la cuenta solo escribe quien abrió el caso.
  await clinicActed(db, kase, message.id, true)
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

/*
 * «Nos espera»: una sola regla para la cola, Inicio y el número del menú.
 * Un caso nos espera si no está resuelto ni esperando a la clínica y, además,
 * nunca le respondimos en público o la clínica hizo algo después de nuestra
 * última respuesta: escribió, adjuntó o autorizó el acceso. Son fragmentos
 * sobre `support_case` sin alias: se usan dentro de un `from support_case`.
 */

/** El primer hecho de la clínica posterior a nuestra última respuesta pública. */
const clinicActAfterReplySql = sql`(select min(act.at) from (${clinicActsSinceSql(supportCase.lastPublicMessageAt)}) act)`

const waitingOnUsSql = sql<boolean>`(${supportCase.status} not in ('resuelto', 'esperando_clinica')
  and (${supportCase.lastPublicMessageAt} is null or ${clinicActAfterReplySql} is not null))`

/** Desde cuándo nos espera: desde que se abrió si nunca respondimos; si no, desde lo primero que hizo la clínica. */
const waitingSinceSql = sql`(case when not ${waitingOnUsSql} then null
  when ${supportCase.lastPublicMessageAt} is null then ${supportCase.createdAt}
  else ${clinicActAfterReplySql} end)`

/** El acceso de diagnóstico vigente del caso, si lo hay. */
const accessUntilSql = (now: Date) => sql`(select max(g.expires_at) from ${supportAccessGrant} g
  where g.case_id = ${supportCase.id} and g.revoked_at is null and g.expires_at > ${now.toISOString()}::timestamptz)`

/**
 * El orden de la cola, el mismo de Inicio: primero lo que nos espera, de la
 * espera más larga a la más corta; después lo que espera a la clínica y lo ya
 * respondido, por nuestra última respuesta; al final lo resuelto.
 */
const queueOrderSql = [
  sql`(case when ${waitingOnUsSql} then 0 when ${supportCase.status} <> 'resuelto' then 1 else 2 end)`,
  sql`${waitingSinceSql} asc nulls last`,
  sql`(case when ${supportCase.status} <> 'resuelto' then ${supportCase.lastPublicMessageAt} end) asc nulls last`,
  sql`${supportCase.resolvedAt} desc nulls last`,
  sql`${supportCase.createdAt} asc`,
  sql`${supportCase.id} asc`,
]

/** Soporte no ve los casos «Revisión de cobro»: son de la administración (ADR 0094 y 0181). */
const visibleKindsFor = (actor: AdminActor | undefined) =>
  actor?.role === "admin" ? undefined : ne(supportCase.kind, "cobro")

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * «Responder hasta el…»: un caso que nadie respondió, a los días hábiles del
 * objetivo del equipo; un caso de cobro, el plazo de su revisión pendiente, y
 * solo para la administración. Un caso automático de odentIA no tiene plazo.
 */
async function answerByOf(
  db: Db,
  actor: AdminActor | undefined,
  rows: Array<Pick<typeof supportCase.$inferSelect, "id" | "kind" | "status" | "openedBy" | "lastPublicMessageAt" | "createdAt">>,
): Promise<Map<string, Date | null>> {
  const out = new Map<string, Date | null>()
  const billing = rows.filter((row) => row.kind === "cobro" && row.status !== "resuelto")
  const reviews =
    actor?.role === "admin" && billing.length > 0
      ? await db
          .select({ caseId: saasActionReview.supportCaseId, requestedAt: saasActionReview.requestedAt })
          .from(saasActionReview)
          .where(
            and(
              inArray(
                saasActionReview.supportCaseId,
                billing.map((row) => row.id),
              ),
              eq(saasActionReview.status, "pendiente"),
            ),
          )
      : []
  for (const row of rows) {
    if (row.status === "resuelto") {
      out.set(row.id, null)
      continue
    }
    if (row.kind === "cobro") {
      const review = reviews.find((item) => item.caseId === row.id)
      out.set(
        row.id,
        review ? addBusinessDays(review.requestedAt, (await saasTermsAt(db, review.requestedAt)).reviewAnswerDays) : null,
      )
      continue
    }
    out.set(
      row.id,
      row.lastPublicMessageAt === null && row.openedBy !== null
        ? addBusinessDays(row.createdAt, SUPPORT_ANSWER_BUSINESS_DAYS)
        : null,
    )
  }
  return out
}

/** Una fila de «Casos de soporte por atender» en Inicio: solo metadatos, nunca la pregunta. */
export interface SupportHomeRow {
  id: string
  organizationId: string | null
  /** La clínica, «Cuenta sin clínica» o «odentIA · automático». */
  organizationName: string
  /** El producto de la clínica; nulo si el caso no es de una clínica. */
  product: ClinicalProduct | null
  kind: SupportKind
  assigneeName: string | null
  waitingSince: string
  answerBy: string | null
  accessUntil: string | null
}

/**
 * Lo que nos espera, en el orden de la cola. Sin auditoría: son metadatos,
 * como los conteos (ni la pregunta ni la conversación). Sin tope, como las
 * filas de la lista de espera: son las mismas que cuenta el número de
 * «Soporte» en el menú (`getAdminSupportAttention`), y un tope haría que
 * Inicio dijera menos que el menú sin avisarlo.
 */
export async function supportHomeRows(db: Db, actor: AdminActor, now: Date = new Date()): Promise<SupportHomeRow[]> {
  const assignee = alias(user, "assignee")
  const rows = await db
    .select({
      id: supportCase.id,
      organizationId: supportCase.organizationId,
      orgName: organization.name,
      product: orgProfile.product,
      kind: supportCase.kind,
      status: supportCase.status,
      openedBy: supportCase.openedBy,
      lastPublicMessageAt: supportCase.lastPublicMessageAt,
      createdAt: supportCase.createdAt,
      assigneeName: assignee.name,
      waitingSince: waitingSinceSql,
      accessUntil: accessUntilSql(now),
    })
    .from(supportCase)
    .leftJoin(organization, eq(organization.id, supportCase.organizationId))
    .leftJoin(orgProfile, eq(orgProfile.organizationId, supportCase.organizationId))
    .leftJoin(assignee, eq(assignee.id, supportCase.assigneeStaffId))
    .where(and(waitingOnUsSql, visibleKindsFor(actor)))
    .orderBy(...queueOrderSql)
  const answerBy = await answerByOf(db, actor, rows)
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.orgName ?? (row.openedBy === null ? "odentIA · automático" : "Cuenta sin clínica"),
    product: isClinicalProduct(row.product) ? row.product : null,
    kind: kindOf(row.kind),
    assigneeName: row.assigneeName,
    waitingSince: (dateOrNull(row.waitingSince) ?? row.createdAt).toISOString(),
    answerBy: answerBy.get(row.id)?.toISOString() ?? null,
    accessUntil: dateOrNull(row.accessUntil)?.toISOString() ?? null,
  }))
}

export interface StaffCaseFilters {
  organizationId?: string
  /** «me»: los míos; «none»: sin responsable; o el id de alguien del equipo. */
  assignee?: "me" | "none" | (string & {})
  kind?: SupportKind
  /** Por omisión, los que no están resueltos («sin_resolver»). */
  status?: SupportStatus | "sin_resolver"
  limit?: number
  offset?: number
}

/** Una fila de la cola: el caso y dónde está su espera. */
export interface StaffSupportCaseListItem extends SupportCaseListItem {
  /** Nos espera (la misma regla de Inicio y del menú). */
  waitingOnUs: boolean
  /** Desde cuándo nos espera; nulo si no nos espera. */
  waitingSince: string | null
  /** «Responder hasta el…»: solo mientras nadie respondió (o la revisión de cobro, para la administración). */
  answerBy: string | null
  /** Nuestra última respuesta pública (o el pedido a la clínica). */
  lastStaffReplyAt: string | null
  /** Hasta cuándo rige el acceso de diagnóstico autorizado. */
  accessUntil: string | null
}

export interface StaffSupportCaseList {
  items: StaffSupportCaseListItem[]
  total: number
  /** Con «sin_resolver»: cuántos resueltos quedan fuera con los mismos filtros. */
  resolvedCount: number
}

/**
 * Cola de casos para el equipo: sin cuerpos de mensajes, solo triaje. Ordena
 * con la regla de «nos espera» y pagina por desplazamiento. Soporte no recibe
 * los casos de cobro.
 */
export async function listSupportCasesForStaff(
  db: Db,
  actor: AdminActor,
  filters: StaffCaseFilters = {},
  now: Date = new Date(),
): Promise<StaffSupportCaseList> {
  const limit = Math.min(Math.max(filters.limit ?? 30, 1), 100)
  const offset = Math.max(filters.offset ?? 0, 0)
  const status = filters.status ?? "sin_resolver"
  const assignee =
    filters.assignee === "none"
      ? isNull(supportCase.assigneeStaffId)
      : filters.assignee
        ? eq(supportCase.assigneeStaffId, filters.assignee === "me" ? actor.userId : filters.assignee)
        : undefined
  const scope = [
    visibleKindsFor(actor),
    filters.organizationId ? eq(supportCase.organizationId, filters.organizationId) : undefined,
    assignee,
    filters.kind ? eq(supportCase.kind, filters.kind) : undefined,
  ]
  const conditions = [
    ...scope,
    status === "sin_resolver" ? ne(supportCase.status, "resuelto") : eq(supportCase.status, status),
  ]
  const rows = await db
    .select({
      kase: supportCase,
      orgName: organization.name,
      waitingOnUs: waitingOnUsSql,
      waitingSince: waitingSinceSql,
      accessUntil: accessUntilSql(now),
    })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(and(...conditions))
    .orderBy(...queueOrderSql)
    .limit(limit)
    .offset(offset)
  const [totals] = await db
    .select({
      total: sql<number>`count(*) filter (where ${and(...conditions)})::int`,
      resolved: sql<number>`count(*) filter (where ${supportCase.status} = 'resuelto')::int`,
    })
    .from(supportCase)
    .where(and(...scope))
  const answerBy = await answerByOf(
    db,
    actor,
    rows.map((row) => row.kase),
  )
  await writeAdminAudit(db, actor, {
    action: "support.cases.list",
    metadata: {
      status,
      kind: filters.kind ?? null,
      assignee: filters.assignee ?? null,
      organizationId: filters.organizationId ?? null,
    },
  })
  return {
    items: rows.map((row) => ({
      ...toListItem(row.kase, 0),
      organizationName: row.orgName,
      waitingOnUs: row.waitingOnUs === true,
      waitingSince: dateOrNull(row.waitingSince)?.toISOString() ?? null,
      answerBy: answerBy.get(row.kase.id)?.toISOString() ?? null,
      lastStaffReplyAt: row.kase.lastPublicMessageAt?.toISOString() ?? null,
      accessUntil: dateOrNull(row.accessUntil)?.toISOString() ?? null,
    })),
    total: Number(totals?.total ?? 0),
    resolvedCount: status === "sin_resolver" ? Number(totals?.resolved ?? 0) : 0,
  }
}

/** La ficha para el equipo: además, quién abrió, quién puede autorizar el acceso y la marca de la guía. */
export interface StaffSupportCaseDetail extends SupportCaseDetail {
  /** Quien abrió el caso y su rol de hoy; nulo en los automáticos de odentIA. */
  opener: { name: string; roleLabel: string } | null
  /** ¿Puede autorizar el acceso quien abrió? Con su membresía de hoy, no con el rol de cuando abrió. */
  openerCanGrant: boolean
  /** La propietaria y los administradores de hoy: quienes pueden autorizar el acceso. */
  granters: { name: string; roleLabel: string }[]
  /** El mensaje que deja «Pedir acceso de diagnóstico…», tal cual; nulo si no se puede pedir. */
  accessRequestText: string | null
  /** Los roles con que soporte puede pedir mirar esta clínica, con su nombre en el producto. */
  accessViewRoles: { value: string; label: string }[]
  /** Por qué no se puede pedir el acceso en este caso, si no se puede. */
  accessRequestBlocked: string | null
  /** «Falta en la guía»: cuándo se marcó, o nulo. */
  guideGapMarkedAt: string | null
}

/** Ficha completa del caso: conversación privada, notas internas, adjuntos y permisos. */
export async function getSupportCaseForStaff(
  db: Db,
  actor: AdminActor,
  caseId: string,
): Promise<StaffSupportCaseDetail> {
  const [row] = await db
    .select({ kase: supportCase, orgName: organization.name })
    .from(supportCase)
    .leftJoin(organization, eq(supportCase.organizationId, organization.id))
    .where(eq(supportCase.id, caseId))
    .limit(1)
  if (!row || !staffSees(actor, row.kase)) throw notFound("Caso")
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
  const access = await accessPeopleOf(db, row.kase)
  const [gap] = await db
    .select({ markedAt: supportGuideGap.markedAt })
    .from(supportGuideGap)
    .where(eq(supportGuideGap.caseId, row.kase.id))
    .limit(1)
  const blocked = await accessRequestBlockedReason(db, row.kase)
  const pending = await accessRequestPendingOf(db, row.kase)
  return {
    ...toDetail(
      row.kase,
      messages.map(toMessage),
      attachments.map(toAttachment),
      grants.map(toGrant),
      row.orgName,
      pending,
    ),
    ...access,
    // Vista previa con lo que viene puesto (la configuración, 30 minutos); la administración arma la suya al elegir.
    accessRequestText: blocked || pending ? null : accessRequestText(access.openerCanGrant, "la configuración de tu clínica", 30),
    accessViewRoles: row.kase.organizationId
      ? await productOfOrg(db, row.kase.organizationId).then((product) =>
          supportViewRolesOf(product).map((role) => ({ value: role, label: roleLabel(role, product) })),
        )
      : [],
    accessRequestBlocked: blocked,
    guideGapMarkedAt: gap?.markedAt.toISOString() ?? null,
  }
}

/* ---------- «Pedir acceso de diagnóstico…» (ADR 0181) ---------- */

/** El mensaje fijo del pedido: qué se pide mirar y quién lo autoriza. */
function accessRequestText(openerCanGrant: boolean, what: string, minutes: number): string {
  const ask = `Para revisarlo necesitamos mirar ${what}, ${minutes} minutos, sin cambiar nada.`
  return openerCanGrant
    ? `${ask} En este caso, revisa el pedido y pulsa «Dar acceso». Puedes cambiar el rol o el tiempo, y quitarlo cuando quieras.`
    : `${ask} Lo autoriza la propietaria o un administrador de la clínica: ya ven este caso en Ayuda, en «Tus casos con soporte». Pueden cambiar el rol o el tiempo, y quitarlo cuando quieran.`
}

/** «tu clínica como Odontólogo» o «la configuración de tu clínica», en las palabras del producto. */
function accessWhatText(viewRole: OrgRole | null, product: ClinicalProduct): string {
  return viewRole ? `tu clínica como ${roleLabel(viewRole, product)}` : "la configuración de tu clínica"
}

/** Quién abrió, si puede autorizar (con su membresía de hoy) y quiénes pueden. */
async function accessPeopleOf(
  db: Db,
  kase: typeof supportCase.$inferSelect,
): Promise<Pick<StaffSupportCaseDetail, "opener" | "openerCanGrant" | "granters">> {
  const [profile] = kase.organizationId
    ? await db
        .select({ product: orgProfile.product })
        .from(orgProfile)
        .where(eq(orgProfile.organizationId, kase.organizationId))
        .limit(1)
    : []
  const product: ClinicalProduct = isClinicalProduct(profile?.product) ? profile.product : "dental"
  const labelOf = (role: string) =>
    (ORG_ROLES as readonly string[]).includes(role) ? roleLabel(role as OrgRole, product) : role
  const people = kase.organizationId
    ? await db
        .select({ userId: member.userId, role: member.role, name: user.name })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .where(eq(member.organizationId, kase.organizationId))
    : []
  const [openerUser] = kase.openedBy
    ? await db.select({ name: user.name }).from(user).where(eq(user.id, kase.openedBy)).limit(1)
    : []
  const openerMembership = people.find((person) => person.userId === kase.openedBy)
  const granters = people
    .filter((person) => person.role === "owner" || person.role === "admin")
    .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, "es") : a.role === "owner" ? -1 : 1))
  return {
    opener: openerUser
      ? {
          name: openerUser.name,
          // Quien ya no está en la clínica conserva el rol con que abrió.
          roleLabel: openerMembership ? labelOf(openerMembership.role) : kase.role || "Cuenta",
        }
      : null,
    openerCanGrant: openerMembership?.role === "owner" || openerMembership?.role === "admin",
    granters: granters.map((person) => ({ name: person.name, roleLabel: labelOf(person.role) })),
  }
}

/** Por qué no se pide el acceso en este caso; nulo si se puede pedir. */
async function accessRequestBlockedReason(db: Db, kase: typeof supportCase.$inferSelect): Promise<string | null> {
  if (!kase.organizationId) return "Este caso no es de una clínica: no hay configuración que ver"
  if (kase.status === "resuelto") return "El caso está resuelto: reábrelo para pedir el acceso"
  if (kase.kind === "cobro") return "Un caso de cobro se revisa sin el acceso de diagnóstico"
  if (kase.kind === "acceso") return "Es un caso para entrar a su cuenta: no hay configuración que ver"
  const grant = await activeGrantFor(db, kase.id)
  if (grant) return `Ya hay un acceso vigente hasta las ${limaTime(grant.expiresAt)}`
  return null
}

const limaTimeFormat = new Intl.DateTimeFormat("es-PE", {
  timeZone: "America/Lima",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})
/** «15:30», en la hora de Lima, como la administración. */
const limaTime = (at: Date): string => limaTimeFormat.format(at)

/** ¿Hay un pedido de acceso sin nada de la clínica después? Entonces no se pide otro. */
async function accessRequestPendingOf(db: Db, kase: typeof supportCase.$inferSelect): Promise<boolean> {
  if (!kase.accessRequestedAt) return false
  const [row] = await db
    .select({ pending: accessRequestPendingSql })
    .from(supportCase)
    .where(eq(supportCase.id, kase.id))
    .limit(1)
  return row?.pending === true
}

/**
 * Soporte pide el acceso de diagnóstico: deja el mensaje fijo (según si quien
 * abrió puede autorizarlo), pasa el caso a «Esperando a la clínica» y, desde
 * ahí, la propietaria y los administradores lo leen y reciben el aviso. Pedirlo
 * otra vez sin que la clínica haya hecho nada no escribe otro mensaje. El caso
 * se lee bloqueado: dos pedidos a la vez (un doble clic, dos pestañas, dos
 * personas) se ordenan y el segundo ve el pedido del primero. Corre dentro de
 * la transacción que abre la ruta.
 */
export async function requestSupportAccess(
  db: Db,
  actor: AdminActor,
  caseId: string,
  now: Date = new Date(),
  access: { viewRole?: unknown; minutes?: unknown } = {},
): Promise<{ requestedAt: string; repeated: boolean }> {
  const kase = await requireStaffCaseFor(db, actor, caseId, { lock: true })
  const minutes = supportMinutesOf(access.minutes)
  const product = kase.organizationId ? await productOfOrg(db, kase.organizationId) : "dental"
  let viewRole: OrgRole | null = null
  if (access.viewRole !== undefined && access.viewRole !== null) {
    if (typeof access.viewRole !== "string" || !(supportViewRolesOf(product) as string[]).includes(access.viewRole))
      throw invalidField("viewRole", "Elige un rol de la clínica.")
    viewRole = access.viewRole as OrgRole
  }
  const blocked = await accessRequestBlockedReason(db, kase)
  if (blocked) {
    const active = blocked.startsWith("Ya hay un acceso vigente")
    throw new ServiceError(active ? "ACCESS_ACTIVE" : "VALIDATION", active ? 409 : 400, blocked)
  }
  if (kase.accessRequestedAt && (await accessRequestPendingOf(db, kase)))
    return { requestedAt: kase.accessRequestedAt.toISOString(), repeated: true }
  const { openerCanGrant } = await accessPeopleOf(db, kase)
  await db.insert(supportMessage).values({
    caseId: kase.id,
    organizationId: kase.organizationId,
    authorKind: "staff",
    authorUserId: actor.userId,
    body: accessRequestText(openerCanGrant, accessWhatText(viewRole, product), minutes),
    createdAt: now,
  })
  await staffWrite(
    db,
    actor,
    kase,
    {
      status: "esperando_clinica",
      resolvedAt: null,
      lastPublicMessageAt: now,
      accessRequestedAt: now,
      accessRequestedRole: viewRole,
      accessRequestedMinutes: minutes,
      accessRequestedBy: actor.userId,
    },
    "support.case.access_requested",
    { de: kase.status, quienAbrioAutoriza: openerCanGrant, rol: viewRole, minutos: minutes },
  )
  return { requestedAt: now.toISOString(), repeated: false }
}

/* ---------- «Falta en la guía» (marca del equipo en admin, ADR 0181) ---------- */

export interface SupportGuideGapItem {
  caseId: string
  question: string
  kind: SupportKind
  /** El tema de la guía según la pantalla desde donde se preguntó, en la guía del producto de la clínica. */
  topic: string | null
  markedAt: string
}

/** Marca que la respuesta de este caso falta en la guía. Marcar dos veces deja una marca. */
export async function markGuideGap(db: Db, actor: AdminActor, caseId: string): Promise<void> {
  const kase = await requireStaffCaseFor(db, actor, caseId)
  await db.insert(supportGuideGap).values({ caseId: kase.id, markedBy: actor.userId }).onConflictDoNothing()
  await writeAdminAudit(db, actor, {
    action: "support.case.guide_gap",
    organizationId: kase.organizationId,
    entityId: kase.id,
    metadata: { on: true },
  })
}

/** «Ya está en la guía»: quita la marca. */
export async function unmarkGuideGap(db: Db, actor: AdminActor, caseId: string): Promise<void> {
  const kase = await requireStaffCaseFor(db, actor, caseId)
  await db.delete(supportGuideGap).where(eq(supportGuideGap.caseId, kase.id))
  await writeAdminAudit(db, actor, {
    action: "support.case.guide_gap",
    organizationId: kase.organizationId,
    entityId: kase.id,
    metadata: { on: false },
  })
}

/**
 * «Para llevar a la guía»: lo marcado, del más viejo al más nuevo. Como el
 * resto de Conocimiento, sin clínica ni conversación: la pregunta, el tema y la
 * fecha. Soporte no ve los casos de cobro.
 */
export async function listGuideGaps(db: Db, actor: AdminActor): Promise<SupportGuideGapItem[]> {
  const rows = await db
    .select({
      caseId: supportCase.id,
      question: supportCase.question,
      kind: supportCase.kind,
      screen: supportCase.screen,
      product: orgProfile.product,
      markedAt: supportGuideGap.markedAt,
    })
    .from(supportGuideGap)
    .innerJoin(supportCase, eq(supportCase.id, supportGuideGap.caseId))
    .leftJoin(orgProfile, eq(orgProfile.organizationId, supportCase.organizationId))
    .where(visibleKindsFor(actor))
    .orderBy(asc(supportGuideGap.markedAt))
    .limit(200)
  await writeAdminAudit(db, actor, { action: "support.knowledge.list", metadata: { lista: "para_la_guia" } })
  return rows.map((row) => ({
    caseId: row.caseId,
    question: row.question,
    kind: kindOf(row.kind),
    topic:
      helpTopicForScreen(row.screen, helpTopicsFor(isClinicalProduct(row.product) ? row.product : "dental"))?.title ??
      null,
    markedAt: row.markedAt.toISOString(),
  }))
}

async function staffWrite(
  db: Db,
  actor: AdminActor,
  kase: typeof supportCase.$inferSelect,
  values: Partial<typeof supportCase.$inferSelect>,
  auditAction: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db
    .update(supportCase)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(supportCase.id, kase.id))
  await writeAdminAudit(db, actor, {
    action: auditAction,
    organizationId: kase.organizationId,
    entityId: kase.id,
    ...(metadata ? { metadata } : {}),
  })
}

/** ¿Ve este actor este caso? Un caso de cobro es solo de la administración (ADR 0094 y 0181). */
const staffSees = (actor: AdminActor, kase: { kind: string }): boolean => kase.kind !== "cobro" || actor.role === "admin"

/**
 * El caso para el equipo. Para el rol Soporte, un caso de cobro no existe: el
 * mismo 404 que un caso que no está, en la ficha y en cada acción.
 */
async function requireStaffCaseFor(
  db: Db,
  actor: AdminActor,
  caseId: string,
  options: { lock?: boolean } = {},
): Promise<typeof supportCase.$inferSelect> {
  const query = db.select().from(supportCase).where(eq(supportCase.id, caseId)).limit(1)
  const [row] = options.lock ? await query.for("update") : await query
  if (!row || !staffSees(actor, row)) throw notFound("Caso")
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
    { de: kase.status, a: status },
  )
  // Resuelto, su permiso termina: no queda soporte mirando un caso cerrado.
  if (status === "resuelto") {
    const now = new Date()
    await db
      .update(supportAccessGrant)
      .set({ revokedAt: now, endReason: "caso_resuelto" })
      .where(and(eq(supportAccessGrant.caseId, kase.id), isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, now)))
  }
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
  if (rows.length !== uniqueIds.length || rows.some((row) => !staffSees(actor, row))) throw notFound("Caso")
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
      and (kind <> 'cobro' or ${actor.role === "admin"})
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
  if (!kase.organizationId)
    throw new ServiceError("FORBIDDEN", 403, "Este caso no tiene clínica asociada")
  const orgId = kase.organizationId
  // El permiso tiene que ser de esta persona de soporte (o de nadie todavía: pasa a ser suyo).
  const grant = await claimSupportGrant(db, actor, kase.id)
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
    const [profileRow] = await tx
      .select({
        countryCode: orgProfile.countryCode,
        currency: orgProfile.currency,
        timezone: orgProfile.timezone,
        locale: orgProfile.locale,
        product: orgProfile.product,
      })
      .from(orgProfile)
      .where(eq(orgProfile.organizationId, orgId))
      .limit(1)
    const product: ClinicalProduct = isClinicalProduct(profileRow?.product) ? profileRow.product : "dental"
    const profile = profileRow
      ? { countryCode: profileRow.countryCode, currency: profileRow.currency, timezone: profileRow.timezone, locale: profileRow.locale }
      : undefined
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
      membersByRole: membersByRole.map((row) => ({
        role: row.role,
        label: (ORG_ROLES as readonly string[]).includes(row.role) ? roleLabel(row.role as OrgRole, product) : row.role,
        total: Number(row.total),
      })),
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
  await requireStaffCaseFor(db, actor, grant.caseId).catch(() => {
    throw notFound("Permiso")
  })
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
  await requireStaffCaseFor(db, actor, caseId)
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
  // Soporte tampoco cuenta los casos de cobro: no existen para su rol.
  const visible = visibleKindsFor(actor)
  const byStatus = await db
    .select({ status: supportCase.status, total: count() })
    .from(supportCase)
    .where(visible)
    .groupBy(supportCase.status)
  const byKind = await db
    .select({ kind: supportCase.kind, total: count() })
    .from(supportCase)
    .where(visible)
    .groupBy(supportCase.kind)
  const [withoutAssignee] = await db
    .select({ total: count() })
    .from(supportCase)
    .where(and(isNull(supportCase.assigneeStaffId), ne(supportCase.status, "resuelto"), visible))
  const [grants] = await db
    .select({ total: count() })
    .from(supportAccessGrant)
    .where(and(isNull(supportAccessGrant.revokedAt), gt(supportAccessGrant.expiresAt, new Date())))
  const [timing] = await db.execute<{ avg_minutes: number | null }>(sql`
    select avg(extract(epoch from (first_reply - opened)) / 60) as avg_minutes from (
      select c.id, c.created_at as opened, min(m.created_at) as first_reply
      from support_case c join support_message m on m.case_id = c.id
      where m.author_kind = 'staff' and m.is_internal = false
        and (c.kind <> 'cobro' or ${actor.role === "admin"})
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
    .select({ screen, topicId: helpAsk.topicId, verdict: helpAsk.verdict, helpful: helpAsk.helpful, noneFits: helpAsk.noneFits, total: count() })
    .from(helpAsk)
    .where(gte(helpAsk.createdAt, new Date(now.getTime() - HELP_STATS_DAYS * 86_400_000)))
    .groupBy(screen, helpAsk.topicId, helpAsk.verdict, helpAsk.helpful, helpAsk.noneFits)
  await writeAdminAudit(db, actor, { action: "support.help_stats.read" })
  const unanswered = new Map<string, number>()
  const notHelpful = new Map<string, number>()
  let asked = 0
  for (const row of rows) {
    const total = Number(row.total)
    // La duda (ADR 0146) no es «sin respuesta» ni se cuenta: si la persona toca una de las que ofrece, esa cuenta
    // como su pregunta, y no dos veces. Si tocó «Ninguna es lo que busco», sí, también tras una redactada: nadie le respondió (ADR 0178).
    // Lo de las cifras sí se cuenta, pero va a Argos: tampoco es «sin respuesta».
    if (row.noneFits) {
      asked += total
      const name = helpTopicForScreen(row.screen)?.title ?? row.screen
      unanswered.set(name, (unanswered.get(name) ?? 0) + total)
      continue
    }
    if (row.verdict === "duda" || row.verdict === "datos") {
      asked += row.verdict === "datos" ? total : 0
      continue
    }
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
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
  actor: AdminActor,
  caseId: string,
  messageId?: string,
): Promise<void> {
  const kase = await requireStaffCaseFor(db, actor, caseId)
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
  await assertStaffAttachmentTarget(db, actor, caseId, input.messageId)
  const kase = await requireStaffCaseFor(db, actor, caseId)
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

export interface AdminSupportAttention {
  /** Los casos que nos esperan: el número de «Soporte» en el menú y las filas de Inicio. */
  openCount: number
  waitingClinicCount: number
  /** Desde cuándo espera el que más espera. */
  oldestWaitingSince: string | null
}

/**
 * Atención pendiente de soporte para el Inicio admin: solo agregados, sin
 * textos de clientes. Cuenta con la misma regla de la cola («nos espera»).
 * Sin `actor`, o con el rol Soporte, no cuenta los casos de cobro. Sin
 * auditoría: es un conteo, no una lectura de datos de clínicas.
 */
export async function getAdminSupportAttention(ownerTx: Db, actor?: AdminActor): Promise<AdminSupportAttention> {
  const [row] = await ownerTx
    .select({
      openCount: sql<number>`count(*) filter (where ${waitingOnUsSql})::int`,
      waitingClinicCount: sql<number>`count(*) filter (where ${supportCase.status} = 'esperando_clinica')::int`,
      oldestWaitingSince: sql`min(${waitingSinceSql})`,
    })
    .from(supportCase)
    .where(visibleKindsFor(actor))
  return {
    openCount: Number(row?.openCount ?? 0),
    waitingClinicCount: Number(row?.waitingClinicCount ?? 0),
    oldestWaitingSince: dateOrNull(row?.oldestWaitingSince)?.toISOString() ?? null,
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
  // El adjunto de la cuenta va siempre suelto: es su respuesta, como en la clínica.
  await clinicActed(db, kase, attachment.id, true)
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
