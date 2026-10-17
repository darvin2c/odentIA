import { createHash, randomUUID } from "node:crypto"
import { normalizePhone, type RegistrationAnswers, type RegistrationConfig } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { organization, user } from "@odentia/db/schema/auth"
import { patient, serviceCatalog, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm"
import { addAgentCaseNote } from "./agent-case.js"
import { createProposal } from "./agent-operations.js"
import { createAppointment } from "./appointments.js"
import {
  assertOwnAppointmentChangeable,
  cancelOwnAppointment,
  confirmOwnAppointment,
  moveOwnAppointment,
  ownAppointmentChangeable,
} from "./own-appointment.js"
import { listAvailableSlots } from "./availability.js"
import { personalLinkToken } from "./personal-link-token.js"
import { branchNotFound, notFound, ServiceError, validation } from "./errors.js"
import { findOrgCountry, findOrgLocale, NEUTRAL_TIMEZONE } from "./locale.js"
import { createPatientRegistrationLink, getPatientRegistrationConfig, registerPatient } from "./patient-registration.js"
import { listPatientsByContact, patientOrganizationToday } from "./patients.js"
import { scheduledItems } from "./plan-next.js"
import { contactDecides } from "./responsibilities.js"

/**
 * «Su enlace» (fase 3, decisión 8; ADR 0037, que amplía el 0014): la página
 * personal de cada persona, `/reserva?token=…`. Muestra solo lo que tiene
 * pendiente —su cita, sus datos por completar, el presupuesto que se le
 * envió, el consentimiento por firmar y el cuestionario— y nunca lo guardado.
 *
 * - **Uno por persona y paciente.** Quien abre es la persona o quien habla por
 *   ella (su representante); lo pendiente es del paciente. Enviarlo otra vez
 *   devuelve el mismo enlace, con más vigencia: lo que llegue después (un
 *   presupuesto, un consentimiento) aparece en él. El token se deriva de la
 *   clave del servidor y del id del enlace (`tokenFor`): en la base solo se
 *   guarda su huella, y aun así se puede volver a dar el mismo.
 * - **Cada cosa deja de servir cuando ya no hace falta**: la cita al pasar su
 *   hora, los datos al enviarlos (una sola vez), el presupuesto al decidirlo o
 *   al reemplazarlo o anularlo la clínica, el consentimiento al firmarlo. El
 *   enlace entero vence cuando no le queda nada (`PERSONAL_LINK_TTL_DAYS` como
 *   tope de lo que no tiene fecha propia) y entonces la página lo dice.
 * - **Reservar** solo lo ofrece el enlace que envía el agente (`booking`), como
 *   antes: el día y la hora con los horarios reales, y a quien aún no es
 *   paciente su ficha la crea el registro de pacientes (alcance `essentials`).
 *   La cita se reserva, cambia, confirma y cancela con las operaciones de la
 *   Agenda, nunca con reglas propias; la página no muestra tarifas.
 * - Tener el enlace es tener su chat: no identifica a nadie, no abre el
 *   portal y nunca une fichas.
 */
export const PERSONAL_LINK_TTL_DAYS = 7
const SLOT_RANGE_DAYS = 7
const TOKEN = /^[0-9a-f]{64}$/

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** El token de un enlace: se recalcula con la clave del servidor, así un mismo enlace se vuelve a dar sin guardarlo. */
const tokenFor = personalLinkToken

type LinkRow = typeof appointmentBookingLink.$inferSelect

export interface IssuePersonalLinkInput {
  /** Quien lo abre: la persona o quien habla por ella. */
  contactId: string
  /** De quién es lo pendiente; vacío si aún no es paciente. */
  patientId?: string | null
  conversationId?: string | null
  /** La cita que muestra; sin ella, la próxima del paciente. */
  appointmentId?: string | null
  /** Ofrece reservar una cita nueva (el agente). */
  booking?: boolean
  serviceId?: string | null
  branchId?: string | null
  /** Quién del equipo lo envía; vacío si el agente o un aviso. */
  createdBy?: string | null
}

export interface IssuedPersonalLink {
  linkId: string
  token: string
  expiresAt: Date
  /** Ya tenía uno vivo: es el mismo enlace, con más vigencia. */
  reused: boolean
}

/**
 * Da el enlace de esta persona para este paciente: el que ya tiene vivo, con
 * su vigencia renovada, o uno nuevo. Uno solo por persona y paciente: el
 * nuevo deja sin efecto los anteriores.
 */
export async function issuePersonalLink(
  tx: Db,
  orgId: string,
  input: IssuePersonalLinkInput,
  deps: { secretsKey: Buffer },
): Promise<IssuedPersonalLink> {
  const patientId = input.patientId ?? null
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`su-enlace:${orgId}:${input.contactId}:${patientId ?? ""}`}))`,
  )
  const now = new Date()
  const expiresAt = new Date(now.getTime() + PERSONAL_LINK_TTL_DAYS * 86_400_000)
  const samePerson = and(
    eq(appointmentBookingLink.organizationId, orgId),
    eq(appointmentBookingLink.contactId, input.contactId),
    patientId ? eq(appointmentBookingLink.patientId, patientId) : isNull(appointmentBookingLink.patientId),
    isNull(appointmentBookingLink.revokedAt),
  )
  const [live] = await tx
    .select()
    .from(appointmentBookingLink)
    .where(and(samePerson, gt(appointmentBookingLink.expiresAt, now)))
    .orderBy(desc(appointmentBookingLink.createdAt))
    .limit(1)
  if (live && hashToken(tokenFor(deps.secretsKey, live.id)) === live.tokenHash) {
    const patch: Partial<typeof appointmentBookingLink.$inferInsert> = {
      expiresAt: live.expiresAt > expiresAt ? live.expiresAt : expiresAt,
    }
    if (input.appointmentId) patch.appointmentId = input.appointmentId
    if (input.conversationId && !live.conversationId) patch.conversationId = input.conversationId
    if (input.createdBy) patch.createdBy = input.createdBy
    if (input.booking) {
      // Vuelve a ofrecer reservar: la cita que ya reservó sigue apareciendo como su cita.
      patch.booking = true
      patch.usedAt = null
      patch.serviceId = input.serviceId ?? null
      patch.branchId = input.branchId ?? null
    }
    await tx
      .update(appointmentBookingLink)
      .set(patch)
      .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, live.id)))
    return { linkId: live.id, token: tokenFor(deps.secretsKey, live.id), expiresAt: patch.expiresAt ?? live.expiresAt, reused: true }
  }
  // Uno solo por persona y paciente: el nuevo deja sin efecto los anteriores.
  await tx.update(appointmentBookingLink).set({ revokedAt: now }).where(samePerson)
  const id = randomUUID()
  const token = tokenFor(deps.secretsKey, id)
  await tx.insert(appointmentBookingLink).values({
    id,
    organizationId: orgId,
    conversationId: input.conversationId ?? null,
    contactId: input.contactId,
    patientId,
    serviceId: input.serviceId ?? null,
    branchId: input.branchId ?? null,
    appointmentId: input.appointmentId ?? null,
    booking: input.booking ?? false,
    createdBy: input.createdBy ?? null,
    tokenHash: hashToken(token),
    expiresAt,
  })
  return { linkId: id, token, expiresAt, reused: false }
}

export interface CreateBookingLinkInput {
  conversationId: string
  /** Paciente para quien es la cita; obligatorio solo si la persona tiene más de uno vinculado. */
  patientId?: string
  serviceId?: string
  branchId?: string
  /** Quién del equipo lo prepara (Bandeja); vacío si lo envía el agente. */
  createdBy?: string | null
}

/**
 * «Su enlace» para la persona de una conversación, con la reserva abierta: lo
 * que envía el agente (`enviar_enlace_cita`) y lo que prepara recepción en la
 * Bandeja. A quien aún no es paciente la página le pide sus datos esenciales.
 */
export async function createBookingLink(
  tx: Db,
  orgId: string,
  input: CreateBookingLinkInput,
  deps: { secretsKey: Buffer },
): Promise<{ token: string; expiresAt: Date; patientName: string | null; needsRegistration: boolean }> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId })
    .from(conversation)
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .limit(1)
  if (!conv) throw notFound("Conversación")
  const linked = (await listPatientsByContact(tx, orgId, conv.contactId)).filter((item) => item.isActive)
  // Quien recién se contacta aún no tiene ficha: la crea él mismo en la página,
  // con el registro de pacientes de la clínica. Sin ese registro activo no hay
  // con qué pedirle sus datos ni su consentimiento, y el enlace no se emite.
  if (linked.length === 0 && !(await getPatientRegistrationConfig(tx, orgId)).enabled) {
    throw new ServiceError("BOOKING_NEEDS_PATIENT", 409, "La persona aún no es paciente y la clínica no tiene activo el registro de pacientes en línea")
  }
  const chosen = input.patientId ? linked.find((item) => item.id === input.patientId) : linked.length === 1 ? linked[0] : undefined
  if (!chosen && linked.length > 0) {
    throw input.patientId
      ? validation("Ese paciente no está vinculado a la persona de la conversación")
      : new ServiceError("BOOKING_PATIENT_AMBIGUOUS", 409, "La persona tiene varios pacientes vinculados: indica para quién es la cita")
  }
  if (input.serviceId) {
    const [service] = await tx
      .select({ id: serviceCatalog.id })
      .from(serviceCatalog)
      .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, input.serviceId), eq(serviceCatalog.isActive, true)))
      .limit(1)
    if (!service) throw notFound("Servicio")
  }
  if (input.branchId) {
    const [site] = await tx
      .select({ id: branch.id })
      .from(branch)
      .where(and(eq(branch.organizationId, orgId), eq(branch.id, input.branchId), eq(branch.isActive, true)))
      .limit(1)
    if (!site) throw branchNotFound()
  }
  const issued = await issuePersonalLink(
    tx,
    orgId,
    {
      contactId: conv.contactId,
      patientId: chosen?.id ?? null,
      conversationId: input.conversationId,
      booking: true,
      serviceId: input.serviceId ?? null,
      branchId: input.branchId ?? null,
      createdBy: input.createdBy ?? null,
    },
    deps,
  )
  return { token: issued.token, expiresAt: issued.expiresAt, patientName: chosen?.displayName ?? null, needsRegistration: !chosen }
}

/** El enlace por su huella. Un enlace desconocido no existe: no se distingue de uno mal escrito. */
async function findLink(tx: Db, orgId: string, token: string, lock = false): Promise<LinkRow> {
  if (!TOKEN.test(token)) throw notFound("Enlace")
  const query = tx
    .select()
    .from(appointmentBookingLink)
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.tokenHash, hashToken(token))))
    .limit(1)
  const [row] = lock ? await query.for("update") : await query
  if (!row) throw notFound("Enlace")
  return row
}

/**
 * De quién es lo pendiente. Si nació sin paciente, lo es quien la persona
 * registró desde entonces: su único paciente vinculado. Con ninguno aún falta
 * el registro; con varios no se elige por ella.
 */
async function patientOf(tx: Db, orgId: string, link: LinkRow): Promise<string | null> {
  if (link.patientId) return link.patientId
  const linked = (await listPatientsByContact(tx, orgId, link.contactId)).filter((item) => item.isActive)
  if (linked.length !== 1 || !linked[0]) return null
  await tx
    .update(appointmentBookingLink)
    .set({ patientId: linked[0].id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.id)))
  return linked[0].id
}

interface ShownAppointment {
  id: string
  version: number
  branchId: string
  status: string
  startsAt: Date
}

/** Una cita se puede cambiar, cancelar o confirmar mientras siga en pie y no haya empezado (`own-appointment.ts`). */
const isChangeable = (row: { status: string; startsAt: Date }): boolean => ownAppointmentChangeable(row)

/**
 * La cita que muestra el enlace: la suya (la que reservó con él o con la que
 * se envió) mientras no pase su hora, o la próxima en pie del paciente
 * mientras el enlace esté vigente. Al pasar la hora deja de servir.
 */
async function shownAppointment(tx: Db, orgId: string, link: LinkRow, patientId: string | null): Promise<ShownAppointment | null> {
  const now = new Date()
  const columns = {
    id: appointment.id,
    version: appointment.version,
    branchId: appointment.branchId,
    status: appointment.status,
    startsAt: appointment.startsAt,
  }
  if (link.appointmentId) {
    const [own] = await tx
      .select(columns)
      .from(appointment)
      .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, link.appointmentId)))
      .limit(1)
    // Cancelada sigue a la vista hasta su hora, para que vea que quedó cancelada.
    if (own && own.startsAt > now && (isChangeable(own) || own.status === "cancelada")) return own
  }
  if (!patientId || link.expiresAt <= now) return null
  const [next] = await tx
    .select(columns)
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.patientId, patientId),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, now),
      ),
    )
    .orderBy(asc(appointment.startsAt))
    .limit(1)
  return next ?? null
}

export interface ResolvedPersonalLink {
  row: LinkRow
  patientId: string | null
  /** El enlace no está revocado. */
  live: boolean
  appointment: ShownAppointment | null
  /**
   * Hasta cuándo sirven los datos, el consentimiento y el cuestionario: la
   * vigencia del enlace o la hora de su cita, lo que llegue después.
   */
  deadline: Date
  /** Aún ofrece reservar una cita nueva. */
  canBook: boolean
  /**
   * Quien lo abre decide por el paciente: la propia persona mayor de edad o su
   * representante legal vigente (`requireDecisionContact`). Solo entonces ve y
   * responde el presupuesto, los consentimientos, «Tus datos», el cuestionario
   * y agenda lo aceptado. Otro vínculo (un familiar, un autorizado) ve solo su cita.
   */
  decides: boolean
  /** Pasó la vigencia de todo lo que no es su propia cita. */
  expired: boolean
}

/** El enlace con lo que hoy le toca: la cita que muestra y hasta cuándo sirve lo demás. */
export async function resolvePersonalLink(tx: Db, orgId: string, token: string, lock = false): Promise<ResolvedPersonalLink> {
  const row = await findLink(tx, orgId, token, lock)
  const live = row.revokedAt === null
  const patientId = live ? await patientOf(tx, orgId, row) : row.patientId
  const shown = live ? await shownAppointment(tx, orgId, row, patientId) : null
  const own = shown && shown.id === row.appointmentId ? shown.startsAt : null
  const deadline = own && own > row.expiresAt ? own : row.expiresAt
  const canBook = live && row.booking && row.usedAt === null && row.expiresAt.getTime() > Date.now()
  const decides = live && patientId !== null && (await contactDecides(tx, orgId, patientId, row.contactId))
  const expired = deadline.getTime() <= Date.now()
  return { row, patientId, live, appointment: shown, deadline, canBook, decides, expired }
}

/**
 * El enlace vigente, o que diga que ya no sirve: un enlace revocado no hace
 * nada y, pasada su vigencia, solo queda su propia cita (`ownAppointment`:
 * cambiarla, cancelarla o confirmarla mientras no empiece).
 */
export async function requireLiveLink(
  tx: Db,
  orgId: string,
  token: string,
  lock = false,
  options: { ownAppointment?: boolean } = {},
): Promise<ResolvedPersonalLink> {
  const link = await resolvePersonalLink(tx, orgId, token, lock)
  if (!link.live) throw linkExpired()
  if (link.expired && !options.ownAppointment) throw linkExpired()
  return link
}

/** Lo del paciente que no es su cita solo lo ve y lo responde quien decide por él. */
export function requireLinkDecider(link: ResolvedPersonalLink): string {
  if (!link.patientId || !link.decides) {
    throw new ServiceError("PORTAL_FORBIDDEN", 404, "Este enlace no puede responder por esta persona")
  }
  return link.patientId
}

/**
 * Deja sin efecto «Su enlace» de un paciente («Quitar enlace»): todos los que
 * tenga vivos, de quien sea. Lo que ya hizo con él se conserva.
 */
export async function revokePersonalLinks(tx: Db, orgId: string, actorUserId: string, patientId: string): Promise<{ revoked: number }> {
  const rows = await tx
    .update(appointmentBookingLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(appointmentBookingLink.organizationId, orgId),
        eq(appointmentBookingLink.patientId, patientId),
        isNull(appointmentBookingLink.revokedAt),
      ),
    )
    .returning({ id: appointmentBookingLink.id })
  if (rows.length > 0) {
    await tx.insert(auditEvent).values({
      organizationId: orgId,
      actorUserId,
      action: "personal_link.revoked",
      entity: "patient",
      entityId: patientId,
      metadata: { links: rows.length },
    })
  }
  return { revoked: rows.length }
}

export function linkExpired(): ServiceError {
  return new ServiceError("BOOKING_LINK_EXPIRED", 409, "Este enlace ya no sirve. Responde el mensaje y te enviamos uno nuevo.")
}

export interface BookingLinkAppointment {
  startsAt: string
  endsAt: string
  timeZone: string
  /** Minutos de la cita. */
  durationMin: number
  /** La sede de la cita: para cambiar de horario solo se ofrecen los de esa sede. */
  branchId: string
  cancelled: boolean
  /** La persona ya la confirmó (o la confirmó la clínica). */
  confirmed: boolean
  /** Aún se puede cambiar de horario o cancelar desde el enlace: no empezó y sigue en pie. */
  canChange: boolean
  /** Aún espera su confirmación. */
  canConfirm: boolean
  branchName: string
  branchAddress: string | null
  dentistName: string
  serviceName: string | null
}

export async function appointmentView(tx: Db, orgId: string, appointmentId: string): Promise<BookingLinkAppointment | null> {
  const [row] = await tx
    .select({
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      branchId: appointment.branchId,
      serviceName: appointment.serviceName,
      branchName: branch.name,
      branchAddress: branch.addressLine1,
      branchTimeZone: branch.timezone,
      dentistName: user.name,
    })
    .from(appointment)
    .innerJoin(branch, eq(branch.id, appointment.branchId))
    .innerJoin(user, eq(user.id, appointment.dentistUserId))
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  if (!row) return null
  const changeable = isChangeable(row)
  return {
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    // La sede hereda la zona de la clínica; nunca la de un país fijo.
    timeZone: row.branchTimeZone ?? (await findOrgLocale(tx, orgId)).timezone,
    durationMin: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000),
    branchId: row.branchId,
    cancelled: row.status === "cancelada",
    confirmed: row.status === "confirmada",
    canChange: changeable,
    canConfirm: changeable && row.status === "programada",
    branchName: row.branchName,
    branchAddress: row.branchAddress,
    dentistName: row.dentistName,
    serviceName: row.serviceName,
  }
}

export interface BookingLinkBranch {
  id: string
  name: string
  address: string | null
  timeZone: string
  defaultMinutes: number
}

/** Lo que necesita la página para reservar: el servicio del que se habló y las sedes. */
export async function bookingContext(
  tx: Db,
  orgId: string,
  link: LinkRow,
): Promise<{ service: { name: string; durationMin: number | null } | null; branches: BookingLinkBranch[]; branchId: string | null }> {
  const region = await findOrgLocale(tx, orgId)
  const service = link.serviceId
    ? (
        await tx
          .select({ name: serviceCatalog.name, durationMin: serviceCatalog.durationMin })
          .from(serviceCatalog)
          .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, link.serviceId)))
          .limit(1)
      )[0] ?? null
    : null
  const sites = await tx
    .select({ id: branch.id, name: branch.name, address: branch.addressLine1, timezone: branch.timezone, minutes: branch.appointmentDefaultMinutes })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.name), asc(branch.id))
  return {
    service,
    branches: sites
      .filter((site) => !link.branchId || site.id === link.branchId)
      .map((site) => ({ id: site.id, name: site.name, address: site.address, timeZone: site.timezone ?? region.timezone, defaultMinutes: site.minutes })),
    branchId: link.branchId,
  }
}

/** Nombre de pila de quien abre el enlace: «Hola, Pedro». */
export async function linkContactFirstName(tx: Db, orgId: string, contactId: string): Promise<string | null> {
  const [row] = await tx
    .select({ givenNames: contact.givenNames, displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), eq(contact.id, contactId)))
    .limit(1)
  return (row?.givenNames ?? row?.displayName ?? "").trim().split(/\s+/)[0] || null
}

/** Nombre de pila del paciente, para decir de quién es lo pendiente. */
export async function patientFirstNameOf(tx: Db, orgId: string, patientId: string): Promise<string | null> {
  const [row] = await tx
    .select({ givenNames: patient.givenNames, displayName: patient.displayName })
    .from(patient)
    .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
    .limit(1)
  return (row?.givenNames ?? row?.displayName ?? "").trim().split(/\s+/)[0] || null
}

export async function clinicNameOf(tx: Db, orgId: string): Promise<string> {
  const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1)
  return org?.name ?? ""
}

export interface BookingLinkSlot {
  startsAt: string
  endsAt: string
  dentistUserId: string
  dentistName: string
  chairId: string | null
}

/** Horarios libres de una sede, día por día: los mismos huecos reales que ve recepción, sin lo que ya pasó. */
export async function listWeekSlots(
  tx: Db,
  orgId: string,
  input: { branchId: string; from: string; to: string; serviceId?: string | null; durationMin?: number | null },
): Promise<{ slots: BookingLinkSlot[]; timeZone: string; truncated: boolean }> {
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw validation("Rango de fechas inválido")
  if (to.getTime() - from.getTime() > SLOT_RANGE_DAYS * 86_400_000) throw validation(`El rango máximo es de ${SLOT_RANGE_DAYS} días`)
  // El paso de las horas lo decide la Agenda (`bookingStepMin`): el mismo que ofrece el agente.
  const notBefore = new Date().toISOString()
  // Día por día: la Agenda recorta cada consulta a un tope de huecos, y con
  // varios profesionales una semana entera dejaría sin horarios los últimos días.
  const slots: BookingLinkSlot[] = []
  let timeZone = NEUTRAL_TIMEZONE
  let truncated = false
  for (let start = from.getTime(); start < to.getTime(); start += 86_400_000) {
    const day = await listAvailableSlots(tx, orgId, {
      branchId: input.branchId,
      ...(input.serviceId ? { serviceId: input.serviceId } : {}),
      ...(input.durationMin ? { durationMin: input.durationMin } : {}),
      from: new Date(start).toISOString(),
      to: new Date(Math.min(start + 86_400_000, to.getTime())).toISOString(),
      notBefore,
    })
    timeZone = day.timeZone
    truncated ||= day.truncated
    for (const slot of day.slots) {
      slots.push({ startsAt: slot.startsAt, endsAt: slot.endsAt, dentistUserId: slot.dentistUserId, dentistName: slot.dentistName, chairId: slot.chairId })
    }
  }
  return { slots, timeZone, truncated }
}

/**
 * Horarios libres para el enlace. Para reservar, los de la sede elegida; para
 * cambiar su cita, solo los de su sede y con su duración.
 */
export async function listBookingLinkSlots(
  tx: Db,
  orgId: string,
  token: string,
  input: { branchId: string; from: string; to: string },
): Promise<{ slots: BookingLinkSlot[]; timeZone: string; truncated: boolean }> {
  const link = await requireLiveLink(tx, orgId, token, false, { ownAppointment: true })
  if (link.canBook) {
    if (link.row.branchId && link.row.branchId !== input.branchId) throw validation("Este enlace es para otra sede")
    return listWeekSlots(tx, orgId, { ...input, serviceId: link.row.serviceId })
  }
  const current = link.appointment
  if (current && isChangeable(current)) {
    if (current.branchId !== input.branchId) throw validation("La cita es en otra sede")
    const view = await appointmentView(tx, orgId, current.id)
    return listWeekSlots(tx, orgId, { ...input, durationMin: view?.durationMin ?? null })
  }
  // Lo aceptado de un presupuesto se reserva desde el mismo enlace («Elegir horario»):
  // solo quien decide por el paciente y mientras el enlace esté vigente.
  if (link.patientId && link.decides && !link.expired && (await hasSchedulableItems(tx, orgId, link.patientId))) {
    return listWeekSlots(tx, orgId, input)
  }
  throw linkExpired()
}

/** Tiene tratamientos aceptados por hacer: «Elegir horario» después de responder su presupuesto. */
async function hasSchedulableItems(tx: Db, orgId: string, patientId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: treatmentPlanItem.id })
    .from(treatmentPlanItem)
    .where(
      and(
        eq(treatmentPlanItem.organizationId, orgId),
        eq(treatmentPlanItem.patientId, patientId),
        eq(treatmentPlanItem.decisionStatus, "aceptado"),
        eq(treatmentPlanItem.status, "pendiente"),
      ),
    )
    .limit(1)
  return !!row
}

/**
 * El celular desde el que la persona escribe, solo si el sistema lo conoce de
 * verdad: la conversación del enlace es de WhatsApp, cuyo identificador es el
 * número. En cualquier otro canal no se supone ninguno.
 */
async function conversationPhone(tx: Db, orgId: string, link: LinkRow): Promise<string | null> {
  if (!link.conversationId) return null
  const [row] = await tx
    .select({ channel: channelConnection.channel, sender: contactIdentity.externalUserId })
    .from(conversation)
    .innerJoin(channelConnection, and(eq(channelConnection.id, conversation.channelConnectionId), eq(channelConnection.organizationId, orgId)))
    .innerJoin(
      contactIdentity,
      and(eq(contactIdentity.id, conversation.contactIdentityId), eq(contactIdentity.organizationId, orgId), eq(contactIdentity.contactId, link.contactId)),
    )
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, link.conversationId)))
    .limit(1)
  if (row?.channel !== "whatsapp") return null
  return normalizePhone(`+${row.sender.replace(/[^0-9]/g, "")}`)
}

function alreadyPatient(): ServiceError {
  return new ServiceError("BOOKING_ALREADY_PATIENT", 409, "Ya tenemos tus datos: puedes reservar")
}

export interface BookingLinkRegistrationForm {
  /** El registro de pacientes vigente de la clínica: de ahí salen la versión y el aviso de privacidad. */
  config: RegistrationConfig
  today: string
  /** El celular de la conversación, si es de WhatsApp; `null` si no se conoce. */
  phone: string | null
  /** País de la clínica (ISO 3166-1 alfa-2): de él dependen los documentos que se ofrecen (ADR 0036). */
  countryCode: string | null
}

/**
 * Lo que la página necesita para pedir los datos de quien aún no es paciente:
 * el registro vigente de la clínica (versión y aviso de privacidad) y, si se
 * conoce, el celular desde el que escribe.
 */
export async function getBookingLinkRegistrationForm(tx: Db, orgId: string, token: string): Promise<BookingLinkRegistrationForm> {
  const link = await requireLiveLink(tx, orgId, token)
  if (!link.canBook) throw linkExpired()
  if (link.patientId !== null) throw alreadyPatient()
  const config = await getPatientRegistrationConfig(tx, orgId)
  if (!config.enabled) throw new ServiceError("BOOKING_NEEDS_PATIENT", 409, "La clínica no tiene activo el registro de pacientes en línea")
  return {
    config,
    today: await patientOrganizationToday(tx, orgId),
    phone: await conversationPhone(tx, orgId, link.row),
    countryCode: await findOrgCountry(tx, orgId),
  }
}

/**
 * Registra a quien aún no es paciente con los datos esenciales para reservar.
 * La ficha la crea el registro de pacientes (`registerPatient`, alcance
 * `essentials`), con sus reglas de identidad, su aviso de privacidad, su
 * consentimiento y su auditoría; aquí solo se emite el enlace de registro para
 * la persona del enlace y se consume en la misma transacción. Lo que la
 * clínica exige y no se pidió queda anotado en el caso.
 */
export async function registerFromBookingLink(
  tx: Db,
  orgId: string,
  token: string,
  input: { submissionId: string; formVersion: number; answers: RegistrationAnswers },
): Promise<{ registered: true }> {
  const link = await requireLiveLink(tx, orgId, token, true)
  if (!link.canBook) throw linkExpired()
  if (link.patientId !== null) throw alreadyPatient()
  if (!link.row.conversationId) throw new ServiceError("BOOKING_NEEDS_PATIENT", 409, "Este enlace no sirve para registrarse")
  const registration = await createPatientRegistrationLink(tx, orgId, null, { contactId: link.row.contactId, conversationId: link.row.conversationId })
  const created = await registerPatient(
    tx,
    orgId,
    { kind: "public", token: registration.token, entryPoint: "public_link", scope: "essentials" },
    { submissionId: input.submissionId, formVersion: input.formVersion, answers: input.answers },
  )
  await tx
    .update(appointmentBookingLink)
    .set({ patientId: created.id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.row.id)))
  // Lo que la clínica exige y aún falta lo anota en el caso el propio registro
  // (`registerPatient` con `essentials`); la ficha queda con la identidad por revisar.
  return { registered: true }
}

/** «lunes, 21 de septiembre a las 3:00 p. m.», en el formato de la clínica y la zona de la sede. */
async function whenText(tx: Db, orgId: string, startsAt: string, timeZone: string): Promise<string> {
  const { locale } = await findOrgLocale(tx, orgId)
  const date = new Date(startsAt)
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date)
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(date)
  return `${day} a las ${time}`
}

/**
 * Deja constancia en el caso y avisa por la conversación del enlace, con la
 * misma política que cualquier mensaje del agente. Un enlace que no salió de
 * una conversación no tiene caso ni chat al que avisar: lo hecho queda en la
 * auditoría a nombre de la persona.
 */
async function tellConversation(
  tx: Db,
  orgId: string,
  link: LinkRow,
  input: { note: string; message: string; key: string; reason: string },
  deps: { secretsKey?: Buffer },
): Promise<void> {
  if (!link.conversationId) return
  await addAgentCaseNote(tx, orgId, link.conversationId, input.note)
  await createProposal(tx, orgId, {
    conversationId: link.conversationId,
    action: "enviar_mensaje",
    payload: { kind: "text", text: input.message },
    reason: input.reason,
    idempotencyKey: input.key,
    ...(deps.secretsKey ? { secretsKey: deps.secretsKey } : {}),
  }).catch((error: unknown) => {
    // El cambio ya está hecho: que el aviso no salga no lo deshace. Queda la nota del caso.
    if (!(error instanceof ServiceError)) throw error
  })
}

/**
 * Reserva la cita elegida. Bloquea el enlace para que dos toques no creen dos
 * citas, usa la operación de Agenda (que valida disponibilidad y solapes) y
 * deja constancia donde el agente y el equipo la ven: una nota del caso y un
 * mensaje de confirmación en la conversación, sujeto a la política de envío.
 * Con `planItemIds` reserva lo que la persona aceptó de su presupuesto
 * («Elegir horario»): la cita sabe qué tratamientos son.
 */
export async function reserveBookingLink(
  tx: Db,
  orgId: string,
  token: string,
  input: { branchId: string; startsAt: string; dentistUserId: string; chairId?: string; planItemIds?: string[] },
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await requireLiveLink(tx, orgId, token, true)
  const forTreatment = (input.planItemIds?.length ?? 0) > 0
  if (!forTreatment) {
    if (link.row.booking && link.row.usedAt) throw new ServiceError("BOOKING_LINK_USED", 409, "Con este enlace ya se reservó una cita")
    if (!link.canBook) throw linkExpired()
    if (link.row.branchId && link.row.branchId !== input.branchId) throw validation("Este enlace es para otra sede")
  }
  const patientId = link.patientId
  if (!patientId) throw new ServiceError("BOOKING_NEEDS_REGISTRATION", 409, "Antes de reservar necesitamos tus datos")
  if (forTreatment) {
    // Lo aceptado lo agenda quien decide por el paciente, y una sola vez: bajo
    // el bloqueo del enlace, lo que ya tiene cita por venir no se vuelve a reservar.
    requireLinkDecider(link)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`su-enlace-agenda:${orgId}:${patientId}`}))`)
    const already = await scheduledItems(tx, orgId, patientId, input.planItemIds ?? [])
    if (already.size > 0) {
      throw new ServiceError("BOOKING_ALREADY_SCHEDULED", 409, "Eso ya tiene su cita. Si quieres cambiarla, usa «Cambiar» en tu cita.")
    }
  }
  const created = await createAppointment(tx, orgId, `contact:${link.row.contactId}`, {
    branchId: input.branchId,
    patientId,
    dentistUserId: input.dentistUserId,
    ...(input.chairId ? { chairId: input.chairId } : {}),
    ...(!forTreatment && link.row.serviceId ? { serviceId: link.row.serviceId } : {}),
    ...(forTreatment ? { planItemIds: input.planItemIds } : {}),
    startsAt: input.startsAt,
    source: "enlace",
    ...(link.row.conversationId ? { conversationId: link.row.conversationId } : {}),
    // Quien reserva es la propia persona, no alguien del equipo: la cita queda sin autora.
    createdByUserId: null,
    // Se le confirma en la página y, si salió de una conversación, por ese chat: no se repite.
    notice: false,
  })
  await tx
    .update(appointmentBookingLink)
    .set({ appointmentId: created.id, ...(forTreatment ? {} : { usedAt: new Date() }) })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.row.id)))
  const view = await appointmentView(tx, orgId, created.id)
  if (!view) throw notFound("Cita")
  const when = await whenText(tx, orgId, view.startsAt, view.timeZone)
  const what = view.serviceName ? `tu cita de ${view.serviceName}` : "tu cita"
  await tellConversation(
    tx,
    orgId,
    link.row,
    {
      note: `Reservó desde su enlace: ${view.serviceName ?? "cita"} el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      message: `Listo: ${what} quedó para el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      key: `enlace-reserva:${link.row.id}:${created.id}`,
      reason: "La persona reservó desde su enlace",
    },
    deps,
  )
  return view
}

/** La cita del enlace, si aún se puede tocar desde aquí. */
function changeableAppointment(link: ResolvedPersonalLink): ShownAppointment {
  const current = link.appointment
  if (!current) throw linkExpired()
  assertOwnAppointmentChangeable(current)
  return current
}

/**
 * Cambia de horario la cita del enlace. Es mover la cita en la Agenda
 * (`moveAppointment`): misma sede y mismo servicio, con las mismas reglas de
 * disponibilidad; la cita no se cancela ni se crea otra.
 */
export async function changeBookingLinkAppointment(
  tx: Db,
  orgId: string,
  token: string,
  input: { startsAt: string; dentistUserId: string; chairId?: string },
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await requireLiveLink(tx, orgId, token, true, { ownAppointment: true })
  const current = changeableAppointment(link)
  await moveOwnAppointment(tx, orgId, `contact:${link.row.contactId}`, current, input)
  // La cita que cambió es la del enlace: sigue a la vista hasta su nueva hora.
  await tx
    .update(appointmentBookingLink)
    .set({ appointmentId: current.id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.row.id)))
  const view = await appointmentView(tx, orgId, current.id)
  if (!view) throw notFound("Cita")
  const when = await whenText(tx, orgId, view.startsAt, view.timeZone)
  await tellConversation(
    tx,
    orgId,
    link.row,
    {
      note: `Cambió su cita desde su enlace: ahora es el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      message: `Listo: tu cita quedó cambiada para el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      key: `enlace-cambio:${link.row.id}:${view.startsAt}`,
      reason: "La persona cambió su cita desde su enlace",
    },
    deps,
  )
  return view
}

/** Cancela la cita del enlace: el mismo cambio de estado de la Agenda, con el motivo «paciente». */
export async function cancelBookingLinkAppointment(
  tx: Db,
  orgId: string,
  token: string,
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await requireLiveLink(tx, orgId, token, true, { ownAppointment: true })
  const current = changeableAppointment(link)
  const before = await appointmentView(tx, orgId, current.id)
  await cancelOwnAppointment(tx, orgId, `contact:${link.row.contactId}`, current, "La canceló la persona desde su enlace")
  await tx
    .update(appointmentBookingLink)
    .set({ appointmentId: current.id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.row.id)))
  const view = await appointmentView(tx, orgId, current.id)
  if (!view || !before) throw notFound("Cita")
  const when = await whenText(tx, orgId, before.startsAt, before.timeZone)
  await tellConversation(
    tx,
    orgId,
    link.row,
    {
      note: `Canceló desde su enlace su cita del ${when} en ${before.branchName}.`,
      message: `Tu cita del ${when} quedó cancelada. Si quieres otra, escríbeme y la vemos.`,
      key: `enlace-cancela:${link.row.id}:${current.id}`,
      reason: "La persona canceló su cita desde su enlace",
    },
    deps,
  )
  return view
}

/** Confirma la cita del enlace: la misma operación que el botón «Confirmar» del recordatorio. */
export async function confirmBookingLinkAppointment(tx: Db, orgId: string, token: string): Promise<BookingLinkAppointment> {
  const link = await requireLiveLink(tx, orgId, token, true, { ownAppointment: true })
  const current = changeableAppointment(link)
  await confirmOwnAppointment(tx, orgId, `contact:${link.row.contactId}`, current, "enlace")
  const view = await appointmentView(tx, orgId, current.id)
  if (!view) throw notFound("Cita")
  return view
}
