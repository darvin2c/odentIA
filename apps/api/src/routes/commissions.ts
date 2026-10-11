/**
 * Comisiones y resultado del mes (Fases 6 y 8).
 * Montaje del padre: `guarded.route("/commissions", createCommissionsRoute(crmDeps))`.
 * Permisos: `commissions.read` (odontólogo: solo propias; admin: todas),
 * `commissions.write` (solo admin) para tasa/liquidar/pagar/anular.
 * El resultado mensual exige `reports.read` o `finance.read` (nunca solo
 * `commissions.read`: el profesional no ve el resto de la caja).
 */
import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, canAccessAny, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import {
  getCommissionSettlementDetail,
  getMonthlyCommissions,
  getMonthlyFinanceResult,
  getMyCommissions,
  listCommissionRates,
  listCommissionSettlements,
  payCommissionSettlement,
  ServiceError,
  setCommissionRate,
  settleMonthCommissions,
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

/** Odontólogo: solo sus comisiones; resto: el profesional pedido. */
function scopedTarget(
  c: Context,
  requested: string | undefined,
  { required }: { required: boolean },
): { target: string | undefined } | { response: Response } {
  const { userId, memberRole } = orgContextOf(c)
  if (memberRole === "dentist") {
    if (requested && requested !== userId)
      return { response: forbid(c, "Solo puedes ver tus propias comisiones") }
    return { target: userId }
  }
  if (!requested && required)
    return {
      response: c.json(
        errorBody(c, "VALIDATION", "Elige el profesional"),
        400,
      ),
    }
  return { target: requested }
}

export function createCommissionsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccessAny(memberRole, ["commissions.read", "reports.read", "finance.read"]))
      return forbid(c)
    await next()
  })

  // --- Tasa única por profesional -------------------------------------------------
  app.get("/rates", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "commissions.read")) return forbid(c)
    const parsed = z.object({ professionalUserId: z.string().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId, { required: false })
    if ("response" in scoped) return scoped.response
    const professionalUserId =
      orgContextOf(c).memberRole === "dentist" ? scoped.target : parsed.data.professionalUserId
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listCommissionRates(tx, orgId, { professionalUserId })),
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

  // --- Mes por profesional ----------------------------------------------------------
  app.get("/monthly", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "commissions.read")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1).optional(),
        year,
        month,
        currency,
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId, { required: true })
    if ("response" in scoped) return scoped.response
    const target = scoped.target
    if (!target) return c.json(errorBody(c, "VALIDATION", "Elige el profesional"), 400)
    const { year: y, month: m, currency: curr } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getMonthlyCommissions(tx, orgId, {
          professionalUserId: target,
          year: y,
          month: m,
          currency: curr,
        }),
      ),
    )
  })

  /** Acceso propio directo: siempre el profesional autenticado. */
  app.get("/my", async (c) => {
    const { orgId, userId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "commissions.read")) return forbid(c)
    const parsed = z.object({ year, month, currency }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getMyCommissions(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/settle", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        year,
        month,
        currency,
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => settleMonthCommissions(tx, orgId, userId, parsed.data)),
    )
  })

  // --- Liquidaciones ------------------------------------------------------------------
  app.get("/settlements", async (c) => {
    const { orgId } = orgContextOf(c)
    if (!canAccess(orgContextOf(c).memberRole, "commissions.read")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().optional(),
        year: z.coerce.number().int().min(2000).max(2100).optional(),
        month: z.coerce.number().int().min(1).max(12).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const scoped = scopedTarget(c, parsed.data.professionalUserId, { required: false })
    if ("response" in scoped) return scoped.response
    const professionalUserId =
      orgContextOf(c).memberRole === "dentist" ? scoped.target : parsed.data.professionalUserId
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listCommissionSettlements(tx, orgId, {
          professionalUserId,
          year: parsed.data.year,
          month: parsed.data.month,
        }),
      ),
    )
  })

  app.get("/settlements/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.read")) return forbid(c)
    const id = c.req.param("id")
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, async (tx) => {
        const detail = await getCommissionSettlementDetail(tx, orgId, id)
        if (memberRole === "dentist" && detail.settlement.professionalUserId !== userId)
          throw new ServiceError("FORBIDDEN", 403, "Solo puedes ver tus propias comisiones")
        return detail
      }),
    )
  })

  app.post("/settlements/:id/pay", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "commissions.write")) return forbid(c)
    const parsed = z
      .object({ branchId: z.uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        payCommissionSettlement(tx, orgId, userId, {
          settlementId: c.req.param("id"),
          branchId: parsed.data.branchId,
        }),
      ),
    )
  })

  app.post("/settlements/:id/void", async (c) => {
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
    if (!canAccessAny(memberRole, ["reports.read", "finance.read"]))
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
