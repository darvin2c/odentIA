import type { Db } from "@odentia/db"
import { patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, isNull } from "drizzle-orm"
import { assertAnswers, assertFormSchema, type FormSchemaDef } from "./clinical-forms.js"
import { notFound, ServiceError } from "./errors.js"
import { logAccess, type PortalContext, requireScope } from "./portal.js"

/**
 * Cuestionario previo a la cita desde el portal: lo responde el paciente o su
 * representante (quien tiene la sesión), queda «declarado» al enviarlo y el
 * equipo lo revisa y finaliza. Usa la misma validación que la ficha.
 */
export interface PortalQuestionnaireView {
  template: { id: string; title: string; version: number; schema: FormSchemaDef } | null
  response: {
    id: string
    answers: Record<string, unknown>
    submittedAt: Date | null
    status: string
  } | null
  respondent: { name: string; relationship: string }
}

async function respondentOf(tx: Db, ctx: PortalContext) {
  const [row] = await tx
    .select({ name: contact.displayName, relationship: patientContact.relationship })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, patientContact.organizationId)),
    )
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

async function currentTemplate(tx: Db, orgId: string) {
  const [template] = await tx
    .select()
    .from(clinicalFormTemplate)
    .where(
      and(
        eq(clinicalFormTemplate.organizationId, orgId),
        eq(clinicalFormTemplate.status, "publicado"),
        eq(clinicalFormTemplate.respondent, "portal"),
      ),
    )
    .orderBy(desc(clinicalFormTemplate.publishedAt))
    .limit(1)
  return template ?? null
}

/** Borrador abierto del portal o, si no hay, el último enviado (solo lectura). */
async function latestResponse(tx: Db, ctx: PortalContext, templateKey: string | null) {
  const rows = await tx
    .select({ response: clinicalFormResponse, key: clinicalFormTemplate.key })
    .from(clinicalFormResponse)
    .innerJoin(clinicalFormTemplate, eq(clinicalFormTemplate.id, clinicalFormResponse.templateId))
    .where(
      and(
        eq(clinicalFormResponse.organizationId, ctx.orgId),
        eq(clinicalFormResponse.patientId, ctx.session.patientId),
        eq(clinicalFormResponse.source, "portal"),
      ),
    )
    .orderBy(desc(clinicalFormResponse.createdAt))
    .limit(10)
  return rows.find((row) => row.key === templateKey && row.response.status !== "descartado")?.response ?? null
}

export async function getPortalQuestionnaire(
  tx: Db,
  ctx: PortalContext,
): Promise<PortalQuestionnaireView> {
  requireScope(ctx.session, "appointments")
  const respondent = await respondentOf(tx, ctx)
  const template = await currentTemplate(tx, ctx.orgId)
  const response = template ? await latestResponse(tx, ctx, template.key) : null
  await logAccess(tx, ctx.orgId, ctx.session.id, "questionnaire.viewed")
  return {
    template: template
      ? {
          id: template.id,
          title: template.title,
          version: template.version,
          schema: assertFormSchema(template.schema),
        }
      : null,
    response: response
      ? {
          id: response.id,
          answers: response.answers as Record<string, unknown>,
          submittedAt: response.submittedAt,
          status: response.status,
        }
      : null,
    respondent,
  }
}

/**
 * Guarda el avance (validación parcial) o lo envía (obligatorios completos).
 * Tras enviarlo ya no se edita desde el portal: lo revisa el equipo.
 */
export async function savePortalQuestionnaire(
  tx: Db,
  ctx: PortalContext,
  input: { answers: unknown; submit?: boolean },
): Promise<PortalQuestionnaireView> {
  requireScope(ctx.session, "appointments")
  await respondentOf(tx, ctx)
  const template = await currentTemplate(tx, ctx.orgId)
  if (!template) throw notFound("Cuestionario")
  const schema = assertFormSchema(template.schema)
  const answers = assertAnswers(schema, input.answers, { requireAll: input.submit === true })
  const existing = await latestResponse(tx, ctx, template.key)
  const open =
    existing && existing.status === "borrador" && !existing.submittedAt && existing.templateId === template.id
      ? existing
      : null
  if (existing?.submittedAt && !open && existing.templateId === template.id && existing.status === "borrador")
    throw new ServiceError("ALREADY_SUBMITTED", 409, "Ya enviaste este cuestionario; tu odontólogo lo revisará")
  const now = new Date()
  let id: string
  if (open) {
    const [row] = await tx
      .update(clinicalFormResponse)
      .set({
        answers,
        respondentContactId: ctx.session.contactId,
        submittedAt: input.submit ? now : null,
        updatedAt: now,
      })
      .where(and(eq(clinicalFormResponse.id, open.id), isNull(clinicalFormResponse.submittedAt)))
      .returning({ id: clinicalFormResponse.id })
    if (!row) throw new ServiceError("ALREADY_SUBMITTED", 409, "Ya enviaste este cuestionario")
    id = row.id
  } else {
    const [row] = await tx
      .insert(clinicalFormResponse)
      .values({
        organizationId: ctx.orgId,
        templateId: template.id,
        templateVersion: template.version,
        templateTitle: template.title,
        templateSnapshot: template.schema as Record<string, unknown>,
        patientId: ctx.session.patientId,
        status: "borrador",
        answers,
        source: "portal",
        respondentContactId: ctx.session.contactId,
        submittedAt: input.submit ? now : null,
      })
      .returning({ id: clinicalFormResponse.id })
    id = row!.id
  }
  await logAccess(
    tx,
    ctx.orgId,
    ctx.session.id,
    input.submit ? "questionnaire.submitted" : "questionnaire.saved",
    "clinical_form_response",
    id,
  )
  if (input.submit) {
    await tx.insert(auditEvent).values({
      organizationId: ctx.orgId,
      actorUserId: null,
      action: "form_response.portal_submitted",
      entity: "clinical_form_response",
      entityId: id,
      metadata: { patientId: ctx.session.patientId, contactId: ctx.session.contactId },
    })
  }
  return getPortalQuestionnaire(tx, ctx)
}
