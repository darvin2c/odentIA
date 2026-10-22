/**
 * Pedidos de la persona sobre sus datos (issue 50, ADR 0080): una copia, una
 * corrección o no recibir mensajes.
 *
 * - Lo pide la propia persona si es mayor de edad o su representante legal
 *   vigente: la regla única de a quién se le manda algo (`listDecisionRecipients`).
 * - Un solo plazo para todo pedido y todo país: `DATA_REQUEST_DAYS` días
 *   corridos desde el día siguiente. Es más corto que lo que piden las leyes
 *   de la región, así que respondiendo a tiempo se cumple en todas, sin
 *   plazos ni feriados por país.
 * - Pendiente → respondida o denegada (con motivo). Antes de responder se
 *   comprueba que es ella o su representante; nunca por el número de teléfono.
 * - «No recibir mensajes» se cumple al registrarlo: se apagan los mensajes que
 *   la persona puede apagar; los avisos de sus citas y papeles siguen.
 */
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { patient, patientDataRequest } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm"
import { setMessageChoice } from "./automation.js"
import { SWITCHABLE_PURPOSES } from "./automation-messages.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { clinicToday } from "./inventory-stock.js"
import { joinPatientPerson, patientPerson } from "./patient-identity.js"
import { requirePatient } from "./patients.js"
import { listDecisionRecipients } from "./responsibilities.js"

export const DATA_REQUEST_KINDS = ["copia", "corregir", "mensajes", "borrar"] as const
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number]

export const DATA_REQUEST_CHANNELS = ["clinica", "whatsapp", "correo", "portal"] as const
export type DataRequestChannel = (typeof DATA_REQUEST_CHANNELS)[number]

/** Cómo se comprobó que es ella o su representante legal. */
export const DATA_REQUEST_VERIFICATIONS = ["documento", "portal", "representante"] as const
export type DataRequestVerification = (typeof DATA_REQUEST_VERIFICATIONS)[number]

export type DataRequestStatus = "pendiente" | "respondida" | "denegada"

/** Días corridos para responder, desde el día siguiente al pedido. */
export const DATA_REQUEST_DAYS = 10

/** Desde cuántos días antes del plazo el pedido sale en «Te espera». */
export const DATA_REQUEST_WARN_DAYS = 3

/** Lo que dice la respuesta de «No recibir mensajes», que se cumple al registrarlo. */
export const MESSAGES_OFF_RESOLUTION =
  "Se apagaron sus recordatorios, controles y novedades. Los avisos de sus citas y papeles siguen."

export interface DataRequestItem {
  id: string
  patientId: string
  kind: DataRequestKind
  requesterContactId: string
  requesterName: string
  /** La propia persona o su representante legal, hoy. */
  requesterRelation: "paciente" | "representante_legal" | null
  channel: DataRequestChannel
  requestedOn: string
  dueOn: string
  said: string | null
  status: DataRequestStatus
  verifiedHow: DataRequestVerification | null
  verifiedAt: string | null
  verifiedByName: string | null
  resolution: string | null
  resolvedAt: string | null
  resolvedByName: string | null
  createdAt: string
}

/** Un día ISO (AAAA-MM-DD) más `days` días corridos. */
export function addCalendarDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

/** El día límite de un pedido hecho ese día: `DATA_REQUEST_DAYS` días corridos desde el siguiente. */
export function dataRequestDueOn(requestedOn: string): string {
  return addCalendarDays(requestedOn, DATA_REQUEST_DAYS)
}

function assertDay(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw validation(`${label}: fecha inválida`)
  return value
}

function cleanText(value: string | null | undefined, label: string, max: number): string | null {
  const text = (value ?? "").trim()
  if (!text) return null
  if (text.length > max) throw validation(`${label} admite hasta ${max} caracteres`)
  return text
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    actorUserId,
    action,
    entity: "patient_data_request",
    entityId,
    metadata,
  })
}

const CONSENT_SOURCE_OF: Record<DataRequestChannel, string> = {
  clinica: "presencial",
  whatsapp: "conversacion",
  correo: "conversacion",
  portal: "portal",
}

export interface CreateDataRequestInput {
  kind: string
  requesterContactId: string
  channel: string
  /** Día en que lo pidió; por defecto, hoy en la clínica. */
  requestedOn?: string | null
  said?: string | null
}

export async function createDataRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  input: CreateDataRequestInput,
): Promise<DataRequestItem> {
  await requirePatient(tx, orgId, patientId)
  if (!(DATA_REQUEST_KINDS as readonly string[]).includes(input.kind)) throw validation("Elige qué pide")
  if (!(DATA_REQUEST_CHANNELS as readonly string[]).includes(input.channel)) throw validation("Elige por dónde llegó")
  const kind = input.kind as DataRequestKind
  const channel = input.channel as DataRequestChannel
  const recipients = await listDecisionRecipients(tx, orgId, patientId)
  const requester = recipients.find((r) => r.contactId === input.requesterContactId)
  if (!requester)
    throw new ServiceError(
      "DATA_REQUEST_NOT_AUTHORIZED",
      403,
      "Solo lo pide la propia persona, si es mayor de edad, o su representante legal vigente",
    )
  const today = await clinicToday(tx, orgId)
  const requestedOn = input.requestedOn ? assertDay(input.requestedOn, "Cuándo lo pidió") : today
  if (requestedOn > today) throw validation("Cuándo lo pidió: no puede ser una fecha futura")
  const said = cleanText(input.said, "Lo que dijo", 1000)
  // «No recibir mensajes» se cumple al registrarlo: apaga lo que la persona
  // puede apagar en el contacto del paciente (lo que recibe por él).
  const messagesOff = kind === "mensajes"
  const now = new Date()
  const [row] = await tx
    .insert(patientDataRequest)
    .values({
      organizationId: orgId,
      patientId,
      kind,
      requesterContactId: requester.contactId,
      channel,
      requestedOn,
      dueOn: dataRequestDueOn(requestedOn),
      said,
      status: messagesOff ? "respondida" : "pendiente",
      resolution: messagesOff ? MESSAGES_OFF_RESOLUTION : null,
      resolvedAt: messagesOff ? now : null,
      resolvedBy: messagesOff ? actorUserId : null,
      createdBy: actorUserId,
    })
    .returning()
  if (!row) throw notFound("Pedido")
  if (messagesOff) {
    for (const purpose of SWITCHABLE_PURPOSES)
      await setMessageChoice(tx, orgId, actorUserId, requester.contactId, {
        choice: purpose,
        receive: false,
        source: CONSENT_SOURCE_OF[channel],
      })
  }
  await audit(tx, orgId, actorUserId, "data_request.create", row.id, { patientId, kind, channel })
  if (messagesOff) await audit(tx, orgId, actorUserId, "data_request.respond", row.id, { patientId, kind })
  return (await listDataRequests(tx, orgId, patientId, { id: row.id }))[0]!
}

/** El pedido pendiente, bloqueado para cambiarlo; «Este pedido ya se respondió» si no lo está. */
export async function lockPendingDataRequest(tx: Db, orgId: string, patientId: string, requestId: string) {
  const [row] = await tx
    .select()
    .from(patientDataRequest)
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.patientId, patientId),
        eq(patientDataRequest.id, requestId),
      ),
    )
    .for("update")
    .limit(1)
  if (!row) throw notFound("Pedido")
  if (row.status !== "pendiente")
    throw new ServiceError("DATA_REQUEST_CLOSED", 409, "Este pedido ya se respondió")
  return row
}

/** Comprobaste que es ella o su representante legal. */
export async function verifyDataRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
  input: { how: string },
): Promise<DataRequestItem> {
  if (!(DATA_REQUEST_VERIFICATIONS as readonly string[]).includes(input.how))
    throw validation("Elige cómo comprobaste que es ella")
  const row = await lockPendingDataRequest(tx, orgId, patientId, requestId)
  await tx
    .update(patientDataRequest)
    .set({ verifiedHow: input.how, verifiedAt: new Date(), verifiedBy: actorUserId, updatedAt: new Date() })
    .where(eq(patientDataRequest.id, row.id))
  await audit(tx, orgId, actorUserId, "data_request.verify", row.id, { patientId, how: input.how })
  return (await listDataRequests(tx, orgId, patientId, { id: row.id }))[0]!
}

/**
 * Responde un pedido: lo que se entregó o hizo. Exige haber comprobado que
 * es ella o su representante.
 */
export async function respondDataRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
  input: { resolution: string },
): Promise<DataRequestItem> {
  const resolution = cleanText(input.resolution, "La respuesta", 1000)
  if (!resolution) throw validation("Escribe qué se entregó o qué se hizo")
  const row = await lockPendingDataRequest(tx, orgId, patientId, requestId)
  if (!row.verifiedAt)
    throw new ServiceError("DATA_REQUEST_NOT_VERIFIED", 409, "Primero comprueba que es ella o su representante")
  if (row.kind === "borrar")
    throw new ServiceError("DATA_REQUEST_ERASE", 409, "Este pedido se responde al borrar sus datos")
  const now = new Date()
  await tx
    .update(patientDataRequest)
    .set({ status: "respondida", resolution, resolvedAt: now, resolvedBy: actorUserId, updatedAt: now })
    .where(eq(patientDataRequest.id, row.id))
  await audit(tx, orgId, actorUserId, "data_request.respond", row.id, { patientId, kind: row.kind })
  return (await listDataRequests(tx, orgId, patientId, { id: row.id }))[0]!
}

/** Deniega un pedido con su motivo (por ejemplo, no se pudo comprobar quién lo pide). */
export async function denyDataRequest(
  tx: Db,
  orgId: string,
  actorUserId: string,
  patientId: string,
  requestId: string,
  input: { reason: string },
): Promise<DataRequestItem> {
  const reason = cleanText(input.reason, "El motivo", 1000)
  if (!reason) throw validation("Escribe por qué se deniega")
  const row = await lockPendingDataRequest(tx, orgId, patientId, requestId)
  const now = new Date()
  await tx
    .update(patientDataRequest)
    .set({ status: "denegada", resolution: reason, resolvedAt: now, resolvedBy: actorUserId, updatedAt: now })
    .where(eq(patientDataRequest.id, row.id))
  await audit(tx, orgId, actorUserId, "data_request.deny", row.id, { patientId, kind: row.kind })
  return (await listDataRequests(tx, orgId, patientId, { id: row.id }))[0]!
}

/** Los pedidos de un paciente: pendientes primero (por plazo), luego los demás del más nuevo. */
export async function listDataRequests(
  tx: Db,
  orgId: string,
  patientId: string,
  filter: { id?: string } = {},
): Promise<DataRequestItem[]> {
  await requirePatient(tx, orgId, patientId)
  const rows = await tx
    .select()
    .from(patientDataRequest)
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.patientId, patientId),
        filter.id ? eq(patientDataRequest.id, filter.id) : undefined,
      ),
    )
    .orderBy(asc(patientDataRequest.status), asc(patientDataRequest.dueOn), desc(patientDataRequest.createdAt))
  if (!rows.length) return []
  const recipients = await listDecisionRecipients(tx, orgId, patientId)
  const names = await namesOf(tx, orgId, rows)
  const userIds = [...new Set(rows.flatMap((r) => [r.verifiedBy, r.resolvedBy]).filter(Boolean) as string[])]
  const users = new Map(
    userIds.length
      ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))).map((u) => [u.id, u.name])
      : [],
  )
  const items = rows.map(
    (row): DataRequestItem => ({
      id: row.id,
      patientId: row.patientId,
      kind: row.kind as DataRequestKind,
      requesterContactId: row.requesterContactId,
      requesterName: names.get(row.requesterContactId) ?? "",
      requesterRelation: recipients.find((r) => r.contactId === row.requesterContactId)?.relation ?? null,
      channel: row.channel as DataRequestChannel,
      requestedOn: row.requestedOn,
      dueOn: row.dueOn,
      said: row.said,
      status: row.status as DataRequestStatus,
      verifiedHow: (row.verifiedHow as DataRequestVerification | null) ?? null,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      verifiedByName: row.verifiedBy ? (users.get(row.verifiedBy) ?? null) : null,
      resolution: row.resolution,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolvedByName: row.resolvedBy ? (users.get(row.resolvedBy) ?? null) : null,
      createdAt: row.createdAt.toISOString(),
    }),
  )
  // Pendientes primero (el plazo más cercano arriba), después los resueltos del más nuevo.
  return [
    ...items.filter((i) => i.status === "pendiente"),
    ...items.filter((i) => i.status !== "pendiente").sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? "")),
  ]
}

async function namesOf(tx: Db, orgId: string, rows: Array<{ requesterContactId: string }>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => r.requesterContactId))]
  const found = await tx
    .select({ id: contact.id, name: contact.displayName })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), inArray(contact.id, ids)))
  return new Map(found.map((c) => [c.id, c.name]))
}

/** Pedidos pendientes que vencen dentro de `DATA_REQUEST_WARN_DAYS` días o ya vencieron, para «Te espera». */
export interface PendingDataRequest {
  id: string
  patientId: string
  patientName: string
  kind: DataRequestKind
  dueOn: string
  verified: boolean
}

export async function dueDataRequests(tx: Db, orgId: string, today: string): Promise<PendingDataRequest[]> {
  const limit = addCalendarDays(today, DATA_REQUEST_WARN_DAYS)
  const rows = await tx
    .select({
      id: patientDataRequest.id,
      patientId: patientDataRequest.patientId,
      kind: patientDataRequest.kind,
      dueOn: patientDataRequest.dueOn,
      verifiedAt: patientDataRequest.verifiedAt,
      patientName: patientPerson.displayName,
    })
    .from(patientDataRequest)
    .innerJoin(patient, and(eq(patient.id, patientDataRequest.patientId), eq(patient.organizationId, orgId)))
    .innerJoin(patientPerson, joinPatientPerson(patientPerson))
    .where(
      and(
        eq(patientDataRequest.organizationId, orgId),
        eq(patientDataRequest.status, "pendiente"),
        lte(patientDataRequest.dueOn, limit),
      ),
    )
    .orderBy(asc(patientDataRequest.dueOn))
  return rows.map((r) => ({
    id: r.id,
    patientId: r.patientId,
    patientName: r.patientName,
    kind: r.kind as DataRequestKind,
    dueOn: r.dueOn,
    verified: r.verifiedAt !== null,
  }))
}

/** Lo que pinta la sección: los pedidos, quién puede pedir hoy y el día de la clínica. */
export interface DataRequestsView {
  requests: DataRequestItem[]
  /** La propia persona si es mayor de edad y su representante legal vigente. */
  requesters: Array<{ contactId: string; displayName: string; relation: "paciente" | "representante_legal" }>
  today: string
}

export async function getDataRequestsView(tx: Db, orgId: string, patientId: string): Promise<DataRequestsView> {
  const requests = await listDataRequests(tx, orgId, patientId)
  const requesters = (await listDecisionRecipients(tx, orgId, patientId)).map(({ contactId, displayName, relation }) => ({
    contactId,
    displayName,
    relation,
  }))
  return { requests, requesters, today: await clinicToday(tx, orgId) }
}
