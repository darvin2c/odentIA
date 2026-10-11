/**
 * Finanzas: caja automática por sede y moneda, gastos cortos, deudas y
 * cierres inmutables. Lectura con `finance.read`, escritura con
 * `finance.write`, cierre con `finance.close` (cashier+admin). Comisiones y
 * resultado del mes viven en `routes/commissions.ts` (`/api/commissions`).
 *
 * Sin emisor fiscal ni pasarela: no hay endpoints de emisión de comprobantes
 * ni de cobro online.
 */
import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import type { Context } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import {
  addShiftMovement,
  closeCashWindow,
  createExpense,
  getCashState,
  getClosureSheet,
  getDayMovements,
  getDebts,
  getFinanceOverview,
  getPatientBalanceForPortal,
  getReceivables,
  getShiftDetail,
  listClosures,
  listExpenses,
  listShifts,
  voidExpense,
  voidMovement,
} from "@odentia/services"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a finanzas"), 403)
}

const cents = z.number().int().positive().max(2147483647)
const currency = z.string().regex(/^[A-Z]{3}$/)
const isoDateTime = z.iso.datetime({ offset: true })
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()

export function createFinanceRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  // Toda la sección exige finance.read (cada escritor también lo tiene);
  // las mutaciones exigen además finance.write en su manejador.
  app.use("*", async (c, next) => {
    const { memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.read")) return forbid(c)
    await next()
  })

  // --- Caja -------------------------------------------------------------------
  app.get("/shifts", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({ branchId: z.uuid().optional(), status: z.enum(["abierta", "cerrada"]).optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listShifts(tx, orgId, parsed.data)),
    )
  })

  app.get("/shifts/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getShiftDetail(tx, orgId, c.req.param("id"))),
    )
  })

  // Ingresar o retirar efectivo de la ventana abierta (único movimiento manual).
  app.post("/shifts/:id/movements", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        direction: z.enum(["ingreso", "egreso"]),
        kind: z.enum(["aporte", "retiro"]),
        amountCents: cents,
        concept: z.string().trim().min(1).max(500),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        addShiftMovement(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // Cerrar caja: cuenta el efectivo, dice cuánto queda y cuánto entrega.
  // Cierra quien cobra (`finance.close`); la diferencia avisa a administración.
  app.post("/closures", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.close")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        currency: currency.optional(),
        countedCents: z.number().int().min(0).max(2147483647),
        retainedCents: z.number().int().min(0).max(2147483647),
        deliveredCents: z.number().int().min(0).max(2147483647),
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => closeCashWindow(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/closures", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listClosures(tx, orgId, parsed.data)),
    )
  })

  app.get("/closures/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getClosureSheet(tx, orgId, c.req.param("id"))),
    )
  })

  // Caja del día por sede: efectivo, totales por medio y ventana abierta.
  app.get("/cash", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({ branchId: z.uuid(), currency: currency.optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getCashState(tx, orgId, parsed.data)),
    )
  })

  app.get("/debts", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ branchId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getDebts(tx, orgId, parsed.data)),
    )
  })

  app.get("/movements", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        currency: currency.optional(),
        day: isoDay,
        timezone: z.string().max(60).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getDayMovements(tx, orgId, parsed.data)),
    )
  })

  app.post("/movements/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidMovement(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Gastos cortos (los proveedores quedan solo en Inventario) -------------------------
  app.get("/expenses", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid().optional(),
        category: z.string().max(60).optional(),
        from: isoDay.optional(),
        to: isoDay.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listExpenses(tx, orgId, parsed.data)),
    )
  })

  app.post("/expenses", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        category: z.string().max(60).optional(),
        concept: z.string().trim().min(1).max(500),
        amountCents: cents,
        currency: currency.optional(),
        spentAt: isoDateTime.nullish(),
        receiptKind: z.string().trim().min(1).max(60).optional(),
        receiptNumber: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
        fromCash: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createExpense(tx, orgId, userId, parsed.data)),
    )
  })

  app.post("/expenses/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidExpense(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Cuentas por cobrar ----------------------------------------------------------
  app.get("/receivables", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ patientId: z.uuid().optional(), branchId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getReceivables(tx, orgId, parsed.data)),
    )
  })

  app.get("/patients/:id/balance", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getPatientBalanceForPortal(tx, orgId, c.req.param("id")),
      ),
    )
  })

  // --- Resumen (Home / Reportes) --------------------------------------------------------------
  app.get("/overview", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({ branchId: z.uuid().optional(), from: isoDay.optional(), to: isoDay.optional() })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getFinanceOverview(tx, orgId, parsed.data)),
    )
  })
  return app
}
