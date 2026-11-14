/**
 * Documentos de un cliente del ARM (ficha › Documentos): lo que le mandamos
 * (carta de bienvenida, propuestas, presentaciones) y lo que nos mandó la
 * clínica. Viven en el bucket privado con la
 * clave `clients/<clientId>/<uuid>.<ext>` (los adjuntos de un correo entrante,
 * en `inbound/<uuid>.<ext>`, porque llegan antes de saber de qué cliente son).
 *
 * Lo que manda la clínica (`archivo_clinica`) y lo que llega por correo
 * (`correo`) es solo de Administración. Se borra a los 30 días (`delete_after`)
 * solo lo de la carga, que es lo que promete el contrato de encargo: los
 * archivos que se suben como «Lo que mandó la clínica» y lo que llega a
 * soporte@ con adjuntos (`isCargaEmail`), con su texto. Lo demás se guarda.
 * Lo borra el worker con `purgeDueClientFiles`. Soporte nunca ve lo `admin_only`. El almacenamiento
 * lo toca quien llama, fuera de la transacción: primero se sube y después se
 * registra (si el registro falla, se borra lo subido); al borrar, primero se
 * marca y después se borra el objeto.
 */

import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import {
  SAAS_CLIENT_FILE_KINDS,
  SAAS_CLIENT_FILE_SOURCES,
  type SaasClientFileKind,
  type SaasClientFileSource,
  type SaasInboundAttachment,
  saasClient,
  saasClientFile,
  saasInboundEmail,
} from "@odentia/db/schema/admin-arm"
import { user } from "@odentia/db/schema/auth"
import { processingAgreementAcceptance } from "@odentia/db/schema/workspace"
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { invalidField, isUniqueViolation, notFound, ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import type { Storage } from "./storage.js"

/** Días que se guarda lo de la carga de datos (contrato de encargo). */
export const CLIENT_FILE_RETENTION_DAYS = 30

/**
 * Lo de la carga que se sube a mano: solo de Administración y con borrado a
 * los 30 días. Un adjunto de correo (`correo`) lleva su plazo según dónde
 * llegó (`isCargaEmail`).
 */
export const CLINIC_SENT_FILE_KINDS: ReadonlySet<SaasClientFileKind> = new Set(["archivo_clinica"])

/**
 * Un correo que puede ser de la carga de datos: llegó a soporte@ (donde la
 * clínica la manda, ADR 0104) con adjuntos, guardados o no. Su texto y sus
 * adjuntos se borran a los 30 días; lo demás que llega se guarda.
 */
export function isCargaEmail(email: {
  mailbox: string
  attachments: number
  notice?: string | null
}): boolean {
  return email.mailbox === "soporte" && (email.attachments > 0 || Boolean(email.notice))
}

/** Lo mismo en SQL, sobre `saas_inbound_email`. */
const CARGA_EMAIL = sql`(${saasInboundEmail.mailbox} = 'soporte' and (jsonb_array_length(${saasInboundEmail.attachments}) > 0 or ${saasInboundEmail.notice} is not null))`

/** Tipos que solo maneja Administración (lo que trae datos de la clínica). */
const ADMIN_FILE_KINDS: ReadonlySet<SaasClientFileKind> = new Set(["archivo_clinica", "correo"])

/** Tope de un documento subido a mano (el de los adjuntos de Soporte es 10 MB). */
export const CLIENT_FILE_MAX_BYTES = 20 * 1024 * 1024

/** Un adjunto de correo como lo guarda `saas_inbound_email`: con su clave mientras el objeto exista. */
export type StoredInboundAttachment = SaasInboundAttachment & { objectKey?: string }

const EXT = /^[a-z0-9]{1,8}$/
const KEY_SAFE = /^[A-Za-z0-9/_.-]{1,300}$/

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

function requireStaff(actor: AdminActor | null): AdminActor {
  if (!actor) throw forbidden("Se requiere personal de administración")
  return actor
}

function requireAdmin(actor: AdminActor | null): AdminActor {
  const staff = requireStaff(actor)
  if (staff.role !== "admin") throw forbidden("Solo Administración puede hacer esto")
  return staff
}

/** El día de Lima `days` días después de `iso` (días civiles, sin hábiles). */
function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Hasta qué día (de Lima) se guarda lo que llegó en `instant`: 30 días después. */
export function clientFileDeleteAfter(instant: Date): string {
  return addDays(limaDate(instant), CLIENT_FILE_RETENTION_DAYS)
}

/** La clave de un documento nuevo del cliente en el bucket privado. */
export function clientFileKey(clientId: string, ext: string): string {
  const clean = ext.trim().toLowerCase().replace(/^\./, "")
  if (!EXT.test(clean)) throw invalidField("file", "El archivo no tiene una extensión válida")
  return `clients/${clientId}/${randomUUID()}.${clean}`
}

/** La clave de un adjunto de un correo entrante (aún no se sabe de qué cliente es). */
export function inboundAttachmentKey(ext: string): string {
  const clean = ext.trim().toLowerCase().replace(/^\./, "")
  if (!EXT.test(clean))
    throw invalidField("attachments", "Un adjunto no tiene una extensión válida")
  return `inbound/${randomUUID()}.${clean}`
}

/** El nombre del archivo sin carpetas ni caracteres de control, como mucho 255. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ""
  const clean = [...base]
    .filter((char) => {
      const code = char.charCodeAt(0)
      return code >= 32 && code !== 127
    })
    .join("")
    .trim()
  return (clean || "archivo").slice(0, 255)
}

async function clientExists(tx: Db, clientId: string): Promise<void> {
  const [row] = await tx
    .select({ id: saasClient.id })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  if (!row) throw notFound("Cliente")
}

export interface RegisterClientFileInput {
  clientId: string
  kind: SaasClientFileKind
  filename: string
  objectKey: string
  contentType: string
  sizeBytes: number
  /** Por defecto, sí; lo de la clínica y del correo, siempre. */
  adminOnly?: boolean
  /** Por defecto: lo de la carga (`archivo_clinica`), a los 30 días; lo demás, nunca. */
  deleteAfter?: string | null
  /** Por defecto: `persona` con actor, `kairos` sin él. */
  source?: SaasClientFileSource
}

export interface ClientFileRow {
  id: string
  clientId: string
  kind: SaasClientFileKind
  filename: string
  contentType: string
  sizeBytes: number
  adminOnly: boolean
  /** Día de Lima en que se borra; nulo, se guarda. */
  deleteAfter: string | null
  source: SaasClientFileSource | null
  createdAt: Date
  createdBy: { userId: string; name: string } | null
}

/**
 * Registra un objeto ya subido como documento del cliente. Con actor nulo lo
 * registra el sistema (Kairós, el correo entrante). Soporte solo registra lo
 * que puede ver (no la carga ni lo que manda la clínica).
 */
export async function registerClientFile(
  tx: Db,
  actor: AdminActor | null,
  input: RegisterClientFileInput,
  now = new Date(),
): Promise<ClientFileRow> {
  if (!SAAS_CLIENT_FILE_KINDS.includes(input.kind))
    throw invalidField("kind", "Elige un tipo de documento")
  if (input.source && !SAAS_CLIENT_FILE_SOURCES.includes(input.source))
    throw invalidField("source", "Origen no válido")
  const clinicSent = CLINIC_SENT_FILE_KINDS.has(input.kind)
  const adminOnly = ADMIN_FILE_KINDS.has(input.kind) ? true : (input.adminOnly ?? true)
  if (actor?.role === "support" && (ADMIN_FILE_KINDS.has(input.kind) || adminOnly))
    throw forbidden("Ese documento es solo de Administración")
  if (
    !KEY_SAFE.test(input.objectKey) ||
    input.objectKey.includes("..") ||
    !(
      input.objectKey.startsWith(`clients/${input.clientId}/`) ||
      input.objectKey.startsWith("inbound/")
    )
  )
    throw invalidField("objectKey", "La clave del archivo no es de este cliente")
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0)
    throw invalidField("file", "El tamaño del archivo no es válido")
  const contentType = input.contentType.trim().toLowerCase()
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentType))
    throw invalidField("file", "El tipo del archivo no es válido")
  const deleteAfter =
    input.deleteAfter !== undefined
      ? input.deleteAfter
      : clinicSent
        ? clientFileDeleteAfter(now)
        : null
  if (deleteAfter !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deleteAfter))
    throw invalidField("deleteAfter", "Fecha AAAA-MM-DD")
  // Lo de la clínica nunca se guarda más de 30 días: el contrato lo promete.
  const cap = clientFileDeleteAfter(now)
  const finalDeleteAfter =
    clinicSent && (deleteAfter === null || deleteAfter > cap) ? cap : deleteAfter
  await clientExists(tx, input.clientId)
  const source = input.source ?? (actor ? "persona" : "kairos")
  let row: typeof saasClientFile.$inferSelect | undefined
  try {
    ;[row] = await tx
      .insert(saasClientFile)
      .values({
        clientId: input.clientId,
        kind: input.kind,
        filename: cleanFilename(input.filename),
        objectKey: input.objectKey,
        contentType,
        sizeBytes: input.sizeBytes,
        adminOnly,
        deleteAfter: finalDeleteAfter,
        createdBy: actor?.userId ?? null,
        source,
      })
      .returning()
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ServiceError("CONFLICT", 409, "Ese archivo ya está registrado")
    throw error
  }
  if (!row) throw new ServiceError("INTERNAL", 500, "No se registró el archivo")
  await writeAdminAudit(tx, actor, {
    // Lo que guarda Kairós solo queda en «Lo que hizo» (`kairos.`); el correo, no.
    action: source === "kairos" ? "kairos.client_file_registered" : "client_file.registered",
    entityId: row.id,
    metadata: {
      clientId: row.clientId,
      kind: row.kind,
      source,
      adminOnly,
      sizeBytes: row.sizeBytes,
    },
  })
  const name = actor
    ? ((
        await tx.select({ name: user.name }).from(user).where(eq(user.id, actor.userId)).limit(1)
      )[0]?.name ?? "")
    : ""
  return toRow(row, actor ? { userId: actor.userId, name } : null)
}

function toRow(
  row: typeof saasClientFile.$inferSelect,
  createdBy: { userId: string; name: string } | null,
): ClientFileRow {
  return {
    id: row.id,
    clientId: row.clientId,
    kind: row.kind as SaasClientFileKind,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    adminOnly: row.adminOnly,
    deleteAfter: row.deleteAfter,
    source: (row.source as SaasClientFileSource | null) ?? null,
    createdAt: row.createdAt,
    createdBy,
  }
}

export interface ClientFileList {
  items: ClientFileRow[]
  /**
   * El contrato de encargo no se copia como archivo: se lee de
   * `processing_agreement_acceptance` de su cuenta (la última versión aceptada).
   */
  agreement: { version: string; acceptedAt: Date; acceptedBy: string | null } | null
}

/** Los documentos vigentes del cliente, lo último arriba. Soporte no recibe lo `admin_only`. */
export async function listClientFiles(
  tx: Db,
  actor: AdminActor | null,
  clientId: string,
): Promise<ClientFileList> {
  const staff = requireStaff(actor)
  const [client] = await tx
    .select({ id: saasClient.id, organizationId: saasClient.organizationId })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  if (!client) throw notFound("Cliente")
  const rows = await tx
    .select({ file: saasClientFile, userId: user.id, userName: user.name })
    .from(saasClientFile)
    .leftJoin(user, eq(user.id, saasClientFile.createdBy))
    .where(
      and(
        eq(saasClientFile.clientId, clientId),
        isNull(saasClientFile.deletedAt),
        staff.role === "admin" ? undefined : eq(saasClientFile.adminOnly, false),
      ),
    )
    .orderBy(desc(saasClientFile.createdAt), desc(saasClientFile.id))
  let agreement: ClientFileList["agreement"] = null
  if (client.organizationId) {
    const [accepted] = await tx
      .select({
        version: processingAgreementAcceptance.version,
        acceptedAt: processingAgreementAcceptance.acceptedAt,
        acceptedBy: user.name,
      })
      .from(processingAgreementAcceptance)
      .leftJoin(user, eq(user.id, processingAgreementAcceptance.acceptedBy))
      .where(eq(processingAgreementAcceptance.organizationId, client.organizationId))
      .orderBy(desc(processingAgreementAcceptance.acceptedAt))
      .limit(1)
    if (accepted)
      agreement = {
        version: accepted.version,
        acceptedAt: accepted.acceptedAt,
        acceptedBy: accepted.acceptedBy,
      }
  }
  return {
    items: rows.map((row) =>
      toRow(row.file, row.userId ? { userId: row.userId, name: row.userName ?? "" } : null),
    ),
    agreement,
  }
}

/** Un documento que el actor puede ver; si no, como si no existiera. */
async function visibleFile(tx: Db, staff: AdminActor, fileId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw notFound("Archivo")
  const [row] = await tx.select().from(saasClientFile).where(eq(saasClientFile.id, fileId)).limit(1)
  if (!row || row.deletedAt || (row.adminOnly && staff.role !== "admin")) throw notFound("Archivo")
  return row
}

/**
 * La dirección firmada (15 min) para descargar un documento. Deja auditoría:
 * lo que manda la clínica puede traer datos de pacientes.
 */
export async function clientFileUrl(
  tx: Db,
  actor: AdminActor | null,
  storage: Pick<Storage, "attachmentUrl">,
  fileId: string,
): Promise<{ url: string; filename: string; contentType: string }> {
  const staff = requireStaff(actor)
  const row = await visibleFile(tx, staff, fileId)
  await writeAdminAudit(tx, staff, {
    action: "client_file.downloaded",
    entityId: row.id,
    metadata: { clientId: row.clientId, kind: row.kind },
  })
  return {
    url: await storage.attachmentUrl(row.objectKey, 900),
    filename: row.filename,
    contentType: row.contentType,
  }
}

/**
 * Borra un documento (solo Administración): lo marca borrado y devuelve su
 * clave para que quien llama borre el objeto después del commit.
 */
export async function deleteClientFile(
  tx: Db,
  actor: AdminActor | null,
  fileId: string,
  now = new Date(),
): Promise<{ objectKey: string }> {
  const staff = requireAdmin(actor)
  const row = await visibleFile(tx, staff, fileId)
  const [marked] = await tx
    .update(saasClientFile)
    .set({ deletedAt: now })
    .where(and(eq(saasClientFile.id, row.id), isNull(saasClientFile.deletedAt)))
    .returning({ id: saasClientFile.id })
  if (!marked) throw notFound("Archivo")
  await writeAdminAudit(tx, staff, {
    action: "client_file.deleted",
    entityId: row.id,
    metadata: { clientId: row.clientId, kind: row.kind },
  })
  return { objectKey: row.objectKey }
}

/** Un objeto que ya cumplió su plazo: un documento del cliente o un adjunto de un correo sin cliente. */
export type DueClientFileDeletion =
  | { source: "archivo"; fileId: string; objectKey: string }
  | { source: "correo"; emailId: string; objectKey: string }

/**
 * Lo que ya pasó su día de borrado (de Lima): documentos con `delete_after`
 * vencido y adjuntos de correos que nadie asignó a un cliente, a los 30 días
 * de llegar. Solo lee: el worker borra el objeto y después lo confirma con
 * `confirmClientFileDeletions` (si el borrado falla, vuelve a salir).
 */
export async function dueClientFileDeletions(
  tx: Db,
  now: Date,
  limit = 100,
): Promise<DueClientFileDeletion[]> {
  const today = limaDate(now)
  const files = await tx
    .select({ id: saasClientFile.id, objectKey: saasClientFile.objectKey })
    .from(saasClientFile)
    .where(and(isNull(saasClientFile.deletedAt), lte(saasClientFile.deleteAfter, today)))
    .orderBy(asc(saasClientFile.deleteAfter), asc(saasClientFile.id))
    .limit(limit)
  const out: DueClientFileDeletion[] = files.map((row) => ({
    source: "archivo",
    fileId: row.id,
    objectKey: row.objectKey,
  }))
  if (out.length >= limit) return out
  // Un correo de la carga sin cliente: sus adjuntos no son documentos de nadie, pero igual se borran a los 30 días.
  const cutoff = addDays(today, -CLIENT_FILE_RETENTION_DAYS)
  const emails = await tx
    .select({ id: saasInboundEmail.id, attachments: saasInboundEmail.attachments })
    .from(saasInboundEmail)
    .where(
      and(
        isNull(saasInboundEmail.clientId),
        CARGA_EMAIL,
        sql`(${saasInboundEmail.receivedAt} at time zone 'America/Lima')::date <= ${cutoff}::date`,
        sql`exists (select 1 from jsonb_array_elements(${saasInboundEmail.attachments}) a where a ? 'objectKey')`,
      ),
    )
    .orderBy(asc(saasInboundEmail.receivedAt))
    .limit(limit)
  for (const email of emails) {
    for (const attachment of email.attachments as StoredInboundAttachment[]) {
      if (attachment.objectKey && out.length < limit)
        out.push({ source: "correo", emailId: email.id, objectKey: attachment.objectKey })
    }
  }
  return out
}

/** Anota como borrado lo que el worker ya borró del almacenamiento. */
export async function confirmClientFileDeletions(
  tx: Db,
  done: readonly DueClientFileDeletion[],
  now: Date,
): Promise<void> {
  const fileIds = done.flatMap((item) => (item.source === "archivo" ? [item.fileId] : []))
  if (fileIds.length > 0) {
    await tx
      .update(saasClientFile)
      .set({ deletedAt: now })
      .where(and(inArray(saasClientFile.id, fileIds), isNull(saasClientFile.deletedAt)))
    await writeAdminAudit(tx, null, {
      action: "kairos.client_files_expired",
      metadata: { count: fileIds.length },
    })
  }
  const byEmail = new Map<string, Set<string>>()
  for (const item of done) {
    if (item.source !== "correo") continue
    const keys = byEmail.get(item.emailId) ?? new Set<string>()
    keys.add(item.objectKey)
    byEmail.set(item.emailId, keys)
  }
  for (const [emailId, keys] of byEmail) {
    const [email] = await tx
      .select({ attachments: saasInboundEmail.attachments })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, emailId))
      .for("update")
      .limit(1)
    if (!email) continue
    const kept = (email.attachments as StoredInboundAttachment[]).map(({ objectKey, ...rest }) =>
      objectKey && keys.has(objectKey) ? rest : { ...rest, ...(objectKey ? { objectKey } : {}) },
    )
    await tx
      .update(saasInboundEmail)
      .set({ attachments: kept })
      .where(eq(saasInboundEmail.id, emailId))
  }
}

/**
 * La pasada del worker: busca lo vencido, borra cada objeto (fuera de toda
 * transacción) y anota lo que sí se borró. Un objeto que no se pudo borrar
 * queda para la próxima pasada. Devuelve cuántos se borraron y cuántos no.
 */
export async function purgeDueClientFiles(
  db: Db,
  storage: Pick<Storage, "deleteAttachment">,
  now: Date,
  limit = 100,
): Promise<{ deleted: number; failed: number }> {
  const due = await dueClientFileDeletions(db, now, limit)
  const done: DueClientFileDeletion[] = []
  let failed = 0
  for (const item of due) {
    try {
      await storage.deleteAttachment(item.objectKey)
      done.push(item)
    } catch {
      failed++
    }
  }
  if (done.length > 0) await db.transaction((tx) => confirmClientFileDeletions(tx, done, now))
  await purgeInboundEmailText(db, now)
  return { deleted: done.length, failed }
}

/**
 * El texto de un correo de la carga (`isCargaEmail`, con o sin cliente) se
 * borra a los 30 días, con sus adjuntos: el contrato promete borrar el correo
 * en que llegó la carga. Quedan el asunto, el remitente y los adjuntos que
 * hubo. Los demás correos se guardan con su texto.
 */
export async function purgeInboundEmailText(db: Db, now: Date): Promise<number> {
  const cutoff = addDays(limaDate(now), -CLIENT_FILE_RETENTION_DAYS)
  const cleared = await db
    .update(saasInboundEmail)
    // El aviso del correo entrante nombra sus adjuntos: se va con el texto.
    .set({ textBody: null, notice: null })
    .where(
      and(
        or(isNotNull(saasInboundEmail.textBody), isNotNull(saasInboundEmail.notice)),
        CARGA_EMAIL,
        sql`(${saasInboundEmail.receivedAt} at time zone 'America/Lima')::date <= ${cutoff}::date`,
      ),
    )
    .returning({ id: saasInboundEmail.id })
  return cleared.length
}
