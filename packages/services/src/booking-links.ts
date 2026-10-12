import { createHash, randomBytes } from "node:crypto"
import { normalizePhone, pendingRegistrationFields, type RegistrationAnswers, type RegistrationConfig } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { appointment, appointmentBookingLink } from "@odentia/db/schema/agenda"
import { organization, user } from "@odentia/db/schema/auth"
import { patient, serviceCatalog } from "@odentia/db/schema/clinical"
import { channelConnection, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { and, asc, eq, isNull } from "drizzle-orm"
import { addAgentCaseNote, CASE_NOTE_CHARS } from "./agent-case.js"
import { createProposal } from "./agent-operations.js"
import { createAppointment, moveAppointment, setAppointmentStatus } from "./appointments.js"
import { listAvailableSlots } from "./availability.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { createPatientRegistrationLink, getPatientRegistrationConfig, registerPatient } from "./patient-registration.js"
import { listPatientsByContact, patientOrganizationToday } from "./patients.js"

/**
 * Reservar desde un enlace: la persona de una conversación elige ella misma
 * el día y la hora viendo los horarios libres, sin ir y venir por el chat. Es
 * una opción junto a reservar conversando, no la única vía. El enlace es
 * personal (una conversación y su persona), efímero y de una sola cita; solo se
 * guarda su huella. Con la cita ya reservada, el mismo enlace sirve para
 * cambiarla de horario o cancelarla hasta que empiece. Sirve a quien ya es paciente y a quien recién se contacta:
 * este deja antes sus datos esenciales (identidad y celular) y el registro de
 * pacientes de la clínica, con ese alcance, es quien crea la ficha; lo demás
 * se completa en la clínica. La reserva usa la misma operación de Agenda que
 * recepción y el agente, así que valen las mismas reglas de disponibilidad.
 * La página no muestra tarifas.
 */
export const BOOKING_LINK_TTL_HOURS = 24
const SLOT_RANGE_DAYS = 7
const TOKEN = /^[0-9a-f]{64}$/

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export interface CreateBookingLinkInput {
  conversationId: string
  /** Paciente para quien es la cita; obligatorio solo si la persona tiene más de uno vinculado. */
  patientId?: string
  serviceId?: string
  branchId?: string
}

export async function createBookingLink(
  tx: Db,
  orgId: string,
  input: CreateBookingLinkInput,
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
    if (!site) throw notFound("Sede")
  }
  // Un solo enlace vivo por conversación: el nuevo deja sin efecto el anterior.
  await tx
    .update(appointmentBookingLink)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(appointmentBookingLink.organizationId, orgId),
        eq(appointmentBookingLink.conversationId, input.conversationId),
        isNull(appointmentBookingLink.usedAt),
        isNull(appointmentBookingLink.revokedAt),
      ),
    )
  const token = randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + BOOKING_LINK_TTL_HOURS * 3_600_000)
  await tx.insert(appointmentBookingLink).values({
    organizationId: orgId,
    conversationId: input.conversationId,
    contactId: conv.contactId,
    patientId: chosen?.id ?? null,
    serviceId: input.serviceId ?? null,
    branchId: input.branchId ?? null,
    tokenHash: hashToken(token),
    expiresAt,
  })
  return { token, expiresAt, patientName: chosen?.displayName ?? null, needsRegistration: !chosen }
}

type LinkRow = typeof appointmentBookingLink.$inferSelect

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
 * Para quién es la cita del enlace. Si nació sin paciente, lo es quien la
 * persona registró desde entonces: su único paciente vinculado. Con ninguno
 * aún falta el registro; con varios no se elige por ella.
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

function stateOf(link: LinkRow): "abierto" | "usado" | "vencido" {
  if (link.usedAt) return "usado"
  if (link.revokedAt || link.expiresAt.getTime() <= Date.now()) return "vencido"
  return "abierto"
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
  /** Aún se puede cambiar de horario o cancelar desde el enlace: no empezó y sigue en pie. */
  canChange: boolean
  branchName: string
  branchAddress: string | null
  dentistName: string
  serviceName: string | null
}

/** Una cita se puede cambiar o cancelar desde su enlace mientras siga en pie y no haya empezado. */
function isChangeable(row: { status: string; startsAt: Date }): boolean {
  return (row.status === "programada" || row.status === "confirmada") && row.startsAt.getTime() > Date.now()
}

async function appointmentView(tx: Db, orgId: string, appointmentId: string): Promise<BookingLinkAppointment | null> {
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
  return {
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    timeZone: row.branchTimeZone ?? "America/Lima",
    durationMin: Math.round((row.endsAt.getTime() - row.startsAt.getTime()) / 60_000),
    branchId: row.branchId,
    cancelled: row.status === "cancelada",
    canChange: isChangeable(row),
    branchName: row.branchName,
    branchAddress: row.branchAddress,
    dentistName: row.dentistName,
    serviceName: row.serviceName,
  }
}

export interface BookingLinkView {
  status: "abierto" | "usado" | "vencido"
  clinicName: string
  /** Solo el nombre de pila: la página confirma para quién es sin exponer más. */
  patientFirstName: string | null
  /** La persona aún no es paciente: antes de reservar completa sus datos en la misma página. */
  needsRegistration: boolean
  /** El servicio del que se habló, sin tarifa. */
  service: { name: string; durationMin: number | null } | null
  branches: Array<{ id: string; name: string; address: string | null; timeZone: string; defaultMinutes: number }>
  /** Sede ya elegida en la conversación. */
  branchId: string | null
  expiresAt: string
  appointment: BookingLinkAppointment | null
}

export async function getBookingLinkView(tx: Db, orgId: string, token: string): Promise<BookingLinkView> {
  const link = await findLink(tx, orgId, token)
  const status = stateOf(link)
  const [org] = await tx.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1)
  const base = { status, clinicName: org?.name ?? "", expiresAt: link.expiresAt.toISOString() }
  if (status === "vencido") {
    return { ...base, patientFirstName: null, needsRegistration: false, service: null, branches: [], branchId: null, appointment: null }
  }
  const patientId = await patientOf(tx, orgId, link)
  const [person] = patientId
    ? await tx
        .select({ displayName: patient.displayName, givenNames: patient.givenNames })
        .from(patient)
        .where(and(eq(patient.organizationId, orgId), eq(patient.id, patientId)))
        .limit(1)
    : []
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
    ...base,
    patientFirstName: (person?.givenNames ?? person?.displayName ?? "").trim().split(/\s+/)[0] || null,
    needsRegistration: status === "abierto" && patientId === null,
    service,
    branches: sites
      .filter((site) => !link.branchId || site.id === link.branchId)
      .map((site) => ({ id: site.id, name: site.name, address: site.address, timeZone: site.timezone ?? "America/Lima", defaultMinutes: site.minutes })),
    branchId: link.branchId,
    appointment: link.appointmentId ? await appointmentView(tx, orgId, link.appointmentId) : null,
  }
}

export interface BookingLinkSlot {
  startsAt: string
  endsAt: string
  dentistUserId: string
  dentistName: string
  chairId: string | null
}

function requireOpen(link: LinkRow): void {
  const status = stateOf(link)
  if (status === "usado") throw new ServiceError("BOOKING_LINK_USED", 409, "Con este enlace ya se reservó una cita")
  if (status === "vencido") throw new ServiceError("BOOKING_LINK_EXPIRED", 409, "Este enlace ya no está disponible")
}

/** La cita reservada con el enlace, si aún se puede cambiar o cancelar. */
async function reservedAppointment(tx: Db, orgId: string, link: LinkRow): Promise<{ id: string; version: number; branchId: string }> {
  const [row] = link.appointmentId
    ? await tx
        .select({ id: appointment.id, version: appointment.version, branchId: appointment.branchId, status: appointment.status, startsAt: appointment.startsAt })
        .from(appointment)
        .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, link.appointmentId)))
        .limit(1)
    : []
  if (!row) throw new ServiceError("BOOKING_LINK_EXPIRED", 409, "Este enlace ya no está disponible")
  if (!isChangeable(row)) throw new ServiceError("BOOKING_NOT_CHANGEABLE", 409, "Esta cita ya no se puede cambiar desde aquí. Escríbenos por el chat.")
  return row
}

/** Horarios libres para el enlace: los mismos huecos reales que ve recepción, sin lo que ya pasó. */
export async function listBookingLinkSlots(
  tx: Db,
  orgId: string,
  token: string,
  input: { branchId: string; from: string; to: string },
): Promise<{ slots: BookingLinkSlot[]; timeZone: string; truncated: boolean }> {
  const link = await findLink(tx, orgId, token)
  // Con la cita ya reservada se siguen viendo horarios libres, para cambiarla: solo los de su sede.
  if (stateOf(link) === "usado") {
    const current = await reservedAppointment(tx, orgId, link)
    if (current.branchId !== input.branchId) throw validation("La cita es en otra sede")
  } else {
    requireOpen(link)
    if (link.branchId && link.branchId !== input.branchId) throw validation("Este enlace es para otra sede")
  }
  const from = new Date(input.from)
  const to = new Date(input.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw validation("Rango de fechas inválido")
  if (to.getTime() - from.getTime() > SLOT_RANGE_DAYS * 86_400_000) throw validation(`El rango máximo es de ${SLOT_RANGE_DAYS} días`)
  // A quien elige su cita se le ofrece un horario por cada cita que cabe, no
  // cada cuarto de hora: menos opciones y las mismas posibilidades reales.
  const [site] = await tx
    .select({ minutes: branch.appointmentDefaultMinutes })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.id, input.branchId)))
    .limit(1)
  if (!site) throw notFound("Sede")
  const service = link.serviceId
    ? (
        await tx
          .select({ minutes: serviceCatalog.durationMin })
          .from(serviceCatalog)
          .where(and(eq(serviceCatalog.organizationId, orgId), eq(serviceCatalog.id, link.serviceId)))
          .limit(1)
      )[0]
    : undefined
  const duration = service?.minutes ?? site.minutes
  const stepMin = Math.min(60, Math.max(15, Math.round(duration / 5) * 5))
  const notBefore = new Date().toISOString()
  // Día por día: la Agenda recorta cada consulta a un tope de huecos, y con
  // varios profesionales una semana entera dejaría sin horarios los últimos días.
  const slots: BookingLinkSlot[] = []
  let timeZone = "America/Lima"
  let truncated = false
  for (let start = from.getTime(); start < to.getTime(); start += 86_400_000) {
    const day = await listAvailableSlots(tx, orgId, {
      branchId: input.branchId,
      ...(link.serviceId ? { serviceId: link.serviceId } : {}),
      from: new Date(start).toISOString(),
      to: new Date(Math.min(start + 86_400_000, to.getTime())).toISOString(),
      notBefore,
      stepMin,
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
 * El celular desde el que la persona escribe, solo si el sistema lo conoce de
 * verdad: la conversación del enlace es de WhatsApp, cuyo identificador es el
 * número. En cualquier otro canal no se supone ninguno.
 */
async function conversationPhone(tx: Db, orgId: string, link: LinkRow): Promise<string | null> {
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
}

/**
 * Lo que la página necesita para pedir los datos de quien aún no es paciente:
 * el registro vigente de la clínica (versión y aviso de privacidad) y, si se
 * conoce, el celular desde el que escribe.
 */
export async function getBookingLinkRegistrationForm(tx: Db, orgId: string, token: string): Promise<BookingLinkRegistrationForm> {
  const link = await findLink(tx, orgId, token)
  requireOpen(link)
  if ((await patientOf(tx, orgId, link)) !== null) throw alreadyPatient()
  const config = await getPatientRegistrationConfig(tx, orgId)
  if (!config.enabled) throw new ServiceError("BOOKING_NEEDS_PATIENT", 409, "La clínica no tiene activo el registro de pacientes en línea")
  return { config, today: await patientOrganizationToday(tx, orgId), phone: await conversationPhone(tx, orgId, link) }
}

/**
 * Registra a quien aún no es paciente con los datos esenciales para reservar.
 * La ficha la crea el registro de pacientes (`registerPatient`, alcance
 * `essentials`), con sus reglas de identidad, su aviso de privacidad, su
 * consentimiento y su auditoría; aquí solo se emite el enlace de registro para
 * la persona del enlace de reserva y se consume en la misma transacción. Lo
 * que la clínica exige y no se pidió queda anotado en el caso.
 */
export async function registerFromBookingLink(
  tx: Db,
  orgId: string,
  token: string,
  input: { submissionId: string; formVersion: number; answers: RegistrationAnswers },
): Promise<{ registered: true }> {
  const link = await findLink(tx, orgId, token, true)
  requireOpen(link)
  if ((await patientOf(tx, orgId, link)) !== null) throw alreadyPatient()
  const registration = await createPatientRegistrationLink(tx, orgId, null, { contactId: link.contactId, conversationId: link.conversationId })
  const created = await registerPatient(
    tx,
    orgId,
    { kind: "public", token: registration.token, entryPoint: "public_link", scope: "essentials" },
    { submissionId: input.submissionId, formVersion: input.formVersion, answers: input.answers },
  )
  await tx
    .update(appointmentBookingLink)
    .set({ patientId: created.id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.id)))
  // Recepción lo ve en el caso: qué pide la clínica y aún falta. La ficha
  // queda además con la identidad por revisar.
  const pending = pendingRegistrationFields(await getPatientRegistrationConfig(tx, orgId), input.answers).map((field) => field.label.toLowerCase())
  const who = input.answers.respondent === "representative" ? "Registró a otra persona" : "Se registró"
  const head = `${who} desde el enlace de reserva con los datos esenciales. Falta en la clínica: confirmar apellidos y nombres`
  // La nota del caso es corta: si la lista no cabe, dice cuántos más faltan en vez de cortarse.
  const named: string[] = []
  for (const label of pending) {
    const rest = pending.length - named.length - 1
    const tail = rest > 0 ? ` y ${rest} más` : ""
    if (`${head}, ${[...named, label].join(", ")}${tail}.`.length > CASE_NOTE_CHARS) break
    named.push(label)
  }
  const left = pending.length - named.length
  await addAgentCaseNote(
    tx,
    orgId,
    link.conversationId,
    `${head}${named.length ? `, ${named.join(", ")}` : ""}${left > 0 ? ` y ${left} más` : ""}.`,
  )
  return { registered: true }
}

function whenText(startsAt: string, timeZone: string): string {
  const date = new Date(startsAt)
  const day = new Intl.DateTimeFormat("es-PE", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(date)
  const time = new Intl.DateTimeFormat("es-PE", { timeZone, hour: "numeric", minute: "2-digit", hour12: true }).format(date)
  return `${day} a las ${time}`
}

/**
 * Reserva la cita elegida. Bloquea el enlace para que dos toques no creen dos
 * citas, usa la operación de Agenda (que valida disponibilidad y solapes) y
 * deja constancia donde el agente y el equipo la ven: una nota del caso y un
 * mensaje de confirmación en la conversación, sujeto a la política de envío.
 */
export async function reserveBookingLink(
  tx: Db,
  orgId: string,
  token: string,
  input: { branchId: string; startsAt: string; dentistUserId: string; chairId?: string },
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await findLink(tx, orgId, token, true)
  requireOpen(link)
  if (link.branchId && link.branchId !== input.branchId) throw validation("Este enlace es para otra sede")
  const patientId = await patientOf(tx, orgId, link)
  if (!patientId) throw new ServiceError("BOOKING_NEEDS_REGISTRATION", 409, "Antes de reservar necesitamos tus datos")
  const created = await createAppointment(tx, orgId, `contact:${link.contactId}`, {
    branchId: input.branchId,
    patientId,
    dentistUserId: input.dentistUserId,
    ...(input.chairId ? { chairId: input.chairId } : {}),
    ...(link.serviceId ? { serviceId: link.serviceId } : {}),
    startsAt: input.startsAt,
    source: "enlace",
    conversationId: link.conversationId,
    // Quien reserva es la propia persona, no alguien del equipo: la cita queda sin autora.
    createdByUserId: null,
  })
  await tx
    .update(appointmentBookingLink)
    .set({ usedAt: new Date(), appointmentId: created.id })
    .where(and(eq(appointmentBookingLink.organizationId, orgId), eq(appointmentBookingLink.id, link.id)))
  const view = await appointmentView(tx, orgId, created.id)
  if (!view) throw notFound("Cita")
  const when = whenText(view.startsAt, view.timeZone)
  const what = view.serviceName ? `tu cita de ${view.serviceName}` : "tu cita"
  await addAgentCaseNote(tx, orgId, link.conversationId, `Reservó desde el enlace: ${view.serviceName ?? "cita"} el ${when} en ${view.branchName}, con ${view.dentistName}.`)
  // La confirmación sale por la conversación con la misma política que cualquier mensaje del agente.
  await createProposal(tx, orgId, {
    conversationId: link.conversationId,
    action: "enviar_mensaje",
    payload: { kind: "text", text: `Listo: ${what} quedó para el ${when} en ${view.branchName}, con ${view.dentistName}.` },
    reason: "La persona reservó desde el enlace",
    idempotencyKey: `enlace-reserva:${link.id}`,
    ...(deps.secretsKey ? { secretsKey: deps.secretsKey } : {}),
  }).catch((error: unknown) => {
    // La cita ya está reservada: que el aviso no salga no la deshace. Queda la nota del caso.
    if (!(error instanceof ServiceError)) throw error
  })
  return view
}

/** Deja constancia en el caso y avisa por la conversación, con la misma política que cualquier mensaje del agente. */
async function tellConversation(
  tx: Db,
  orgId: string,
  link: LinkRow,
  input: { note: string; message: string; key: string; reason: string },
  deps: { secretsKey?: Buffer },
): Promise<void> {
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
 * Cambia de horario la cita reservada con el enlace. Es mover la cita en la
 * Agenda (`moveAppointment`): misma sede y mismo servicio, con las mismas
 * reglas de disponibilidad; la cita no se cancela ni se crea otra.
 */
export async function changeBookingLinkAppointment(
  tx: Db,
  orgId: string,
  token: string,
  input: { startsAt: string; dentistUserId: string; chairId?: string },
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await findLink(tx, orgId, token, true)
  const current = await reservedAppointment(tx, orgId, link)
  await moveAppointment(tx, orgId, `contact:${link.contactId}`, current.id, {
    expectedVersion: current.version,
    startsAt: input.startsAt,
    dentistUserId: input.dentistUserId,
    ...(input.chairId ? { chairId: input.chairId } : {}),
  })
  const view = await appointmentView(tx, orgId, current.id)
  if (!view) throw notFound("Cita")
  const when = whenText(view.startsAt, view.timeZone)
  await tellConversation(
    tx,
    orgId,
    link,
    {
      note: `Cambió su cita desde el enlace: ahora es el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      message: `Listo: tu cita quedó cambiada para el ${when} en ${view.branchName}, con ${view.dentistName}.`,
      key: `enlace-cambio:${link.id}:${view.startsAt}`,
      reason: "La persona cambió su cita desde el enlace",
    },
    deps,
  )
  return view
}

/** Cancela la cita reservada con el enlace: el mismo cambio de estado de la Agenda, con el motivo «paciente». */
export async function cancelBookingLinkAppointment(
  tx: Db,
  orgId: string,
  token: string,
  deps: { secretsKey?: Buffer } = {},
): Promise<BookingLinkAppointment> {
  const link = await findLink(tx, orgId, token, true)
  const current = await reservedAppointment(tx, orgId, link)
  const before = await appointmentView(tx, orgId, current.id)
  await setAppointmentStatus(tx, orgId, `contact:${link.contactId}`, current.id, "cancelada", {
    cancelReason: "paciente",
    cancelNote: "La canceló la persona desde su enlace de reserva",
  })
  const view = await appointmentView(tx, orgId, current.id)
  if (!view || !before) throw notFound("Cita")
  const when = whenText(before.startsAt, before.timeZone)
  await tellConversation(
    tx,
    orgId,
    link,
    {
      note: `Canceló desde el enlace su cita del ${when} en ${before.branchName}.`,
      message: `Tu cita del ${when} quedó cancelada. Si quieres otra, escríbeme y la vemos.`,
      key: `enlace-cancela:${link.id}`,
      reason: "La persona canceló su cita desde el enlace",
    },
    deps,
  )
  return view
}
