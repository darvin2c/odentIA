/**
 * La página pública de la copia de su historia (`/pendientes?abre=copia`, mesa del
 * 18 nov): de la familia de «Su enlace» (ADR 0037 y 0167), sin sesión.
 *
 * - Abrirla no descarga ni registra nada: la miran también la vista previa de un
 *   chat y los lectores de enlaces del correo. «Descargar» es un envío aparte.
 * - Para bajarla, quien la pidió escribe su número de documento, como al firmar a
 *   distancia (`sameDocument`): sin documento en su ficha, «Esta copia la recibes en
 *   la clínica». Con `RECORD_COPY_ATTEMPTS` mal escritos deja de servir, como el PIN
 *   del portal (el intento se anota después del rollback: `recordRecordCopyFailure`).
 * - Sirve mientras el pedido lo diga (`copy_until`: siete días desde el último envío),
 *   hasta `RECORD_COPY_DOWNLOADS` veces, y solo a quien la pidió si todavía decide por
 *   el paciente. Una historia bloqueada o borrada no existe para el enlace.
 * - Vencido, quitado, inválido o sin intentos: la misma respuesta (404), sin nada de
 *   la persona. Cada descarga queda en `patient_record_download`.
 */
import { documentText } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patientDataRequest, patientRecordDownload } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, desc, eq, gt, lt, sql } from "drizzle-orm"
import { clinicNameOf, resolvePersonalLink } from "./booking-links.js"
import { sameDocument } from "./clinical-forms.js"
import { RECORD_COPY_ATTEMPTS, RECORD_COPY_DOWNLOADS } from "./data-requests.js"
import { notFound, ServiceError } from "./errors.js"
import { findOrgCountry, findOrgLocale } from "./locale.js"
import {
  buildPatientRecordCopy,
  type PatientRecordCopy,
  patientRecordSummary,
} from "./patient-record-copy.js"
import type { Storage } from "./storage.js"

export interface RecordCopyView {
  clinicName: string
  locale: string
  countryCode: string | null
  /** Nombre de pila de quien la abre. */
  firstName: string | null
  /** El del paciente si quien la abre decide por él («La historia de Mateo»); null si es la propia persona. */
  patientFirstName: string | null
  /** Hasta cuándo se baja con este enlace. */
  until: string
  /** Lo que pesa, más o menos; null si no se sabe. */
  approxBytes: number | null
  /** Su ficha tiene el documento con que comparar: sin él, la copia se entrega en la clínica. */
  canDownload: boolean
  /** Cómo se llama su documento («DNI»), para pedírselo; null si no se sabe. */
  documentLabel: string | null
  /** Cuántas veces más se puede bajar con este enlace. */
  downloadsLeft: number
}

/** Lo que dice un enlace que no sirve: igual si venció, si se quitó o si nunca existió. */
function unavailable(): ServiceError {
  return notFound("Enlace")
}

interface LiveCopy {
  patientId: string
  requestId: string
  requesterContactId: string
  until: Date
  self: boolean
}

/** El pedido de copia que este enlace sirve hoy, o «no disponible». */
async function liveCopyOf(tx: Db, orgId: string, token: string, lock = false): Promise<LiveCopy> {
  // Un enlace inexistente, de otra clínica o de una historia bloqueada: 404 (`findLink`).
  const link = await resolvePersonalLink(tx, orgId, token)
  if (!link.live || !link.patientId || !link.decides) throw unavailable()
  const query = tx
    .select({
      id: patientDataRequest.id,
      copyUntil: patientDataRequest.copyUntil,
      failed: patientDataRequest.copyFailedAttempts,
    })
    .from(patientDataRequest)
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.patientId, link.patientId),
        eq(patientDataRequest.kind, "copia"),
        eq(patientDataRequest.status, "respondida"),
        eq(patientDataRequest.requesterContactId, link.row.contactId),
        gt(patientDataRequest.copyUntil, sql`now()`),
        lt(patientDataRequest.copyFailedAttempts, RECORD_COPY_ATTEMPTS),
      ),
    )
    .orderBy(desc(patientDataRequest.copyUntil))
    .limit(1)
  const [request] = lock ? await query.for("update") : await query
  if (!request?.copyUntil) throw unavailable()
  const [self] = await tx.execute<{ self: boolean }>(sql`
    select p.person_id = ${link.row.contactId}::uuid as self
    from patient p where p.organization_id = ${orgId} and p.id = ${link.patientId}::uuid`)
  return {
    patientId: link.patientId,
    requestId: request.id,
    requesterContactId: link.row.contactId,
    until: request.copyUntil,
    self: self?.self === true,
  }
}

async function requesterOf(tx: Db, orgId: string, contactId: string) {
  const [row] = await tx
    .select({
      givenNames: contact.givenNames,
      displayName: contact.displayName,
      docType: contact.docType,
      docNumber: contact.docNumber,
    })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  return row ?? null
}

async function downloadsOf(tx: Db, orgId: string, requestId: string): Promise<number> {
  const [row] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(patientRecordDownload)
    .where(
      and(
        eq(patientRecordDownload.organizationId, orgId),
        eq(patientRecordDownload.dataRequestId, requestId),
      ),
    )
  return row?.count ?? 0
}

const firstWord = (value: string | null | undefined) => (value ?? "").trim().split(/\s+/)[0] || null

/** Lo que muestra la página al abrirla. No descarga ni registra nada. */
export async function getRecordCopyView(
  tx: Db,
  orgId: string,
  token: string,
  deps: { storage: Storage },
): Promise<RecordCopyView> {
  const copy = await liveCopyOf(tx, orgId, token)
  const requester = await requesterOf(tx, orgId, copy.requesterContactId)
  const region = await findOrgLocale(tx, orgId)
  const summary = await patientRecordSummary(tx, orgId, copy.patientId, deps)
  let patientFirstName: string | null = null
  if (!copy.self) {
    const [row] = await tx.execute<{ given_names: string | null; display_name: string }>(sql`
      select pp.given_names, pp.display_name from patient p
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
      where p.organization_id = ${orgId} and p.id = ${copy.patientId}::uuid`)
    patientFirstName = firstWord(row?.given_names ?? row?.display_name)
  }
  return {
    clinicName: await clinicNameOf(tx, orgId),
    locale: region.locale,
    countryCode: await findOrgCountry(tx, orgId),
    firstName: firstWord(requester?.givenNames ?? requester?.displayName),
    patientFirstName,
    until: copy.until.toISOString(),
    approxBytes: summary.approxBytes,
    canDownload: Boolean(requester?.docNumber),
    documentLabel: requester?.docType ? documentText(requester.docType, "").trim() || null : null,
    downloadsLeft: Math.max(
      0,
      RECORD_COPY_DOWNLOADS - (await downloadsOf(tx, orgId, copy.requestId)),
    ),
  }
}

const IN_CLINIC = "Esta copia la recibes en la clínica: pídela ahí y te la entregamos."
const WRONG_DOCUMENT = "Ese documento no coincide con el que tenemos registrado."

/** El documento que escribió es el de quien la pidió; si no, el error va en su campo. */
async function requireDocument(
  tx: Db,
  orgId: string,
  copy: LiveCopy,
  typed: string,
): Promise<void> {
  const requester = await requesterOf(tx, orgId, copy.requesterContactId)
  if (!requester?.docNumber) throw new ServiceError("RECORD_COPY_IN_CLINIC", 409, IN_CLINIC)
  const text = typed.trim()
  if (!text)
    throw new ServiceError("VALIDATION", 400, "Escribe tu número de documento.", {
      docNumber: "Escribe tu número de documento.",
    })
  if (text.length > 40 || !sameDocument(text, requester.docNumber))
    throw new ServiceError("RECORD_COPY_DOCUMENT", 400, WRONG_DOCUMENT, {
      docNumber: WRONG_DOCUMENT,
    })
}

/** «Descargar» antes de bajar: dice en su campo si el documento no es el suyo, sin registrar nada. */
export async function checkRecordCopyDocument(
  tx: Db,
  orgId: string,
  token: string,
  docNumber: string,
): Promise<{ ok: true }> {
  const copy = await liveCopyOf(tx, orgId, token)
  await requireDocument(tx, orgId, copy, docNumber)
  return { ok: true }
}

/**
 * Un documento mal escrito: se anota en el pedido, fuera de la transacción que lo
 * rechazó (el rollback borraría el conteo), como el PIN del portal. Con el tope, el
 * enlace deja de servir para la copia: hay que pedirla de nuevo.
 */
export async function recordRecordCopyFailure(tx: Db, orgId: string, token: string): Promise<void> {
  let copy: LiveCopy
  try {
    copy = await liveCopyOf(tx, orgId, token, true)
  } catch {
    return
  }
  await tx
    .update(patientDataRequest)
    .set({ copyFailedAttempts: sql`${patientDataRequest.copyFailedAttempts} + 1` })
    .where(
      and(eq(patientDataRequest.organizationId, orgId), eq(patientDataRequest.id, copy.requestId)),
    )
}

/**
 * «Descargar»: comprueba otra vez su documento y el tope, anota la descarga y arma la
 * copia, la misma de la clínica (`buildPatientRecordCopy`). Quien llama la entrega en
 * streaming después de confirmar la transacción.
 */
export async function startRecordCopyDownload(
  tx: Db,
  orgId: string,
  token: string,
  input: { docNumber: string },
  evidence: { ip?: string | null; userAgent?: string | null },
  deps: { storage: Storage },
): Promise<PatientRecordCopy> {
  const copy = await liveCopyOf(tx, orgId, token, true)
  await requireDocument(tx, orgId, copy, input.docNumber)
  if ((await downloadsOf(tx, orgId, copy.requestId)) >= RECORD_COPY_DOWNLOADS)
    throw new ServiceError(
      "RECORD_COPY_LIMIT",
      409,
      `Ya la bajaste ${RECORD_COPY_DOWNLOADS} veces con este enlace. Si la necesitas otra vez, pídele a la clínica que te la envíe de nuevo.`,
    )
  await tx.insert(patientRecordDownload).values({
    organizationId: orgId,
    patientId: copy.patientId,
    dataRequestId: copy.requestId,
    ip: evidence.ip?.slice(0, 100) ?? null,
    userAgent: evidence.userAgent?.slice(0, 500) ?? null,
  })
  return buildPatientRecordCopy(tx, orgId, copy.patientId, deps)
}
