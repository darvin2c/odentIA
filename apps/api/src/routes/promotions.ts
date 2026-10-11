import { withOrgContext } from "@odentia/db"
import {
  createPromotion,
  endPromotion,
  getPromotion,
  getPromotionMetrics,
  listPromotions,
  updatePromotion,
} from "@odentia/services"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"

/**
 * Promociones (propiedad PresupuestosPromociones, fase 5).
 * - GET /?scope=vigentes|todas&serviceId= → lista (caja y presupuestos leen
 *   vigentes; `catalog.read` la ven todos los roles operativos).
 * - POST / { name, startsAt, endsAt?, conditions?, items } → 201
 * - GET /:id → detalle con servicios y métricas de uso/cobrado
 * - PATCH /:id { name?, startsAt?, endsAt?, conditions?, isActive?, items? }
 * - POST /:id/end {} → termina hoy (lo usado conserva su snapshot)
 * Mutaciones solo administración (`settings.write`).
 * Dinero solo en centavos enteros; modo fixed|from según servicio.
 */
const promotionItemInput = z
  .object({
    serviceId: z.uuid(),
    mode: z.enum(["fixed", "from"]),
    priceCents: z.number().int().min(0).max(2147483647),
  })
  .strict()

const promotionCreateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }).nullish(),
    conditions: z.string().trim().max(500).nullish(),
    items: z.array(promotionItemInput).min(1).max(100),
  })
  .strict()

const promotionPatchInput = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).nullish(),
    conditions: z.string().trim().max(500).nullish(),
    isActive: z.boolean().optional(),
    items: z.array(promotionItemInput).min(1).max(100).optional(),
  })
  .strict()

const promotionsQuery = z
  .object({
    scope: z.enum(["vigentes", "todas"]).optional(),
    serviceId: z.uuid().optional(),
  })
  .strict()

export function createPromotionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()

  app.get("/", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver promociones"), 403)
    }
    const parsed = promotionsQuery.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listPromotions(tx, orgId, {
          vigentesOnly: (parsed.data.scope ?? "vigentes") === "vigentes",
          serviceId: parsed.data.serviceId,
        }),
      ),
    )
  })

  app.post("/", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo administración configura promociones"), 403)
    }
    const parsed = promotionCreateInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createPromotion(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/:id", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "catalog.read")) {
      return c.json(errorBody(c, "FORBIDDEN", "No tienes permiso para ver promociones"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const promotion = await getPromotion(tx, orgId, c.req.param("id"))
        const metrics = await getPromotionMetrics(tx, orgId, c.req.param("id"))
        return { ...promotion, metrics }
      }),
    )
  })

  app.patch("/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo administración configura promociones"), 403)
    }
    const parsed = promotionPatchInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        updatePromotion(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  app.post("/:id/end", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "settings.write")) {
      return c.json(errorBody(c, "FORBIDDEN", "Solo administración configura promociones"), 403)
    }
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => endPromotion(tx, orgId, userId, c.req.param("id"))),
    )
  })

  return app
}
