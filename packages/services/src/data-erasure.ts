/**
 * Borrar los datos de una persona a su pedido y su historia bloqueada (ADR
 * 0080, fase 2). Se borra lo no clínico (conversaciones, oportunidades,
 * tareas, notas, correo, redes, etiquetas, campos propios y lo que el agente
 * recuerda) y se bloquea lo que la ley pide guardar: la historia clínica, los
 * cobros y los comprobantes. Bloqueada es archivada y algo más: no sale en
 * búsquedas, agenda, listas ni reportes, y solo Administración la abre, con
 * motivo.
 */
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { patient, patientDataRequest, patientRecordOpening } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm"
import { setAppointmentStatus } from "./appointments.js"
import { setMessageChoice } from "./automation.js"
import { recordClinicalAccess } from "./clinical-access.js"
import { type DataRequestItem, listDataRequests, lockPendingDataRequest } from "./data-requests.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { joinPatientPerson } from "./patient-identity.js"
import { getAccountSummary } from "./payments.js"
import { setPersonArchived } from "./people.js"

/** Cuánto dura abrir una historia bloqueada para leerla. */
export const RECORD_OPENING_MINUTES = 60

/** Por qué se abre una historia bloqueada. «vuelve» la desbloquea entera. */
export const RECORD_OPENING_REASONS = ["vuelve", "autoridad", "reclamo", "otro"] as const
export type RecordOpeningReason = (typeof RECORD_OPENING_REASONS)[number]

export interface ErasurePreview {
  conversations: number
  messages: number
  opportunities: number
  tasks: number
  notes: number
  /** Citas por venir: se cancelan sin avisarle. */
  futureAppointments: Array<{ id: string; startsAt: string }>
  /** Lo que debe, por moneda: se mantiene en Caja. */
  balances: Array<{ currency: string; cents: number }>
}

async function personOf(tx: Db, orgId: string, patientId: string) {
  const [row] = await tx
    .select({
      personId: patient.personId,
      patientNumber: patient.patientNumber,
      displayName: contact.displayName,
      docType: contact.docType,
      docNumber: contact.docNumber,
      lockedAt: contact.recordLockedAt,
      lockedBy: contact.recordLockedBy,
    })
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  if (!row) throw notFound("Paciente")
  return row
}

/** Lo que se borra y lo que hay que saber antes de confirmar (tablero 6). */
export async function erasurePreview(tx: Db, orgId: string, patientId: string): Promise<ErasurePreview> {
  const person = await personOf(tx, orgId, patientId)
  const counts = await tx.execute<{ conversations: number; messages: number; opportunities: number; tasks: number; notes: number }>(sql`
    select
      (select count(*)::int from conversation where organization_id = ${orgId} and contact_id = ${person.personId}) as conversations,
      (select count(*)::int from message m join conversation v on v.id = m.conversation_id
        where v.organization_id = ${orgId} and v.contact_id = ${person.personId}) as messages,
      (select count(*)::int from opportunity where organization_id = ${orgId} and contact_id = ${person.personId}) as opportunities,
      (select count(*)::int from task where organization_id = ${orgId} and contact_id = ${person.personId}) as tasks,
      (select count(*)::int from crm_note where organization_id = ${orgId} and contact_id = ${person.personId}) as notes`)
  const row = counts[0]!
  const future = await tx
    .select({ id: appointment.id, startsAt: appointment.startsAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, sql`now()`),
      ),
    )
    .orderBy(appointment.startsAt)
  const account = await getAccountSummary(tx, orgId, patientId)
  return {
    conversations: row.conversations,
    messages: row.messages,
    opportunities: row.opportunities,
    tasks: row.tasks,
    notes: row.notes,
    futureAppointments: future.map((a) => ({ id: a.id, startsAt: a.startsAt.toISOString() })),
    balances: account.byCurrency.filter((b) => b.saldo > 0).map((b) => ({ currency: b.currency, cents: b.saldo })),
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/** «Se borraron 2 conversaciones (46 mensajes), 1 oportunidad, sus datos de contacto…»: solo lo que había. */
export function erasureResolution(preview: ErasurePreview): string {
  const parts: string[] = []
  if (preview.conversations)
    parts.push(
      `${plural(preview.conversations, "conversación", "conversaciones")} (${plural(preview.messages, "mensaje", "mensajes")})`,
    )
  if (preview.opportunities) parts.push(plural(preview.opportunities, "oportunidad", "oportunidades"))
  if (preview.tasks) parts.push(plural(preview.tasks, "tarea", "tareas"))
  if (preview.notes) parts.push(plural(preview.notes, "nota", "notas"))
  parts.push("sus datos de contacto")
  const appointments = preview.futureAppointments.length
    ? ` Se cancelaron ${plural(preview.futureAppointments.length, "cita", "citas")} sin avisarle.`
    : ""
  return `Se borraron ${parts.join(", ")} y lo que el agente recordaba de ella.${appointments} La historia clínica, los cobros y los comprobantes quedaron bloqueados.`
}

/**
 * Responde un pedido de borrar: cancela sus citas por venir sin avisarle,
 * apaga todos sus mensajes, borra lo no clínico (`erase_person_data`) y
 * bloquea la historia. Exige haber comprobado que es ella. Devuelve las
 * claves de los adjuntos de sus mensajes, para borrarlos del almacenamiento
 * después de confirmar.
 */
export async function eraseForDataRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
): Promise<{ request: DataRequestItem; attachmentKeys: string[] }> {
  const request = await lockPendingDataRequest(tx, orgId, patientId, requestId)
  if (request.kind !== "borrar") throw validation("Este pedido no es de borrar")
  if (!request.verifiedAt)
    throw new ServiceError("DATA_REQUEST_NOT_VERIFIED", 409, "Primero comprueba que es ella o su representante")
  const person = await personOf(tx, orgId, patientId)
  if (person.lockedAt) throw new ServiceError("RECORD_LOCKED", 409, "Su historia ya está bloqueada")
  const preview = await erasurePreview(tx, orgId, patientId)
  for (const item of preview.futureAppointments)
    await setAppointmentStatus(tx, orgId, actorUserId, item.id, "cancelada", {
      cancelReason: "paciente",
      cancelNote: "Pidió borrar sus datos",
      notice: false,
    })
  await setMessageChoice(tx, orgId, actorUserId, person.personId, {
    choice: "ninguno",
    receive: false,
    source: "revocacion_datos",
  })
  const erased = await tx.execute<{ keys: string[] | null }>(
    sql`select public.erase_person_data(${patientId}::uuid, ${actorUserId}) as keys`,
  )
  const now = new Date()
  const resolution = erasureResolution(preview)
  await tx
    .update(patientDataRequest)
    .set({ status: "respondida", resolution, resolvedAt: now, resolvedBy: actorUserId, updatedAt: now })
    .where(eq(patientDataRequest.id, request.id))
  await tx.insert(auditEvent).values([
    {
      organizationId: orgId,
      actorUserId,
      action: "data_request.respond",
      entity: "patient_data_request",
      entityId: request.id,
      metadata: { patientId, kind: "borrar" },
    },
    {
      organizationId: orgId,
      actorUserId,
      action: "patient.record_locked",
      entity: "patient",
      entityId: patientId,
      metadata: {
        requestId: request.id,
        conversations: preview.conversations,
        messages: preview.messages,
        opportunities: preview.opportunities,
        tasks: preview.tasks,
        notes: preview.notes,
        cancelledAppointments: preview.futureAppointments.length,
      },
    },
  ])
  const [updated] = await listDataRequests(tx, orgId, patientId, { id: request.id })
  return { request: updated!, attachmentKeys: erased[0]?.keys ?? [] }
}

export interface RecordLockState {
  locked: boolean
  /** Hasta cuándo la abrió para leer quien mira, si la abrió. */
  openUntil: string | null
}

/** ¿Está bloqueada la historia y la abrió quien mira? */
export async function recordLockState(
  tx: Db,
  orgId: string,
  userId: string,
  patientId: string,
): Promise<RecordLockState> {
  const [row] = await tx
    .select({ lockedAt: contact.recordLockedAt })
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  if (!row?.lockedAt) return { locked: false, openUntil: null }
  const [opening] = await tx
    .select({ expiresAt: patientRecordOpening.expiresAt })
    .from(patientRecordOpening)
    .where(
      and(
        eq(patientRecordOpening.organizationId, orgId),
        eq(patientRecordOpening.patientId, patientId),
        eq(patientRecordOpening.userId, userId),
        gt(patientRecordOpening.expiresAt, sql`now()`),
      ),
    )
    .orderBy(desc(patientRecordOpening.expiresAt))
    .limit(1)
  return { locked: true, openUntil: opening?.expiresAt.toISOString() ?? null }
}

export interface LockedRecordItem {
  patientId: string
  personId: string
  patientNumber: number
  displayName: string
  docType: string | null
  docNumber: string | null
  lockedAt: string
  lockedByName: string | null
}

/** Las historias bloqueadas de la clínica, la más reciente primero. */
export async function listLockedRecords(tx: Db, orgId: string): Promise<LockedRecordItem[]> {
  const rows = await tx
    .select({
      patientId: patient.id,
      personId: patient.personId,
      patientNumber: patient.patientNumber,
      displayName: contact.displayName,
      docType: contact.docType,
      docNumber: contact.docNumber,
      lockedAt: contact.recordLockedAt,
      lockedByName: user.name,
    })
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
    .leftJoin(user, eq(user.id, contact.recordLockedBy))
    .where(and(eq(patient.organizationId, orgId), isNotNull(contact.recordLockedAt)))
    .orderBy(desc(contact.recordLockedAt))
  return rows.map((r) => ({ ...r, lockedAt: r.lockedAt!.toISOString() }))
}

export interface LockedRecordView extends LockedRecordItem {
  /** El pedido que la bloqueó: quién lo pidió y qué se borró. */
  request: { requesterName: string | null; resolution: string | null } | null
  openUntil: string | null
}

/** La pantalla de una historia bloqueada (tablero 7). */
export async function getLockedRecord(
  tx: Db,
  orgId: string,
  userId: string,
  patientId: string,
): Promise<LockedRecordView> {
  const item = (await listLockedRecords(tx, orgId)).find((r) => r.patientId === patientId)
  if (!item) throw new ServiceError("RECORD_NOT_LOCKED", 409, "Esta historia no está bloqueada")
  const [request] = await tx
    .select({ requesterName: contact.displayName, resolution: patientDataRequest.resolution })
    .from(patientDataRequest)
    .leftJoin(
      contact,
      and(eq(contact.organizationId, patientDataRequest.organizationId), eq(contact.id, patientDataRequest.requesterContactId)),
    )
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.patientId, patientId),
        eq(patientDataRequest.kind, "borrar"),
        eq(patientDataRequest.status, "respondida"),
      ),
    )
    .orderBy(desc(patientDataRequest.resolvedAt))
    .limit(1)
  const state = await recordLockState(tx, orgId, userId, patientId)
  return { ...item, request: request ?? null, openUntil: state.openUntil }
}

/**
 * Abre una historia bloqueada con motivo. «Vuelve a atenderse» la desbloquea
 * entera: vuelve a ser paciente con su historia de antes (lo borrado no
 * vuelve). Los demás motivos la abren a quien lo pide durante una hora, solo
 * para leer. Todo queda en «Consultas a la historia» y en la auditoría.
 */
export async function openLockedRecord(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: { reason: string; note?: string | null },
): Promise<RecordLockState> {
  if (!(RECORD_OPENING_REASONS as readonly string[]).includes(input.reason)) throw invalidField("reason", "Elige el motivo")
  const reason = input.reason as RecordOpeningReason
  const note = (input.note ?? "").trim() || null
  if (note && note.length > 500) throw invalidField("note", "El motivo admite hasta 500 caracteres")
  if (reason === "otro" && !note) throw invalidField("note", "Escribe el motivo")
  const person = await personOf(tx, orgId, patientId)
  if (!person.lockedAt) throw new ServiceError("RECORD_NOT_LOCKED", 409, "Esta historia no está bloqueada")
  if (reason === "vuelve") {
    await tx
      .update(contact)
      .set({ recordLockedAt: null, recordLockedBy: null, updatedAt: new Date() })
      .where(and(eq(contact.organizationId, orgId), eq(contact.id, person.personId)))
    await setPersonArchived(tx, orgId, { userId: actorUserId }, person.personId, false)
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "patient.record_unlocked",
      entity: "patient",
      entityId: patientId,
      metadata: { reason },
    })
    return { locked: false, openUntil: null }
  }
  const [opening] = await tx
    .insert(patientRecordOpening)
    .values({
      organizationId: orgId,
      patientId,
      userId: actorUserId,
      reason,
      note,
      expiresAt: sql`now() + make_interval(mins => ${RECORD_OPENING_MINUTES})`,
    })
    .returning({ expiresAt: patientRecordOpening.expiresAt })
  await recordClinicalAccess(tx, orgId, actorUserId, patientId, "apertura")
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action: "patient.record_opened",
    entity: "patient",
    entityId: patientId,
    metadata: { reason, note },
  })
  return { locked: true, openUntil: opening!.expiresAt.toISOString() }
}

/** Lo mismo, desde la persona: su ficha, si la tiene y está bloqueada. */
export async function personRecordLock(
  tx: Db,
  orgId: string,
  userId: string,
  personId: string,
): Promise<(RecordLockState & { patientId: string }) | null> {
  const [row] = await tx
    .select({ patientId: patient.id })
    .from(patient)
    .innerJoin(contact, joinPatientPerson())
    .where(and(eq(patient.organizationId, orgId), eq(patient.personId, personId), isNotNull(contact.recordLockedAt)))
    .limit(1)
  if (!row) return null
  return { ...(await recordLockState(tx, orgId, userId, row.patientId)), patientId: row.patientId }
}
