import type { VisitQuestions } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { and, eq } from "drizzle-orm"
import { ServiceError } from "./errors.js"
import { logAccess, type PortalContext, requireScope } from "./portal.js"
import { contactDecides } from "./responsibilities.js"
import { nextAppointmentIdOf, saveVisitAnswer, visitAskOf, visitSentOf } from "./visit-answers.js"

/**
 * «Antes de tu cita» desde el portal (mesa de formularios del 13 nov, entrega 8): la misma regla
 * que su enlace (`visitAskOf`, `saveVisitAnswer`). Lo responde quien decide por el paciente (él
 * mismo o su representante legal vigente), para su próxima cita, una vez. El portal ya no tiene un
 * cuestionario propio: lo que antes respondía ahí se dejó de usar, y lo enviado sigue en su ficha.
 */
export interface PortalVisitView {
  /** Lo que se le pregunta para su próxima cita; nulo si no hay nada por responder. */
  visit: { appointmentId: string; startsAt: Date; purpose: string | null; questions: VisitQuestions } | null
  /** Lo que ya envió para esa cita: cuándo, nunca qué. */
  sent: { at: Date; own: boolean } | null
  respondent: { name: string; relationship: string }
}

async function respondentOf(tx: Db, ctx: PortalContext) {
  const [row] = await tx
    .select({ name: contact.displayName, relationship: patientContact.relationship })
    .from(patientContact)
    .innerJoin(contact, and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, patientContact.organizationId)))
    .where(
      and(
        eq(patientContact.organizationId, ctx.orgId),
        eq(patientContact.patientId, ctx.session.patientId),
        eq(patientContact.contactId, ctx.session.contactId),
      ),
    )
  if (!row) throw new ServiceError("PORTAL_FORBIDDEN", 404, "Tu acceso ya no está vinculado al paciente")
  return row
}

export async function getPortalVisit(tx: Db, ctx: PortalContext): Promise<PortalVisitView> {
  requireScope(ctx.session, "appointments")
  const respondent = await respondentOf(tx, ctx)
  const { patientId, contactId } = ctx.session
  const decides = await contactDecides(tx, ctx.orgId, patientId, contactId)
  const appointmentId = decides ? await nextAppointmentIdOf(tx, ctx.orgId, patientId) : null
  const ask = await visitAskOf(tx, ctx.orgId, { patientId, appointmentId })
  await logAccess(tx, ctx.orgId, ctx.session.id, "visit.viewed")
  return {
    visit: ask,
    sent: decides ? await visitSentOf(tx, ctx.orgId, appointmentId, contactId) : null,
    respondent,
  }
}

export async function savePortalVisit(tx: Db, ctx: PortalContext, input: unknown): Promise<PortalVisitView> {
  requireScope(ctx.session, "appointments")
  await respondentOf(tx, ctx)
  const { patientId, contactId } = ctx.session
  // Quién lo responde lo decide la operación, igual que desde su enlace.
  await saveVisitAnswer(tx, ctx.orgId, { patientId, contactId }, await nextAppointmentIdOf(tx, ctx.orgId, patientId), input, "portal")
  await logAccess(tx, ctx.orgId, ctx.session.id, "visit.sent")
  return getPortalVisit(tx, ctx)
}
