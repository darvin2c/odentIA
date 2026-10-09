import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { getPatientAccount, createCharge, voidCharge, createPayment, applyPayment, voidPaymentApplication, refundPayment, voidPayment } from "@odentia/services"
import type { Context } from "hono"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a finanzas"), 403)
}

const cents = z.number().int().positive().max(2147483647)
const currency = z.string().regex(/^[A-Z]{3}$/)
const chargeInput = z.object({budgetItemId:z.uuid().nullish(),encounterProcedureId:z.uuid().nullish(),planItemId:z.uuid().nullish(),description:z.string().trim().min(1).max(2000).optional(),amountCents:cents.optional(),currency:currency.optional(),dueAt:z.iso.datetime({offset:true}).nullish(),notes:z.string().max(4000).nullish()}).strict()
const paymentInput = z.object({payerContactId:z.uuid().nullish(),amountCents:cents,currency,paidAt:z.iso.datetime({offset:true}),method:z.enum(["efectivo","tarjeta","transferencia","yape","plin","otro"]),reference:z.string().max(200).nullish(),notes:z.string().max(4000).nullish(),shiftId:z.uuid().nullish()}).strict()
const applyInput = z.object({chargeId:z.uuid(),amountCents:cents}).strict()
const refundInput = z.object({amountCents:cents,reason:z.string().trim().min(1).max(2000),refundedAt:z.iso.datetime({offset:true}).optional()}).strict()
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const paymentVoidInput = z.object({ reason: z.string().trim().min(1).max(2000), compensateShiftId: z.uuid().nullish() }).strict()
export function createPatientPaymentsRoute(deps: Pick<CrmDeps, "db">) {
  const app = new Hono()
  // La cuenta exige finance.read; cada mutación exige además finance.write.
  // Guarda acotado a las rutas de caja: montada en "/", un `use("*")` también
  // exigiría caja a las subrutas del paciente registradas después (responsables).
  for (const path of [
    "/:id/account",
    "/:id/charges",
    "/:id/charges/*",
    "/:id/payments",
    "/:id/payments/*",
    "/:id/payment-applications/*",
  ]) {
    app.use(path, async (c, next) => {
      const { memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
      await next()
    })
  }
  app.get("/:id/account", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      getPatientAccount(tx, orgId, params.data.id)))
  })
  app.post("/:id/charges", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = chargeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      createCharge(tx, orgId, userId, params.data.id, parsed.data)))
  })
  app.post("/:id/charges/:chargeId/void", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),chargeId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      voidCharge(tx, orgId, userId, params.data.id, params.data.chargeId, parsed.data)))
  })
  app.post("/:id/payments", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = paymentInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      createPayment(tx, orgId, userId, params.data.id, parsed.data)))
  })
  app.post("/:id/payments/:paymentId/applications", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),paymentId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = applyInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      applyPayment(tx, orgId, userId, params.data.id, params.data.paymentId, parsed.data)))
  })
  app.post("/:id/payment-applications/:applicationId/void", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),applicationId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      voidPaymentApplication(tx, orgId, userId, params.data.id, params.data.applicationId, parsed.data)))
  })
  app.post("/:id/payments/:paymentId/refunds", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),paymentId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = refundInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      refundPayment(tx, orgId, userId, params.data.id, params.data.paymentId, parsed.data)))
  })
  app.post("/:id/payments/:paymentId/void", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),paymentId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = paymentVoidInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      voidPayment(tx, orgId, userId, params.data.id, params.data.paymentId, parsed.data)))
  })
  return app
}
