/**
 * Finanzas: caja por sede/turno, gastos y proveedores, cuentas por cobrar con
 * planes de cuotas, comisiones y resúmenes. Lectura con `finance.read`,
 * escritura con `finance.write` (owner/admin/cashier según matriz de Roles).
 *
 * Sin emisor fiscal ni pasarela: no hay endpoints de emisión de comprobantes
 * ni de cobro online.
 */
import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import {
  addShiftMovement,
  closeShift,
  createExpense,
  createInstallmentPlan,
  createSupplier,
  getFinanceOverview,
  getPatientBalanceForPortal,
  getReceivables,
  getSettlementDetail,
  getShiftDetail,
  listCommissionRules,
  listExpenses,
  listInstallmentPlans,
  listSettlements,
  listShifts,
  listSuppliers,
  openShift,
  previewCommissions,
  refreshInstallmentPlan,
  registerPaymentInShift,
  settleCommissions,
  upsertCommissionRule,
  voidExpense,
  voidInstallmentPlan,
  voidMovement,
  voidSettlement,
} from "@odentia/services"
import type { Context } from "hono"

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

  app.post("/shifts", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        currency,
        openingCents: z.number().int().min(0).max(2147483647).optional(),
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => openShift(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/shifts/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getShiftDetail(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/shifts/:id/movements", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        direction: z.enum(["ingreso", "egreso"]),
        kind: z.enum(["aporte", "retiro", "ajuste", "devolucion"]),
        amountCents: cents,
        concept: z.string().trim().min(1).max(500),
        method: z.string().max(60).nullish(),
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

  app.post("/shifts/:id/payments", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z.object({ paymentId: z.uuid() }).strict().safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        registerPaymentInShift(tx, orgId, userId, c.req.param("id"), parsed.data.paymentId),
      ),
    )
  })

  app.post("/shifts/:id/close", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    // El cierre con arqueo lo supervisa dueño/admin; el cajero opera el turno.
    if (memberRole !== "owner" && memberRole !== "admin")
      return c.json(errorBody(c, "FORBIDDEN", "Solo dueño/admin pueden cerrar el turno"), 403)
    const parsed = z
      .object({
        countedCents: z.number().int().min(0).max(2147483647),
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        closeShift(tx, orgId, userId, c.req.param("id"), {
          countedCents: parsed.data.countedCents,
          notes: parsed.data.notes,
        }),
      ),
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

  // --- Proveedores y gastos ------------------------------------------------------
  app.get("/suppliers", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSuppliers(tx, orgId)),
    )
  })

  app.post("/suppliers", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(200),
        docType: z.enum(["RUC", "DNI", "CE", "pasaporte", "otro"]).optional(),
        docNumber: z.string().max(40).nullish(),
        email: z.string().max(200).nullish(),
        phone: z.string().max(40).nullish(),
        address: z.string().max(500).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createSupplier(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/expenses", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid().optional(),
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
        supplierId: z.uuid().nullish(),
        concept: z.string().trim().min(1).max(500),
        amountCents: cents,
        currency,
        spentAt: isoDateTime.nullish(),
        receiptKind: z.enum(["boleta", "factura", "recibo", "nota", "ninguno"]).optional(),
        receiptNumber: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
        shiftId: z.uuid().nullish(),
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
    const parsed = z.object({ patientId: z.uuid().optional() }).safeParse(c.req.query())
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

  // --- Planes de cuotas ---------------------------------------------------------------
  app.get("/installment-plans", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ patientId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listInstallmentPlans(tx, orgId, parsed.data)),
    )
  })

  app.post("/installment-plans", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        patientId: z.uuid(),
        chargeId: z.uuid(),
        installments: z.number().int().min(1).max(60),
        firstDueAt: isoDay,
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { patientId, ...rest } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        createInstallmentPlan(tx, orgId, userId, patientId, rest),
      ),
    )
  })

  app.post("/installment-plans/:id/refresh", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        refreshInstallmentPlan(tx, orgId, userId, c.req.param("id")),
      ),
    )
  })

  app.post("/installment-plans/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidInstallmentPlan(tx, orgId, userId, c.req.param("id"), parsed.data),
      ),
    )
  })

  // --- Comisiones -------------------------------------------------------------------------
  app.get("/commission-rules", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ professionalUserId: z.string().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listCommissionRules(tx, orgId, parsed.data)),
    )
  })

  app.post("/commission-rules", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        base: z.enum(["cobrado", "produccion"]),
        rateBps: z.number().int().min(0).max(10000),
        serviceId: z.uuid().nullish(),
        branchId: z.uuid().nullish(),
        validFrom: isoDay.nullish(),
        validTo: isoDay.nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => upsertCommissionRule(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/commissions/preview", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        base: z.enum(["cobrado", "produccion"]),
        from: isoDay,
        to: isoDay,
        currency,
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => previewCommissions(tx, orgId, parsed.data)),
    )
  })

  app.post("/commissions/settle", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        professionalUserId: z.string().min(1),
        base: z.enum(["cobrado", "produccion"]),
        from: isoDay,
        to: isoDay,
        currency,
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => settleCommissions(tx, orgId, userId, parsed.data)),
    )
  })

  app.get("/settlements", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ professionalUserId: z.string().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSettlements(tx, orgId, parsed.data)),
    )
  })

  app.get("/settlements/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getSettlementDetail(tx, orgId, c.req.param("id"))),
    )
  })

  app.post("/settlements/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidSettlement(tx, orgId, userId, c.req.param("id"), parsed.data),
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
