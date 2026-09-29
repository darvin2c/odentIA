import { createHash } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { automationLinkToken } from "@odentia/db/schema/automation"
import {
  cancelAppointmentByToken,
  cancelJob,
  confirmAppointmentByToken,
  createRule,
  getPublicLinkInfo,
  listConsents,
  listJobs,
  listRules,
  previewCampaignSegment,
  setConsent,
  unsubscribeByToken,
  updateRule,
} from "@odentia/services"
import { eq } from "drizzle-orm"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

const ruleInput = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum([
    "recordatorio_cita",
    "seguimiento_presupuesto",
    "seguimiento_cita",
    "seguimiento_no_asistencia",
    "recuperacion_inactivo",
    "recordatorio_control",
    "campana",
  ]),
  channel: z.enum(["whatsapp", "telegram", "messenger", "instagram"]).default("whatsapp"),
  enabled: z.boolean().default(true),
  templateName: z.string().max(120).nullable().optional(),
  templateLanguage: z.string().max(20).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

const rulePatch = ruleInput.partial()

const jobsQuery = z.object({
  status: z.enum(["pendiente", "enviado", "fallido", "cancelado", "omitido"]).optional(),
  kind: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const consentInput = z.object({
  purpose: z.enum(["recordatorio", "seguimiento", "marketing"]),
  channel: z.enum(["whatsapp", "telegram", "messenger", "instagram"]),
  granted: z.boolean(),
  source: z.string().max(60).optional(),
})

const previewInput = z.object({
  tags: z.array(z.string().max(60)).max(20).optional(),
  opportunityStageIds: z.array(z.string().uuid()).max(20).optional(),
  channel: z.enum(["whatsapp", "telegram", "messenger", "instagram"]).optional(),
})

/**
 * Centro de automatizaciones: reglas, trabajos/resultados, consentimientos
 * y vista previa de campañas. Lectura `crm.read`, mutación `crm.write`.
 */
export function createAutomationsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/rules", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listRules(tx, orgId)))
  })

  app.post("/rules", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    const parsed = ruleInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createRule(tx, orgId, userId, parsed.data)),
    )
  })

  app.patch("/rules/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    const parsed = rulePatch.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateRule(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })

  app.get("/jobs", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    const parsed = jobsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listJobs(tx, orgId, parsed.data)))
  })

  app.post("/jobs/:id/cancel", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => cancelJob(tx, orgId, userId, c.req.param("id"))),
    )
  })

  app.get("/contacts/:contactId/consents", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listConsents(tx, orgId, c.req.param("contactId"))),
    )
  })

  app.post("/contacts/:contactId/consents", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.write")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    const parsed = consentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        setConsent(tx, orgId, userId, c.req.param("contactId"), parsed.data),
      ),
    )
  })

  app.post("/campaigns/preview", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "crm.read")) return c.json(errorBody(c, "FORBIDDEN", "Sin permiso de CRM"), 403)
    const parsed = previewInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => previewCampaignSegment(tx, orgId, parsed.data)),
    )
  })

  return app
}

/**
 * Enlaces públicos seguros (confirmar/cancelar cita, baja). Sin sesión: el
 * token opaco (hash en DB) resuelve el tenant; las respuestas nunca incluyen
 * paciente ni contacto. El padre monta en `/api/public/automations`.
 */
export function createPublicAutomationsRoute(deps: { db: CrmDeps["db"]; ownerDb: CrmDeps["db"] }) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    c.header("Referrer-Policy", "no-referrer")
    await next()
  })
  app.onError((_error, c) => c.json(errorBody(c, "INTERNAL", "No pudimos completar la solicitud"), 500))

  async function orgIdOf(token: string): Promise<string | null> {
    const hash = createHash("sha256").update(token).digest("hex")
    const [link] = await deps.ownerDb
      .select({ organizationId: automationLinkToken.organizationId })
      .from(automationLinkToken)
      .where(eq(automationLinkToken.tokenHash, hash))
      .limit(1)
    return link?.organizationId ?? null
  }

  app.get("/cita/:token", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPublicLinkInfo(tx, token)))
  })

  app.post("/cita/:token/confirmar", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => confirmAppointmentByToken(tx, token)),
    )
  })

  app.post("/cita/:token/cancelar", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => cancelAppointmentByToken(tx, token)),
    )
  })

  app.get("/baja/:token", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPublicLinkInfo(tx, token)))
  })

  app.post("/baja/:token", async (c) => {
    const token = c.req.param("token")
    const orgId = await orgIdOf(token)
    if (!orgId) return c.json(errorBody(c, "NOT_FOUND", "Enlace no disponible"), 404)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => unsubscribeByToken(tx, token)))
  })

  return app
}
