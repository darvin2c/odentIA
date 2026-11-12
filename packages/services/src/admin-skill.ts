/**
 * La llave de la skill de la carga y lo que deja (ADR 0183). La skill prepara
 * fuera del servidor el plan de configuración (`clinica.json`), el plan de
 * pacientes (`plan.json`) y el informe (`informe-N.json`), y con su llave solo
 * los **deposita** en la ficha del cliente › Alta. La llave no aprueba, no
 * ensaya, no carga, no envía y no lee clientes ni pacientes: eso lo hace una
 * persona de Administración con su sesión y su segundo factor.
 *
 * La llave (`sk_` + 32 bytes en base64url) se muestra una sola vez; se guarda
 * su sha256. Vence a los 90 días y se revoca. Vale solo si quien la creó sigue
 * en el personal, activo y sin bloqueo.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { isAdminRole } from "@odentia/auth/admin-permissions"
import type { Db } from "@odentia/db"
import {
  SAAS_IMPORT_DRAFT_KINDS,
  type SaasImportDraftKind,
  type SaasImportDraftStatus,
  saasClient,
  saasClientFile,
  saasImportDraft,
  saasSkillKey,
} from "@odentia/db/schema/admin-arm"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { userGlobalBlock } from "@odentia/db/schema/admin-organizations"
import { organization, user } from "@odentia/db/schema/auth"
import { orgProfile } from "@odentia/db/schema/org"
import { and, asc, count, desc, eq, gt, isNull, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { z } from "zod"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { clinicImportPlanSchema } from "./clinic-import-plan.js"
import { progressReportSchema } from "./clinic-progress-report.js"
import { clinicSetupPlanSchema } from "./clinic-setup-plan.js"
import { fieldPath, invalidField, isUniqueViolation, notFound, ServiceError } from "./errors.js"
import type { Storage } from "./storage.js"

/** Días que vale una llave nueva. */
export const SKILL_KEY_DAYS = 90
/** Llaves vigentes por persona: una por equipo donde corre la skill, con margen. */
export const SKILL_KEY_MAX_ACTIVE = 5
const TOKEN_PATTERN = /^sk_[A-Za-z0-9_-]{43}$/
const DAY_MS = 86_400_000

/**
 * Quien actúa con una llave de la skill: la persona del personal dueña de la
 * llave, con su rol vigente, y la marca de que viene por la llave. Solo sirve
 * para depositar: las demás operaciones de la carga lo rechazan.
 */
export interface SkillActor extends AdminActor {
  via: "skill"
  keyId: string
  scope: "carga"
}

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function isSkillActor(actor: AdminActor): actor is SkillActor {
  return (actor as Partial<SkillActor>).via === "skill"
}

/** Personal con sesión (no la llave) y rol Administración. */
function requireSessionAdmin(actor: AdminActor | null): AdminActor {
  if (!actor) throw forbidden("Se requiere personal de administración")
  if (isSkillActor(actor)) throw forbidden("La llave de la skill solo deja borradores")
  if (actor.role !== "admin") throw forbidden("Solo Administración puede hacer esto")
  return actor
}

/** sha256 en hexadecimal de la llave: lo único que se guarda. */
export function hashSkillKey(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

function invalidKey(): ServiceError {
  return new ServiceError(
    "SKILL_KEY_INVALID",
    401,
    "La llave no vale: no existe, venció o fue revocada",
  )
}

export type SkillKeyState = "vigente" | "vencida" | "revocada"

export interface SkillKeyRow {
  id: string
  label: string
  user: { userId: string; name: string }
  scope: "carga"
  state: SkillKeyState
  createdAt: Date
  expiresAt: Date
  revokedAt: Date | null
  revokedBy: { userId: string; name: string } | null
  lastUsedAt: Date | null
}

const labelSchema = z
  .string("Ponle un nombre a la llave")
  .trim()
  .min(1, "Ponle un nombre a la llave")
  .max(80, "El nombre de la llave, 80 caracteres como mucho")

/**
 * Crea una llave para quien la pide (solo Administración y solo para sí). La
 * llave vuelve una sola vez: después solo se ve su nombre y sus fechas.
 */
export async function createSkillKey(
  tx: Db,
  actor: AdminActor | null,
  input: { label: string },
  now = new Date(),
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const staff = requireSessionAdmin(actor)
  const label = labelSchema.safeParse(input.label)
  if (!label.success)
    throw invalidField("label", label.error.issues[0]?.message ?? "Nombre no válido")
  // Una a la vez por persona: dos pestañas no pasan el tope juntas.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('skill-key:' || ${staff.userId}))`)
  const [active] = await tx
    .select({ n: count() })
    .from(saasSkillKey)
    .where(
      and(
        eq(saasSkillKey.userId, staff.userId),
        isNull(saasSkillKey.revokedAt),
        gt(saasSkillKey.expiresAt, now),
      ),
    )
  if ((active?.n ?? 0) >= SKILL_KEY_MAX_ACTIVE)
    throw new ServiceError(
      "SKILL_KEY_LIMIT",
      409,
      `Ya tienes ${SKILL_KEY_MAX_ACTIVE} llaves vigentes: revoca una que no uses antes de crear otra`,
    )
  const token = `sk_${randomBytes(32).toString("base64url")}`
  const expiresAt = new Date(now.getTime() + SKILL_KEY_DAYS * DAY_MS)
  const [row] = await tx
    .insert(saasSkillKey)
    .values({
      userId: staff.userId,
      label: label.data,
      tokenHash: hashSkillKey(token),
      scope: "carga",
      expiresAt,
    })
    .returning({ id: saasSkillKey.id })
  if (!row) throw new ServiceError("INTERNAL", 500, "No se creó la llave")
  await writeAdminAudit(tx, staff, {
    action: "skill.key_created",
    entityId: row.id,
    metadata: { scope: "carga", expiresAt: expiresAt.toISOString() },
  })
  return { id: row.id, token, expiresAt }
}

function keyState(row: { revokedAt: Date | null; expiresAt: Date }, now: Date): SkillKeyState {
  if (row.revokedAt) return "revocada"
  return row.expiresAt.getTime() > now.getTime() ? "vigente" : "vencida"
}

/** Las llaves de todo el personal (solo Administración), lo vigente arriba. Nunca la huella. */
export async function listSkillKeys(
  tx: Db,
  actor: AdminActor | null,
  now = new Date(),
): Promise<SkillKeyRow[]> {
  requireSessionAdmin(actor)
  const owner = alias(user, "skill_key_owner")
  const revoker = alias(user, "skill_key_revoker")
  const rows = await tx
    .select({
      key: {
        id: saasSkillKey.id,
        label: saasSkillKey.label,
        userId: saasSkillKey.userId,
        createdAt: saasSkillKey.createdAt,
        expiresAt: saasSkillKey.expiresAt,
        revokedAt: saasSkillKey.revokedAt,
        revokedBy: saasSkillKey.revokedBy,
        lastUsedAt: saasSkillKey.lastUsedAt,
      },
      ownerName: owner.name,
      revokerName: revoker.name,
    })
    .from(saasSkillKey)
    .innerJoin(owner, eq(owner.id, saasSkillKey.userId))
    .leftJoin(revoker, eq(revoker.id, saasSkillKey.revokedBy))
    .orderBy(desc(saasSkillKey.createdAt), desc(saasSkillKey.id))
  const order: Record<SkillKeyState, number> = { vigente: 0, vencida: 1, revocada: 2 }
  return rows
    .map(({ key, ownerName, revokerName }) => ({
      id: key.id,
      label: key.label,
      user: { userId: key.userId, name: ownerName },
      scope: "carga" as const,
      state: keyState(key, now),
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      revokedBy: key.revokedBy ? { userId: key.revokedBy, name: revokerName ?? "" } : null,
      lastUsedAt: key.lastUsedAt,
    }))
    .sort((a, b) => order[a.state] - order[b.state])
}

/** Revoca una llave, propia o de otra persona (solo Administración). Revocar otra vez no cambia nada. */
export async function revokeSkillKey(
  tx: Db,
  actor: AdminActor | null,
  keyId: string,
  now = new Date(),
): Promise<{ id: string; revokedAt: Date }> {
  const staff = requireSessionAdmin(actor)
  if (!/^[0-9a-f-]{36}$/i.test(keyId)) throw notFound("Llave")
  const [row] = await tx
    .select({ id: saasSkillKey.id, userId: saasSkillKey.userId, revokedAt: saasSkillKey.revokedAt })
    .from(saasSkillKey)
    .where(eq(saasSkillKey.id, keyId))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Llave")
  if (row.revokedAt) return { id: row.id, revokedAt: row.revokedAt }
  await tx
    .update(saasSkillKey)
    .set({ revokedAt: now, revokedBy: staff.userId })
    .where(eq(saasSkillKey.id, row.id))
  await writeAdminAudit(tx, staff, {
    action: "skill.key_revoked",
    entityId: row.id,
    metadata: { own: row.userId === staff.userId },
  })
  return { id: row.id, revokedAt: now }
}

/**
 * Quién actúa con esta llave. Exige la llave vigente (ni vencida ni revocada)
 * y a su dueña en el personal, activa y sin bloqueo; el rol es el de hoy, no
 * el de cuando creó la llave. Anota el último uso. Cualquier falla dice lo
 * mismo (401), sin contar cuál fue.
 */
export async function resolveSkillKey(
  tx: Db,
  token: string,
  now = new Date(),
): Promise<SkillActor> {
  const presented = token.trim()
  if (!TOKEN_PATTERN.test(presented)) throw invalidKey()
  const hash = hashSkillKey(presented)
  const [row] = await tx
    .select({
      id: saasSkillKey.id,
      userId: saasSkillKey.userId,
      tokenHash: saasSkillKey.tokenHash,
      scope: saasSkillKey.scope,
      expiresAt: saasSkillKey.expiresAt,
      revokedAt: saasSkillKey.revokedAt,
      role: adminStaff.role,
      active: adminStaff.active,
    })
    .from(saasSkillKey)
    .leftJoin(adminStaff, eq(adminStaff.userId, saasSkillKey.userId))
    .where(eq(saasSkillKey.tokenHash, hash))
    .limit(1)
  if (!row) throw invalidKey()
  const expected = Buffer.from(row.tokenHash, "utf8")
  const actual = Buffer.from(hash, "utf8")
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw invalidKey()
  if (row.revokedAt || row.expiresAt.getTime() <= now.getTime()) throw invalidKey()
  if (!row.active || !row.role || !isAdminRole(row.role) || row.scope !== "carga")
    throw invalidKey()
  const [blocked] = await tx
    .select({ userId: userGlobalBlock.userId })
    .from(userGlobalBlock)
    .where(
      and(
        eq(userGlobalBlock.userId, row.userId),
        eq(userGlobalBlock.active, true),
        or(isNull(userGlobalBlock.expiresAt), gt(userGlobalBlock.expiresAt, now)),
      ),
    )
    .limit(1)
  if (blocked) throw invalidKey()
  await tx.update(saasSkillKey).set({ lastUsedAt: now }).where(eq(saasSkillKey.id, row.id))
  return { userId: row.userId, role: row.role, via: "skill", keyId: row.id, scope: "carga" }
}

/** Lo que la skill deja: el tipo, su número y el JSON del archivo. */
export interface ImportDraftCheckInput {
  organizationSlug: string
  kind: SaasImportDraftKind
  number: number
  payload: unknown
}

export interface ImportDraftTarget {
  organizationId: string
  clientId: string
  kind: SaasImportDraftKind
  number: number
  /** Solo cifras, para el aviso: nunca datos de pacientes. */
  summary: Record<string, number>
}

const draftTargetSchema = z.strictObject({
  organizationSlug: z
    .string("Falta la clínica")
    .trim()
    .min(2, "Falta la clínica")
    .max(63, "La dirección de la clínica, 63 caracteres como mucho"),
  kind: z.enum(SAAS_IMPORT_DRAFT_KINDS, "Tipo de borrador no válido"),
  number: z
    .number("Falta el número")
    .int("El número es entero")
    .min(1, "El número empieza en 1")
    .max(99, "El número va hasta 99"),
  payload: z.unknown(),
})

function badPayload(issues: readonly z.core.$ZodIssue[], generic: boolean): ServiceError {
  // Solo dónde está el problema: el mensaje de un plan de pacientes nunca repite sus datos.
  const fields: Record<string, string> = {}
  for (const issue of issues.slice(0, 20)) {
    const path = fieldPath(issue.path)
    const key = path ? (path.startsWith("[") ? `payload${path}` : `payload.${path}`) : "payload"
    fields[key] ??= generic ? "Este dato no es válido" : issue.message
  }
  return new ServiceError(
    "VALIDATION",
    400,
    "El archivo no es del tipo que dice o tiene datos no válidos",
    fields,
  )
}

function summaryOf(kind: SaasImportDraftKind, payload: unknown): Record<string, number> {
  if (kind === "plan_configuracion") {
    const plan = clinicSetupPlanSchema.parse(payload)
    return {
      sedes: plan.branches.length,
      servicios: plan.services.length,
      equipo: plan.team.length,
      productos: plan.products.length,
      proveedores: plan.suppliers.length,
      mediosDePago: plan.paymentMethods.length,
      consentimientos: plan.consents.length,
      formatos: plan.forms.length,
      respuestas: plan.knowledge.length,
      gastosFijos: plan.recurringExpenses.length,
    }
  }
  if (kind === "plan_pacientes") {
    const plan = clinicImportPlanSchema.parse(payload)
    return {
      personas: plan.people.length,
      pacientes: plan.people.filter((person) => person.patient).length,
      omitidas: plan.omitted.length,
      archivos: plan.sources.length,
    }
  }
  const report = progressReportSchema.parse(payload)
  return {
    numero: report.number,
    hecho: report.done.length,
    usado: report.used.length,
    falta: report.notYet.length,
  }
}

/**
 * Comprueba lo que la skill quiere dejar, sin escribir nada: que la clínica
 * exista y tenga su cliente, que el JSON sea del tipo que dice y de esa
 * clínica (el plan con su misma dirección y producto, el de pacientes con su
 * país, el informe con su producto y su número) y que ese número esté libre.
 * Los errores dicen dónde, nunca los datos. La ruta lo llama antes de subir.
 */
/**
 * Otro con el mismo número lo reemplaza si se devolvió, o si su JSON ya se
 * borró a los 30 días sin cargarse (sin él no hay qué cargar). Uno `usada`
 * nunca: ya se cargó.
 */
function replaceable(draft: { status: string; payloadDeletedAt: Date | null }): boolean {
  return (
    draft.status === "devuelta" ||
    (draft.payloadDeletedAt !== null && (draft.status === "lista" || draft.status === "aprobada"))
  )
}

export async function checkImportDraft(
  tx: Db,
  actor: SkillActor,
  raw: ImportDraftCheckInput,
): Promise<ImportDraftTarget> {
  if (!isSkillActor(actor) || actor.scope !== "carga")
    throw forbidden("Solo la llave de la skill deja borradores")
  if (actor.role !== "admin") throw forbidden("Solo Administración deja borradores de la carga")
  const parsed = draftTargetSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    throw invalidField(
      fieldPath(first?.path ?? []) || "payload",
      first?.message ?? "Borrador no válido",
    )
  }
  const input = parsed.data
  const [org] = await tx
    .select({
      id: organization.id,
      slug: organization.slug,
      product: orgProfile.product,
      countryCode: orgProfile.countryCode,
      clientId: saasClient.id,
    })
    .from(organization)
    .leftJoin(orgProfile, eq(orgProfile.organizationId, organization.id))
    .leftJoin(saasClient, eq(saasClient.organizationId, organization.id))
    .where(eq(organization.slug, input.organizationSlug.toLowerCase()))
    .limit(1)
  if (!org)
    throw invalidField(
      "organizationSlug",
      `No hay una clínica con la dirección «${input.organizationSlug}»`,
    )
  if (!org.clientId)
    throw invalidField(
      "organizationSlug",
      "Esa clínica aún no tiene su cliente en la administración",
    )
  const schema =
    input.kind === "plan_configuracion"
      ? clinicSetupPlanSchema
      : input.kind === "plan_pacientes"
        ? clinicImportPlanSchema
        : progressReportSchema
  const checked = schema.safeParse(input.payload)
  if (!checked.success) throw badPayload(checked.error.issues, input.kind === "plan_pacientes")
  const data = checked.data as Record<string, unknown>
  const product = org.product ?? "dental"
  if (input.kind === "plan_configuracion") {
    if (data.slug !== org.slug)
      throw invalidField("payload.slug", "El plan es de otra clínica: su dirección no es esta")
    if (data.product !== product)
      throw invalidField("payload.product", "El plan es de otro producto que la clínica")
  } else if (input.kind === "plan_pacientes") {
    if (org.countryCode && data.countryCode !== org.countryCode)
      throw invalidField(
        "payload.countryCode",
        "El plan de pacientes es de otro país que la clínica",
      )
  } else {
    if (data.product !== product)
      throw invalidField("payload.product", "El informe es de otro producto que la clínica")
    if (data.number !== input.number) throw invalidField("number", "El número no es el del informe")
  }
  const [taken] = await tx
    .select({ status: saasImportDraft.status, payloadDeletedAt: saasImportDraft.payloadDeletedAt })
    .from(saasImportDraft)
    .where(
      and(
        eq(saasImportDraft.organizationId, org.id),
        eq(saasImportDraft.kind, input.kind),
        eq(saasImportDraft.number, input.number),
      ),
    )
    .limit(1)
  if (taken && !replaceable(taken))
    throw new ServiceError(
      "IMPORT_DRAFT_EXISTS",
      409,
      `Ya hay un borrador N.º ${input.number} de ese tipo para esta clínica: usa el número siguiente`,
      { number: "Ese número ya se usó" },
    )
  return {
    organizationId: org.id,
    clientId: org.clientId,
    kind: input.kind,
    number: input.number,
    summary: summaryOf(input.kind, checked.data),
  }
}

export interface DepositImportDraftInput extends ImportDraftCheckInput {
  /** Dónde quedó el JSON en el bucket privado (`clients/<clientId>/…json`). */
  payloadKey: string
  /** El PDF que la acompaña, ya registrado como documento del cliente. */
  pdfFileId?: string | null
  /** Cifras extra para el aviso (solo números); las del archivo mandan. */
  summary?: Record<string, number> | null
}

/**
 * Deja el borrador `lista` para que Administración lo apruebe o lo devuelva.
 * Uno devuelto con el mismo número (o uno cuyo JSON ya se borró a los 30
 * días) se reemplaza y vuelve a `lista`. Su JSON anterior queda en
 * `stale_payload_keys` y vuelve en `replacedPayloadKey`: la ruta lo borra
 * después del commit con `purgeImportDraftPayloads` y, si falla, lo borra la
 * pasada del worker.
 */
export async function depositImportDraft(
  tx: Db,
  actor: SkillActor,
  input: DepositImportDraftInput,
  now = new Date(),
): Promise<{
  id: string
  clientId: string
  organizationId: string
  replacedPayloadKey: string | null
}> {
  const target = await checkImportDraft(tx, actor, {
    organizationSlug: input.organizationSlug,
    kind: input.kind,
    number: input.number,
    payload: input.payload,
  })
  if (
    !input.payloadKey.startsWith(`clients/${target.clientId}/`) ||
    input.payloadKey.includes("..")
  )
    throw invalidField("payloadKey", "La clave del borrador no es de este cliente")
  if (input.pdfFileId) {
    const [file] = await tx
      .select({ clientId: saasClientFile.clientId, deletedAt: saasClientFile.deletedAt })
      .from(saasClientFile)
      .where(eq(saasClientFile.id, input.pdfFileId))
      .limit(1)
    if (!file || file.deletedAt || file.clientId !== target.clientId)
      throw invalidField("pdfFileId", "El PDF no es un documento de este cliente")
  }
  const extra = Object.fromEntries(
    Object.entries(input.summary ?? {})
      .filter(([key, value]) => /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) && Number.isFinite(value))
      .slice(0, 20),
  )
  const summary = { ...extra, ...target.summary }
  const values = {
    payloadKey: input.payloadKey,
    pdfFileId: input.pdfFileId ?? null,
    summary,
    status: "lista" as const,
    uploadedBy: actor.userId,
    viaSkill: true,
    approvedBy: null,
    approvedAt: null,
    returnedNote: null,
    payloadUploadedAt: now,
    payloadDeletedAt: null,
    updatedAt: now,
  }
  const [previous] = await tx
    .select({
      id: saasImportDraft.id,
      status: saasImportDraft.status,
      payloadKey: saasImportDraft.payloadKey,
      payloadDeletedAt: saasImportDraft.payloadDeletedAt,
    })
    .from(saasImportDraft)
    .where(
      and(
        eq(saasImportDraft.organizationId, target.organizationId),
        eq(saasImportDraft.kind, target.kind),
        eq(saasImportDraft.number, target.number),
      ),
    )
    .for("update")
    .limit(1)
  let id: string
  let replacedPayloadKey: string | null = null
  if (previous) {
    if (!replaceable(previous))
      throw new ServiceError(
        "IMPORT_DRAFT_EXISTS",
        409,
        `Ya hay un borrador N.º ${target.number} de ese tipo`,
        {
          number: "Ese número ya se usó",
        },
      )
    replacedPayloadKey =
      previous.payloadKey === input.payloadKey || previous.payloadDeletedAt
        ? null
        : previous.payloadKey
    await tx
      .update(saasImportDraft)
      .set({
        ...values,
        // El JSON anterior espera su borrado hasta que el almacenamiento lo confirme.
        ...(replacedPayloadKey
          ? {
              stalePayloadKeys: sql`array_append(${saasImportDraft.stalePayloadKeys}, ${replacedPayloadKey}::text)`,
            }
          : {}),
      })
      .where(eq(saasImportDraft.id, previous.id))
    id = previous.id
  } else {
    try {
      const [row] = await tx
        .insert(saasImportDraft)
        .values({
          clientId: target.clientId,
          organizationId: target.organizationId,
          kind: target.kind,
          number: target.number,
          ...values,
        })
        .returning({ id: saasImportDraft.id })
      if (!row) throw new ServiceError("INTERNAL", 500, "No se guardó el borrador")
      id = row.id
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ServiceError(
          "IMPORT_DRAFT_EXISTS",
          409,
          `Ya hay un borrador N.º ${target.number} de ese tipo`,
          {
            number: "Ese número ya se usó",
          },
        )
      throw error
    }
  }
  await writeAdminAudit(tx, actor, {
    action: "skill.draft_deposited",
    organizationId: target.organizationId,
    entityId: id,
    metadata: {
      via: "skill",
      keyId: actor.keyId,
      clientId: target.clientId,
      kind: target.kind,
      number: target.number,
      replaced: replacedPayloadKey !== null || previous !== undefined,
    },
  })
  return {
    id,
    clientId: target.clientId,
    organizationId: target.organizationId,
    replacedPayloadKey,
  }
}

export interface ImportDraftRow {
  id: string
  clientId: string
  organizationId: string
  kind: SaasImportDraftKind
  number: number
  status: SaasImportDraftStatus
  summary: Record<string, number | string | null> | null
  pdfFileId: string | null
  viaSkill: boolean
  uploadedBy: { userId: string; name: string }
  approvedBy: { userId: string; name: string } | null
  approvedAt: Date | null
  returnedNote: string | null
  /** Cuándo se subió el JSON vigente (de ahí cuentan los 30 días). */
  payloadUploadedAt: Date
  /** Cuándo se borró el JSON (al cargarse o a los 30 días): ya no se puede abrir. */
  payloadDeletedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const uploader = alias(user, "draft_uploader")
const approver = alias(user, "draft_approver")

function draftSelect() {
  return {
    draft: saasImportDraft,
    uploaderName: uploader.name,
    approverName: approver.name,
  }
}

function toDraftRow(row: {
  draft: typeof saasImportDraft.$inferSelect
  uploaderName: string | null
  approverName: string | null
}): ImportDraftRow {
  const draft = row.draft
  return {
    id: draft.id,
    clientId: draft.clientId,
    organizationId: draft.organizationId,
    kind: draft.kind as SaasImportDraftKind,
    number: draft.number,
    status: draft.status as SaasImportDraftStatus,
    summary: draft.summary ?? null,
    pdfFileId: draft.pdfFileId,
    viaSkill: draft.viaSkill,
    uploadedBy: { userId: draft.uploadedBy, name: row.uploaderName ?? "" },
    approvedBy: draft.approvedBy
      ? { userId: draft.approvedBy, name: row.approverName ?? "" }
      : null,
    approvedAt: draft.approvedAt,
    returnedNote: draft.returnedNote,
    payloadUploadedAt: draft.payloadUploadedAt,
    payloadDeletedAt: draft.payloadDeletedAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  }
}

/** Lo que dejó la skill para un cliente (solo Administración), lo último arriba. */
export async function listImportDrafts(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
): Promise<ImportDraftRow[]> {
  requireSessionAdmin(actor)
  const rows = await tx
    .select(draftSelect())
    .from(saasImportDraft)
    .leftJoin(uploader, eq(uploader.id, saasImportDraft.uploadedBy))
    .leftJoin(approver, eq(approver.id, saasImportDraft.approvedBy))
    .where(eq(saasImportDraft.clientId, clientId))
    .orderBy(desc(saasImportDraft.createdAt), desc(saasImportDraft.id))
  return rows.map(toDraftRow)
}

async function lockedDraft(tx: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Borrador")
  const [row] = await tx
    .select()
    .from(saasImportDraft)
    .where(eq(saasImportDraft.id, id))
    .for("update")
    .limit(1)
  if (!row) throw notFound("Borrador")
  return row
}

async function draftRow(tx: Db, id: string): Promise<ImportDraftRow> {
  const [row] = await tx
    .select(draftSelect())
    .from(saasImportDraft)
    .leftJoin(uploader, eq(uploader.id, saasImportDraft.uploadedBy))
    .leftJoin(approver, eq(approver.id, saasImportDraft.approvedBy))
    .where(eq(saasImportDraft.id, id))
    .limit(1)
  if (!row) throw notFound("Borrador")
  return toDraftRow(row)
}

/** El sí de Administración a lo que dejó la skill: `lista` → `aprobada`. */
export async function approveImportDraft(
  tx: Db,
  actor: AdminActor | null,
  id: string,
  now = new Date(),
): Promise<ImportDraftRow> {
  const staff = requireSessionAdmin(actor)
  const draft = await lockedDraft(tx, id)
  if (draft.status !== "lista")
    throw new ServiceError("IMPORT_DRAFT_STATE", 409, "Ese borrador ya no espera tu sí")
  await tx
    .update(saasImportDraft)
    .set({ status: "aprobada", approvedBy: staff.userId, approvedAt: now, updatedAt: now })
    .where(eq(saasImportDraft.id, draft.id))
  await writeAdminAudit(tx, staff, {
    action: "skill.draft_approved",
    organizationId: draft.organizationId,
    entityId: draft.id,
    metadata: { clientId: draft.clientId, kind: draft.kind, number: draft.number },
  })
  return draftRow(tx, draft.id)
}

const noteSchema = z
  .string("Di qué hay que corregir")
  .trim()
  .min(1, "Di qué hay que corregir")
  .max(1000, "La nota, 1000 caracteres como mucho")

/**
 * Lo devuelve a la skill con lo que hay que corregir (`lista` o `aprobada` →
 * `devuelta`). La skill puede dejar otro con el mismo número.
 */
export async function returnImportDraft(
  tx: Db,
  actor: AdminActor | null,
  id: string,
  note: string,
  now = new Date(),
): Promise<ImportDraftRow> {
  const staff = requireSessionAdmin(actor)
  const parsed = noteSchema.safeParse(note)
  if (!parsed.success)
    throw invalidField("note", parsed.error.issues[0]?.message ?? "Nota no válida")
  const draft = await lockedDraft(tx, id)
  if (draft.status !== "lista" && draft.status !== "aprobada")
    throw new ServiceError(
      "IMPORT_DRAFT_STATE",
      409,
      draft.status === "usada"
        ? "Ese borrador ya se cargó: no se devuelve"
        : "Ese borrador ya se devolvió",
    )
  await tx
    .update(saasImportDraft)
    .set({ status: "devuelta", returnedNote: parsed.data, updatedAt: now })
    .where(eq(saasImportDraft.id, draft.id))
  await writeAdminAudit(tx, staff, {
    action: "skill.draft_returned",
    organizationId: draft.organizationId,
    entityId: draft.id,
    metadata: { clientId: draft.clientId, kind: draft.kind, number: draft.number },
  })
  return draftRow(tx, draft.id)
}

/**
 * Ya se cargó (o se envió, el informe) desde este borrador: `lista` o
 * `aprobada` → `usada`. Su JSON ya no hace falta: quien llama lo borra
 * después del commit con `purgeImportDraftPayloads` (y si no, la pasada).
 */
export async function markImportDraftUsed(
  tx: Db,
  actor: AdminActor | null,
  id: string,
  now = new Date(),
): Promise<ImportDraftRow> {
  const staff = requireSessionAdmin(actor)
  const draft = await lockedDraft(tx, id)
  if (draft.status === "usada") return draftRow(tx, draft.id)
  if (draft.status === "devuelta")
    throw new ServiceError("IMPORT_DRAFT_STATE", 409, "Ese borrador se devolvió: no se carga")
  await tx
    .update(saasImportDraft)
    .set({
      status: "usada",
      // Cargarlo es también el sí de quien lo carga, si nadie lo había aprobado.
      approvedBy: draft.approvedBy ?? staff.userId,
      approvedAt: draft.approvedAt ?? now,
      updatedAt: now,
    })
    .where(eq(saasImportDraft.id, draft.id))
  await writeAdminAudit(tx, staff, {
    action: "skill.draft_used",
    organizationId: draft.organizationId,
    entityId: draft.id,
    metadata: { clientId: draft.clientId, kind: draft.kind, number: draft.number },
  })
  return draftRow(tx, draft.id)
}

/**
 * El JSON de un borrador, para que la tarjeta de la carga (#598) lo ensaye y
 * lo cargue sin elegir un archivo (solo Administración, con sesión). Se lee
 * del bucket privado y se vuelve a validar; leerlo deja auditoría (el plan de
 * pacientes trae sus datos). Uno devuelto no se carga.
 */
export async function importDraftPayload(
  tx: Db,
  actor: AdminActor | null,
  storage: Pick<Storage, "getAttachment">,
  id: string,
): Promise<{
  id: string
  kind: SaasImportDraftKind
  number: number
  organizationId: string
  payload: unknown
}> {
  const staff = requireSessionAdmin(actor)
  if (!storage.getAttachment)
    throw new ServiceError(
      "STORAGE_UNAVAILABLE",
      503,
      "El almacenamiento no está disponible para leer el borrador",
    )
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Borrador")
  const [draft] = await tx.select().from(saasImportDraft).where(eq(saasImportDraft.id, id)).limit(1)
  if (!draft) throw notFound("Borrador")
  if (draft.status === "devuelta")
    throw new ServiceError(
      "IMPORT_DRAFT_STATE",
      409,
      "Ese borrador se devolvió: espera el que lo corrige",
    )
  if (draft.payloadDeletedAt)
    throw new ServiceError(
      "IMPORT_DRAFT_PAYLOAD_GONE",
      409,
      draft.status === "usada"
        ? "Ese borrador ya se cargó y su archivo se borró"
        : "El archivo de ese borrador se borró a los 30 días: pide a la skill que deje otro con el mismo número",
    )
  const bytes = await storage.getAttachment(draft.payloadKey)
  let payload: unknown
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new ServiceError(
      "IMPORT_DRAFT_UNREADABLE",
      502,
      "El archivo del borrador no se pudo leer",
    )
  }
  const kind = draft.kind as SaasImportDraftKind
  const schema =
    kind === "plan_configuracion"
      ? clinicSetupPlanSchema
      : kind === "plan_pacientes"
        ? clinicImportPlanSchema
        : progressReportSchema
  if (!schema.safeParse(payload).success)
    throw new ServiceError(
      "IMPORT_DRAFT_UNREADABLE",
      502,
      "El archivo del borrador ya no es válido",
    )
  await writeAdminAudit(tx, staff, {
    action: "skill.draft_opened",
    organizationId: draft.organizationId,
    entityId: draft.id,
    metadata: { clientId: draft.clientId, kind, number: draft.number },
  })
  return { id: draft.id, kind, number: draft.number, organizationId: draft.organizationId, payload }
}

/* ---------- Borrado del JSON ---------- */

/** Días que se guarda el JSON de un borrador desde que se subió (contrato de encargo). */
export const IMPORT_DRAFT_PAYLOAD_DAYS = 30

/** Por qué se borra un JSON: se cargó, pasaron los 30 días o lo reemplazó otro. */
export type ImportDraftPayloadDeletionReason = "usada" | "30_dias" | "reemplazado"

/**
 * Borra del bucket los JSON de los borradores que ya no deben estar: el de
 * uno `usada`, el de uno subido hace 30 días o más (aunque nadie lo use) y los
 * reemplazados que esperan. Cada objeto se borra fuera de toda transacción y
 * después se anota (`payload_deleted_at`, o se quita de `stale_payload_keys`)
 * con su auditoría `skill.draft_payload_deleted`, sin la clave ni los datos.
 * Lo que el almacenamiento no pudo borrar queda para la próxima pasada. Con
 * `draftId`, solo ese (la ruta, justo después de usarlo o reemplazarlo).
 */
export async function purgeImportDraftPayloads(
  db: Db,
  storage: Pick<Storage, "deleteAttachment">,
  now: Date,
  options: { draftId?: string; limit?: number } = {},
): Promise<{ deleted: number; failed: number }> {
  const cutoff = new Date(now.getTime() - IMPORT_DRAFT_PAYLOAD_DAYS * DAY_MS)
  const currentDue = sql<boolean>`(${saasImportDraft.payloadDeletedAt} is null and (${saasImportDraft.status} = 'usada' or ${saasImportDraft.payloadUploadedAt} <= ${cutoff.toISOString()}::timestamptz))`
  const due = await db
    .select({
      id: saasImportDraft.id,
      clientId: saasImportDraft.clientId,
      organizationId: saasImportDraft.organizationId,
      kind: saasImportDraft.kind,
      number: saasImportDraft.number,
      status: saasImportDraft.status,
      payloadKey: saasImportDraft.payloadKey,
      currentDue,
      stale: saasImportDraft.stalePayloadKeys,
    })
    .from(saasImportDraft)
    .where(
      and(
        options.draftId ? eq(saasImportDraft.id, options.draftId) : undefined,
        or(currentDue, sql`cardinality(${saasImportDraft.stalePayloadKeys}) > 0`),
      ),
    )
    .orderBy(asc(saasImportDraft.payloadUploadedAt), asc(saasImportDraft.id))
    .limit(options.limit ?? 100)
  let deleted = 0
  let failed = 0
  const gone = async (key: string) => {
    try {
      await storage.deleteAttachment(key)
      return true
    } catch {
      failed++
      return false
    }
  }
  for (const draft of due) {
    const current: ImportDraftPayloadDeletionReason | null = draft.currentDue
      ? draft.status === "usada"
        ? "usada"
        : "30_dias"
      : null
    const staleDone: string[] = []
    for (const key of draft.stale ?? []) if (await gone(key)) staleDone.push(key)
    const currentDone = current !== null && (await gone(draft.payloadKey))
    if (staleDone.length === 0 && !currentDone) continue
    await db.transaction(async (tx) => {
      if (staleDone.length > 0)
        await tx
          .update(saasImportDraft)
          .set({
            stalePayloadKeys: sql`array(select k from unnest(${saasImportDraft.stalePayloadKeys}) as k where k <> all(array[${sql.join(
              staleDone.map((key) => sql`${key}`),
              sql`, `,
            )}]::text[]))`,
          })
          .where(eq(saasImportDraft.id, draft.id))
      // Solo si sigue siendo el mismo JSON: uno que llegó mientras tanto no se marca como borrado.
      const marked = currentDone
        ? await tx
            .update(saasImportDraft)
            .set({ payloadDeletedAt: now })
            .where(
              and(
                eq(saasImportDraft.id, draft.id),
                eq(saasImportDraft.payloadKey, draft.payloadKey),
                isNull(saasImportDraft.payloadDeletedAt),
              ),
            )
            .returning({ id: saasImportDraft.id })
        : []
      const reasons: Array<{ reason: ImportDraftPayloadDeletionReason; count: number }> = [
        ...(marked.length > 0 && current ? [{ reason: current, count: 1 }] : []),
        ...(staleDone.length > 0
          ? [{ reason: "reemplazado" as const, count: staleDone.length }]
          : []),
      ]
      for (const { reason, count: files } of reasons)
        await writeAdminAudit(tx, null, {
          action: "skill.draft_payload_deleted",
          organizationId: draft.organizationId,
          entityId: draft.id,
          metadata: {
            clientId: draft.clientId,
            kind: draft.kind,
            number: draft.number,
            reason,
            files,
          },
        })
    })
    deleted += staleDone.length + (currentDone ? 1 : 0)
  }
  return { deleted, failed }
}
