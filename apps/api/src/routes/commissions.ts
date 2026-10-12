/**
 * Comisiones de los profesionales y resultado del mes (Fases 6 y 8).
 * Montaje del padre: `guarded.route("/commissions", createCommissionsRoute(crmDeps))`.
 *
 * - `commissions.read`: cada profesional ve solo las suyas (`/my`, `/monthly`
 *   y `/payments` propios).
 * - `commissions.write` (administración): ve a todos, fija el porcentaje,
 *   registra el pago y lo anula.
 * - El resultado del mes es de quien dirige la clínica (`reports.read`): ni
 *   caja ni el profesional lo ven.
 */
import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import {
  getMonthlyCommissions,
  getMonthlyFinanceResult,
  getMyCommissions,
  listCommissionRates,
  listCommissionSettlements,
  listMonthCommissions,
  payMonthCommission,
  setCommissionRate,
  voidCommissionSettlement,
} from "@odentia/services"
import type { Context } from "hono"

function forbid(c: Context, message = "No tienes acceso a comisiones") {
  return c.json(errorBody(c, "FORBIDDEN", message), 403)
}

const currency = z.string().regex(/^[A-Z]{3}$/)
const year = z.coerce.number().int().min(2000).max(2100)
const month = z.coerce.number().int().min(1).max(12)
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const period = z.object({ year, month, currency: currency.optional() })

/**
 * A quién se puede mirar: administración, a quien pida; cualquier otro con
 * `commissions.read`, solo a sí mismo. Decide el permiso, no el nombre del rol.
 */
function scopedTarget(
  c: Context,
  requested: string | undefined,
): { target: string | undefined } | { response: Response } {
  const { userId, memberRole } = orgContextOf(c)
  if (canAccess(memberRole, "commissions.write")) return { target: requested }
  if (requested && requested !== userId)
    return { response: forbid(c, "Solo puedes ver tus propias comisiones") }
  return { target: userId }
}

export function createCommissionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["commissions.read", "reports.read"])) return forbid(c)
    await next()
  })

  // --- Porcentaje por profesional ------------------------------------------------
  app.get("/rates", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.read")) return forbid(c)
    const parsed = z.object({ professionalUserId: z.string().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId)
    if ("response" in scoped) return scoped.response
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listCommissionRates(tx, orgId, { professionalUserId: scoped.target }),
      ),
    )
  })

  app.put("/rates", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        rateBps: z.number().int().min(0).max(10000),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => setCommissionRate(tx, orgId, userId, parsed.data)),
    )
  })

  // --- El mes de toda la clínica (administración) ----------------------------------
  app.get("/month", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write"))
      return forbid(c, "Solo administración ve las comisiones de todos")
    const parsed = period.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listMonthCommissions(tx, orgId, parsed.data)),
    )
  })

  // --- El mes de un profesional, con cada cobro -------------------------------------
  app.get("/monthly", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.read")) return forbid(c)
    const parsed = period
      .extend({ professionalUserId: z.string().min(1).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId)
    if ("response" in scoped) return scoped.response
    const target = scoped.target
    if (!target) return c.json(errorBody(c, "VALIDATION", "Elige el profesional"), 400)
    const { year: y, month: m, currency: unit } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getMonthlyCommissions(tx, orgId, { professionalUserId: target, year: y, month: m, currency: unit }),
      ),
    )
  })

  /** Lo propio: siempre el profesional autenticado, con sus meses anteriores. */
  app.get("/my", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.read")) return forbid(c)
    const parsed = period.safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getMyCommissions(tx, orgId, userId, parsed.data)),
    )
  })

  // --- Registrar el pago: un solo paso (congela los cobros y deja el gasto) ----------
  app.post("/pay", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        year: z.number().int().min(2000).max(2100),
        month: z.number().int().min(1).max(12),
        currency: currency.optional(),
        branchId: z.uuid(),
        notes: z.string().max(2000).nullish(),
        expectedCents: z.number().int().positive().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => payMonthCommission(tx, orgId, userId, parsed.data)),
    )
  })

  // --- Pagos registrados --------------------------------------------------------------
  app.get("/payments", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.read")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().optional(),
        year: year.optional(),
        month: month.optional(),
        // Con `1` llegan también los anulados (motivo y quién anuló).
        includeVoided: z.enum(["0", "1"]).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId)
    if ("response" in scoped) return scoped.response
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listCommissionSettlements(tx, orgId, {
          professionalUserId: scoped.target,
          year: parsed.data.year,
          month: parsed.data.month,
          includeVoided: parsed.data.includeVoided === "1",
        }),
      ),
    )
  })

  app.post("/payments/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidCommissionSettlement(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Resultado del mes (Fase 6) ----------------------------------------------------------
  app.get("/monthly-result", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "reports.read"))
      return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso al resultado del mes"), 403)
    const parsed = z
      .object({
        year,
        month,
        branchId: z.uuid().optional(),
        currency: currency.optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getMonthlyFinanceResult(tx, orgId, parsed.data)),
    )
  })

  return app
}
