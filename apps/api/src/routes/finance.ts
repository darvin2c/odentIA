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
import { patientLockRefusal } from "../lib/record-lock.js"
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
  ServiceError,
  ticketPatientId,
  listDebts,
  listTickets,
  TICKET_SORTS,
  TICKET_STATES,
  dismissExpenseGap,
  EXPENSE_CATEGORIES,
  EXPENSE_FILTER_TYPES,
  endRecurringExpense,
  getRecurringMonth,
  listRecurringPeople,
  payRecurringOccurrence,
  registerRecurringExpense,
  skipRecurringOccurrence,
  unskipRecurringOccurrence,
  updateRecurringExpense,
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
const reasonInput = z
  .object({
    reason: z
      .string({ error: "Escribe el motivo de la anulación." })
      .trim()
      .min(1, "Escribe el motivo de la anulación.")
      .max(2000, "Escribe el motivo en 2000 caracteres como mucho."),
  })
  .strict()

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
        concept: z.string().trim().min(1, "Cuenta para qué es el movimiento.").max(500, "Escribe como mucho 500 caracteres."),
        currency: currency.optional(),
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
    // El comprobante de una historia bloqueada se guarda, pero para los demás no existe (ADR 0080).
    const patientId = await withOrgContext(deps.db, orgId, (tx) => ticketPatientId(tx, orgId, params.data.id)).catch(
      (error) => {
        if (error instanceof ServiceError && error.status === 404) return null
        throw error
      },
    )
    const blocked = patientId ? await patientLockRefusal(c, deps.db, patientId, "Ticket no encontrado") : null
    if (blocked) return blocked
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
    // Un id que no es uuid no existe: se dice, no se convierte en un error interno.
    if (!z.uuid().safeParse(c.req.param("id")).success) return c.json(errorBody(c, "NOT_FOUND", "No existe"), 404)
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
    const { orgId, memberRole } = orgContextOf(c)
    const parsed = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        branchId: z.uuid().optional(),
        q: z.string().max(200).optional(),
        category: z.enum(EXPENSE_FILTER_TYPES).optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        getMonthExpenses(tx, orgId, parsed.data, { seesCommissions: canAccess(memberRole, "commissions.write") }),
      ),
    )
  })

  app.get("/expenses", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
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
      withOrgContext(deps.db, orgId, (tx) =>
        listExpenses(tx, orgId, parsed.data, { seesCommissions: canAccess(memberRole, "commissions.write") }),
      ),
    )
  })

  const recurringMonthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "El mes debe tener formato AAAA-MM")

  app.post("/expenses", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        branchId: z.uuid(),
        category: z.string().max(60).optional(),
        concept: z.string().trim().min(1, "Escribe en qué se gastó.").max(500, "Escribe como mucho 500 caracteres."),
        amountCents: cents,
        currency: currency.optional(),
        exchangeRate: z.string().max(40).optional(),
        spentAt: isoDateTime.nullish(),
        receiptKind: z.string().trim().min(1).max(60).optional(),
        receiptNumber: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
        fromCash: z.boolean().optional(),
        // El pago del impuesto de lo cobrado (ADR 0083): solo con el tipo «Impuestos».
        salesTax: z.boolean().optional(),
        // «Se repite»: la plantilla, y este gasto queda como su primera ocurrencia.
        repeat: z
          .object({
            everyMonths: z.union([z.literal(1), z.literal(6), z.literal(12)]),
            day: z.number().int().min(1).max(31),
            memberUserId: z.string().max(200).nullish(),
            // El mes que paga (el sueldo de octubre pagado en noviembre).
            month: recurringMonthKey.nullish(),
            // `false`: se anota sin pagar; queda por pagar desde ese mes, sin ningún gasto.
            paid: z.boolean().optional(),
            // Se paga al mes siguiente (el sueldo de noviembre, el 2 de diciembre).
            dueNextMonth: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    const { repeat, ...expenseInput } = parsed.data
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx): Promise<unknown> =>
        repeat
          ? registerRecurringExpense(tx, orgId, userId, { ...expenseInput, repeat })
          : createExpense(tx, orgId, userId, expenseInput),
      ),
    )
  })

  // --- Gastos que se repiten: lo por pagar del mes, pagar con un toque, «este mes no» ------------
  app.get("/expenses/recurring", async (c) => {
    const { orgId } = orgContextOf(c)
    const parsed = z
      .object({
        year: z.coerce.number().int().min(2000).max(2100),
        month: z.coerce.number().int().min(1).max(12),
        branchId: z.uuid().optional(),
      })
      .safeParse(c.req.query())
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => getRecurringMonth(tx, orgId, parsed.data)))
  })
  app.get("/expenses/recurring/people", async (c) => {
    const { orgId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    return runService(c, 200, () => withOrgContext(deps.db, orgId, (tx) => listRecurringPeople(tx, orgId)))
  })
  app.patch("/expenses/recurring/:id", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        concept: z.string().trim().min(1, "Escribe en qué se gasta.").max(500).optional(),
        amountCents: cents.optional(),
        day: z.number().int().min(1).max(31).optional(),
        memberUserId: z.string().max(200).nullish(),
        fromCash: z.boolean().optional(),
        lastMonth: recurringMonthKey.nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => updateRecurringExpense(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })
  app.post("/expenses/recurring/:id/end", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) => endRecurringExpense(tx, orgId, userId, c.req.param("id"))),
    )
  })
  app.post("/expenses/recurring/:id/pay", async (c) => {
    const { orgId, userId, memberRole } = orgContextOf(c)
    if (!canAccess(memberRole, "finance.write")) return forbid(c)
    const parsed = z
      .object({
        month: recurringMonthKey,
        amountCents: cents.optional(),
        fromCash: z.boolean().optional(),
        spentAt: isoDateTime.nullish(),
        receiptKind: z.string().trim().min(1).max(60).optional(),
        receiptNumber: z.string().max(60).nullish(),
        notes: z.string().max(2000).nullish(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 201, () =>
      withOrgContext(deps.db, orgId, (tx) => payRecurringOccurrence(tx, orgId, userId, c.req.param("id"), parsed.data)),
    )
  })
  for (const [path, action] of [
    ["skip", skipRecurringOccurrence],
    ["unskip", unskipRecurringOccurrence],
  ] as const) {
    app.post(`/expenses/recurring/:id/${path}`, async (c) => {
      const { orgId, userId, memberRole } = orgContextOf(c)
      if (!canAccess(memberRole, "finance.write")) return forbid(c)
      const parsed = z.object({ month: recurringMonthKey }).strict().safeParse(await c.req.json().catch(() => null))
      if (!parsed.success) return validationError(c, parsed.error.issues)
      return runService(c, 200, () =>
        withOrgContext(deps.db, orgId, (tx) => action(tx, orgId, userId, c.req.param("id"), parsed.data)),
      )
    })
  }

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
        // El cruce: lo que salió en la otra moneda; el cambio se calcula solo.
        tenderCents: z.number().int().min(1).max(2147483647).optional(),
        tenderCurrency: currency.optional(),
        exchangeRate: z.string().max(40).optional(),
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
    // Un id que no es uuid no existe: se dice, no se convierte en un error interno.
    if (!z.uuid().safeParse(c.req.param("id")).success) return c.json(errorBody(c, "NOT_FOUND", "No existe"), 404)
    const parsed = reasonInput.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return validationError(c, parsed.error.issues)
    return runService(c, 200, () =>
      withOrgContext(deps.db, orgId, (tx) =>
        voidExpense(tx, orgId, userId, c.req.param("id"), parsed.data, {
          allowPostClose: canAccess(memberRole, "finance.admin"),
        }),
      ),
    )
  })

  return app
}
