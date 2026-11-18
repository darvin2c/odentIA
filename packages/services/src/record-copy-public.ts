/**
 * La página pública de la copia de su historia (`/pendientes?abre=copia`, mesa del
 * 18 nov): de la familia de «Su enlace» (ADR 0037 y 0167), sin sesión, pero con su
 * propio token, el que viajó dentro del PDF (`record-copy-link.ts`). «Su enlace» no la abre.
 *
 * - Abrirla no descarga, no registra nada y no dibuja ni guarda papeles: la miran
 *   también la vista previa de un chat y los lectores de enlaces del correo.
 * - Para bajarla, quien la pidió escribe su número de documento, como al firmar a
 *   distancia (`sameDocument`): sin documento en su ficha, «Esta copia la recibes en
 *   la clínica». Cada intento se cuenta antes de comparar, en su propia transacción
 *   (`reserveRecordCopyAttempt`); si el documento coincide se devuelve. Con
 *   `RECORD_COPY_ATTEMPTS` mal escritos deja de servir, como el PIN del portal.
 * - Sirve hasta `copy_until`, `RECORD_COPY_DOWNLOADS` veces y solo mientras quien la
 *   pidió decide por el paciente. Una historia bloqueada o borrada no existe para él.
 * - Vencido, reemplazado por otro envío, inválido o sin intentos: la misma respuesta
 *   (404), sin nada de la persona. Cada descarga queda en `patient_record_download`.
 */
import { documentText } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patientDataRequest, patientRecordDownload } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq, gt, isNull, lt, lte, sql } from "drizzle-orm"
import { clinicNameOf } from "./booking-links.js"
import { sameDocument } from "./clinical-forms.js"
import {
  RECORD_COPY_ATTEMPTS,
  RECORD_COPY_DOWNLOADS,
  recordCopySentAt,
  recordCopyStartsSince,
} from "./data-requests.js"
import { notFound, ServiceError } from "./errors.js"
import { findOrgCountry, findOrgLocale } from "./locale.js"
import {
  buildPatientRecordCopy,
  type PatientRecordCopy,
  patientRecordSummary,
} from "./patient-record-copy.js"
import { isPatientLocked } from "./patient-identity.js"
import { RECORD_COPY_TOKEN, recordCopyTokenHash } from "./record-copy-link.js"
import { contactDecides } from "./responsibilities.js"
import type { Storage } from "./storage.js"

export interface RecordCopyView {
  clinicName: string
  locale: string
  /** La zona de la clínica, para decir «hasta el 25 de noviembre» como ella. */
  timezone: string
  countryCode: string | null
  /** Nombre de pila de quien la abre. */
  firstName: string | null
  /** El del paciente si quien la abre decide por él («La historia de Mateo»); null si es la propia persona. */
  patientFirstName: string | null
  /** Hasta cuándo se baja: el último instante de ese día en la zona de la clínica. */
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

/** Lo que dice un enlace que no sirve: igual si venció, si se reemplazó o si nunca existió. */
function unavailable(): ServiceError {
  return notFound("Enlace")
}

interface LiveCopy {
  patientId: string
  requestId: string
  requesterContactId: string
  until: Date
  self: boolean
  /** Los intentos con documento ya contados (con el de esta petición, si se reservó). */
  failed: number
}

/**
 * El pedido de copia de este token, si hoy sirve. `reserved`: el intento de esta petición
 * ya se contó (`reserveRecordCopyAttempt`), así que vale con el tope justo.
 */
async function liveCopyOf(
  tx: Db,
  orgId: string,
  token: string,
  options: { lock?: boolean; reserved?: boolean } = {},
): Promise<LiveCopy> {
  if (!RECORD_COPY_TOKEN.test(token)) throw unavailable()
  const query = tx
    .select({
      id: patientDataRequest.id,
      patientId: patientDataRequest.patientId,
      requesterContactId: patientDataRequest.requesterContactId,
      copyUntil: patientDataRequest.copyUntil,
      failed: patientDataRequest.copyFailedAttempts,
    })
    .from(patientDataRequest)
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.copyTokenHash, recordCopyTokenHash(token)),
        eq(patientDataRequest.kind, "copia"),
        eq(patientDataRequest.status, "respondida"),
        gt(patientDataRequest.copyUntil, sql`now()`),
        options.reserved
          ? lte(patientDataRequest.copyFailedAttempts, RECORD_COPY_ATTEMPTS)
          : lt(patientDataRequest.copyFailedAttempts, RECORD_COPY_ATTEMPTS),
      ),
    )
    .limit(1)
  const [request] = options.lock ? await query.for("update") : await query
  if (!request?.copyUntil) throw unavailable()
  // De una historia bloqueada (o borrada, que la bloquea) no se entrega nada.
  if (await isPatientLocked(tx, orgId, request.patientId)) throw unavailable()
  // Solo mientras quien la pidió decide por el paciente: al terminar la representación, se corta.
  if (!(await contactDecides(tx, orgId, request.patientId, request.requesterContactId)))
    throw unavailable()
  const [self] = await tx.execute<{ self: boolean }>(sql`
    select p.person_id = ${request.requesterContactId}::uuid as self
    from patient p where p.organization_id = ${orgId} and p.id = ${request.patientId}::uuid`)
  return {
    patientId: request.patientId,
    requestId: request.id,
    requesterContactId: request.requesterContactId,
    until: request.copyUntil,
    self: self?.self === true,
    failed: request.failed,
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

/** Las descargas que empezaron con el enlace del último envío: el tope es de cada envío. */
async function downloadsOf(tx: Db, orgId: string, requestId: string): Promise<number> {
  const sentAt = (await recordCopySentAt(tx, orgId, [requestId])).get(requestId) ?? null
  return recordCopyStartsSince(tx, orgId, requestId, sentAt)
}

const LIMIT = `Ya la bajaste ${RECORD_COPY_DOWNLOADS} veces con este enlace. Si la necesitas otra vez, pídele a la clínica que te la envíe de nuevo.`

async function requireDownloadsLeft(tx: Db, orgId: string, copy: LiveCopy): Promise<void> {
  if ((await downloadsOf(tx, orgId, copy.requestId)) >= RECORD_COPY_DOWNLOADS)
    throw new ServiceError("RECORD_COPY_LIMIT", 409, LIMIT)
}

const firstWord = (value: string | null | undefined) => (value ?? "").trim().split(/\s+/)[0] || null

/**
 * Lo que muestra la página al abrirla. No descarga, no registra y no arma papeles: lo que
 * trae y lo que pesa salen de `patientRecordSummary`, que no dibuja ni guarda nada.
 */
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
    timezone: region.timezone,
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

/**
 * Cuenta este intento antes de comparar el documento, en una transacción propia que se
 * confirma aparte: así muchas peticiones a la vez no prueban más documentos que el tope.
 * Agotadas las descargas no se cuenta nada (la página lo dice). Sin intentos: 404.
 */
export async function reserveRecordCopyAttempt(
  tx: Db,
  orgId: string,
  token: string,
): Promise<void> {
  const copy = await liveCopyOf(tx, orgId, token)
  await requireDownloadsLeft(tx, orgId, copy)
  const [counted] = await tx
    .update(patientDataRequest)
    .set({ copyFailedAttempts: sql`${patientDataRequest.copyFailedAttempts} + 1` })
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.id, copy.requestId),
        lt(patientDataRequest.copyFailedAttempts, RECORD_COPY_ATTEMPTS),
      ),
    )
    .returning({ id: patientDataRequest.id })
  if (!counted) throw unavailable()
}

/**
 * El documento que escribió es el de quien la pidió: el intento ya contado se devuelve (en
 * la transacción de la petición, que solo se confirma si todo sale bien). Si no, el error
 * va en su campo y el intento queda contado.
 */
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
  if (text.length > 40 || !sameDocument(text, requester.docNumber)) {
    // El intento de esta petición ya está contado: quedan los que faltan para el tope.
    const left = Math.max(0, RECORD_COPY_ATTEMPTS - copy.failed)
    const message =
      left === 0
        ? `${WRONG_DOCUMENT} Ya no quedan intentos: pídele a la clínica que te la envíe de nuevo.`
        : `${WRONG_DOCUMENT} ${left === 1 ? "Te queda 1 intento." : `Te quedan ${left} intentos.`}`
    throw new ServiceError("RECORD_COPY_DOCUMENT", 400, message, { docNumber: message })
  }
  await tx
    .update(patientDataRequest)
    .set({ copyFailedAttempts: sql`greatest(${patientDataRequest.copyFailedAttempts} - 1, 0)` })
    .where(
      and(eq(patientDataRequest.organizationId, orgId), eq(patientDataRequest.id, copy.requestId)),
    )
}

/**
 * «Descargar» antes de bajar: dice en su campo si el documento no es el suyo, o que ya no
 * le quedan descargas, sin bajar ni registrar nada. Antes, `reserveRecordCopyAttempt`.
 */
export async function checkRecordCopyDocument(
  tx: Db,
  orgId: string,
  token: string,
  docNumber: string,
): Promise<{ ok: true }> {
  const copy = await liveCopyOf(tx, orgId, token, { reserved: true })
  await requireDownloadsLeft(tx, orgId, copy)
  await requireDocument(tx, orgId, copy, docNumber)
  return { ok: true }
}

/**
 * «Descargar»: comprueba otra vez su documento y el tope, anota que empezó (el tope cuenta
 * los inicios) y arma la copia, la misma de la clínica (`buildPatientRecordCopy`). Quien
 * llama la entrega en streaming después de confirmar la transacción y, si termina de
 * enviarse, lo anota con `finishRecordCopyDownload`. Antes, `reserveRecordCopyAttempt`.
 */
export async function startRecordCopyDownload(
  tx: Db,
  orgId: string,
  token: string,
  input: { docNumber: string },
  evidence: { ip?: string | null; userAgent?: string | null },
  deps: { storage: Storage },
): Promise<{ copy: PatientRecordCopy; downloadId: string }> {
  const copy = await liveCopyOf(tx, orgId, token, { lock: true, reserved: true })
  await requireDownloadsLeft(tx, orgId, copy)
  await requireDocument(tx, orgId, copy, input.docNumber)
  const [download] = await tx
    .insert(patientRecordDownload)
    .values({
      organizationId: orgId,
      patientId: copy.patientId,
      dataRequestId: copy.requestId,
      ip: evidence.ip?.slice(0, 100) ?? null,
      userAgent: evidence.userAgent?.slice(0, 500) ?? null,
    })
    .returning({ id: patientRecordDownload.id })
  return {
    copy: await buildPatientRecordCopy(tx, orgId, copy.patientId, deps),
    downloadId: download!.id,
  }
}

/** El ZIP terminó de enviarse: desde ahora «Se bajó» y sale en «Consultas a la historia clínica». Una vez. */
export async function finishRecordCopyDownload(
  tx: Db,
  orgId: string,
  downloadId: string,
): Promise<void> {
  await tx
    .update(patientRecordDownload)
    .set({ completedAt: new Date() })
    .where(
      and(
        eq(patientRecordDownload.organizationId, orgId),
        eq(patientRecordDownload.id, downloadId),
        isNull(patientRecordDownload.completedAt),
      ),
    )
}
