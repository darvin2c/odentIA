/**
 * Regresiones de inventario (hallazgos de revisión):
 * - Recepciones parciales idénticas con claves distintas aplican ambas;
 *   reintentar la misma clave no duplica; reutilizarla con otro contenido
 *   responde 409 sin efectos.
 * - El traslado mueve saldo entre almacenes con ledger doble válido.
 * - El tope pedido se respeta: recibir por encima responde 409 sin mover
 *   saldos (las recepciones concurrentes se serializan con FOR UPDATE).
 */
import type { Db } from "@odentia/db"
import { randomUUID } from "node:crypto"
import { branch } from "@odentia/db/schema/org"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createWarehouse,
  getProductDetail,
  receivePurchaseOrder,
  recordMovement,
} from "./inventory.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

interface InventoryFixture {
  actor: string
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  sede: { id: string }
  almacen: { id: string }
  proveedor: { id: string }
  producto: { id: string }
}

async function inventoryFixture(): Promise<InventoryFixture> {
  const f = await clinicalFixture()
  // Cada fixture usa SKU y documento propios: los tests comparten la DB del
  // contenedor y el unique por org colisionaría entre tests.
  const tag = randomUUID().replace(/-/g, "").slice(0, 8)
  const [sede] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name: `Sede test ${tag}` })
    .returning()
  const almacen = await f.run((tx) =>
    createWarehouse(tx, "org_a", f.actor, { branchId: sede.id, name: "Almacén test" }),
  )
  const proveedor = await f.run((tx) =>
    createSupplier(tx, "org_a", f.actor, { name: "Proveedor test", docType: "RUC", docNumber: `209999${tag}` }),
  )
  const producto = await f.run((tx) =>
    createProduct(tx, "org_a", f.actor, { sku: `INS-TEST-${tag}`, name: "Insumo test", kind: "insumo", unit: "unidad", minStock: 0 }),
  )
  return { actor: f.actor, run: f.run, sede, almacen, proveedor, producto }
}

async function confirmedOrder(fx: InventoryFixture, qty: number) {
  const order = await fx.run((tx) =>
    createPurchaseOrder(tx, "org_a", fx.actor, {
      supplierId: fx.proveedor.id,
      warehouseId: fx.almacen.id,
      lines: [{ productId: fx.producto.id, quantity: qty, unitCostCents: 100 }],
    }),
  )
  await fx.run((tx) => confirmPurchaseOrder(tx, "org_a", fx.actor, order.id))
  return order
}

it("dos entregas idénticas con claves distintas aplican; reintento idéntico no duplica; clave reutilizada con otro contenido responde 409", async () => {
  const fx = await inventoryFixture()
  const order = await confirmedOrder(fx, 10)
  const line = { productId: fx.producto.id, quantity: 4, lotCode: "T-001", expiresAt: "2028-01-01" }
  const keyA = randomUUID()
  const keyB = randomUUID()

  await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [line], keyA))
  await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [line], keyB))
  const afterTwo = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(afterTwo.onHand).toBe(8)

  // Reintento exacto de la primera entrega: sin efectos.
  await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [line], keyA))
  const afterRetry = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(afterRetry.onHand).toBe(8)

  // Misma clave con otra cantidad: 409 y sin efectos.
  await expect(
    fx.run((tx) =>
      receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ ...line, quantity: 2 }], keyA),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  // Misma clave con otro contenido: 409 y sin efectos.
  const otro = await fx.run((tx) =>
    createProduct(tx, "org_a", fx.actor, { sku: "INS-OTRO", name: "Otro", kind: "insumo", unit: "unidad", minStock: 0 }),
  )
  await expect(
    fx.run((tx) =>
      receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: otro.id, quantity: 1 }], keyA),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  const afterMismatch = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(afterMismatch.onHand).toBe(8)
})

it("el traslado mueve saldo entre almacenes con ledger doble y no deja negativos", async () => {
  const fx = await inventoryFixture()
  const destino = await fx.run((tx) =>
    createWarehouse(tx, "org_a", fx.actor, { branchId: fx.sede.id, name: "Almacén destino" }),
  )
  const order = await confirmedOrder(fx, 10)
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [
      { productId: fx.producto.id, quantity: 8, lotCode: "T-002", expiresAt: "2028-01-01" },
    ], randomUUID()),
  )
  const detail = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  const lote = detail.lots.find((row) => row.code === "T-002")!

  await fx.run((tx) =>
    recordMovement(tx, "org_a", fx.actor, {
      productId: fx.producto.id,
      kind: "traslado",
      quantity: 3,
      lotId: lote.id,
      destWarehouseId: destino.id,
      reason: "Traslado a destino",
      idempotencyKey: `test:traslado:${order.id}`,
    }),
  )
  const after = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  const origen = after.lots.find((row) => row.code === "T-002" && row.warehouseId === fx.almacen.id)!
  const llegado = after.lots.find((row) => row.code === "T-002" && row.warehouseId === destino.id)!
  expect(origen.quantityOnHand).toBe(5)
  expect(llegado.quantityOnHand).toBe(3)
  expect(after.movements.filter((row) => row.kind === "traslado")).toHaveLength(2)

  // Más de lo disponible: 409 sin mover saldos.
  await expect(
    fx.run((tx) =>
      recordMovement(tx, "org_a", fx.actor, {
        productId: fx.producto.id,
        kind: "traslado",
        quantity: 6,
        lotId: origen.id,
        destWarehouseId: destino.id,
        reason: "Traslado imposible",
        idempotencyKey: `test:traslado-imposible:${order.id}`,
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
})

it("recibir por encima de lo pedido responde 409 sin mover saldos", async () => {
  const fx = await inventoryFixture()
  const order = await confirmedOrder(fx, 10)
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [
      { productId: fx.producto.id, quantity: 10, lotCode: "T-003", expiresAt: "2028-01-01" },
    ], randomUUID()),
  )
  await expect(
    fx.run((tx) =>
      receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [
        { productId: fx.producto.id, quantity: 1, lotCode: "T-004" },
      ], randomUUID()),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  const detail = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(detail.onHand).toBe(10)
  expect(detail.lowStock).toBe(false)
})
