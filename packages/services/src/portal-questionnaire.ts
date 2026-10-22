import type { Db } from "@odentia/db"
import { patientContact } from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { clinicalFormResponse, clinicalFormTemplate } from "@odentia/db/schema/clinical-forms"
import { auditEvent } from "@odentia/db/schema/org"
import { and, desc, eq, isNull } from "drizzle-orm"
import { assertAnswers, assertFormSchema, type FormSchemaDef } from "./clinical-forms.js"
import { notFound, ServiceError } from "./errors.js"
import { logAccess, type PortalContext, requireScope } from "./portal.js"
import { productHooks } from "./products.js"

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

/** Quién responde: la persona del paciente o quien habla por ella, con su vínculo. */
interface Respondent {
  orgId: string
  patientId: string
  contactId: string
}

function fromSession(ctx: PortalContext): Respondent {
  return { orgId: ctx.orgId, patientId: ctx.session.patientId, contactId: ctx.session.contactId }
}

async function respondentOf(tx: Db, who: Respondent) {
  const [row] = await tx
    .select({ name: contact.displayName, relationship: patientContact.relationship })
    .from(patientContact)
    .innerJoin(
      contact,
      and(eq(contact.id, patientContact.contactId), eq(contact.organizationId, patientContact.organizationId)),
    )
    .where(
      and(
        eq(patientContact.organizationId, who.orgId),
        eq(patientContact.patientId, who.patientId),
        eq(patientContact.contactId, who.contactId),
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
async function latestResponse(tx: Db, who: Respondent, templateKey: string | null) {
  const rows = await tx
    .select({ response: clinicalFormResponse, key: clinicalFormTemplate.key })
    .from(clinicalFormResponse)
    .innerJoin(clinicalFormTemplate, eq(clinicalFormTemplate.id, clinicalFormResponse.templateId))
    .where(
      and(
        eq(clinicalFormResponse.organizationId, who.orgId),
        eq(clinicalFormResponse.patientId, who.patientId),
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
  const respondent = await respondentOf(tx, fromSession(ctx))
  const template = await currentTemplate(tx, ctx.orgId)
  const response = template ? await latestResponse(tx, fromSession(ctx), template.key) : null
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
  const id = await saveQuestionnaire(tx, fromSession(ctx), input)
  await logAccess(
    tx,
    ctx.orgId,
    ctx.session.id,
    input.submit ? "questionnaire.submitted" : "questionnaire.saved",
    "clinical_form_response",
    id,
  )
  return getPortalQuestionnaire(tx, ctx)
}

/**
 * «Antes de tu cita» por responder: la plantilla vigente de la clínica y si
 * ya la envió. Es lo que muestra «Su enlace»: nunca las respuestas guardadas.
 */
export async function pendingQuestionnaire(
  tx: Db,
  orgId: string,
  patientId: string,
): Promise<{ id: string; title: string; version: number; schema: FormSchemaDef } | null> {
  const template = await currentTemplate(tx, orgId)
  if (!template) return null
  const latest = await latestResponse(tx, { orgId, patientId, contactId: "" }, template.key)
  if (latest && latest.templateId === template.id && latest.submittedAt) return null
  return { id: template.id, title: template.title, version: template.version, schema: assertFormSchema(template.schema) }
}

/** Lo envía desde «Su enlace» la persona o quien habla por ella: queda declarado y lo revisa el equipo. */
export async function submitQuestionnaireFromLink(
  tx: Db,
  who: Respondent,
  answers: unknown,
): Promise<{ submitted: true }> {
  await saveQuestionnaire(tx, who, { answers, submit: true, origin: "enlace" })
  return { submitted: true }
}

/**
 * Guarda el avance (validación parcial) o lo envía (obligatorios completos),
 * la misma regla para el portal y «Su enlace». Tras enviarlo ya no se edita:
 * lo revisa el equipo.
 */
async function saveQuestionnaire(
  tx: Db,
  who: Respondent,
  input: { answers: unknown; submit?: boolean; origin?: "portal" | "enlace" },
): Promise<string> {
  await respondentOf(tx, who)
  const template = await currentTemplate(tx, who.orgId)
  if (!template) throw notFound("Cuestionario")
  const schema = assertFormSchema(template.schema)
  const answers = assertAnswers(schema, input.answers, {
    requireAll: input.submit === true,
    site: (await productHooks(tx, who.orgId)).site,
  })
  const existing = await latestResponse(tx, who, template.key)
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
        respondentContactId: who.contactId,
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
        organizationId: who.orgId,
        templateId: template.id,
        templateVersion: template.version,
        templateTitle: template.title,
        templateSnapshot: template.schema as Record<string, unknown>,
        patientId: who.patientId,
        status: "borrador",
        answers,
        source: "portal",
        respondentContactId: who.contactId,
        submittedAt: input.submit ? now : null,
      })
      .returning({ id: clinicalFormResponse.id })
    id = row!.id
  }
  if (input.submit) {
    await tx.insert(auditEvent).values({
      organizationId: who.orgId,
      actorUserId: `contact:${who.contactId}`,
      action: "form_response.portal_submitted",
      entity: "clinical_form_response",
      entityId: id,
      metadata: { patientId: who.patientId, contactId: who.contactId, via: input.origin ?? "portal" },
    })
  }
  return id
}
