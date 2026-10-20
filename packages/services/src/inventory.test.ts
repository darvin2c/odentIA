/**
 * Inventario por sede (ADR 0067) y lo que la fase 1 dejó cuidado:
 * - Recepciones idempotentes por clave, aunque completen la orden; otro
 *   contenido con la misma clave es un conflicto sin efectos. Varios lotes por
 *   producto, unidades de compra × factor y el precio de la factura.
 * - «Ya la tengo», editar un borrador, «Cerrar con lo recibido» y su saldo.
 * - Lo que hay por sede: estado, orden por urgencia, filtros y conteos.
 * - Pegar la lista, contar, dar de baja, registrar uso, trasladar y agregar
 *   sin compra, cada uno con su clave.
 * - Pedir lo que falta: cuánto pedir en cajas y un borrador por proveedor.
 * - Sin precios, la respuesta no los trae.
 * - Movimientos con quién, sede y la cobertura como una sola fila.
 * - El aviso de lo que llegó va a quien lleva las compras, no a quien lo registró.
 * - El tipo de documento del proveedor es un código de la lista del país.
 */
import type { Db } from "@odentia/db"
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { encounter } from "@odentia/db/schema/clinical"
import { member, user } from "@odentia/db/schema/auth"
import { purchaseOrderLine, stockMovement, supplier as supplierTable } from "@odentia/db/schema/inventory"
import { branch, orgProfile } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq, like } from "drizzle-orm"
import { expect, it } from "vitest"
import { describeAuditEvent } from "./audit-words.js"
import { payPurchaseOrder, purchaseOrderLabel } from "./finance.js"
import {
  addStock,
  adjustLot,
  cancelPurchaseOrder,
  closePurchaseOrder,
  confirmPurchaseOrder,
  countStock,
  createProduct,
  createPurchaseOrder,
  createReorderDrafts,
  createSupplier,
  getProductDetail,
  getPurchaseOrder,
  getReorderSuggestions,
  importProducts,
  listMovements,
  listProducts,
  listPurchaseOrders,
  listSuppliers,
  previewProductImport,
  receivePurchaseOrder,
  registerUse,
  setProductActive,
  skuFromName,
  transferStock,
  updateProduct,
  updatePurchaseOrder,
  updateSupplier,
  writeOffExpired,
} from "./inventory.js"
import { defaultWarehouse } from "./inventory-stock.js"
import { supplierCredits } from "./purchase-balance.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

/** Un miembro de la clínica con su rol, para ver a quién llegan los avisos. */
async function memberOf(orgId: string, role: string, name = `Equipo ${role}`): Promise<string> {
  const id = randomUUID()
  await ownerDb.insert(user).values({ id, name, email: `${id}@example.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: id, role, createdAt: new Date() })
  return id
}

/** Una clínica propia por prueba (Lima, soles): dos sedes, un proveedor y quien lleva el inventario. */
async function clinic() {
  const orgId = randomUUID()
  await insertOrg(ownerDb, orgId, `inventario-${orgId.slice(0, 8)}`)
  const actor = await memberOf(orgId, "owner", "Ana Torres")
  const [sede] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Sede Miraflores" }).returning()
  const [otra] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Sede San Isidro" }).returning()
  const run = <T>(fn: (tx: Db) => Promise<T>) => withOrgContext(appDb, orgId, fn)
  const supplier = await run((tx) => createSupplier(tx, orgId, actor, { name: "Dental Andina SAC" }))
  /** Guantes: se usan por guante y se compran por caja de 100. */
  const gloves = (minimums: Array<{ branchId: string; minQuantity: number }> = []) =>
    run((tx) =>
      createProduct(tx, orgId, actor, { name: "Guantes de nitrilo", unit: "guante", purchaseUnit: "caja", purchaseFactor: 100, minimums }),
    )
  const order = (lines: Array<{ productId: string; quantity: number; unitCostCents?: number }>, mode: "borrador" | "pedir" = "pedir", supplierId = supplier.id) =>
    run((tx) => createPurchaseOrder(tx, orgId, actor, { supplierId, branchId: sede!.id, mode, lines }))
  const receive = (orderId: string, lines: Parameters<typeof receivePurchaseOrder>[4], key = randomUUID(), by = actor) =>
    run((tx) => receivePurchaseOrder(tx, orgId, by, orderId, lines, key))
  const detail = (productId: string, branchId = sede!.id, prices = true) => run((tx) => getProductDetail(tx, orgId, productId, { branchId, prices }))
  return { orgId, actor, sede: sede!, otra: otra!, run, supplier, gloves, order, receive, detail }
}

type Clinic = Awaited<ReturnType<typeof clinic>>

/** Una compra pedida y recibida entera en un lote: el saldo de partida de las demás pruebas. */
async function stocked(c: Clinic, productId: string, quantity: number, lotCode: string, expiresAt: string | null) {
  const order = await c.order([{ productId, quantity, unitCostCents: 100 }])
  await c.receive(order.id, [{ productId, quantity, lotCode, expiresAt }])
  return order
}

it("recibir: dos entregas iguales con claves distintas aplican; el reintento no duplica, también después de completar; otra cosa con la misma clave es un conflicto", async () => {
  const c = await clinic()
  const item = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Resina A2", unit: "jeringa" }))
  const order = await c.order([{ productId: item.id, quantity: 10, unitCostCents: 6500 }])
  const line = { productId: item.id, quantity: 4, lotCode: "T-001", expiresAt: "2028-01-01" }
  const keyA = randomUUID()
  await c.receive(order.id, [line], keyA)
  await c.receive(order.id, [line], randomUUID())
  expect((await c.detail(item.id)).onHand).toBe(8)
  await c.receive(order.id, [line], keyA)
  expect((await c.detail(item.id)).onHand).toBe(8)
  await expect(c.receive(order.id, [{ ...line, quantity: 2 }], keyA)).rejects.toMatchObject({ code: "CONFLICT" })

  // La recepción que completa la orden: el reintento devuelve lo hecho, otra entrega es un conflicto en palabras.
  const keyB = randomUUID()
  const last = await c.receive(order.id, [{ productId: item.id, quantity: 2, lotCode: "T-001" }], keyB)
  expect(last.status).toBe("recibida")
  const retry = await c.receive(order.id, [{ productId: item.id, quantity: 2, lotCode: "T-001" }], keyB)
  expect(retry).toMatchObject({ status: "recibida", replayed: true })
  expect((await c.detail(item.id)).onHand).toBe(10)
  await expect(c.receive(order.id, [{ productId: item.id, quantity: 1 }])).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("ya se recibió entera"),
  })
})

it("recibir en unidades de compra, en varios lotes y con el precio de la factura: el lote suma cajas × factor y «Por pagar» usa el precio nuevo", async () => {
  const c = await clinic()
  const item = await c.gloves()
  const order = await c.order([{ productId: item.id, quantity: 20, unitCostCents: 3800 }])
  // La línea copia la unidad de compra y su factor.
  const created = await c.run((tx) => getPurchaseOrder(tx, c.orgId, order.id))
  expect(created.lines[0]).toMatchObject({ purchaseUnit: "caja", unitFactor: 100, quantity: 20, unitCostCents: 3800 })
  // Cambiar el producto después no reescribe lo pedido.
  await c.run((tx) => updateProduct(tx, c.orgId, c.actor, item.id, { purchaseFactor: 50 }))
  const received = await c.receive(order.id, [
    {
      productId: item.id,
      lots: [
        { quantity: 5, lotCode: "L-A", expiresAt: "2028-01-01" },
        { quantity: 3, lotCode: "L-B", expiresAt: "2029-01-01" },
      ],
      unitCostCents: 3650,
    },
  ])
  expect(received.status).toBe("parcialmente_recibida")
  const product = await c.detail(item.id)
  expect(product.onHand).toBe(800)
  expect(product.lots.map((lot) => [lot.code, lot.quantityOnHand])).toEqual([
    ["L-A", 500],
    ["L-B", 300],
  ])
  const after = await c.run((tx) => getPurchaseOrder(tx, c.orgId, order.id))
  expect(after.lines[0]).toMatchObject({ receivedQuantity: 8, pendingQuantity: 12, unitCostCents: 3650, orderedUnitCostCents: 3800 })
  expect(after.balance).toMatchObject({ receivedCents: 8 * 3650, dueCents: 8 * 3650 })
  // La última compra dice el precio por caja y lo usado.
  expect(product.lastPurchase).toMatchObject({ label: purchaseOrderLabel(order.orderNumber), supplierName: "Dental Andina SAC", quantity: 8, unitCostCents: 3650 })

  // Un lote sin código lleva el número de la orden y no se reutiliza con otro vencimiento.
  await c.receive(order.id, [{ productId: item.id, quantity: 1, expiresAt: "2030-01-01" }])
  await expect(c.receive(order.id, [{ productId: item.id, quantity: 1, expiresAt: "2031-01-01" }])).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining(`El lote ${purchaseOrderLabel(order.orderNumber)} de Guantes de nitrilo ya existe y vence el`),
  })
  // Recibir de más dice cuánto falta; un producto repetido se rechaza en palabras.
  await expect(c.receive(order.id, [{ productId: item.id, quantity: 12 }])).rejects.toMatchObject({
    code: "CONFLICT",
    message: "La recepción supera lo pedido: de ese producto faltan 11",
  })
  await expect(
    c.receive(order.id, [
      { productId: item.id, quantity: 1 },
      { productId: item.id, quantity: 1 },
    ]),
  ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("repite un producto") })
})

it("«Ya la tengo» registra la compra como llegada en un paso, con sus lotes; un borrador se edita y se confirma", async () => {
  const c = await clinic()
  const item = await c.gloves()
  const resina = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Resina A2", unit: "jeringa" }))
  const bought = await c.run((tx) =>
    createPurchaseOrder(tx, c.orgId, c.actor, {
      supplierId: c.supplier.id,
      branchId: c.sede.id,
      mode: "ya_la_tengo",
      lines: [
        { productId: item.id, quantity: 8, unitCostCents: 3650, lots: [{ quantity: 8, lotCode: "L-2431", expiresAt: "2027-03-31" }] },
        { productId: resina.id, quantity: 2, unitCostCents: 6500 },
      ],
    }),
  )
  expect(bought).toMatchObject({ status: "recibida", branchId: c.sede.id, warehouseIsDefault: true, createdByName: "Ana Torres" })
  expect(bought.balance).toMatchObject({ receivedCents: 8 * 3650 + 2 * 6500, dueCents: 8 * 3650 + 2 * 6500 })
  expect((await c.detail(item.id)).lots.map((lot) => [lot.code, lot.quantityOnHand])).toEqual([["L-2431", 800]])
  expect((await c.detail(resina.id)).lots.map((lot) => lot.code)).toEqual([bought.label])
  // Se paga al momento como siempre (gasto de Materiales enlazado).
  await c.run((tx) => payPurchaseOrder(tx, c.orgId, c.actor, { orderId: bought.id, amountCents: 8 * 3650 + 2 * 6500 }))
  // Los lotes de «Ya la tengo» deben sumar lo que llegó.
  await expect(
    c.run((tx) =>
      createPurchaseOrder(tx, c.orgId, c.actor, {
        supplierId: c.supplier.id,
        branchId: c.sede.id,
        mode: "ya_la_tengo",
        lines: [{ productId: item.id, quantity: 8, lots: [{ quantity: 5 }] }],
      }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("deben sumar lo que llegó") })

  // Un borrador: se cambian sus productos (el que se quita se borra) y luego se pide.
  const draft = await c.order([{ productId: item.id, quantity: 5, unitCostCents: 3600 }, { productId: resina.id, quantity: 3 }], "borrador")
  const edited = await c.run((tx) =>
    updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, { notes: "Entregar en la mañana", lines: [{ productId: resina.id, quantity: 6, unitCostCents: 6500 }] }),
  )
  expect(edited).toMatchObject({ status: "borrador", notes: "Entregar en la mañana", label: draft.label })
  expect(edited.lines.map((line) => [line.productId, line.quantity])).toEqual([[resina.id, 6]])
  // No se recibe lo que no se pidió.
  await expect(c.receive(draft.id, [{ productId: resina.id, quantity: 1 }])).rejects.toMatchObject({ message: "Confirma la orden antes de recibir la mercadería" })
  await c.run((tx) => confirmPurchaseOrder(tx, c.orgId, c.actor, draft.id))
  await expect(c.run((tx) => updatePurchaseOrder(tx, c.orgId, c.actor, draft.id, { notes: "otra" }))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "La compra ya está confirmada: solo se cambia una compra en borrador",
  })
  // La base no deja quitar líneas de una compra pedida.
  await expect(
    c.run((tx) => tx.delete(purchaseOrderLine).where(and(eq(purchaseOrderLine.organizationId, c.orgId), eq(purchaseOrderLine.orderId, draft.id)))),
  ).rejects.toMatchObject({ cause: { code: "42501" } })
})

it("«Cerrar con lo recibido»: exige algo recibido, deja de esperar lo demás y lo adelantado de más queda a favor", async () => {
  const c = await clinic()
  const item = await c.gloves()
  const order = await c.order([{ productId: item.id, quantity: 20, unitCostCents: 1000 }])
  await expect(c.run((tx) => closePurchaseOrder(tx, c.orgId, c.actor, order.id))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "Todavía no llegó nada de esta compra: si ya no va a llegar, cancélala.",
  })
  // Se adelantaron 150 y llegaron 12 cajas (120).
  await c.run((tx) => payPurchaseOrder(tx, c.orgId, c.actor, { orderId: order.id, amountCents: 15_000 }))
  await c.receive(order.id, [{ productId: item.id, quantity: 12 }])
  expect((await c.run((tx) => supplierCredits(tx, c.orgId)))).toEqual([])
  const closed = await c.run((tx) => closePurchaseOrder(tx, c.orgId, c.actor, order.id))
  expect(closed).toMatchObject({ status: "cerrada", balance: { receivedCents: 12_000, paidCents: 15_000, dueCents: 0, aheadCents: 3_000 } })
  expect((await c.run((tx) => supplierCredits(tx, c.orgId)))[0]).toMatchObject({ supplierId: c.supplier.id, cents: 3_000 })
  // Cerrada ya no recibe, no se cancela ni se vuelve a cerrar.
  await expect(c.receive(order.id, [{ productId: item.id, quantity: 1 }])).rejects.toMatchObject({
    message: "La orden está cerrada con lo recibido y ya no admite recepción",
  })
  await expect(c.run((tx) => cancelPurchaseOrder(tx, c.orgId, c.actor, order.id))).rejects.toMatchObject({ code: "CONFLICT" })
  await expect(c.run((tx) => closePurchaseOrder(tx, c.orgId, c.actor, order.id))).rejects.toMatchObject({ code: "CONFLICT" })
  expect(describeAuditEvent("purchase_order.closed").what).toBe("Cerró una compra con lo recibido")
})

it("compras por sede y por vista, con sus conteos; sin precios no viaja ningún importe", async () => {
  const c = await clinic()
  const item = await c.gloves()
  await c.order([{ productId: item.id, quantity: 1, unitCostCents: 100 }], "borrador")
  const coming = await c.order([{ productId: item.id, quantity: 2, unitCostCents: 100 }])
  const due = await c.order([{ productId: item.id, quantity: 3, unitCostCents: 100 }])
  await c.receive(due.id, [{ productId: item.id, quantity: 3 }])
  const elsewhere = await c.run((tx) =>
    createPurchaseOrder(tx, c.orgId, c.actor, { supplierId: c.supplier.id, branchId: c.otra.id, mode: "pedir", lines: [{ productId: item.id, quantity: 1 }] }),
  )
  const list = await c.run((tx) => listPurchaseOrders(tx, c.orgId, { branchId: c.sede.id, view: "por_llegar" }))
  expect(list.counts).toEqual({ por_llegar: 1, por_pagar: 1, borradores: 1, todas: 3 })
  expect(list.items.map((row) => row.id)).toEqual([coming.id])
  expect(list.items[0]).toMatchObject({ branchName: "Sede Miraflores", createdByName: "Ana Torres", lines: 1, pendingLines: 1, totalCents: 200 })
  expect((await c.run((tx) => listPurchaseOrders(tx, c.orgId, { view: "por_pagar" }))).items.map((row) => row.id)).toEqual([due.id])
  expect((await c.run((tx) => listPurchaseOrders(tx, c.orgId, { branchId: c.otra.id }))).items.map((row) => row.id)).toEqual([elsewhere.id])

  // Sin precios: ni importes ni saldos ni pagos, y «Por pagar» no se ofrece.
  const blind = await c.run((tx) => listPurchaseOrders(tx, c.orgId, { branchId: c.sede.id, prices: false }))
  expect(blind.counts).not.toHaveProperty("por_pagar")
  for (const row of blind.items) {
    expect(row).not.toHaveProperty("totalCents")
    expect(row).not.toHaveProperty("balance")
  }
  await expect(c.run((tx) => listPurchaseOrders(tx, c.orgId, { view: "por_pagar", prices: false }))).rejects.toMatchObject({ status: 403 })
  const order = await c.run((tx) => getPurchaseOrder(tx, c.orgId, due.id, { prices: false }))
  for (const key of ["totalCents", "balance", "payments", "supplierCreditCents"]) expect(order).not.toHaveProperty(key)
  expect(order.lines[0]).not.toHaveProperty("unitCostCents")
  expect(order.lines[0]).toMatchObject({ quantity: 3, receivedQuantity: 3, purchaseUnit: "caja", unitFactor: 100 })
})

it("lo que hay por sede: estado, orden por urgencia, filtros y conteos; los precios solo con precios", async () => {
  const c = await clinic()
  const now = new Date("2030-06-15T15:00:00Z")
  const guantes = await c.gloves([{ branchId: c.sede.id, minQuantity: 1000 }, { branchId: c.otra.id, minQuantity: 500 }])
  const lido = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Lidocaína 2%", unit: "cartucho", minimums: [{ branchId: c.sede.id, minQuantity: 50 }] }))
  const cepillo = await c.run((tx) =>
    createProduct(tx, c.orgId, c.actor, { name: "Cepillo dental suave", usedInCare: false, forSale: true, unit: "cepillo", salePriceCents: 1500, minimums: [{ branchId: c.sede.id, minQuantity: 5 }] }),
  )
  const mepi = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Mepivacaína 3%", unit: "cartucho" }))
  const adhesivo = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Adhesivo universal", unit: "frasco" }))
  const resina = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Resina A2", unit: "jeringa" }))
  await stocked(c, guantes.id, 11, "G-1", null)
  await stocked(c, lido.id, 40, "L-1", "2031-01-01")
  await stocked(c, mepi.id, 5, "M-1", "2030-06-01")
  await stocked(c, adhesivo.id, 6, "A-1", "2030-07-01")
  await stocked(c, resina.id, 1, "R-1", null)
  // Se usaron 4 jeringas de resina con 1 registrada: faltan 3.
  const patient = (await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: "Lucía Paredes", patientNumber: 1 }))[0]!
  await expect(
    c.run((tx) => registerUse(tx, c.orgId, c.actor, { productId: resina.id, branchId: c.sede.id, quantity: 4, patientId: patient.id, idempotencyKey: randomUUID() })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "No alcanza: en Sede Miraflores hay 1 jeringa." })
  const { consumeFefo } = await import("./inventory-stock.js")
  const main = await c.run((tx) => defaultWarehouse(tx, c.orgId, c.sede.id))
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, { productId: resina.id, warehouseId: main.id, quantity: 4, allowShortage: true, base: { kind: "consumo", reason: "Atención", actorUserId: c.actor, keyPrefix: `prueba:${randomUUID()}` } }),
  )

  const list = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, prices: true, now }))
  expect(list.items.map((item) => [item.name, item.state])).toEqual([
    ["Resina A2", "faltante"],
    ["Mepivacaína 3%", "vencido"],
    ["Lidocaína 2%", "hace_falta"],
    ["Cepillo dental suave", "no_hay"],
    ["Adhesivo universal", "por_vencer"],
    ["Guantes de nitrilo", "ok"],
  ])
  expect(list.counts).toEqual({ todos: 6, hacen_falta: 3, por_vencer: 2 })
  const byName = new Map(list.items.map((item) => [item.name, item]))
  expect(byName.get("Resina A2")).toMatchObject({ onHand: -3, shortage: 3 })
  expect(byName.get("Lidocaína 2%")).toMatchObject({ onHand: 40, minQuantity: 50, missing: 10 })
  expect(byName.get("Mepivacaína 3%")).toMatchObject({ expired: { quantity: 5, firstDate: "2030-06-01" } })
  expect(byName.get("Adhesivo universal")).toMatchObject({ expiring: { quantity: 6, date: "2030-07-01", firstQuantity: 6 } })
  expect(byName.get("Guantes de nitrilo")).toMatchObject({ onHand: 1100, minQuantity: 1000, unit: "guante", purchaseUnit: "caja", purchaseFactor: 100 })
  expect(byName.get("Cepillo dental suave")).toMatchObject({ salePriceCents: 1500, saleCurrency: "PEN" })
  const needs = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, need: "hacen_falta", now }))
  expect(needs.items.map((item) => item.name)).toEqual(["Resina A2", "Lidocaína 2%", "Cepillo dental suave"])
  expect((await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, need: "por_vencer", now }))).items.map((item) => item.name)).toEqual([
    "Mepivacaína 3%",
    "Adhesivo universal",
  ])
  expect((await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, q: "lidocaina", now }))).items.map((item) => item.name)).toEqual(["Lidocaína 2%"])
  // La otra sede tiene lo suyo: los guantes hacen falta allí y no hay nada más.
  const there = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.otra.id, now }))
  expect(there.items.find((item) => item.id === guantes.id)).toMatchObject({ onHand: 0, minQuantity: 500, state: "no_hay" })
  expect(there.counts.hacen_falta).toBe(1)
  // Sin precios: el precio de venta no viaja.
  const blind = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, now }))
  for (const item of blind.items) expect(item).not.toHaveProperty("salePriceCents")

  // El detalle: todas las sedes, lotes de la elegida, último precio solo con precios.
  const detail = await c.run((tx) => getProductDetail(tx, c.orgId, guantes.id, { branchId: c.sede.id, prices: true, now }))
  expect(detail.branches.map((row) => [row.branchName, row.onHand, row.minQuantity, row.state])).toEqual([
    ["Sede Miraflores", 1100, 1000, "ok"],
    ["Sede San Isidro", 0, 500, "no_hay"],
  ])
  expect(detail.lastPurchase).toMatchObject({ supplierName: "Dental Andina SAC", quantity: 11, unitCostCents: 100, currency: "PEN" })
  const blindDetail = await c.run((tx) => getProductDetail(tx, c.orgId, guantes.id, { branchId: c.sede.id, now }))
  expect(blindDetail.lastPurchase).not.toHaveProperty("unitCostCents")
  expect(blindDetail).not.toHaveProperty("salePriceCents")
  // Un desactivado sigue a la vista mientras le quede algo, pero ya no hace falta.
  await c.run((tx) => setProductActive(tx, c.orgId, c.actor, lido.id, false))
  const afterOff = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id, now }))
  expect(afterOff.items.find((item) => item.id === lido.id)).toMatchObject({ isActive: false, state: "ok", onHand: 40 })
  expect(afterOff.counts.hacen_falta).toBe(2)
})

it("productos: se usa o se vende, unidades de la lista, código armado desde el nombre y la unidad de uso no cambia con historia", async () => {
  const c = await clinic()
  await expect(
    c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Nada", usedInCare: false, forSale: false })),
  ).rejects.toMatchObject({ code: "VALIDATION", message: "Marca si se usa en las atenciones, si se vende o las dos" })
  await expect(
    c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Guante caro", salePriceCents: 100 })),
  ).rejects.toMatchObject({ message: "El precio de venta es solo para lo que se vende" })
  await expect(c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Algo", unitCode: "ZZZ" }))).rejects.toMatchObject({
    message: "La unidad de uso no está en la lista",
  })
  const first = await c.run((tx) =>
    createProduct(tx, c.orgId, c.actor, { name: "Guantes de nitrilo talla M", unit: "Guantes", purchaseUnit: "cajas", purchaseFactor: 100 }),
  )
  expect(first).toMatchObject({ sku: "GUA-NIT-TAL-M", unit: "guante", unitCode: null, purchaseUnit: "caja", purchaseUnitCode: "XBX", purchaseFactor: 100 })
  expect(skuFromName("Lidocaína 2% con epinefrina")).toBe("LID-2-EPI")
  const second = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Guantes de nitrilo talla M" }))
  expect(second.sku).toBe("GUA-NIT-TAL-M-2")
  await expect(c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Otro", sku: "GUA-NIT-TAL-M" }))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "Ese código ya lo usa «Guantes de nitrilo talla M». Elige otro.",
  })
  // Se compra igual que se usa: sin unidad de compra y de a uno.
  const same = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Frasco", unit: "frasco", purchaseUnit: "frasco" }))
  expect(same).toMatchObject({ unit: "frasco", unitCode: "XBO", purchaseUnit: null, purchaseFactor: 1 })

  // Sin historia, la unidad cambia; con una compra, ya no (la de compra sí).
  await c.run((tx) => updateProduct(tx, c.orgId, c.actor, first.id, { unit: "par" }))
  await c.order([{ productId: first.id, quantity: 1 }], "borrador")
  await expect(c.run((tx) => updateProduct(tx, c.orgId, c.actor, first.id, { unit: "guante" }))).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("«par»"),
  })
  const renamed = await c.run((tx) =>
    updateProduct(tx, c.orgId, c.actor, first.id, { name: "Guantes M", purchaseFactor: 50, forSale: true, salePriceCents: 90, minimums: [{ branchId: c.sede.id, minQuantity: 20 }] }),
  )
  expect(renamed).toMatchObject({ name: "Guantes M", sku: "GUA-NIT-TAL-M", purchaseFactor: 50, salePriceCents: 90, saleCurrency: "PEN" })
  expect(renamed.minimums).toEqual([{ branchId: c.sede.id, minQuantity: 20 }])
  // Dejar de venderlo quita su precio.
  expect(await c.run((tx) => updateProduct(tx, c.orgId, c.actor, first.id, { forSale: false }))).toMatchObject({ salePriceCents: null, saleCurrency: null })
})

it("pegar la lista: revisa cada fila (nueva, existe, parecida, inválida) y agrega con «Inventario inicial» sin duplicar al reintentar", async () => {
  const c = await clinic()
  const existing = await c.gloves()
  const rows = [
    { name: "Guantes de nitrilo", unit: "caja de 100", onHand: "11", minQuantity: "10" },
    { name: "Lidocaína 2% c/ epinefrina", unit: "cartucho", onHand: "40", minQuantity: 50 },
    { name: "Resina A2", unit: "jeringas", onHand: 6, minQuantity: "" },
    { name: "guantes nitrilo", unit: "caja", onHand: "2" },
    { name: "Hilo retractor", unit: "rollo", onHand: "tres", minQuantity: "1" },
    { name: "Pasta profiláctica", unit: "caja de 1000", onHand: "2,000,000" },
    { name: "Resina A2", onHand: "1" },
  ]
  const preview = await c.run((tx) => previewProductImport(tx, c.orgId, c.sede.id, rows))
  expect(preview.rows.map((row) => [row.name, row.status])).toEqual([
    ["Guantes de nitrilo", "existe"],
    ["Lidocaína 2% c/ epinefrina", "nuevo"],
    ["Resina A2", "nuevo"],
    ["guantes nitrilo", "parecido"],
    ["Hilo retractor", "invalido"],
    ["Pasta profiláctica", "invalido"],
    ["Resina A2", "invalido"],
  ])
  expect(preview.counts).toEqual({ nuevo: 2, existe: 1, parecido: 1, invalido: 3 })
  expect(preview.rows[0]).toMatchObject({ productId: existing.id, unit: "unidad", purchaseUnit: "caja", purchaseFactor: 100, onHand: 1100, minQuantity: 1000 })
  expect(preview.rows[2]).toMatchObject({ unit: "jeringa", onHand: 6, minQuantity: null })
  expect(preview.rows[3]?.similarTo).toEqual({ id: existing.id, name: "Guantes de nitrilo" })
  expect(preview.rows[4]?.reason).toBe("«Hay» no es un número entero desde 0")
  expect(preview.rows[5]?.reason).toBe("El número es demasiado grande")
  expect(preview.rows[6]?.reason).toBe("Está repetido en la lista (fila 3)")

  // Se agregan las válidas; la parecida, como el mismo producto que eligió la pantalla.
  const chosen = [
    rows[0]!,
    rows[1]!,
    rows[2]!,
    { ...rows[3]!, productId: existing.id, unit: "guante", onHand: "1150" },
  ]
  const key = randomUUID()
  const done = await c.run((tx) => importProducts(tx, c.orgId, c.actor, c.sede.id, chosen, key))
  expect(done).toMatchObject({ created: 2, updated: 2, unchanged: 0 })
  const lido = done.items.find((item) => item.name === "Lidocaína 2% c/ epinefrina")!
  const lidoDetail = await c.detail(lido.productId)
  expect(lidoDetail).toMatchObject({ onHand: 40, minQuantity: 50, unit: "cartucho" })
  expect(lidoDetail.lots).toMatchObject([{ code: "", quantityOnHand: 40 }])
  expect(lidoDetail.movements[0]).toMatchObject({ kind: "ingreso", reason: "Inventario inicial" })
  // Los guantes quedaron con lo último que se escribió para ellos.
  expect((await c.detail(existing.id)).onHand).toBe(1150)
  // El reintento con la misma clave no crea ni mueve nada más.
  const again = await c.run((tx) => importProducts(tx, c.orgId, c.actor, c.sede.id, chosen, key))
  expect(again.created).toBe(0)
  expect((await c.detail(lido.productId)).onHand).toBe(40)
  expect((await c.detail(existing.id)).onHand).toBe(1150)
  const products = await c.run((tx) => listProducts(tx, c.orgId, { branchId: c.sede.id }))
  expect(products.items.filter((item) => item.name === "Resina A2")).toHaveLength(1)
  // Una fila inválida no se agrega: se dice cuál.
  await expect(c.run((tx) => importProducts(tx, c.orgId, c.actor, c.sede.id, [rows[4]!], randomUUID()))).rejects.toMatchObject({
    code: "VALIDATION",
    message: "Fila 1: «Hay» no es un número entero desde 0",
  })
})

it("contar: se escribe lo que hay y odentIA ajusta la diferencia con «Conteo»; lo no contado no cambia", async () => {
  const c = await clinic()
  const item = await c.gloves()
  const other = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Adhesivo universal", unit: "frasco" }))
  const untouched = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Eyector", unit: "unidad" }))
  await stocked(c, item.id, 11, "G-1", "2030-01-01")
  await stocked(c, other.id, 6, "A-1", null)
  await stocked(c, untouched.id, 200, "E-1", null)
  const key = randomUUID()
  const items = [
    { productId: item.id, counted: 1050 },
    { productId: other.id, counted: 7 },
  ]
  const result = await c.run((tx) => countStock(tx, c.orgId, c.actor, c.sede.id, items, key))
  expect(result.changed).toEqual([
    { productId: item.id, name: "Guantes de nitrilo", unit: "guante", before: 1100, after: 1050, delta: -50 },
    { productId: other.id, name: "Adhesivo universal", unit: "frasco", before: 6, after: 7, delta: 1 },
  ])
  expect((await c.detail(other.id)).movements[0]).toMatchObject({ kind: "ajuste", reason: "Conteo: había 6, hay 7", actorName: "Ana Torres" })
  expect((await c.detail(untouched.id)).onHand).toBe(200)
  // El reintento devuelve lo mismo sin mover nada; igual no cambia nada.
  expect((await c.run((tx) => countStock(tx, c.orgId, c.actor, c.sede.id, items, key))).changed).toHaveLength(2)
  expect((await c.detail(item.id)).onHand).toBe(1050)
  expect((await c.run((tx) => countStock(tx, c.orgId, c.actor, c.sede.id, [{ productId: item.id, counted: 1050 }], randomUUID()))).changed).toEqual([])
  expect(describeAuditEvent("stock.conteo").what).toBe("Guardó un conteo del inventario")
})

it("dar de baja lo vencido: cada lote vencido de la sede queda en 0 con «Venció», sin tocar lo demás", async () => {
  const c = await clinic()
  const item = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Mepivacaína 3%", unit: "cartucho" }))
  await stocked(c, item.id, 5, "VIEJO", "2020-01-01")
  await stocked(c, item.id, 4, "NUEVO", "2099-01-01")
  const key = randomUUID()
  const done = await c.run((tx) => writeOffExpired(tx, c.orgId, c.actor, item.id, c.sede.id, key))
  expect(done).toMatchObject({ quantity: 5, lots: [{ code: "VIEJO", quantity: 5 }], replayed: false })
  const detail = await c.detail(item.id)
  expect(detail.lots.map((lot) => lot.code)).toEqual(["NUEVO"])
  expect(detail.movements[0]).toMatchObject({ kind: "ajuste", reason: "Venció", quantityDelta: -5 })
  expect(await c.run((tx) => writeOffExpired(tx, c.orgId, c.actor, item.id, c.sede.id, key))).toMatchObject({ quantity: 5, replayed: true })
  await expect(c.run((tx) => writeOffExpired(tx, c.orgId, c.actor, item.id, c.sede.id, randomUUID()))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "No hay lotes vencidos de Mepivacaína 3% en Sede Miraflores.",
  })
})

it("registrar uso, trasladar, agregar sin compra y ajustar un lote: cada uno con su clave y sus palabras", async () => {
  const c = await clinic()
  const item = await c.gloves()
  await stocked(c, item.id, 3, "PRONTO", "2030-01-01")
  await stocked(c, item.id, 2, "TARDE", "2031-01-01")
  const patient = (await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: "Lucía Paredes", patientNumber: 1 }))[0]!
  const [today] = await ownerDb
    .insert(encounter)
    .values({ organizationId: c.orgId, patientId: patient.id, dentistUserId: c.actor, reason: "Limpieza" })
    .returning({ id: encounter.id })

  // Uso con paciente: sale del lote que vence primero y se une a su atención de hoy.
  const useKey = randomUUID()
  const used = await c.run((tx) =>
    registerUse(tx, c.orgId, c.actor, { productId: item.id, branchId: c.sede.id, quantity: 2, patientId: patient.id, note: "Se le regaló", idempotencyKey: useKey }),
  )
  expect(used).toMatchObject({ patientId: patient.id, encounterId: today!.id, replayed: false })
  expect(used.movements.map((row) => [row.kind, row.quantityDelta, row.reason])).toEqual([["consumo", -2, "Se le regaló"]])
  expect((await c.run((tx) => registerUse(tx, c.orgId, c.actor, { productId: item.id, branchId: c.sede.id, quantity: 2, patientId: patient.id, idempotencyKey: useKey }))).replayed).toBe(true)
  expect((await c.detail(item.id)).onHand).toBe(498)

  // Trasladar a la otra sede: llega a su almacén principal, en parejas por lote.
  const moved = await c.run((tx) =>
    transferStock(tx, c.orgId, c.actor, { productId: item.id, fromBranchId: c.sede.id, toBranchId: c.otra.id, quantity: 350, idempotencyKey: randomUUID() }),
  )
  expect(moved.movements.filter((row) => row.kind === "traslado")).toHaveLength(4)
  expect((await c.detail(item.id, c.sede.id)).onHand).toBe(148)
  const there = await c.detail(item.id, c.otra.id)
  expect(there.onHand).toBe(350)
  expect(there.lots.map((lot) => [lot.code, lot.quantityOnHand, lot.warehouseIsDefault])).toEqual([
    ["PRONTO", 298, true],
    ["TARDE", 52, true],
  ])
  await expect(
    c.run((tx) => transferStock(tx, c.orgId, c.actor, { productId: item.id, fromBranchId: c.sede.id, toBranchId: c.sede.id, quantity: 1, idempotencyKey: randomUUID() })),
  ).rejects.toMatchObject({ message: "Elige otra sede de destino" })
  await expect(
    c.run((tx) => transferStock(tx, c.orgId, c.actor, { productId: item.id, fromBranchId: c.otra.id, toBranchId: c.sede.id, quantity: 351, idempotencyKey: randomUUID() })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "No alcanza: en Sede San Isidro hay 350 guantes." })

  // Agregar sin compra: una muestra, con su lote; un código que ya existe con otro vencimiento se pide en palabras.
  const added = await c.run((tx) =>
    addStock(tx, c.orgId, c.actor, { productId: item.id, branchId: c.sede.id, quantity: 300, reason: "muestra", lotCode: "MUESTRA-1", expiresAt: "2032-01-01", idempotencyKey: randomUUID() }),
  )
  expect(added.movements[0]).toMatchObject({ kind: "ingreso", reason: "Muestra o regalo", quantityDelta: 300 })
  await expect(
    c.run((tx) => addStock(tx, c.orgId, c.actor, { productId: item.id, branchId: c.sede.id, quantity: 1, reason: "otro", idempotencyKey: randomUUID() })),
  ).rejects.toMatchObject({ message: "Escribe el motivo" })
  await expect(
    c.run((tx) =>
      addStock(tx, c.orgId, c.actor, { productId: item.id, branchId: c.sede.id, quantity: 1, reason: "muestra", lotCode: "MUESTRA-1", expiresAt: "2033-01-01", idempotencyKey: randomUUID() }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("El lote MUESTRA-1 de Guantes de nitrilo ya existe y vence el") })

  // Ajustar un lote: se escribe cuántos hay y el servidor calcula la diferencia.
  const lot = (await c.detail(item.id)).lots.find((row) => row.code === "MUESTRA-1")!
  const adjusted = await c.run((tx) =>
    adjustLot(tx, c.orgId, c.actor, { lotId: lot.id, counted: 290, reason: "se_dano", note: "Se mojó una caja", idempotencyKey: randomUUID() }),
  )
  expect(adjusted).toMatchObject({ before: 300, after: 290, delta: -10 })
  expect(adjusted.movement).toMatchObject({ kind: "ajuste", reason: "Se dañó · Se mojó una caja" })
  expect((await c.detail(item.id)).onHand).toBe(438)
  expect(describeAuditEvent("stock.uso").what).toBe("Registró el uso de un producto fuera de una atención")
})

it("movimientos: por sede, con quién, paciente y compra, paginados con su total; la cobertura es una sola fila", async () => {
  const c = await clinic()
  const item = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Resina A2", unit: "jeringa" }))
  const patient = (await insertTestPatients(ownerDb, { organizationId: c.orgId, displayName: "Lucía Paredes", patientNumber: 1 }))[0]!
  const { consumeFefo } = await import("./inventory-stock.js")
  const main = await c.run((tx) => defaultWarehouse(tx, c.orgId, c.sede.id))
  await c.run((tx) =>
    consumeFefo(tx, c.orgId, {
      productId: item.id,
      warehouseId: main.id,
      quantity: 3,
      allowShortage: true,
      base: { kind: "consumo", reason: "Restauración", actorUserId: c.actor, patientId: patient.id, keyPrefix: `prueba:${randomUUID()}` },
    }),
  )
  const order = await stocked(c, item.id, 10, "R-1", null)
  const all = await c.run((tx) => listMovements(tx, c.orgId, { branchId: c.sede.id }))
  expect(all.total).toBe(3)
  expect(all.items.map((row) => [row.kind, row.quantityDelta, row.affectsStock])).toEqual([
    ["cobertura", -3, false],
    ["ingreso", 10, true],
    ["consumo", -3, true],
  ])
  expect(all.items[1]).toMatchObject({ purchaseOrderLabel: order.label, actorName: "Ana Torres", branchName: "Sede Miraflores", lotCode: "R-1" })
  expect(all.items[2]).toMatchObject({ patientName: "Lucía Paredes", patientId: patient.id, personId: patient.personId, lotId: null })
  expect((await c.run((tx) => listMovements(tx, c.orgId, { branchId: c.otra.id }))).total).toBe(0)
  const page = await c.run((tx) => listMovements(tx, c.orgId, { branchId: c.sede.id, kind: "consumo", limit: 1 }))
  expect(page).toMatchObject({ total: 1, items: [{ kind: "consumo" }] })
  expect((await c.run((tx) => listMovements(tx, c.orgId, { q: "resin", from: "2000-01-01", to: "2099-12-31" }))).total).toBe(3)
})

it("pedir lo que falta: cuánto pedir en cajas para llegar al mínimo y un borrador por proveedor con el último precio", async () => {
  const c = await clinic()
  const other = await c.run((tx) => createSupplier(tx, c.orgId, c.actor, { name: "Distribuidora Médica Lima" }))
  const guantes = await c.gloves([{ branchId: c.sede.id, minQuantity: 1000 }])
  const lido = await c.run((tx) =>
    createProduct(tx, c.orgId, c.actor, { name: "Lidocaína 2%", unit: "cartucho", purchaseUnit: "caja", purchaseFactor: 50, minimums: [{ branchId: c.sede.id, minQuantity: 50 }] }),
  )
  const nunca = await c.run((tx) => createProduct(tx, c.orgId, c.actor, { name: "Cepillo", unit: "cepillo", minimums: [{ branchId: c.sede.id, minQuantity: 5 }] }))
  const first = await c.order([{ productId: guantes.id, quantity: 2, unitCostCents: 3650 }])
  await c.receive(first.id, [{ productId: guantes.id, quantity: 2 }])
  const second = await c.order([{ productId: lido.id, quantity: 1, unitCostCents: 21000 }], "pedir", other.id)
  await c.receive(second.id, [{ productId: lido.id, quantity: 1 }])
  // Se usaron 30 cartuchos: quedan 20 de 50.
  await c.run((tx) => registerUse(tx, c.orgId, c.actor, { productId: lido.id, branchId: c.sede.id, quantity: 30, idempotencyKey: randomUUID() }))

  const suggestions = await c.run((tx) => getReorderSuggestions(tx, c.orgId, c.sede.id))
  const by = new Map(suggestions.items.map((item) => [item.productId, item]))
  // 800 guantes faltan: 8 cajas.
  expect(by.get(guantes.id)).toMatchObject({ onHand: 200, missing: 800, quantity: 8, lastPurchase: { supplierName: "Dental Andina SAC", unitCostCents: 3650 } })
  // 30 cartuchos faltan: una caja de 50, redondeado hacia arriba; usados 30 en 30 días.
  expect(by.get(lido.id)).toMatchObject({ missing: 30, quantity: 1, usedLast30Days: 30, lastPurchase: { supplierName: "Distribuidora Médica Lima", unitCostCents: 21000 } })
  expect(by.get(nunca.id)).toMatchObject({ quantity: 5, lastPurchase: null })
  // Sin precios no viaja el último precio.
  const blind = await c.run((tx) => getReorderSuggestions(tx, c.orgId, c.sede.id, { prices: false }))
  expect(blind.items.find((item) => item.productId === guantes.id)?.lastPurchase).not.toHaveProperty("unitCostCents")

  const drafts = await c.run((tx) => createReorderDrafts(tx, c.orgId, c.actor, c.sede.id))
  expect(drafts.drafts.map((row) => [row.supplierName, row.lines]).sort()).toEqual([
    ["Dental Andina SAC", 1],
    ["Distribuidora Médica Lima", 1],
  ])
  expect(drafts.withoutSupplier.map((item) => item.productId)).toEqual([nunca.id])
  const draft = await c.run((tx) => getPurchaseOrder(tx, c.orgId, drafts.drafts.find((row) => row.supplierName === "Dental Andina SAC")!.id))
  expect(draft).toMatchObject({ status: "borrador", branchId: c.sede.id })
  expect(draft.lines).toMatchObject([{ productId: guantes.id, quantity: 8, unitCostCents: 3650, purchaseUnit: "caja", unitFactor: 100 }])
  // Lo que ya está en un borrador no se repite.
  const again = await c.run((tx) => createReorderDrafts(tx, c.orgId, c.actor, c.sede.id))
  expect(again.drafts).toEqual([])
  expect(again.alreadyInDraft.map((item) => item.productId).sort()).toEqual([guantes.id, lido.id].sort())
  // Lo que ya viene en una compra pedida se descuenta.
  await c.run((tx) => confirmPurchaseOrder(tx, c.orgId, c.actor, draft.id))
  expect((await c.run((tx) => getReorderSuggestions(tx, c.orgId, c.sede.id))).items.find((item) => item.productId === guantes.id)).toBeUndefined()
})

it("proveedores: cuántas compras y, con precios, lo que se les debe y lo que se tiene a favor", async () => {
  const c = await clinic()
  const item = await c.gloves()
  const order = await c.order([{ productId: item.id, quantity: 2, unitCostCents: 5000 }])
  await c.receive(order.id, [{ productId: item.id, quantity: 2 }])
  await c.run((tx) => payPurchaseOrder(tx, c.orgId, c.actor, { orderId: order.id, amountCents: 4000 }))
  const [row] = await c.run((tx) => listSuppliers(tx, c.orgId, { prices: true }))
  expect(row).toMatchObject({ name: "Dental Andina SAC", orders: 1, currency: "PEN", dueCents: 6000, creditCents: 0 })
  const [blind] = await c.run((tx) => listSuppliers(tx, c.orgId))
  expect(blind).toMatchObject({ orders: 1 })
  expect(blind).not.toHaveProperty("dueCents")
})

it("el aviso de lo que llegó va a quien lleva las compras, con lo que falta pagar, y no a quien lo registró", async () => {
  const c = await clinic()
  const admin = await memberOf(c.orgId, "admin")
  const rosa = await memberOf(c.orgId, "reception", "Rosa Quispe")
  const item = await c.gloves()
  const order = await c.order([{ productId: item.id, quantity: 20, unitCostCents: 3330 }])
  await c.receive(order.id, [{ productId: item.id, quantity: 20 }], randomUUID(), rosa)
  const notices = await ownerDb
    .select({ userId: workspaceNotification.userId, title: workspaceNotification.title, permission: workspaceNotification.permission })
    .from(workspaceNotification)
    .where(and(eq(workspaceNotification.organizationId, c.orgId), like(workspaceNotification.dedupeKey, `inventory:received:${order.id}:%`)))
  expect(notices.map((row) => row.userId).sort()).toEqual([admin, c.actor].sort())
  for (const notice of notices) {
    expect(notice.permission).toBe("inventory.write")
    // El importe va en el formato de la clínica (con su espacio fijo entre «S/» y el número).
    expect(order.label).toBe("OC-0001")
    expect(notice.title).toMatch(/^Rosa Quispe registró lo que llegó de OC-0001: falta pagar S\/\s666\.00$/)
  }
})

it("los mensajes de inventario no llevan códigos internos", async () => {
  const c = await clinic()
  const item = await c.gloves()
  await expect(
    c.run((tx) =>
      createPurchaseOrder(tx, c.orgId, c.actor, { supplierId: c.supplier.id, branchId: c.sede.id, lines: [{ productId: item.id, quantity: 1, unitCostCents: 3_000_000_000 }] }),
    ),
  ).rejects.toMatchObject({ message: "El costo por unidad es demasiado alto" })
  await expect(c.receive(randomUUID(), [{ productId: item.id, quantity: 1 }])).rejects.toMatchObject({ code: "NOT_FOUND", message: "Orden de compra no encontrada" })
  await expect(c.run((tx) => createPurchaseOrder(tx, c.orgId, c.actor, { supplierId: c.supplier.id, lines: [{ productId: item.id, quantity: 1 }] }))).rejects.toMatchObject({
    message: "Elige la sede a la que llega la compra",
  })
  await stocked(c, item.id, 1, "L-1", null)
  const movements = await ownerDb
    .select({ reason: stockMovement.reason })
    .from(stockMovement)
    .where(and(eq(stockMovement.organizationId, c.orgId), like(stockMovement.reason, "Recepción%")))
  for (const row of movements) expect(row.reason).toMatch(/^Recepción de OC-\d{4,} · lote /)
})

it("proveedor: el tipo de documento es un código de la lista del país de la clínica y el número exige su tipo", async () => {
  const c = await clinic()
  const create = (input: Parameters<typeof createSupplier>[3]) => c.run((tx) => createSupplier(tx, c.orgId, c.actor, input))
  const update = (id: string, input: Parameters<typeof updateSupplier>[4]) => c.run((tx) => updateSupplier(tx, c.orgId, c.actor, id, input))
  // Perú: RUC, DNI, carné de extranjería, pasaporte u «Otro»; se guarda el código.
  const ruc = await create({ name: "Insumos Lima SAC", docType: "ruc", docNumber: "20111222333" })
  expect(ruc.docType).toBe("RUC")
  expect((await create({ name: "Juan Pérez", docType: "DNI", docNumber: "45678904" })).docType).toBe("DNI")
  // Texto libre, el genérico del núcleo y el certificado de nacido vivo no son de la lista.
  for (const docType of ["NIT", "TRIBUTARIO", "CNV"]) {
    await expect(create({ name: `Con ${docType}`, docType, docNumber: "900123456" })).rejects.toMatchObject({
      code: "VALIDATION",
      message: "El tipo de documento del proveedor tiene que ser uno de la lista: RUC, DNI, Carné de extranjería, Pasaporte u Otro",
    })
  }
  await expect(create({ name: "Sin tipo", docNumber: "20999888777" })).rejects.toMatchObject({
    code: "VALIDATION",
    message: "Indica el tipo de documento del proveedor junto con su número",
  })

  // Al editar se mira el tipo que llega; uno antiguo que nadie cambia se conserva.
  await expect(update(ruc.id, { docType: "NIT" })).rejects.toMatchObject({ code: "VALIDATION" })
  await ownerDb.update(supplierTable).set({ docType: "NIT" }).where(eq(supplierTable.id, ruc.id))
  expect((await update(ruc.id, { phone: "+5115550000" }))?.docType).toBe("NIT")
  expect((await update(ruc.id, { docType: "OTRO" }))?.docType).toBe("OTRO")

  // Un país sin perfil propio recibe el núcleo: un documento tributario genérico, nunca el RUC.
  await ownerDb.update(orgProfile).set({ countryCode: "CL" }).where(eq(orgProfile.organizationId, c.orgId))
  expect((await create({ name: "Dental Sur SpA", docType: "TRIBUTARIO", docNumber: "76.123.456-7" })).docType).toBe("TRIBUTARIO")
  await expect(create({ name: "Con RUC", docType: "RUC", docNumber: "20111222334" })).rejects.toMatchObject({
    code: "VALIDATION",
    message: "El tipo de documento del proveedor tiene que ser uno de la lista: Documento tributario, Documento nacional, Pasaporte u Otro",
  })
})
