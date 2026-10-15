import type { ReplyButton } from "@odentia/channels"
import type { Db } from "@odentia/db"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import type { AutomationCause, AutomationVia, automationJob } from "@odentia/db/schema/automation"
import { clinicalFollowUp, patient, patientContact, treatmentBudget } from "@odentia/db/schema/clinical"
import { channelConnection, contact, contactIdentity, conversation } from "@odentia/db/schema/crm"
import { opportunity } from "@odentia/db/schema/opportunities"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { type AutomationMessage, type MessageVariable, placePhrase, renderMessage, replyId } from "./automation-messages.js"
import { findTemplateByName, type TemplateItem } from "./channel-templates.js"
import { isDirectThread } from "./contacts.js"
import { reopenConversation, startContactConversation, WA_FREE_TEXT_WINDOW_MS } from "./conversations.js"
import { ServiceError } from "./errors.js"
import { openEmailThread } from "./financial-documents.js"
import { findOrgLocale, NEUTRAL_TIMEZONE } from "./locale.js"

/**
 * Por dónde le llega un mensaje automático a cada persona y qué dice. El orden
 * es fijo y lo decide el sistema, nunca un modelo:
 *
 * 1. WhatsApp como respuesta, si la persona escribió en las últimas 24 horas.
 * 2. WhatsApp con el mensaje aprobado, si no.
 * 3. Correo, si no hay WhatsApp o su mensaje aún no está aprobado.
 * 4. Si nada de eso se puede, no se intenta: se devuelve el motivo, para que el
 *    equipo sepa por qué y cómo habilitarlo.
 */

type JobRow = typeof automationJob.$inferSelect

export interface ComposedMessage {
  spec: AutomationMessage
  /** Datos en el orden de las variables de la plantilla. */
  params: string[]
  /** El texto completo: lo que la persona lee por cualquier vía. */
  text: string
  subject: string
  buttons: ReplyButton[]
}

export function firstName(person: { givenNames: string | null; displayName: string }): string {
  const given = person.givenNames?.trim().split(/\s+/)[0]
  return given || person.displayName.trim().split(/\s+/)[0] || person.displayName
}

function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

/** «mañana, martes 13 de octubre» o «martes 13 de octubre», en la zona de la sede. */
export function dayPhrase(date: Date, now: Date, timeZone: string, locale: string): string {
  const day = new Intl.DateTimeFormat(locale, { timeZone, weekday: "long", day: "numeric", month: "long" })
    .format(date)
    .replace(",", "")
  const key = dayKey(date, timeZone)
  if (key === dayKey(now, timeZone)) return `hoy, ${day}`
  if (key === dayKey(new Date(now.getTime() + 24 * 3_600_000), timeZone)) return `mañana, ${day}`
  return day
}

function timePhrase(date: Date, timeZone: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hour: "numeric", minute: "2-digit" }).format(date)
}

/** Nombre con el que la clínica se presenta; nulo si aún no tiene perfil. */
export async function findClinicName(tx: Db, orgId: string): Promise<string | null> {
  const [profile] = await tx
    .select({ tradeName: orgProfile.tradeName, legalName: orgProfile.legalName })
    .from(orgProfile)
    .where(eq(orgProfile.organizationId, orgId))
    .limit(1)
  return profile?.tradeName?.trim() || profile?.legalName || null
}

export async function clinicName(tx: Db, orgId: string): Promise<string> {
  return (await findClinicName(tx, orgId)) ?? "la clínica"
}

/** Si la persona que recibe el mensaje es el propio paciente. */
async function isSelf(tx: Db, orgId: string, patientId: string, contactId: string): Promise<boolean> {
  const [own] = await tx
    .select({ id: patientContact.id })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, patientId),
        eq(patientContact.contactId, contactId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return !!own
}

async function patientName(tx: Db, orgId: string, patientId: string): Promise<string> {
  const [row] = await tx
    .select({ givenNames: patient.givenNames, displayName: patient.displayName })
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.organizationId, orgId)))
    .limit(1)
  return row ? firstName(row) : "tu familiar"
}

/**
 * Arma el mensaje de uno o varios trabajos del mismo tipo para una persona
 * (varios recordatorios de cita del mismo día salen juntos). Los datos se leen
 * ahora de la agenda, el presupuesto, el control o la oportunidad: no se guarda
 * un texto viejo.
 * `spec` trae el texto vigente de la clínica (`currentAutomationMessage`).
 * Devuelve null si el trabajo ya no tiene de dónde sacar sus datos.
 */
export async function composeJobMessage(
  tx: Db,
  orgId: string,
  spec: AutomationMessage,
  jobs: JobRow[],
  now: Date,
): Promise<ComposedMessage | null> {
  const lead = jobs[0]
  if (!lead?.contactId) return null
  const contactId = lead.contactId
  const [person] = await tx
    .select({ givenNames: contact.givenNames, displayName: contact.displayName })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  if (!person) return null
  const { locale, timezone: orgZone } = await findOrgLocale(tx, orgId)
  const clinic = await clinicName(tx, orgId)
  const values: Partial<Record<MessageVariable, string>> = { persona: firstName(person), clinica: clinic }

  const pastVisit = spec.key === "seguimiento_no_asistencia" || spec.key === "cita_cancelada"
  if (spec.key === "recordatorio_cita" || pastVisit) {
    const ids = jobs.map((job) => job.appointmentId).filter((id): id is string => !!id)
    if (ids.length === 0) return null
    const rows = await tx
      .select({
        id: appointment.id,
        startsAt: appointment.startsAt,
        patientId: appointment.patientId,
        branchName: branch.name,
        branchZone: branch.timezone,
        dentist: user.name,
      })
      .from(appointment)
      .innerJoin(branch, and(eq(branch.id, appointment.branchId), eq(branch.organizationId, orgId)))
      .innerJoin(user, eq(user.id, appointment.dentistUserId))
      .where(and(eq(appointment.organizationId, orgId), inArray(appointment.id, ids)))
      .orderBy(asc(appointment.startsAt), asc(appointment.id))
    const first = rows[0]
    if (!first) return null
    const zone = first.branchZone || orgZone || NEUTRAL_TIMEZONE
    if (pastVisit) {
      values.cita_pasada = dayPhrase(first.startsAt, now, zone, locale).replace(/^(hoy|mañana), /, "")
    } else {
      values.lugar = placePhrase(clinic, first.branchName)
      const parts: string[] = []
      for (const row of rows) {
        const rowZone = row.branchZone || orgZone || NEUTRAL_TIMEZONE
        const who = (await isSelf(tx, orgId, row.patientId, contactId))
          ? ""
          : `${await patientName(tx, orgId, row.patientId)}: `
        parts.push(
          `${who}${dayPhrase(row.startsAt, now, rowZone, locale)}, a las ${timePhrase(row.startsAt, rowZone, locale)}, con ${row.dentist}`,
        )
      }
      values.citas = parts.join("; ")
    }
  }

  if (spec.key === "recordatorio_control") {
    const controlId = controlIdOf(lead.payload)
    if (!controlId) return null
    const [control] = await tx
      .select({ title: clinicalFollowUp.title, patientId: clinicalFollowUp.patientId })
      .from(clinicalFollowUp)
      .where(and(eq(clinicalFollowUp.id, controlId), eq(clinicalFollowUp.organizationId, orgId)))
      .limit(1)
    if (!control) return null
    values.control = (await isSelf(tx, orgId, control.patientId, contactId))
      ? control.title
      : `${control.title}, de ${await patientName(tx, orgId, control.patientId)}`
  }

  if (spec.key === "seguimiento_presupuesto") {
    if (!lead.budgetId) return null
    const [budget] = await tx
      .select({ title: treatmentBudget.title })
      .from(treatmentBudget)
      .where(and(eq(treatmentBudget.id, lead.budgetId), eq(treatmentBudget.organizationId, orgId)))
      .limit(1)
    if (!budget) return null
    values.presupuesto = budget.title
  }

  if (spec.key === "seguimiento_comercial") {
    if (!lead.opportunityId) return null
    const [opp] = await tx
      .select({ title: opportunity.title })
      .from(opportunity)
      .where(and(eq(opportunity.id, lead.opportunityId), eq(opportunity.organizationId, orgId)))
      .limit(1)
    if (!opp) return null
    values.oportunidad = opp.title
  }

  const { params, text } = renderMessage(spec, values)
  return {
    spec,
    params,
    text,
    subject: `${spec.subject} · ${clinic}`,
    buttons: spec.buttons.map((button) => ({ id: replyId(button.action, lead.id), title: button.title })),
  }
}

function controlIdOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("controlId" in payload)) return null
  return typeof payload.controlId === "string" ? payload.controlId : null
}

// -------------------------------------------------------------- la vía ---

export type MessageRoute =
  | {
      via: AutomationVia
      channel: "whatsapp" | "email"
      conversationId: string
      /** Solo en `plantilla`. */
      template?: { name: string; language: string }
    }
  | { cause: AutomationCause; detail: string }

/**
 * Decide la vía para escribirle a una persona. No envía nada. `spec` es el
 * mensaje con el texto vigente de la clínica: su plantilla es la que se busca
 * en la conexión. Nulo es un mensaje sin plantilla declarada: solo puede salir
 * como respuesta.
 */
export async function routeMessage(
  tx: Db,
  orgId: string,
  contactId: string,
  spec: Pick<AutomationMessage, "template"> | null,
): Promise<MessageRoute> {
  const [person] = await tx
    .select({ email: contact.email })
    .from(contact)
    .where(and(eq(contact.id, contactId), eq(contact.organizationId, orgId)))
    .limit(1)
  const identities = await tx
    .select()
    .from(contactIdentity)
    .where(
      and(
        eq(contactIdentity.organizationId, orgId),
        eq(contactIdentity.contactId, contactId),
        eq(contactIdentity.channel, "whatsapp"),
      ),
    )
    .orderBy(desc(contactIdentity.isPrimary), asc(contactIdentity.createdAt), asc(contactIdentity.id))
    .limit(1)
  const identity = identities[0]
  const connections = await tx
    .select({ id: channelConnection.id, channel: channelConnection.channel })
    .from(channelConnection)
    .where(
      and(
        eq(channelConnection.organizationId, orgId),
        eq(channelConnection.status, "active"),
        inArray(channelConnection.channel, ["whatsapp", "email"]),
      ),
    )
    .orderBy(asc(channelConnection.createdAt), asc(channelConnection.id))
  const whatsapp = connections.find((row) => row.channel === "whatsapp")
  const mailbox = connections.find((row) => row.channel === "email")

  let template: TemplateItem | null = null
  if (identity && whatsapp) {
    const threads = await tx
      .select({
        id: conversation.id,
        status: conversation.status,
        externalThreadId: conversation.externalThreadId,
        lastInboundAt: conversation.lastInboundAt,
      })
      .from(conversation)
      .where(
        and(
          eq(conversation.organizationId, orgId),
          eq(conversation.contactId, contactId),
          eq(conversation.contactIdentityId, identity.id),
          eq(conversation.channelConnectionId, whatsapp.id),
        ),
      )
    const thread = threads.find((row) => isDirectThread("whatsapp", row.externalThreadId, identity.externalUserId))
    // Una conversación cerrada no se reabre con una respuesta: su ventana ya no
    // cuenta. Con plantilla sí se le puede volver a escribir.
    if (
      thread?.status === "open" &&
      thread.lastInboundAt &&
      Date.now() - thread.lastInboundAt.getTime() <= WA_FREE_TEXT_WINDOW_MS
    ) {
      return { via: "respuesta", channel: "whatsapp", conversationId: thread.id }
    }
    template = spec ? await findTemplateByName(tx, orgId, whatsapp.id, spec.template) : null
    if (template?.status === "aprobada") {
      try {
        const started = await startContactConversation(tx, orgId, null, contactId, {
          identityId: identity.id,
          connectionId: whatsapp.id,
        })
        if (started.status !== "open") await reopenConversation(tx, orgId, started.id)
        return {
          via: "plantilla",
          channel: "whatsapp",
          conversationId: started.id,
          template: { name: template.name, language: template.language },
        }
      } catch (error) {
        // Un hilo que no se puede abrir (historial ambiguo, persona archivada) no
        // tumba el lote: se intenta el correo y, si no, se dice el motivo.
        if (!(error instanceof ServiceError)) throw error
      }
    }
  }

  const email = person?.email?.trim().toLowerCase()
  if (spec && mailbox && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    try {
      const thread = await openEmailThread(tx, orgId, null, { contactId, email }, mailbox)
      return { via: "correo", channel: "email", conversationId: thread.id }
    } catch (error) {
      if (!(error instanceof ServiceError)) throw error
    }
  }

  if (!identity && !email) {
    return { cause: "sin_destino", detail: "La persona no tiene WhatsApp ni correo registrados" }
  }
  if (identity && whatsapp) {
    const state =
      template?.status === "en_revision"
        ? "WhatsApp aún no aprueba el mensaje"
        : template
          ? `WhatsApp tiene el mensaje ${template.status}${template.reason ? ` (${template.reason})` : ""}`
          : "Aún no hay un mensaje aprobado por WhatsApp"
    return { cause: "sin_plantilla", detail: `${state} y la persona no escribió en las últimas 24 horas` }
  }
  return {
    cause: "sin_conexion",
    detail: identity
      ? "La clínica no tiene WhatsApp conectado"
      : "La persona solo tiene correo y la clínica no tiene un correo conectado",
  }
}
