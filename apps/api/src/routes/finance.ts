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
  addCashMovement,
  closeCashWindow,
  createExpense,
  DEBT_SORTS,
  getCashState,
  getClosureSheet,
  getDayMovements,
  getDebts,
  getTicketReceiptById,
  listDebts,
  listTickets,
  TICKET_SORTS,
  TICKET_STATES,
  dismissExpenseGap,
  EXPENSE_CATEGORIES,
  getMonthExpenses,
  getPurchasesToPay,
  listClosures,
  listExpenses,
  listSaleProducts,
  payPurchaseOrder,
  voidExpense,
  voidMovement,
  voidSupplierCreditUse,
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
  // Ingresar o retirar efectivo (único movimiento manual). Va por sede: la
  // caja nace sola si aún no existía.
  app.post("/cash/movements", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        kind: z.enum(["aporte", "retiro"]),
        amountCents: cents,
        concept: z.string().trim().min(1).max(500),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => addCashMovement(tx, orgId, userId, parsed.data)),
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
        // La ventana que se contó (o null si la sede aún no tenía caja):
        // repetir el envío devuelve el mismo cierre, no abre otro.
        shiftId: z.uuid().nullable(),
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
        // Página siguiente: `closedAt` del último cierre ya recibido.
        before: isoDateTime.optional(),
        // `descuadre`: solo los que no cuadraron.
        result: z.enum(["descuadre"]).optional(),
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

  // «+ Agregar producto» en «Cobrar» (ADR 0067): lo que se vende, con su
  // precio y lo que hay en la sede del cobro. Es de quien cobra; nunca el costo.
  app.get("/sale-products", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid({ error: "Elige la sede del cobro" }),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      })
      .strict()
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listSaleProducts(tx, orgId, parsed.data)),
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

  // Deudas de una sede por páginas, con búsqueda, antigüedad y orden.
  app.get("/debts/list", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        q: z.string().max(200).optional(),
        age: z.enum(["30", "90"]).optional(),
        when: z.enum(["hoy"]).optional(),
        sort: z.enum(DEBT_SORTS).optional(),
        cursor: z.string().max(20).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => listDebts(tx, orgId, parsed.data)),
    )
  })

  // --- Cobros: todos los tickets de la sede ------------------------------------------
  // Medios y quién cobró van separados por comas: `methods=<id>,<id>`.
  const idList = z
    .string()
    .max(2000)
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
  app.get("/tickets", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        q: z.string().max(200).optional(),
        from: isoDay.optional(),
        to: isoDay.optional(),
        methods: idList.optional(),
        cashiers: idList.optional(),
        state: z.enum(TICKET_STATES).optional(),
        sort: z.enum(TICKET_SORTS).optional(),
        cursor: z.string().max(500).optional(),
        limit: z.coerce.number().int().min(1).max(100).optional(),
      })
      .strict()
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { methods, cashiers, ...query } = parsed.data
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        listTickets(tx, orgId, {
          ...query,
          ...(methods ? { methodIds: methods } : {}),
          ...(cashiers ? { cashierIds: cashiers } : {}),
        }),
      ),
    )
  })

  // Un ticket por su identificador: la lista y el buscador rápido lo abren sin saber de quién es.
  app.get("/tickets/:id", async (c) => {
    const { orgId } = orgContextOf(c)
    const params = z.object({ id: z.uuid() }).safeParse(c.req.param())
    if (!params.success) return validationError(c, params.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getTicketReceiptById(tx, orgId, params.data.id)),
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
  // Gastos de un mes con su total por tipo (el mes es el de la clínica).
  app.get("/expenses/month", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        branchId: z.uuid().optional(),
        q: z.string().max(200).optional(),
        category: z.enum(EXPENSE_CATEGORIES).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => getMonthExpenses(tx, orgId, parsed.data)),
    )
  })

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
        // El pago del impuesto de lo cobrado (ADR 0083): solo con el tipo «Impuestos».
        salesTax: z.boolean().optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => createExpense(tx, orgId, userId, parsed.data)),
    )
  })

  // --- Compras de Inventario (ADR 0061): pagarlas es un gasto de Materiales enlazado ---------
  // Lo que hay que pagar: recibidas sin pagar, lo que aún no llega y lo que se tiene a favor.
  app.get("/purchases", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z.object({ branchId: z.uuid().optional() }).safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getPurchasesToPay(tx, orgId, parsed.data)))
  })

  // Registrar el pago de una compra: en partes, por adelantado o con lo que se tiene a favor.
  app.post("/purchases/:orderId/payments", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        amountCents: z.number().int().min(0).max(2147483647),
        creditCents: z.number().int().min(0).max(2147483647).optional(),
        spentAt: isoDateTime.nullish(),
        fromCash: z.boolean().optional(),
        receiptKind: z.string().trim().min(1).max(60).optional(),
        receiptNumber: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
        expectedDueCents: z.number().int().min(0).optional(),
        // Lo pagado que vio la pantalla: un envío repetido no paga dos veces.
        expectedPaidCents: z.number().int().min(0).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const orderId = z.uuid().safeParse(c.req.param("orderId"))
    if (!orderId.success) return validationError(c, orderId.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => payPurchaseOrder(tx, orgId, userId, { ...parsed.data, orderId: orderId.data })),
    )
  })

  // Deshacer el uso de lo que se tenía a favor con un proveedor.
  app.post("/supplier-credit-uses/:id/void", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const id = z.uuid().safeParse(c.req.param("id"))
    if (!id.success) return validationError(c, id.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => voidSupplierCreditUse(tx, orgId, userId, id.data, parsed.data)),
    )
  })

  // «No hubo ese gasto» (Reportes › Finanzas › Puede faltar un gasto).
  app.post("/expense-gaps", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        category: z.enum(EXPENSE_CATEGORIES),
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        branchId: z.uuid().nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () => withOrgContext(deps.db, orgId, (tx) => dismissExpenseGap(tx, orgId, userId, parsed.data)))
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

  return app
}
