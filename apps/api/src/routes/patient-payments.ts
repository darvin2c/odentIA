import { withOrgContext } from "@odentia/db"
import { Hono } from "hono"
import { z } from "zod"
import { canAccess, orgContextOf } from "../lib/context.js"
import { errorBody } from "../lib/error.js"
import { type CrmDeps, runService, validationError } from "./helpers.js"
import { collectCharge, createCharge, getAccountSummary, getTicketReceipt, refundCredit, sendTicketReceiptByEmail, ServiceError, updateCharge, voidCharge, voidTicket } from "@odentia/services"
import type { Context } from "hono"

function forbid(c: Context) {
  return c.json(errorBody(c, "FORBIDDEN", "No tienes acceso a finanzas"), 403)
}

const cents = z.number().int().positive().max(2147483647)
const reasonInput = z.object({ reason: z.string().trim().min(1).max(2000) }).strict()
const collectInput = z.object({
  branchId: z.uuid(),
  payerContactId: z.uuid().nullish(),
  chargeIds: z.array(z.uuid()).nullish(),
  advanceCents: cents.nullish(),
  payments: z.array(z.object({
    paymentMethodId: z.uuid(),
    amountCents: cents,
    reference: z.string().max(200).nullish(),
  }).strict()).max(10).nullish(),
  cashReceivedCents: cents.nullish(),
  requestId: z.uuid(),
}).strict()
const chargeInput = z.object({
  branchId: z.uuid().nullish(),
  /** Línea aceptada de una propuesta: el cargo hereda descripción, precio acordado y promoción. */
  budgetItemId: z.uuid().nullish(),
  /**
   * «+ Agregar producto» (ADR 0067): el concepto toma nombre y precio de venta
   * × cantidad, exige la sede y descuenta de su almacén al crearse.
   */
  productId: z.uuid({ error: "Elige el producto de la lista" }).nullish(),
  quantity: z
    .number({ error: "Escribe la cantidad" })
    .int({ error: "La cantidad es un número entero" })
    .min(1, { error: "La cantidad va de 1 a 9999" })
    .max(9999, { error: "La cantidad va de 1 a 9999" })
    .nullish(),
  /** Clave del formulario de la venta: un reintento no vende dos veces. */
  requestId: z.uuid({ error: "No se pudo identificar esta venta: cierra el cobro y vuelve a abrirlo" }).nullish(),
  description: z.string().trim().min(1).max(2000).nullish(),
  amountCents: cents.nullish(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullish(),
  notes: z.string().max(4000).nullish(),
}).strict()
const updateChargeInput = z.object({
  amountCents: cents.nullish(),
  description: z.string().trim().min(1).max(2000).nullish(),
  promotionId: z.uuid().nullish(),
  // Obligatorio al cambiar importe o descripción (lo exige el servicio);
  // aplicar una promoción ya dice el motivo.
  reason: z.string().trim().min(1).max(2000).nullish(),
}).strict()
const refundInput = z.object({
  branchId: z.uuid(),
  amountCents: cents,
  paymentMethodId: z.uuid().nullish(),
  reason: z.string().trim().min(1).max(2000),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict()
export function createPatientPaymentsRoute(deps: Pick<CrmDeps, "db" | "storage">) {
  const app = new Hono()
  // La cuenta exige finance.read; cada mutación exige además finance.write.
  // Guarda acotado a las rutas de caja: montada en "/", un `use("*")` también
  // exigiría caja a las subrutas del paciente registradas después (responsables).
  for (const path of [
    "/:id/account",
    "/:id/collect",
    "/:id/charges",
    "/:id/charges/*",
    "/:id/tickets/*",
    "/:id/refunds",
    "/:id/receipts/*",
  ]) {
    app.use(path, async (c, next) => {
      const { memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "finance.read")) return forbid(c)
      await next()
    })
  }
  // Cuenta nueva: tres cifras por moneda, pendiente y cobros. Los servicios de
  // Portal y recorrido clínico leen `getPatientAccount` directo, sin ruta.
  app.get("/:id/account", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      getAccountSummary(tx, orgId, params.data.id)))
  })
  // Cobro atómico en un paso: ticket numerado, pagos por medio, aplicación
  // automática del crédito y reparto FIFO, todo en la caja de la sede.
  app.post("/:id/collect", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = collectInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    // El dominio no acepta null en opcionales: se normaliza en el borde.
    const body = parsed.data
    return runService(c, 201, async () => {
      const collected = await withOrgContext(deps.db, orgId, tx =>
        collectCharge(tx, orgId, userId, params.data.id, {
          branchId: body.branchId,
          payerContactId: body.payerContactId ?? undefined,
          chargeIds: body.chargeIds ?? undefined,
          advanceCents: body.advanceCents ?? undefined,
          payments: (body.payments ?? []).map((p) => ({
            paymentMethodId: p.paymentMethodId,
            amountCents: p.amountCents,
            reference: p.reference ?? undefined,
          })),
          cashReceivedCents: body.cashReceivedCents ?? undefined,
          requestId: body.requestId,
        }))
      // El comprobante sale solo por correo (decisión 20 v2), después de cobrar y
      // aparte: si el envío falla, el cobro ya quedó. Un reintento no lo repite.
      if (collected.duplicate) return { ...collected, receipt: null }
      const receipt = await withOrgContext(deps.db, orgId, tx =>
        sendTicketReceiptByEmail(tx, orgId, userId, params.data.id, collected.ticket.id, { storage: deps.storage }),
      ).catch((error: unknown) => {
        // El cobro ya quedó: un fallo del envío no lo deshace ni lo hace parecer fallido.
        if (!(error instanceof ServiceError)) console.error("cobro: el comprobante no salió por correo", error)
        return {
          sent: null,
          reason: "sin_conexion" as const,
          text: `No se pudo enviar el comprobante${error instanceof ServiceError ? `: ${error.message}` : ""}. Entrégalo impreso.`,
        }
      })
      return { ...collected, receipt }
    })
  })
  // Cargos de caja: concepto manual (fuera del tarifario, con o sin moneda),
  // cargo de una línea aceptada de la propuesta (hereda precio y promoción) o
  // producto que se vende (precio de venta × cantidad; sale de la sede).
  // Las fuentes clínicas las crea el cierre de la atención, no esta ruta.
  app.post("/:id/charges", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = chargeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const body = parsed.data
    const problem = body.productId
      ? body.budgetItemId
        ? "Un producto se cobra solo, sin la línea del presupuesto"
        : body.description || body.amountCents
          ? "El concepto y el importe de un producto salen de su precio de venta"
          : !body.branchId
            ? "Elige la sede del cobro: el producto sale de su almacén"
            : !body.requestId
              ? "No se pudo identificar esta venta: cierra el cobro y vuelve a abrirlo"
              : null
      : body.quantity != null || body.requestId != null
        ? "La cantidad solo va con un producto"
        : !body.budgetItemId && (!body.description || !body.amountCents)
          ? "Indica el concepto y el importe, o la línea aceptada"
          : null
    if (problem)
      return validationError(c, [{ code: "custom", path: [], message: problem, input: body } as never])
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      createCharge(tx, orgId, userId, params.data.id, {
        branchId: body.branchId ?? undefined,
        budgetItemId: body.budgetItemId ?? undefined,
        productId: body.productId ?? undefined,
        quantity: body.quantity ?? undefined,
        requestKey: body.requestId ?? undefined,
        description: body.description ?? undefined,
        amountCents: body.amountCents ?? undefined,
        currency: body.currency ?? undefined,
        notes: body.notes ?? undefined,
      })))
  })
  app.post("/:id/charges/:chargeId/update", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),chargeId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = updateChargeInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      updateCharge(tx, orgId, userId, params.data.id, params.data.chargeId, {
        amountCents: parsed.data.amountCents ?? undefined,
        description: parsed.data.description ?? undefined,
        // null quita la promoción; ausente la deja como está.
        promotionId: parsed.data.promotionId,
        reason: parsed.data.reason,
      })))
  })
  // Quitar un concepto. Si es un producto, vuelve al inventario de la sede.
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
  // Anular cobro: revierte todo en una acción. Tras el cierre solo administración.
  // Los productos no vuelven: sus conceptos quedan por cobrar.
  app.post("/:id/tickets/:ticketId/void", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid(),ticketId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      voidTicket(tx, orgId, userId, params.data.id, params.data.ticketId, {
        ...parsed.data,
        allowPostClose: canAccess(memberRole, "finance.admin"),
      })))
  })
  // Devolver dinero: solo saldo a favor, sale del efectivo de la caja del día.
  app.post("/:id/refunds", async c => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const params = z.object({id:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    const parsed = refundInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, tx =>
      refundCredit(tx, orgId, userId, params.data.id, parsed.data)))
  })
  // Snapshot del ticket para PDF e impresión (Documentos).
  app.get("/:id/receipts/:ticketId", async c => {
    const { orgId } = orgContextOf(c)
    const params = z.object({id:z.uuid(),ticketId:z.uuid()}).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, tx =>
      getTicketReceipt(tx, orgId, params.data.id, params.data.ticketId)))
  })
  return app
}
