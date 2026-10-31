import { withOrgContext } from "@odentia/db"
import {
  createPaymentMethod,
  listPaymentMethods,
  movePaymentMethod,
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

const nameInput = z
  .string()
  .trim()
  .min(1, "Escribe el nombre del medio de pago")
  .max(120, "El nombre admite hasta 120 caracteres")

const typeCodeInput = z.enum(["10", "48", "30", "68", "20", "1"], "Elige el tipo del medio de pago de la lista")

const createInput = z
  .object({
    name: nameInput,
    typeCode: typeCodeInput.nullish(),
    sortOrder: z.number().int().min(0).max(9999).nullish(),
  })
  .strict()

const patchInput = z
  .object({
    name: nameInput.optional(),
    typeCode: typeCodeInput.optional(),
    sortOrder: z.number().int().min(0).max(9999).nullish(),
    isActive: z.boolean().optional(),
  })
  .strict()

const moveInput = z.object({ direction: z.enum(["up", "down"]) }).strict()

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
          // Sin puesto indicado, el medio nuevo va al final de la lista.
          atEnd: true,
        }),
      ),
    )
  })

  // Subir o bajar un medio un puesto: responde con la lista como queda.
  app.post("/:id/move", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(
        errorBody(c, "FORBIDDEN", "No tienes permiso para configurar medios de pago"),
        403,
      )
    }
    const parsed = moveInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        movePaymentMethod(tx, orgId, userId, c.req.param("id"), parsed.data.direction),
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
