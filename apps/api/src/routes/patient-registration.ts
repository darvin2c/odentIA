import { registrationConfigSchema } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { conversation } from "@odentia/db/schema/crm"
import {
  clinicOriginOf,
  createBookingLink,
  createPatientRegistrationLink,
  getPatientRegistrationConfig,
  patientOrganizationToday,
  personalLinkUrl,
  previewPersonalLinkSend,
  revokePersonalLinks,
  savePatientRegistrationConfig,
  sendPersonalLink,
  showPersonalLink,
  ServiceError,
} from "@odentia/services"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

export function createPatientRegistrationRoute(deps: CrmDeps & { cookieDomain: string; webURL: string }) {
  const app = new Hono()
  app.get("/patient-registration/config", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    // La lee quien da de alta pacientes y quien configura el registro.
    if (!canAccess(memberRole, "crm.read") && !canAccess(memberRole, "settings.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver el registro"), 403)
    }
    try {
      const result = await withOrgContext(deps.db, orgId, async tx => ({ data: await getPatientRegistrationConfig(tx, orgId), meta: { today: await patientOrganizationToday(tx, orgId) } }))
      c.header("Cache-Control", "no-store")
      return c.json(result)
    } catch (error) { return serviceErrorResponse(c, error) ?? Promise.reject(error) }
  })
  app.put("/patient-registration/config", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para configurar el registro"), 403)
    }
    const parsed = z.strictObject({ enabled: z.boolean(), fields: registrationConfigSchema.shape.fields, privacyNotice: registrationConfigSchema.shape.privacyNotice, askReminders: z.boolean().optional(), askMessages: z.boolean().optional(), expectedVersion: z.number().int().nonnegative() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => savePatientRegistrationConfig(tx, orgId, userId, parsed.data)))
  })
  app.post("/contacts/:id/registration-links", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para crear enlaces de registro"), 403)
    }
    const parsed = z.strictObject({ conversationId: z.uuid() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    return runService(c, 201, () => withOrgContext(deps.db, orgId, async tx => {
      // En la clínica, en el dominio de su producto (decisión 9 del issue 229).
      const origin = await clinicOriginOf(tx, orgId)
      if (!origin) throw new Error("La organización no tiene dirección pública")
      const link = await createPatientRegistrationLink(tx, orgId, userId, { contactId: c.req.param("id"), conversationId: parsed.data.conversationId })
      const url = new URL("/registro", origin)
      url.searchParams.set("token", link.token)
      return { url: url.toString(), expiresAt: link.expiresAt.toISOString() }
    }))
  })

  // «Su enlace» de la persona de una conversación, para escribirlo en el hilo
  // (Bandeja, «Contexto»): elige su cita y, si aún no es paciente, deja sus datos.
  app.post("/contacts/:id/personal-link", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para enviar su enlace"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse({ id: c.req.param("id") })
    const parsed = z.strictObject({ conversationId: z.uuid(), patientId: z.uuid().optional() }).safeParse(await c.req.json().catch(() => null))
    if (!params.success) return validationError(c, params.error.issues)
    if (!parsed.success) return validationError(c, parsed.error.issues)
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    return runService(c, 201, () => withOrgContext(deps.db, orgId, async tx => {
      const [thread] = await tx
        .select({ contactId: conversation.contactId })
        .from(conversation)
        .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, parsed.data.conversationId)))
        .limit(1)
      if (thread?.contactId !== params.data.id) throw new ServiceError("VALIDATION", 400, "La conversación no es de esta persona")
      const link = await createBookingLink(
        tx,
        orgId,
        { conversationId: parsed.data.conversationId, createdBy: userId, ...(parsed.data.patientId ? { patientId: parsed.data.patientId } : {}) },
        { secretsKey: deps.secretsKey },
      )
      const url = await personalLinkUrl(tx, orgId, link.token)
      if (!url) throw new Error("La organización no tiene dirección pública")
      return { url, expiresAt: link.expiresAt.toISOString(), needsRegistration: link.needsRegistration, patientName: link.patientName }
    }))
  })

  // «Enviarle su enlace» desde la página de la persona: dice antes a quién y por dónde.
  app.get("/patients/:id/personal-link/preview", async c => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Enviarle su enlace es de quien edita sus datos"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse({ id: c.req.param("id") })
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => previewPersonalLinkSend(tx, orgId, params.data.id)))
  })

  app.post("/patients/:id/personal-link", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Enviarle su enlace es de quien edita sus datos"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse({ id: c.req.param("id") })
    const parsed = z.strictObject({ requestId: z.uuid().optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!params.success) return validationError(c, params.error.issues)
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, tx =>
        sendPersonalLink(tx, orgId, userId, { patientId: params.data.id, requestId: parsed.data.requestId ?? null }, { secretsKey: deps.secretsKey }),
      ),
    )
  })
  // «Su enlace» en un código QR para escanearlo en la clínica: no se envía nada.
  app.post("/patients/:id/personal-link/show", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Mostrar su enlace es de quien edita sus datos"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse({ id: c.req.param("id") })
    if (!params.success) return validationError(c, params.error.issues)
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, tx => showPersonalLink(tx, orgId, userId, params.data.id, { secretsKey: deps.secretsKey })),
    )
  })
  // «Quitar enlace»: deja sin efecto su enlace, de quien sea; lo que ya hizo con él se conserva.
  app.delete("/patients/:id/personal-link", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "patients.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Quitar su enlace es de quien edita sus datos"), 403)
    }
    const params = z.object({ id: z.uuid() }).safeParse({ id: c.req.param("id") })
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => revokePersonalLinks(tx, orgId, userId, params.data.id)))
  })
  return app
}
