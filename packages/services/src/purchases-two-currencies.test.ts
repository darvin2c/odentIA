/**
 * Gastos, compras y margen con dos monedas: un gasto suelto lleva moneda y cambio; pagar
 * una compra puede cruzar monedas (USD 1,500 pagados con S/ 5,640 la dejan al día) y sale
 * de la caja de lo que salió; el saldo de una compra sigue en su moneda; el margen dice el
 * costo en la moneda del material y lo que queda en la del servicio. Y una clínica que no
 * activó la segunda moneda sigue igual.
 */
import { randomUUID } from "node:crypto"
import { serviceCatalog } from "@odentia/db/schema/clinical"
import { cashMovement, expense } from "@odentia/db/schema/finance"
import { and, eq } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { runArgosQuery } from "./argos-query.js"
import { twoCurrencyClinic } from "./exam-two-currencies.js"
import {
  addCashMovement,
  createExpense,
  getCashState,
  getMonthExpenses,
  payPurchaseOrder,
  voidExpense,
} from "./finance.js"
import {
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createReorderDrafts,
  createSupplier,
  getPurchaseOrder,
  listSuppliers,
  receivePurchaseOrder,
  updatePurchaseOrder,
} from "./inventory.js"
import { expensesMany, getReportFinance } from "./report-finance.js"
import {
  listServiceMaterials,
  serviceMaterialSummaries,
  setServiceMaterials,
} from "./service-materials.js"
import { appDb, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Clinic = Awaited<ReturnType<typeof twoCurrencyClinic>>

const dayAround = () => {
  const now = new Date()
  return { start: new Date(now.getTime() - 86_400_000), end: new Date(now.getTime() + 86_400_000) }
}

const put = (c: Clinic, currency: string, amountCents: number) =>
  c.run((tx) =>
    addCashMovement(tx, c.orgId, c.actor, {
      branchId: c.branchId,
      kind: "aporte",
      amountCents,
      currency,
      concept: "Para la prueba",
    }),
  )
const cashIn = async (c: Clinic, currency: string) =>
  (await c.run((tx) => getCashState(tx, c.orgId, { branchId: c.branchId, currency })))
    .cashOnHandCents
const spent = async (c: Clinic) => {
  const [rows] = await c.run((tx) => expensesMany(tx, c.orgId, [dayAround()]))
  return rows?.reduce((sum, row) => sum + row.totalCents, 0) ?? 0
}
const expenseOf = async (id: string) => {
  const [row] = await ownerDb.select().from(expense).where(eq(expense.id, id))
  return row!
}

/** Una compra pedida y recibida, en la moneda que se diga. */
async function received(
  c: Clinic,
  input: {
    supplierId?: string
    currency?: string
    productId?: string
    quantity?: number
    unitCostCents: number
  },
) {
  const supplierId =
    input.supplierId ??
    (
      await c.run((tx) =>
        createSupplier(tx, c.orgId, c.actor, { name: `Dental ${randomUUID().slice(0, 8)}` }),
      )
    ).id
  const productId =
    input.productId ??
    (
      await c.run((tx) =>
        createProduct(tx, c.orgId, c.actor, {
          name: `Implante ${randomUUID().slice(0, 8)}`,
          unit: "unidad",
        }),
      )
    ).id
  const quantity = input.quantity ?? 1
  const order = await c.run((tx) =>
    createPurchaseOrder(tx, c.orgId, c.actor, {
      supplierId,
      branchId: c.branchId,
      mode: "pedir",
      ...(input.currency ? { currency: input.currency } : {}),
      lines: [{ productId, quantity, unitCostCents: input.unitCostCents }],
    }),
  )
  await c.run((tx) =>
    receivePurchaseOrder(tx, c.orgId, c.actor, order.id, [{ productId, quantity }], randomUUID()),
  )
  return { orderId: order.id, supplierId, productId }
}

describe("un gasto suelto", () => {
  it("en dólares a 3.75: lleva su valor y sale de la caja de dólares", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "USD", 100_000)
    await put(c, "PEN", 100_000)
    const row = await c.run((tx) =>
      createExpense(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        category: "Alquiler",
        concept: "Alquiler de noviembre",
        amountCents: 50_000,
        currency: "USD",
        exchangeRate: "3.75",
        fromCash: true,
      }),
    )
    expect(row).toMatchObject({
      amountCents: 50_000,
      currency: "USD",
      tenderCents: null,
      tenderCurrency: null,
      businessCents: 187_500,
    })
    expect(Number(row.exchangeRate)).toBe(3.75)
    expect(await cashIn(c, "USD")).toBe(50_000)
    expect(await cashIn(c, "PEN")).toBe(100_000)
    // Reportes lo cuenta por su valor, con el cambio que se dijo, aunque el de hoy cambie.
    expect(await spent(c)).toBe(187_500)
  })

  it("sin decir el cambio se congela el de hoy, y en moneda del negocio no guarda nada", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const dollars = await c.run((tx) =>
      createExpense(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        concept: "Laboratorio",
        amountCents: 1_000,
        currency: "USD",
      }),
    )
    expect(dollars).toMatchObject({ businessCents: 3_750 })
    expect(Number(dollars.exchangeRate)).toBe(3.75)
    const soles = await c.run((tx) =>
      createExpense(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        concept: "Agua",
        amountCents: 1_000,
        currency: "PEN",
      }),
    )
    expect(soles).toMatchObject({
      tenderCents: null,
      tenderCurrency: null,
      exchangeRate: null,
      businessCents: null,
    })
  })

  it("no se gasta en una tercera moneda, ni con un cambio que no se entiende", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await expect(
      c.run((tx) =>
        createExpense(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          concept: "Euros",
          amountCents: 100,
          currency: "EUR",
        }),
      ),
    ).rejects.toMatchObject({ fields: { currency: expect.any(String) } })
    await expect(
      c.run((tx) =>
        createExpense(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          concept: "Mal cambio",
          amountCents: 100,
          currency: "USD",
          exchangeRate: "tres",
        }),
      ),
    ).rejects.toMatchObject({ fields: { exchangeRate: expect.any(String) } })
  })

  it("el impuesto de lo cobrado se paga en moneda del negocio", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await expect(
      c.run((tx) =>
        createExpense(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          category: "Impuestos",
          concept: "IGV",
          amountCents: 100,
          currency: "USD",
          salesTax: true,
        }),
      ),
    ).rejects.toMatchObject({ fields: { salesTax: expect.any(String) } })
  })
})

describe("pagar una compra en dólares", () => {
  const dollarOrder = (c: Clinic) => received(c, { currency: "USD", unitCostCents: 150_000 })

  it("USD 1,500 pagados con S/ 5,640 la dejan al día: cancela dólares, sale de la caja de soles y vale lo pagado", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "PEN", 600_000)
    await put(c, "USD", 10_000)
    const { orderId } = await dollarOrder(c)

    const paid = await c.run((tx) =>
      payPurchaseOrder(tx, c.orgId, c.actor, {
        orderId,
        amountCents: 150_000,
        tenderCents: 564_000,
        tenderCurrency: "PEN",
        fromCash: true,
      }),
    )
    expect(paid.balance).toMatchObject({ currency: "USD", paidCents: 150_000, dueCents: 0 })
    expect(paid.expense).toMatchObject({
      amountCents: 150_000,
      currency: "USD",
      tenderCents: 564_000,
      tenderCurrency: "PEN",
      businessCents: 564_000,
    })
    // El cambio que resulta, a la vista: S/ 3.76 por USD 1, aunque el de hoy sea 3.75.
    expect(Number(paid.expense?.exchangeRate)).toBe(3.76)
    expect(await cashIn(c, "PEN")).toBe(600_000 - 564_000)
    expect(await cashIn(c, "USD")).toBe(10_000)
    const [movement] = await ownerDb
      .select()
      .from(cashMovement)
      .where(
        and(eq(cashMovement.organizationId, c.orgId), eq(cashMovement.expenseId, paid.expense!.id)),
      )
    expect(movement).toMatchObject({ kind: "gasto", amountCents: 564_000, currency: "PEN" })

    // Lo cargado aquí es lo que cuentan Reportes y Argos.
    expect(await spent(c)).toBe(564_000)
    const now = new Date()
    const month = await c.run((tx) =>
      getMonthExpenses(tx, c.orgId, {
        year: Number(
          new Intl.DateTimeFormat("en", { timeZone: "America/Lima", year: "numeric" }).format(now),
        ),
        month: Number(
          new Intl.DateTimeFormat("en", { timeZone: "America/Lima", month: "numeric" }).format(now),
        ),
      }),
    )
    expect(month).toMatchObject({
      currency: "PEN",
      totalCents: 564_000,
      byCategory: [{ category: "Materiales", cents: 564_000 }],
    })
    expect(month.expenses[0]).toMatchObject({
      tenderCents: 564_000,
      tenderCurrency: "PEN",
      fromCash: true,
    })
    const { rows } = await runArgosQuery(appDb, {
      orgId: c.orgId,
      memberRole: "owner",
      query: "select monto, monto_otra_moneda, otra_moneda from gastos",
    })
    expect(rows).toEqual([{ monto: 5640, monto_otra_moneda: null, otra_moneda: null }])

    // El pago en la compra dice lo que salió.
    const order = await c.run((tx) => getPurchaseOrder(tx, c.orgId, orderId, { prices: true }))
    expect(order.payments?.[0]).toMatchObject({
      amountCents: 150_000,
      tenderCents: 564_000,
      tenderCurrency: "PEN",
    })
  }, 120_000)

  it("anular ese pago: la compra vuelve a deberlo, vuelve a la caja de soles y deja de contar", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "PEN", 600_000)
    const { orderId } = await dollarOrder(c)
    const paid = await c.run((tx) =>
      payPurchaseOrder(tx, c.orgId, c.actor, {
        orderId,
        amountCents: 150_000,
        tenderCents: 564_000,
        tenderCurrency: "PEN",
        fromCash: true,
      }),
    )
    await c.run((tx) =>
      voidExpense(tx, c.orgId, c.actor, paid.expense!.id, { reason: "Se registró mal" }),
    )

    expect(await cashIn(c, "PEN")).toBe(600_000)
    expect(await spent(c)).toBe(0)
    const order = await c.run((tx) => getPurchaseOrder(tx, c.orgId, orderId, { prices: true }))
    expect(order.balance).toMatchObject({ paidCents: 0, dueCents: 150_000 })
    // Lo guardado no se reescribe: sigue diciendo lo que pasó, marcado como anulado.
    expect(await expenseOf(paid.expense!.id)).toMatchObject({
      tenderCents: 564_000,
      businessCents: 564_000,
      voidReason: "Se registró mal",
    })
  })

  it("pagada en dólares también lleva su valor, con el cambio que se dijo y de la caja de dólares", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "USD", 200_000)
    const { orderId } = await dollarOrder(c)
    const paid = await c.run((tx) =>
      payPurchaseOrder(tx, c.orgId, c.actor, {
        orderId,
        amountCents: 150_000,
        exchangeRate: "3.8",
        fromCash: true,
      }),
    )
    expect(paid.expense).toMatchObject({
      tenderCents: null,
      tenderCurrency: null,
      businessCents: 570_000,
    })
    expect(Number(paid.expense?.exchangeRate)).toBe(3.8)
    expect(await cashIn(c, "USD")).toBe(50_000)
    expect(paid.balance).toMatchObject({ dueCents: 0 })
  })

  it("el cruce también vale al revés: una compra en soles pagada en dólares vale lo que cancela", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "USD", 10_000)
    const { orderId } = await received(c, { unitCostCents: 37_600 })
    const paid = await c.run((tx) =>
      payPurchaseOrder(tx, c.orgId, c.actor, {
        orderId,
        amountCents: 37_600,
        tenderCents: 10_000,
        tenderCurrency: "USD",
        fromCash: true,
      }),
    )
    expect(paid.expense).toMatchObject({
      amountCents: 37_600,
      currency: "PEN",
      tenderCents: 10_000,
      tenderCurrency: "USD",
      businessCents: 37_600,
    })
    expect(Number(paid.expense?.exchangeRate)).toBe(3.76)
    expect(await cashIn(c, "USD")).toBe(0)
    expect(paid.balance).toMatchObject({ dueCents: 0 })
  })

  it("lo que no alcanza en la caja de lo que salió se dice junto a lo que salió", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    await put(c, "PEN", 1_000)
    await put(c, "USD", 500_000)
    const { orderId } = await dollarOrder(c)
    await expect(
      c.run((tx) =>
        payPurchaseOrder(tx, c.orgId, c.actor, {
          orderId,
          amountCents: 150_000,
          tenderCents: 564_000,
          tenderCurrency: "PEN",
          fromCash: true,
        }),
      ),
    ).rejects.toMatchObject({
      code: "INSUFFICIENT_CASH",
      fields: { tenderCents: expect.any(String) },
    })
  })

  it("lo que salió va en la otra moneda, con su importe y sin otro cambio", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const { orderId } = await dollarOrder(c)
    const pay = (input: Partial<Parameters<typeof payPurchaseOrder>[3]>) =>
      c.run((tx) =>
        payPurchaseOrder(tx, c.orgId, c.actor, { orderId, amountCents: 150_000, ...input }),
      )
    await expect(pay({ tenderCents: 100, tenderCurrency: "USD" })).rejects.toMatchObject({
      fields: { tenderCurrency: expect.any(String) },
    })
    await expect(pay({ tenderCents: 100, tenderCurrency: "EUR" })).rejects.toMatchObject({
      fields: { tenderCurrency: expect.any(String) },
    })
    await expect(pay({ tenderCents: 564_000 })).rejects.toMatchObject({
      fields: { tenderCurrency: expect.any(String) },
    })
    await expect(pay({ tenderCurrency: "PEN" })).rejects.toMatchObject({
      fields: { tenderCents: expect.any(String) },
    })
    await expect(
      pay({ tenderCents: 564_000, tenderCurrency: "PEN", exchangeRate: "3.75" }),
    ).rejects.toMatchObject({
      fields: { exchangeRate: expect.any(String) },
    })
  })
})

describe("proveedores y pedidos", () => {
  it("un proveedor al que se le deben dólares no dice que está al día", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const { supplierId } = await received(c, { currency: "USD", unitCostCents: 150_000 })
    const [row] = (await c.run((tx) => listSuppliers(tx, c.orgId, { prices: true }))).filter(
      (item) => item.id === supplierId,
    )
    expect(row).toMatchObject({
      currency: "PEN",
      dueCents: 0,
      creditCents: 0,
      otherBalances: [{ currency: "USD", dueCents: 150_000, creditCents: 0 }],
    })
    // Sin permiso de precios no viaja nada de esto.
    const [blind] = (await c.run((tx) => listSuppliers(tx, c.orgId))).filter(
      (item) => item.id === supplierId,
    )
    expect(blind).not.toHaveProperty("otherBalances")
  })

  it("lo pagado de más en dólares queda a favor en dólares", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const { orderId, supplierId } = await received(c, { currency: "USD", unitCostCents: 10_000 })
    await c.run((tx) => payPurchaseOrder(tx, c.orgId, c.actor, { orderId, amountCents: 15_000 }))
    const [row] = (await c.run((tx) => listSuppliers(tx, c.orgId, { prices: true }))).filter(
      (item) => item.id === supplierId,
    )
    expect(row?.otherBalances).toEqual([{ currency: "USD", dueCents: 0, creditCents: 5_000 }])
  })

  it("«Armar pedidos» agrupa por proveedor y moneda: US$ 400 no se vuelven S/ 400", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const vendor = await c.run((tx) =>
      createSupplier(tx, c.orgId, c.actor, { name: "Dental Import" }),
    )
    const need = [{ branchId: c.branchId, minQuantity: 10 }]
    const implant = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Implante", unit: "unidad", minimums: need }),
    )
    const gloves = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Guantes", unit: "guante", minimums: need }),
    )
    const needle = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Aguja", unit: "aguja", minimums: need }),
    )
    await received(c, {
      supplierId: vendor.id,
      currency: "USD",
      productId: implant.id,
      unitCostCents: 40_000,
    })
    await received(c, { supplierId: vendor.id, productId: gloves.id, unitCostCents: 30 })
    await received(c, {
      supplierId: vendor.id,
      currency: "USD",
      productId: needle.id,
      unitCostCents: 500,
    })

    const result = await c.run((tx) => createReorderDrafts(tx, c.orgId, c.actor, c.branchId))
    expect(result.drafts).toHaveLength(2)
    const orders = await Promise.all(
      result.drafts.map((draft) =>
        c.run((tx) => getPurchaseOrder(tx, c.orgId, draft.id, { prices: true })),
      ),
    )
    const dollars = orders.find((order) => order.currency === "USD")
    const soles = orders.find((order) => order.currency === "PEN")
    expect(dollars?.status).toBe("borrador")
    expect(
      dollars?.lines.map((line) => line.unitCostCents).sort((a, b) => Number(a) - Number(b)),
    ).toEqual([500, 40_000])
    expect(soles?.lines.map((line) => [line.productId, line.unitCostCents])).toEqual([
      [gloves.id, 30],
    ])
    expect(dollars?.supplierId).toBe(vendor.id)
    expect(soles?.supplierId).toBe(vendor.id)
  })

  it("la moneda de una compra se cambia solo en borrador, con los precios de nuevo", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const vendor = await c.run((tx) =>
      createSupplier(tx, c.orgId, c.actor, { name: "Dental Import" }),
    )
    const item = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Implante", unit: "unidad" }),
    )
    const draft = await c.run((tx) =>
      createPurchaseOrder(tx, c.orgId, c.actor, {
        supplierId: vendor.id,
        branchId: c.branchId,
        lines: [{ productId: item.id, quantity: 1, unitCostCents: 40_000 }],
      }),
    )
    expect(draft.currency).toBe("PEN")
    // Sin precios nuevos, S/ 400 no pasan a ser USD 400.
    await expect(
      c.run((tx) => updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, { currency: "USD" })),
    ).rejects.toMatchObject({ fields: { currency: expect.any(String) } })
    const moved = await c.run((tx) =>
      updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, {
        currency: "USD",
        lines: [{ productId: item.id, quantity: 1, unitCostCents: 10_000 }],
      }),
    )
    expect(moved.currency).toBe("USD")
    await expect(
      c.run((tx) => updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, { currency: "EUR" })),
    ).rejects.toMatchObject({ fields: { currency: expect.any(String) } })

    await c.run((tx) => confirmPurchaseOrder(tx, c.orgId, c.actor, draft.id))
    await expect(
      c.run((tx) => updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, { currency: "PEN" })),
    ).rejects.toMatchObject({ status: 409 })
    expect((await c.run((tx) => getPurchaseOrder(tx, c.orgId, draft.id))).currency).toBe("USD")
  })

  it("no se compra en una tercera moneda", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const vendor = await c.run((tx) =>
      createSupplier(tx, c.orgId, c.actor, { name: "Dental Import" }),
    )
    const item = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Implante", unit: "unidad" }),
    )
    await expect(
      c.run((tx) =>
        createPurchaseOrder(tx, c.orgId, c.actor, {
          supplierId: vendor.id,
          branchId: c.branchId,
          currency: "EUR",
          lines: [{ productId: item.id, quantity: 1, unitCostCents: 100 }],
        }),
      ),
    ).rejects.toMatchObject({ fields: { currency: expect.any(String) } })
  })
})

describe("cuánto deja un servicio", () => {
  /** Un servicio con su precio y materiales, cada uno comprado en su moneda. */
  async function service(
    c: Clinic,
    price: { priceCents: number; currency: string },
    materials: Array<{ currency?: string; unitCostCents: number; quantity?: number }>,
  ) {
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name: `Implante ${randomUUID().slice(0, 8)}`, ...price })
      .returning()
    const items: Array<{ productId: string; quantity: number }> = []
    for (const material of materials) {
      const product = await c.run((tx) =>
        createProduct(tx, c.orgId, c.actor, {
          name: `Material ${randomUUID().slice(0, 8)}`,
          unit: "unidad",
          usedInCare: true,
        }),
      )
      await received(c, {
        currency: material.currency,
        productId: product.id,
        unitCostCents: material.unitCostCents,
      })
      items.push({ productId: product.id, quantity: material.quantity ?? 1 })
    }
    await c.run((tx) => setServiceMaterials(tx, c.orgId, c.actor, row!.id, items, { prices: true }))
    return row!.id
  }
  const read = (c: Clinic, id: string) =>
    c.run((tx) => listServiceMaterials(tx, c.orgId, id, { prices: true }))

  it("servicio e insumo en dólares: no hace falta ningún cambio", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const id = await service(c, { priceCents: 100_000, currency: "USD" }, [
      { currency: "USD", unitCostCents: 40_000 },
    ])
    const result = await read(c, id)
    expect(result.cost).toEqual({
      cents: 40_000,
      currency: "USD",
      unpriced: 0,
      shareOfPrice: 0.4,
      parts: [{ currency: "USD", cents: 40_000 }],
      estimated: false,
      leftCents: 60_000,
      rate: null,
    })
    expect(result.items[0]).toMatchObject({ costCents: 40_000, costCurrency: "USD" })
  })

  it("servicio en dólares con un material en soles: el margen va en dólares y es una estimación", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const id = await service(c, { priceCents: 100_000, currency: "USD" }, [
      { currency: "USD", unitCostCents: 40_000 },
      { unitCostCents: 30 },
    ])
    expect((await read(c, id)).cost).toEqual({
      cents: 40_008,
      currency: "USD",
      unpriced: 0,
      shareOfPrice: 40_008 / 100_000,
      parts: [
        { currency: "PEN", cents: 30 },
        { currency: "USD", cents: 40_000 },
      ],
      estimated: true,
      leftCents: 59_992,
      rate: "3.75",
    })
  })

  it("servicio en soles con el insumo en dólares: 50 % al cambio de hoy, no 0.01 %", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const id = await service(c, { priceCents: 300_000, currency: "PEN" }, [
      { currency: "USD", unitCostCents: 40_000 },
      { unitCostCents: 30 },
    ])
    const { cost } = await read(c, id)
    expect(cost).toMatchObject({
      cents: 150_030,
      currency: "PEN",
      estimated: true,
      leftCents: 149_970,
      rate: "3.75",
    })
    expect(cost?.shareOfPrice).toBeCloseTo(0.5001, 4)
    // La lista de servicios dice cada moneda por su lado.
    const summaries = await c.run((tx) =>
      serviceMaterialSummaries(tx, c.orgId, [id], { prices: true }),
    )
    expect(summaries.get(id)).toEqual({
      count: 2,
      cost: {
        cents: 30,
        currency: "PEN",
        unpriced: 0,
        parts: [
          { currency: "PEN", cents: 30 },
          { currency: "USD", cents: 40_000 },
        ],
      },
    })
  })

  it("una última compra a precio 0 no esconde la anterior", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb)
    const product = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Implante", unit: "unidad", usedInCare: true }),
    )
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name: "Implante", priceCents: 100_000, currency: "USD" })
      .returning()
    await c.run((tx) =>
      setServiceMaterials(tx, c.orgId, c.actor, row!.id, [{ productId: product.id, quantity: 1 }], {
        prices: true,
      }),
    )
    await received(c, { currency: "USD", productId: product.id, unitCostCents: 40_000 })
    await received(c, { currency: "USD", productId: product.id, unitCostCents: 0 })
    expect((await read(c, row!.id)).cost).toMatchObject({
      cents: 40_000,
      currency: "USD",
      unpriced: 0,
    })
  })

  it("lo comprado en una moneda que ya no es de la clínica no se suma", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    const product = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Implante", unit: "unidad", usedInCare: true }),
    )
    await received(c, { currency: "EUR", productId: product.id, unitCostCents: 40_000 })
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name: "Implante", priceCents: 100_000, currency: "PEN" })
      .returning()
    await c.run((tx) =>
      setServiceMaterials(tx, c.orgId, c.actor, row!.id, [{ productId: product.id, quantity: 1 }], {
        prices: true,
      }),
    )
    expect((await read(c, row!.id)).cost).toBeNull()
  })
})

describe("una clínica de una sola moneda", () => {
  it("guarda y paga como siempre, sin cambio ni cruce", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    await put(c, "PEN", 100_000)
    const row = await c.run((tx) =>
      createExpense(tx, c.orgId, c.actor, {
        branchId: c.branchId,
        concept: "Agua",
        amountCents: 1_000,
        fromCash: true,
      }),
    )
    expect(row).toMatchObject({
      currency: "PEN",
      tenderCents: null,
      tenderCurrency: null,
      exchangeRate: null,
      businessCents: null,
    })
    expect(await cashIn(c, "PEN")).toBe(99_000)
    await expect(
      c.run((tx) =>
        createExpense(tx, c.orgId, c.actor, {
          branchId: c.branchId,
          concept: "Agua",
          amountCents: 1_000,
          exchangeRate: "3.75",
        }),
      ),
    ).rejects.toMatchObject({ fields: { exchangeRate: expect.any(String) } })

    const { orderId, supplierId } = await received(c, { unitCostCents: 10_000 })
    await expect(
      c.run((tx) =>
        payPurchaseOrder(tx, c.orgId, c.actor, {
          orderId,
          amountCents: 10_000,
          tenderCents: 3_000,
          tenderCurrency: "USD",
        }),
      ),
    ).rejects.toMatchObject({ fields: { tenderCurrency: expect.any(String) } })
    const paid = await c.run((tx) =>
      payPurchaseOrder(tx, c.orgId, c.actor, { orderId, amountCents: 4_000 }),
    )
    expect(paid.expense).toMatchObject({
      tenderCents: null,
      exchangeRate: null,
      businessCents: null,
    })

    // El proveedor dice lo de siempre, sin nada de más.
    const [vendor] = (await c.run((tx) => listSuppliers(tx, c.orgId, { prices: true }))).filter(
      (item) => item.id === supplierId,
    )
    expect(vendor).toMatchObject({ currency: "PEN", dueCents: 6_000, creditCents: 0 })
    expect(vendor).not.toHaveProperty("otherBalances")
  })

  it("el costo de un servicio tiene la misma forma de siempre", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    const product = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Guantes", unit: "guante", usedInCare: true }),
    )
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name: "Limpieza", priceCents: 12_000, currency: "PEN" })
      .returning()
    await c.run((tx) =>
      setServiceMaterials(tx, c.orgId, c.actor, row!.id, [{ productId: product.id, quantity: 2 }], {
        prices: true,
      }),
    )
    await received(c, { productId: product.id, unitCostCents: 150 })
    const result = await c.run((tx) => listServiceMaterials(tx, c.orgId, row!.id, { prices: true }))
    expect(result.cost).toEqual({
      cents: 300,
      currency: "PEN",
      unpriced: 0,
      shareOfPrice: 300 / 12_000,
    })
    expect(result.items[0]).not.toHaveProperty("costCurrency")
    const summaries = await c.run((tx) =>
      serviceMaterialSummaries(tx, c.orgId, [row!.id], { prices: true }),
    )
    expect(summaries.get(row!.id)).toEqual({
      count: 1,
      cost: { cents: 300, currency: "PEN", unpriced: 0 },
    })
  })

  it("una última compra a precio 0 tampoco esconde la anterior aquí: es el error que se corrige", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    const product = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Guantes", unit: "guante", usedInCare: true }),
    )
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: c.orgId, name: "Limpieza", priceCents: 12_000, currency: "PEN" })
      .returning()
    await c.run((tx) =>
      setServiceMaterials(tx, c.orgId, c.actor, row!.id, [{ productId: product.id, quantity: 1 }], {
        prices: true,
      }),
    )
    await received(c, { productId: product.id, unitCostCents: 150 })
    await received(c, { productId: product.id, unitCostCents: 0 })
    const result = await c.run((tx) => listServiceMaterials(tx, c.orgId, row!.id, { prices: true }))
    expect(result.cost).toEqual({
      cents: 150,
      currency: "PEN",
      unpriced: 0,
      shareOfPrice: 150 / 12_000,
    })
  })

  it("«Armar pedidos» sigue en su moneda", async () => {
    const c = await twoCurrencyClinic(ownerDb, appDb, { rate: null })
    const need = [{ branchId: c.branchId, minQuantity: 10 }]
    const gloves = await c.run((tx) =>
      createProduct(tx, c.orgId, c.actor, { name: "Guantes", unit: "guante", minimums: need }),
    )
    await received(c, { productId: gloves.id, unitCostCents: 30 })
    const result = await c.run((tx) => createReorderDrafts(tx, c.orgId, c.actor, c.branchId))
    expect(result.drafts).toHaveLength(1)
    const order = await c.run((tx) =>
      getPurchaseOrder(tx, c.orgId, result.drafts[0]!.id, { prices: true }),
    )
    expect(order.currency).toBe("PEN")
  })
})
