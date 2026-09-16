import { withOrgContext } from "@odentia/db"
import {
  createService,
  fromTemplates,
  listServices,
  listTemplates,
  updateService,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canWrite, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

const templatesQuery = z
  .object({
    q: z.string().max(200).optional(),
    specialty: z.string().max(40).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

const offersQuery = z
  .object({
    q: z.string().max(200).optional(),
    specialty: z.string().max(40).optional(),
    state: z.enum(["active", "inactive", "unpriced", "legacy"]).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict()

const createInput = z
  .object({
    templateId: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(200).nullish(),
    specialty: z.string().trim().min(1).max(40).nullish(),
    scope: z.string().trim().min(1).max(20).nullish(),
    code: z.string().max(40).nullish(),
    priceCents: z.number().int().min(0).max(2147483647).nullish(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullish(),
    durationMin: z.number().int().min(1).max(1440).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const patchInput = z
  .object({
    templateId: z.string().uuid().nullish(),
    name: z.string().trim().min(1).max(200).optional(),
    specialty: z.string().trim().min(1).max(40).optional(),
    scope: z.string().trim().min(1).max(20).optional(),
    code: z.string().max(40).nullish(),
    priceCents: z.number().int().min(0).max(2147483647).nullish(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    durationMin: z.number().int().min(1).max(1440).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const fromTemplatesInput = z
  .object({ templateIds: z.array(z.string().uuid()).min(1).max(100) })
  .strict()

export function createServicesRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = offersQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const page = await withOrgContext(deps.db, orgId, (tx) =>
        listServices(tx, orgId, {
          q: parsed.data.q,
          specialty: parsed.data.specialty,
          state: parsed.data.state,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
      return c.json(page)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.get("/templates", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = templatesQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const page = await withOrgContext(deps.db, orgId, (tx) =>
        listTemplates(tx, {
          q: parsed.data.q,
          specialty: parsed.data.specialty,
          cursor: parsed.data.cursor,
          limit: parsed.data.limit,
        }),
      )
      return c.json(page)
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/from-templates", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) {
      return c.json(
        errorBody(c, "FORBIDDEN", "Solo owner/admin pueden administrar el tarifario"),
        403,
      )
    }
    const parsed = fromTemplatesInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        fromTemplates(tx, orgId, userId, parsed.data.templateIds),
      ),
    )
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden crear prestaciones"), 403)
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createService(tx, orgId, userId, {
          templateId: parsed.data.templateId,
          name: parsed.data.name,
          specialty: parsed.data.specialty,
          scope: parsed.data.scope,
          code: parsed.data.code,
          priceCents: parsed.data.priceCents,
          currency: parsed.data.currency,
          durationMin: parsed.data.durationMin,
          isActive: parsed.data.isActive,
        }),
      ),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canWrite(memberRole)) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo owner/admin pueden editar prestaciones"), 403)
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updateService(tx, orgId, userId, c.req.param("id"), {
          templateId: parsed.data.templateId,
          name: parsed.data.name,
          specialty: parsed.data.specialty,
          scope: parsed.data.scope,
          code: parsed.data.code,
          priceCents: parsed.data.priceCents,
          currency: parsed.data.currency,
          durationMin: parsed.data.durationMin,
          isActive: parsed.data.isActive,
        }),
      ),
    )
  })

  return app
}
