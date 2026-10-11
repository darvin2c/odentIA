import { withOrgContext } from "@odentia/db"
import {
  createPaymentMethod,
  listPaymentMethods,
  updatePaymentMethod,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, serviceErrorResponse, validationError } from "./helpers.js"

// Medios de pago por clínica: administración los configura (settings.write),
// caja y el resto los leen para cobrar (finance.read o catalog.read).

const listQuery = z
  .object({ activeOnly: z.enum(["0", "1"]).transform((value) => value === "1").optional() })
  .strict()

const createInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    typeCode: z.enum(["10", "48", "30", "68", "20", "1"]).nullish(),
    sortOrder: z.number().int().min(0).max(9999).nullish(),
  })
  .strict()

const patchInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    typeCode: z.enum(["10", "48", "30", "68", "20", "1"]).optional(),
    sortOrder: z.number().int().min(0).max(9999).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

export function createPaymentMethodsRoute(deps: CrmDeps) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (
      !canAccess(memberRole, "finance.read") &&
      !canAccess(memberRole, "catalog.read") &&
      !canAccess(memberRole, "settings.read")
    ) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver los medios de pago"), 403)
    }
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    try {
      const data = await withOrgContext(deps.db, orgId, (tx) =>
        listPaymentMethods(tx, orgId, { activeOnly: parsed.data.activeOnly ?? true }),
      )
      return c.json({ data })
    } catch (e) {
      return serviceErrorResponse(c, e) ?? Promise.reject(e)
    }
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para configurar medios de pago"),
        403,
      )
    }
    const parsed = createInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createPaymentMethod(tx, orgId, userId, {
          name: parsed.data.name,
          typeCode: parsed.data.typeCode,
          sortOrder: parsed.data.sortOrder,
        }),
      ),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para configurar medios de pago"),
        403,
      )
    }
    const parsed = patchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updatePaymentMethod(tx, orgId, userId, c.req.param("id"), {
          name: parsed.data.name,
          typeCode: parsed.data.typeCode,
          sortOrder: parsed.data.sortOrder ?? undefined,
          isActive: parsed.data.isActive,
        }),
      ),
    )
  })

  return app
}
