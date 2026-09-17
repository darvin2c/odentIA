import { registrationConfigSchema } from "@odentia/clinical"
import { withOrgContext } from "@odentia/db"
import { organization } from "@odentia/db/schema/auth"
import { createPatientRegistrationLink, getPatientRegistrationConfig, patientOrganizationToday, savePatientRegistrationConfig } from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { canWrite, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

export function createPatientRegistrationRoute(deps: CrmDeps & { cookieDomain: string }) {
  const app = new Hono()
  app.get("/patient-registration/config", async c => {
    const { orgId } = orgContextOf(c)
    try {
      const result = await withOrgContext(deps.db, orgId, async tx => ({ data: await getPatientRegistrationConfig(tx, orgId), meta: { today: await patientOrganizationToday(tx, orgId) } }))
      c.header("Cache-Control", "no-store")
      return c.json(result)
    } catch (error) { return serviceErrorResponse(c, error) ?? Promise.reject(error) }
  })
  app.put("/patient-registration/config", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden configurar el registro"), 403)
    const parsed = z.strictObject({ enabled: z.boolean(), fields: registrationConfigSchema.shape.fields, privacyNotice: registrationConfigSchema.shape.privacyNotice, expectedVersion: z.number().int().nonnegative() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx => savePatientRegistrationConfig(tx, orgId, userId, parsed.data)))
  })
  app.post("/contacts/:id/registration-links", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden crear enlaces de registro"), 403)
    const parsed = z.strictObject({ conversationId: z.uuid() }).safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    return runService(c, 201, () => withOrgContext(deps.db, orgId, async tx => {
      const [org] = await tx.select({ slug: organization.slug }).from(organization).where(eq(organization.id, orgId)).limit(1)
      if (!org?.slug) throw new Error("La organización no tiene dirección pública")
      const link = await createPatientRegistrationLink(tx, orgId, userId, { contactId: c.req.param("id"), conversationId: parsed.data.conversationId })
      const url = new URL(`https://${org.slug}.${deps.cookieDomain.replace(/^\./, "")}/registro`)
      url.searchParams.set("token", link.token)
      return { url: url.toString(), expiresAt: link.expiresAt.toISOString() }
    }))
  })
  return app
}
