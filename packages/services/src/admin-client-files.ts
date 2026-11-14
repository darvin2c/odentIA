/**
 * Documentos de un cliente del ARM (ficha › Documentos): lo que le mandamos
 * (carta de bienvenida, propuestas, presentaciones) y lo que nos mandó la
 * clínica. Viven en el bucket privado con la
 * clave `clients/<clientId>/<uuid>.<ext>` (los adjuntos de un correo entrante,
 * en `inbound/<uuid>.<ext>`, porque llegan antes de saber de qué cliente son).
 *
 * Lo que manda la clínica (`archivo_clinica`) y lo que llega por correo
 * (`correo`) es solo de Administración. Solo se borra a los 30 días de llegar
 * (`received_at`) lo que Administración dice que es la carga de datos
 * (`archivo_clinica`: subido así, o un adjunto marcado con
 * `markClientFileCarga`), con el texto del correo en que llegó: es lo que
 * promete el contrato de encargo. Nada se borra por el buzón al que llegó: lo
 * demás se guarda. Lo borra el worker con `purgeDueClientFiles`; lo marcado
 * después de los 30 días se borra al marcarlo (`clearDueCargaNow`). Soporte
 * nunca ve lo `admin_only`. El almacenamiento
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
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, type SQL, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { writeAdminAudit } from "./admin-core.js"
import { invalidField, isUniqueViolation, notFound, ServiceError } from "./errors.js"
import { limaDate } from "./peru-business-days.js"
import type { Storage } from "./storage.js"

/** Días que se guarda lo de la carga de datos (contrato de encargo). */
export const CLIENT_FILE_RETENTION_DAYS = 30

/**
 * La carga de datos: solo de Administración y con borrado a los 30 días de
 * llegar. Un adjunto de correo (`correo`) se guarda hasta que Administración
 * dice que es la carga (`markClientFileCarga`).
 */
export const CLINIC_SENT_FILE_KINDS: ReadonlySet<SaasClientFileKind> = new Set(["archivo_clinica"])

/**
 * Los tipos con que suele llegar una carga de datos (Excel, CSV, Word). Solo
 * sirven para sugerirla (Kairós): nunca deciden que algo es la carga ni lo
 * borran.
 */
export const LIKELY_CARGA_TYPES: readonly string[] = [
  "text/csv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]

/** Lo mismo por el nombre, para un adjunto que llegó con un tipo genérico. */
export const LIKELY_CARGA_NAME = /\.(xlsx|csv|docx)$/i

/** Si un archivo puede ser la carga de datos, por su tipo o su nombre (solo para sugerirlo). */
export function isLikelyCarga(file: { contentType: string; filename: string }): boolean {
  return (
    LIKELY_CARGA_TYPES.includes(file.contentType.trim().toLowerCase()) ||
    LIKELY_CARGA_NAME.test(file.filename.trim())
  )
}

/**
 * `isLikelyCarga` en SQL sobre una fila de `saas_client_file` con ese alias
 * (`f`): la misma lista de tipos y el mismo nombre.
 */
export function likelyCargaSql(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Alias no válido")
  const column = (name: string) => sql.raw(`${alias}.${name}`)
  return sql`(lower(${column("content_type")}) in (${sql.join(
    LIKELY_CARGA_TYPES.map((type) => sql`${type}`),
    sql`, `,
  )}) or ${column("filename")} ~* ${LIKELY_CARGA_NAME.source})`
}

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

/**
 * El día (de Lima) en que se borra la carga que llegó en `receivedAt`: la
 * única cuenta del plazo. Lo que dice llegar en el futuro cuenta desde ahora.
 */
export function cargaDeleteAfter(receivedAt: Date, now: Date): string {
  return clientFileDeleteAfter(receivedAt.getTime() < now.getTime() ? receivedAt : now)
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

/** La extensión de cada tipo que se guarda (lo que entra por correo y lo que se sube). */
const EXT_OF_TYPE: Record<string, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/gif": ["gif"],
  "text/csv": ["csv"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
}

/**
 * El nombre con que sale un documento adjunto: con la extensión de su tipo
 * real, porque los programas de correo lo abren por ella («factura.html» que es
 * un PDF sale «factura.pdf»). Un tipo que no está en la lista no se toca.
 */
export function filenameForType(name: string, contentType: string): string {
  const exts = EXT_OF_TYPE[contentType.trim().toLowerCase()]
  const clean = cleanFilename(name)
  if (!exts) return clean
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(clean)
  if (match && exts.includes((match[1] ?? "").toLowerCase())) return clean
  const base = (match ? clean.slice(0, match.index) : clean).trim() || "archivo"
  return `${base.slice(0, 250)}.${exts[0]}`
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
  /** Por defecto: lo de la carga (`archivo_clinica`), a los 30 días de llegar; lo demás, nunca. */
  deleteAfter?: string | null
  /** Por defecto: `persona` con actor, `kairos` sin él. */
  source?: SaasClientFileSource
  /** Cuándo llegó (la hora del correo); por defecto, ahora. Lo que dice llegar en el futuro, ahora. */
  receivedAt?: Date
  /** El correo en que llegó, si vino por correo. */
  inboundEmailId?: string | null
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
  /** Cuándo llegó: la hora del correo si vino por correo; si no, cuándo se subió. */
  receivedAt: Date
  /** Cuándo se dijo que es la carga de datos; nulo si no se marcó. */
  cargaAt: Date | null
  /** El correo en que llegó. */
  inboundEmailId: string | null
  /**
   * Solo en un adjunto (`correo`): el día de Lima en que se borraría si se
   * marca ahora como la carga. Lo calcula el servidor: el día de Lima y el del
   * navegador pueden no coincidir.
   */
  cargaDeleteAfter: string | null
  /** Marcarlo ahora lo borra en el acto: llegó hace 30 días o más. */
  cargaDueNow: boolean
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
  const receivedAt =
    input.receivedAt && input.receivedAt.getTime() < now.getTime() ? input.receivedAt : now
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
        ? cargaDeleteAfter(receivedAt, now)
        : null
  if (deleteAfter !== null && !/^\d{4}-\d{2}-\d{2}$/.test(deleteAfter))
    throw invalidField("deleteAfter", "Fecha AAAA-MM-DD")
  // La carga nunca se guarda más de 30 días desde que llegó: el contrato lo promete.
  const cap = cargaDeleteAfter(receivedAt, now)
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
        receivedAt,
        inboundEmailId: input.inboundEmailId ?? null,
        // Subirlo como la carga ya es decir que lo es.
        cargaAt: clinicSent ? now : null,
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
  return toRow(row, actor ? { userId: actor.userId, name } : null, now)
}

function toRow(
  row: typeof saasClientFile.$inferSelect,
  createdBy: { userId: string; name: string } | null,
  now: Date,
): ClientFileRow {
  const cargaDay = row.kind === "correo" ? cargaDeleteAfter(row.receivedAt, now) : null
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
    receivedAt: row.receivedAt,
    cargaAt: row.cargaAt,
    inboundEmailId: row.inboundEmailId,
    cargaDeleteAfter: cargaDay,
    cargaDueNow: cargaDay !== null && cargaDay <= limaDate(now),
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
  now = new Date(),
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
      toRow(row.file, row.userId ? { userId: row.userId, name: row.userName ?? "" } : null, now),
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

/**
 * «Es la carga de datos»: un adjunto que mandó la clínica (`correo`) pasa a
 * ser la carga (`archivo_clinica`) y se borra a los 30 días de llegar, con el
 * texto del correo en que llegó. Solo Administración, sobre lo que ya llegó
 * (no se vuelve a subir), y no se deshace. Es idempotente: lo que ya es la
 * carga se devuelve igual. Si llegó hace 30 días o más (`dueNow`), el texto
 * del correo se borra aquí mismo y el objeto lo borra quien llama después del
 * commit (`clearDueCargaNow`); si eso falla, su día ya pasó y lo borra la
 * limpieza en la vuelta siguiente.
 */
export async function markClientFileCarga(
  tx: Db,
  actor: AdminActor | null,
  fileId: string,
  now = new Date(),
): Promise<{ file: ClientFileRow; dueNow: boolean; objectKey: string }> {
  const staff = requireAdmin(actor)
  if (!/^[0-9a-f-]{36}$/i.test(fileId)) throw notFound("Archivo")
  const [row] = await tx
    .select()
    .from(saasClientFile)
    .where(eq(saasClientFile.id, fileId))
    .for("update")
    .limit(1)
  if (!row || row.deletedAt) throw notFound("Archivo")
  const today = limaDate(now)
  const withCreator = async (file: typeof saasClientFile.$inferSelect) => {
    const [creator] = file.createdBy
      ? await tx
          .select({ userId: user.id, name: user.name })
          .from(user)
          .where(eq(user.id, file.createdBy))
          .limit(1)
      : []
    return toRow(file, creator ?? null, now)
  }
  // Un doble clic, o el «sí» de Kairós después del botón de la ficha, no falla.
  if (row.kind === "archivo_clinica")
    return {
      file: await withCreator(row),
      dueNow: row.deleteAfter !== null && row.deleteAfter <= today,
      objectKey: row.objectKey,
    }
  if (row.kind !== "correo")
    throw invalidField("fileId", "Solo un adjunto que mandó la clínica puede ser la carga de datos")
  const deleteAfter = cargaDeleteAfter(row.receivedAt, now)
  const [updated] = await tx
    .update(saasClientFile)
    .set({ kind: "archivo_clinica", adminOnly: true, cargaAt: now, deleteAfter })
    .where(
      and(
        eq(saasClientFile.id, row.id),
        isNull(saasClientFile.deletedAt),
        eq(saasClientFile.kind, "correo"),
      ),
    )
    .returning()
  if (!updated) throw new ServiceError("CONFLICT", 409, "Ese archivo cambió mientras lo marcabas")
  const dueNow = deleteAfter <= today
  // El texto del correo no está en el almacenamiento: se borra en esta misma transacción.
  if (dueNow && row.inboundEmailId)
    await tx
      .update(saasInboundEmail)
      .set({ textBody: null, notice: null })
      .where(eq(saasInboundEmail.id, row.inboundEmailId))
  await writeAdminAudit(tx, staff, {
    action: "client_file.marked_carga",
    entityId: row.id,
    metadata: {
      clientId: row.clientId,
      inboundEmailId: row.inboundEmailId,
      receivedAt: row.receivedAt.toISOString(),
      deleteAfter,
      deletedNow: dueNow,
    },
  })
  return { file: await withCreator(updated), dueNow, objectKey: row.objectKey }
}

/** Una carga que ya cumplió su plazo: su objeto se borra y después se confirma. */
export interface DueClientFileDeletion {
  fileId: string
  objectKey: string
}

/**
 * Lo que ya pasó su día de borrado (de Lima): solo la carga de datos
 * (`archivo_clinica`) con `delete_after` vencido. Nada más se borra solo,
 * aunque tenga fecha (un adjunto que registró con plazo el código anterior,
 * mientras se despliega, se guarda). Solo lee: el worker borra el objeto y
 * después lo confirma con `confirmClientFileDeletions` (si el borrado falla,
 * vuelve a salir).
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
    .where(
      and(
        isNull(saasClientFile.deletedAt),
        eq(saasClientFile.kind, "archivo_clinica"),
        lte(saasClientFile.deleteAfter, today),
      ),
    )
    .orderBy(asc(saasClientFile.deleteAfter), asc(saasClientFile.id))
    .limit(limit)
  return files.map((row) => ({ fileId: row.id, objectKey: row.objectKey }))
}

/**
 * Anota como borrado lo que ya se borró del almacenamiento y quita su clave
 * del correo en que llegó, para que no apunte a un objeto que ya no existe. La
 * auditoría guarda qué archivos y de qué clientes («Se borraron sin cargar»).
 */
export async function confirmClientFileDeletions(
  tx: Db,
  done: readonly DueClientFileDeletion[],
  now: Date,
): Promise<void> {
  const fileIds = [...new Set(done.map((item) => item.fileId))]
  if (fileIds.length === 0) return
  const marked = await tx
    .update(saasClientFile)
    .set({ deletedAt: now })
    .where(and(inArray(saasClientFile.id, fileIds), isNull(saasClientFile.deletedAt)))
    .returning({
      id: saasClientFile.id,
      clientId: saasClientFile.clientId,
      inboundEmailId: saasClientFile.inboundEmailId,
    })
  if (marked.length === 0) return
  const byEmail = new Map<string, Set<string>>()
  for (const file of marked) {
    if (!file.inboundEmailId) continue
    const ids = byEmail.get(file.inboundEmailId) ?? new Set<string>()
    ids.add(file.id)
    byEmail.set(file.inboundEmailId, ids)
  }
  for (const [emailId, ids] of byEmail) {
    const [email] = await tx
      .select({ attachments: saasInboundEmail.attachments })
      .from(saasInboundEmail)
      .where(eq(saasInboundEmail.id, emailId))
      .for("update")
      .limit(1)
    if (!email) continue
    const kept = (email.attachments as StoredInboundAttachment[]).map(({ objectKey, ...rest }) =>
      rest.fileId && ids.has(rest.fileId) ? rest : { ...rest, ...(objectKey ? { objectKey } : {}) },
    )
    await tx
      .update(saasInboundEmail)
      .set({ attachments: kept })
      .where(eq(saasInboundEmail.id, emailId))
  }
  await writeAdminAudit(tx, null, {
    action: "kairos.client_files_expired",
    metadata: {
      count: marked.length,
      fileIds: marked.map((file) => file.id),
      clientIds: [...new Set(marked.map((file) => file.clientId))],
    },
  })
}

/**
 * Lo que el código anterior todavía programó para borrarse mientras se desplegaba (un adjunto
 * de `soporte@` registrado con `delete_after`, `received_at` de ahora y sin su correo, después
 * de que corrió la 0119): deja de estarlo, con la misma auditoría que el relleno
 * (`client_file.retention_lifted`, con el día que tenía), y se liga a su correo con la hora del
 * correo, como hizo la 0119. Idempotente y barata (lo normal es que no encuentre nada): la
 * corre cada pasada de Kairós antes de mirar el alta. Devuelve cuántos levantó.
 */
export async function liftLeftoverCorreoRetention(tx: Db): Promise<number> {
  const leftovers = (await tx.execute(sql`
    select f.id, f.client_id as "clientId", f.delete_after::text as "deleteAfter",
      c.organization_id as "organizationId", e.id as "emailId",
      case when e.id is null then null else least(e.received_at, f.created_at) end as "receivedAt"
    from ${saasClientFile} f
    join ${saasClient} c on c.id = f.client_id
    left join lateral (
      select m.id, m.received_at from ${saasInboundEmail} m
      cross join lateral jsonb_array_elements(m.attachments) a
      where a ->> 'fileId' = f.id::text
      order by m.received_at asc, m.id asc limit 1
    ) e on f.inbound_email_id is null
    where f.kind = 'correo' and f.deleted_at is null and f.delete_after is not null
    order by f.id
    for update of f`)) as unknown as Array<{
    id: string
    clientId: string
    deleteAfter: string
    organizationId: string | null
    emailId: string | null
    receivedAt: Date | string | null
  }>
  for (const file of leftovers) {
    await tx
      .update(saasClientFile)
      .set({
        deleteAfter: null,
        ...(file.emailId && file.receivedAt
          ? { inboundEmailId: file.emailId, receivedAt: new Date(file.receivedAt) }
          : {}),
      })
      .where(eq(saasClientFile.id, file.id))
    await writeAdminAudit(tx, null, {
      action: "client_file.retention_lifted",
      entityId: file.id,
      organizationId: file.organizationId,
      metadata: { clientId: file.clientId, deleteAfter: file.deleteAfter },
    })
  }
  return leftovers.length
}

/**
 * La pasada del worker: busca lo vencido, borra cada objeto (fuera de toda
 * transacción) y anota lo que sí se borró. Un objeto que no se pudo borrar
 * queda para la próxima pasada. Devuelve cuántos se borraron, cuántos no y
 * de cuántos correos se borró el texto.
 */
export async function purgeDueClientFiles(
  db: Db,
  storage: Pick<Storage, "deleteAttachment">,
  now: Date,
  limit = 100,
): Promise<{ deleted: number; failed: number; textsCleared: number }> {
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
  const textsCleared = await purgeInboundEmailText(db, now)
  return { deleted: done.length, failed, textsCleared }
}

/**
 * Borra ya la carga que se marcó después de sus 30 días: primero el objeto y
 * después su registro. Lo llama la ruta después del commit de
 * `markClientFileCarga`; si falla, la limpieza lo vuelve a intentar.
 */
export async function clearDueCargaNow(
  db: Db,
  storage: Pick<Storage, "deleteAttachment">,
  fileId: string,
  objectKey: string,
  now: Date,
): Promise<void> {
  await storage.deleteAttachment(objectKey)
  await db.transaction((tx) => confirmClientFileDeletions(tx, [{ fileId, objectKey }], now))
}

/**
 * El texto del correo en que llegó la carga se borra a los 30 días de llegar,
 * con ella: el contrato promete borrar el correo de la carga. Solo el de un
 * correo con un adjunto marcado como la carga (`archivo_clinica`); los demás
 * se guardan con su texto. Quedan el asunto, el remitente y los adjuntos que
 * hubo.
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
        sql`exists (select 1 from ${saasClientFile} f where f.inbound_email_id = ${saasInboundEmail.id} and f.kind = 'archivo_clinica')`,
        sql`(${saasInboundEmail.receivedAt} at time zone 'America/Lima')::date <= ${cutoff}::date`,
      ),
    )
    .returning({ id: saasInboundEmail.id })
  return cleared.length
}
