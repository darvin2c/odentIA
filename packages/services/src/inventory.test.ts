/**
 * Regresiones de inventario (hallazgos de revisión y cierre de la fase 1):
 * - Recepciones parciales idénticas con claves distintas aplican ambas;
 *   reintentar la misma clave no duplica, también después de completar la
 *   orden; reutilizarla con otro contenido es un conflicto sin efectos.
 * - Movimientos con clave obligatoria: el reintento se reconoce antes que el
 *   saldo, otro contenido con la misma clave es un conflicto en palabras y la
 *   carrera de dos iguales no aborta la transacción.
 * - El traslado mueve saldo entre almacenes con ledger doble: las dos filas
 *   guardan origen y destino como dice el esquema.
 * - Alertas y stock bajo en la consulta, con «hoy» en la zona de la clínica.
 * - Lo que protege la historia: unidad y tipo de un producto usado, sede de un
 *   almacén con existencias o compras.
 */
import type { Db } from "@odentia/db"
import { randomUUID } from "node:crypto"
import { member, user } from "@odentia/db/schema/auth"
import { stockMovement } from "@odentia/db/schema/inventory"
import { branch } from "@odentia/db/schema/org"
import { workspaceNotification } from "@odentia/db/schema/workspace"
import { and, eq, like } from "drizzle-orm"
import { expect, it } from "vitest"
import { describeAuditEvent } from "./audit-words.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { purchaseOrderLabel } from "./finance.js"
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createWarehouse,
  getAlerts,
  getProductDetail,
  getPurchaseOrder,
  listMovements,
  listProducts,
  receivePurchaseOrder,
  recordMovement,
  setProductActive,
  setWarehouseActive,
  updateProduct,
  updateSupplier,
  updateWarehouse,
} from "./inventory.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

interface InventoryFixture {
  actor: string
  patientId: string
  run: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>
  sede: { id: string }
  almacen: { id: string }
  proveedor: { id: string }
  producto: { id: string; sku: string }
}

const tagOf = () => randomUUID().replace(/-/g, "").slice(0, 8)

async function inventoryFixture(product: { unit?: string; minStock?: number } = {}): Promise<InventoryFixture> {
  const f = await clinicalFixture()
  // Cada fixture usa SKU y documento propios: los tests comparten la DB del
  // contenedor y el unique por org colisionaría entre tests.
  const tag = tagOf()
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
    createProduct(tx, "org_a", f.actor, {
      sku: `INS-TEST-${tag}`,
      name: "Insumo test",
      kind: "insumo",
      unit: product.unit ?? "unidad",
      minStock: product.minStock ?? 0,
    }),
  )
  return { actor: f.actor, patientId: f.patient.id, run: f.run, sede, almacen, proveedor, producto }
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

/** Una orden recibida entera en un lote propio: el saldo de partida de los movimientos. */
async function stockedLot(fx: InventoryFixture, qty: number, lotCode = `L-${tagOf()}`, expiresAt: string | null = "2028-01-01") {
  const order = await confirmedOrder(fx, qty)
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: qty, lotCode, expiresAt }], randomUUID()),
  )
  const detail = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  return detail.lots.find((lot) => lot.code === lotCode && lot.warehouseId === fx.almacen.id)!
}

const onHandOf = async (fx: InventoryFixture) => (await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))).onHand

/** Un miembro de org_a con el rol dado, para ver a quién llegan los avisos. */
async function memberWithRole(role: string): Promise<string> {
  const id = randomUUID()
  await ownerDb.insert(user).values({ id, name: `Equipo ${role}`, email: `${id}@example.test` })
  await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_a", userId: id, role, createdAt: new Date() })
  return id
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

it("reintentar la recepción que completó la orden devuelve lo ya aplicado, no un conflicto", async () => {
  const fx = await inventoryFixture()
  const order = await confirmedOrder(fx, 5)
  const lines = [{ productId: fx.producto.id, quantity: 5, lotCode: "T-COMPLETA", expiresAt: "2028-01-01" }]
  const key = randomUUID()
  const first = await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, lines, key))
  expect(first.status).toBe("recibida")

  // La respuesta se perdió y la pantalla reintenta con la misma clave.
  const retry = await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, lines, key))
  expect(retry.status).toBe("recibida")
  expect(retry.lines[0]?.receivedQuantity).toBe(5)
  expect(await onHandOf(fx)).toBe(5)
  const ingresos = await fx.run((tx) => listMovements(tx, "org_a", { productId: fx.producto.id, kind: "ingreso" }))
  expect(ingresos).toHaveLength(1)

  // Otra entrega (otra clave) sobre la orden completa sí es un conflicto, dicho con palabras.
  await expect(
    fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, order.id, lines, randomUUID())),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("ya se recibió entera") })
})

it("la recepción rechaza en palabras un producto repetido y un lote existente con otro vencimiento; sin código, el lote lleva el número de la orden", async () => {
  const fx = await inventoryFixture()
  const order = await confirmedOrder(fx, 10)
  const label = purchaseOrderLabel(order.orderNumber!)

  await expect(
    fx.run((tx) =>
      receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [
        { productId: fx.producto.id, quantity: 1 },
        { productId: fx.producto.id, quantity: 2 },
      ], randomUUID()),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400, message: expect.stringContaining("repite un producto") })

  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 2, expiresAt: "2028-01-01" }], randomUUID()),
  )
  const detail = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(detail.lots.map((lot) => lot.code)).toEqual([label])
  expect(detail.movements[0]?.reason).toBe(`Recepción de ${label} · lote ${label}`)

  // La segunda entrega sin código vuelve al mismo lote; con otro vencimiento no se ignora el dato.
  await expect(
    fx.run((tx) =>
      receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 2, expiresAt: "2029-01-01" }], randomUUID()),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining(`El lote ${label} de Insumo test ya existe`) })
  // Sin vencimiento, o con el mismo, suma al lote.
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 2, expiresAt: "2028-01-01" }], randomUUID()),
  )
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 1 }], randomUUID()),
  )
  const after = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  expect(after.lots).toHaveLength(1)
  expect(after.lots[0]).toMatchObject({ code: label, expiresAt: "2028-01-01", quantityOnHand: 5 })
})

it("confirmar fuera de borrador, recibir sin confirmar y cancelar con recepciones se rechazan en palabras", async () => {
  const fx = await inventoryFixture()
  const draft = await fx.run((tx) =>
    createPurchaseOrder(tx, "org_a", fx.actor, {
      supplierId: fx.proveedor.id,
      warehouseId: fx.almacen.id,
      lines: [{ productId: fx.producto.id, quantity: 3, unitCostCents: 100 }],
    }),
  )
  await expect(
    fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, draft.id, [{ productId: fx.producto.id, quantity: 1 }], randomUUID())),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Confirma la orden") })
  await fx.run((tx) => confirmPurchaseOrder(tx, "org_a", fx.actor, draft.id))
  await expect(fx.run((tx) => confirmPurchaseOrder(tx, "org_a", fx.actor, draft.id))).rejects.toMatchObject({
    code: "CONFLICT",
    message: "La orden ya está confirmada: solo se confirma una orden en borrador",
  })

  await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, draft.id, [{ productId: fx.producto.id, quantity: 1 }], randomUUID()))
  await expect(fx.run((tx) => cancelPurchaseOrder(tx, "org_a", fx.actor, draft.id))).rejects.toMatchObject({
    code: "CONFLICT",
    message: expect.stringContaining("ya tiene recepciones"),
  })

  // Una sin recepciones se cancela y ya no recibe ni se confirma; el estado nunca sale como código.
  const other = await confirmedOrder(fx, 2)
  const cancelled = await fx.run((tx) => cancelPurchaseOrder(tx, "org_a", fx.actor, other.id))
  expect(cancelled.status).toBe("cancelada")
  const refused = fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, other.id, [{ productId: fx.producto.id, quantity: 1 }], randomUUID()))
  await expect(refused).rejects.toMatchObject({ code: "CONFLICT", message: "La orden está cancelada y ya no admite recepción" })
  await expect(fx.run((tx) => confirmPurchaseOrder(tx, "org_a", fx.actor, other.id))).rejects.toMatchObject({
    message: "La orden está cancelada: solo se confirma una orden en borrador",
  })
})

it("consumo, ingreso manual y ajuste mueven el saldo con su motivo y nunca lo dejan negativo", async () => {
  const fx = await inventoryFixture({ unit: "caja x 100" })
  const lot = await stockedLot(fx, 10)
  const move = (input: Partial<Parameters<typeof recordMovement>[3]>) =>
    fx.run((tx) =>
      recordMovement(tx, "org_a", fx.actor, {
        productId: fx.producto.id,
        kind: "ingreso",
        quantity: 1,
        lotId: lot.id,
        reason: "Prueba",
        idempotencyKey: randomUUID(),
        ...input,
      }),
    )

  await move({ kind: "ingreso", quantity: 3, reason: "Donación de un proveedor" })
  expect(await onHandOf(fx)).toBe(13)

  await expect(move({ kind: "consumo", quantity: 2 })).rejects.toMatchObject({ code: "VALIDATION", message: expect.stringContaining("paciente") })
  const consumo = await move({ kind: "consumo", quantity: 2, patientId: fx.patientId, reason: "Profilaxis" })
  expect(consumo).toMatchObject({ kind: "consumo", quantityDelta: -2, patientId: fx.patientId })
  expect(await onHandOf(fx)).toBe(11)
  await expect(move({ kind: "consumo", quantity: 12, patientId: fx.patientId })).rejects.toMatchObject({
    code: "CONFLICT",
    message: "No alcanza el stock del lote: quedan 11 (caja x 100)",
  })

  await move({ kind: "ajuste", quantity: -11, reason: "Conteo físico" })
  expect(await onHandOf(fx)).toBe(0)
  await expect(move({ kind: "ajuste", quantity: -1 })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("negativo") })
  await expect(move({ kind: "ajuste", quantity: 0 })).rejects.toMatchObject({ code: "VALIDATION" })
  expect(await onHandOf(fx)).toBe(0)

  // Cada tipo deja su frase en la actividad del equipo, nunca el código.
  expect(describeAuditEvent("stock.ingreso").what).toBe("Registró un ingreso de existencias")
  expect(describeAuditEvent("stock.consumo").what).toBe("Registró el uso de un insumo con un paciente")
})

it("la clave del movimiento: obligatoria, se mira antes que el saldo y otro contenido con ella es un conflicto en palabras", async () => {
  const fx = await inventoryFixture()
  const lot = await stockedLot(fx, 5)
  const consumo = { productId: fx.producto.id, kind: "consumo" as const, quantity: 5, lotId: lot.id, reason: "Exodoncia", patientId: fx.patientId }

  await expect(
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, idempotencyKey: "  " })),
  ).rejects.toMatchObject({ code: "VALIDATION", status: 400 })

  const key = randomUUID()
  const first = await fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, idempotencyKey: key }))
  expect(await onHandOf(fx)).toBe(0)
  // El reintento llega con el lote ya vacío: devuelve lo hecho, no «no alcanza».
  const retry = await fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, idempotencyKey: key }))
  expect(retry.id).toBe(first.id)
  expect(await onHandOf(fx)).toBe(0)

  await expect(
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, quantity: 4, idempotencyKey: key })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("ya se registró con otros datos") })
  await expect(
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, kind: "ingreso", idempotencyKey: key })),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  // Tampoco se borra lo hecho si después se desactiva el producto: el reintento lo devuelve.
  await fx.run((tx) => setProductActive(tx, "org_a", fx.actor, fx.producto.id, false))
  const afterDeactivation = await fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...consumo, idempotencyKey: key }))
  expect(afterDeactivation.id).toBe(first.id)
})

it("dos movimientos con la misma clave al mismo tiempo dejan uno solo, sin abortar la transacción", async () => {
  const fx = await inventoryFixture()
  const lot = await stockedLot(fx, 10)
  const otherLot = await stockedLot(fx, 10)
  const ajuste = { productId: fx.producto.id, kind: "ajuste" as const, quantity: -1, reason: "Conteo" }

  // El mismo contenido: el segundo espera al primero y devuelve su fila.
  const key = randomUUID()
  const same = await Promise.all([
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...ajuste, lotId: lot.id, idempotencyKey: key })),
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...ajuste, lotId: lot.id, idempotencyKey: key })),
  ])
  expect(same[0].id).toBe(same[1].id)

  // Otro lote con la misma clave: uno entra y el otro es un conflicto, nunca un error de la base.
  const raced = randomUUID()
  const results = await Promise.allSettled([
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...ajuste, lotId: lot.id, idempotencyKey: raced })),
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...ajuste, lotId: otherLot.id, idempotencyKey: raced })),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  const rejected = results.find((result) => result.status === "rejected")
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "CONFLICT" })
  expect(await onHandOf(fx)).toBe(18)
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
  const traslado = {
    productId: fx.producto.id,
    kind: "traslado" as const,
    quantity: 3,
    lotId: lote.id,
    destWarehouseId: destino.id,
    reason: "Traslado a destino",
    idempotencyKey: `test:traslado:${order.id}`,
  }

  const entry = await fx.run((tx) => recordMovement(tx, "org_a", fx.actor, traslado))
  const after = await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))
  const origen = after.lots.find((row) => row.code === "T-002" && row.warehouseId === fx.almacen.id)!
  const llegado = after.lots.find((row) => row.code === "T-002" && row.warehouseId === destino.id)!
  expect(origen.quantityOnHand).toBe(5)
  expect(llegado.quantityOnHand).toBe(3)
  // Las dos filas: origen en `warehouseId`, destino en `destWarehouseId`, y el lote de cada lado.
  const rows = after.movements.filter((row) => row.kind === "traslado")
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row).toMatchObject({ warehouseId: fx.almacen.id, destWarehouseId: destino.id, destWarehouseName: "Almacén destino" })
  expect(rows.find((row) => row.quantityDelta > 0)?.lotId).toBe(llegado.id)
  expect(rows.find((row) => row.quantityDelta < 0)?.lotId).toBe(origen.id)
  // El almacén de destino ve la llegada; el de origen, la salida.
  const enDestino = await fx.run((tx) => listMovements(tx, "org_a", { productId: fx.producto.id, warehouseId: destino.id }))
  expect(enDestino.map((row) => row.quantityDelta)).toEqual([3])

  // El reintento devuelve la misma llegada sin mover nada más.
  const retry = await fx.run((tx) => recordMovement(tx, "org_a", fx.actor, traslado))
  expect(retry.id).toBe(entry.id)
  expect(await onHandOf(fx)).toBe(8)

  // Más de lo disponible: 409 sin mover saldos.
  await expect(
    fx.run((tx) =>
      recordMovement(tx, "org_a", fx.actor, { ...traslado, quantity: 6, lotId: origen.id, idempotencyKey: randomUUID() }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })
  // Al mismo almacén, o a uno desactivado, tampoco.
  await expect(
    fx.run((tx) =>
      recordMovement(tx, "org_a", fx.actor, { ...traslado, destWarehouseId: fx.almacen.id, lotId: origen.id, idempotencyKey: randomUUID() }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await fx.run((tx) => setWarehouseActive(tx, "org_a", fx.actor, destino.id, false))
  await expect(
    fx.run((tx) => recordMovement(tx, "org_a", fx.actor, { ...traslado, lotId: origen.id, idempotencyKey: randomUUID() })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "El almacén de destino está desactivado" })
})

it("un producto o un almacén desactivado no recibe movimientos ni órdenes nuevas", async () => {
  const fx = await inventoryFixture()
  const lot = await stockedLot(fx, 4)
  await fx.run((tx) => setProductActive(tx, "org_a", fx.actor, fx.producto.id, false))
  await expect(
    fx.run((tx) =>
      recordMovement(tx, "org_a", fx.actor, {
        productId: fx.producto.id,
        kind: "ingreso",
        quantity: 1,
        lotId: lot.id,
        reason: "Prueba",
        idempotencyKey: randomUUID(),
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "El producto está desactivado" })
  await expect(
    fx.run((tx) =>
      createPurchaseOrder(tx, "org_a", fx.actor, {
        supplierId: fx.proveedor.id,
        warehouseId: fx.almacen.id,
        lines: [{ productId: fx.producto.id, quantity: 1 }],
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })

  await fx.run((tx) => setProductActive(tx, "org_a", fx.actor, fx.producto.id, true))
  await fx.run((tx) => setWarehouseActive(tx, "org_a", fx.actor, fx.almacen.id, false))
  await expect(
    fx.run((tx) =>
      createPurchaseOrder(tx, "org_a", fx.actor, {
        supplierId: fx.proveedor.id,
        warehouseId: fx.almacen.id,
        lines: [{ productId: fx.producto.id, quantity: 1 }],
      }),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "El almacén destino está desactivado" })
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

  // En parte: el tope dice cuánto falta.
  const partial = await confirmedOrder(fx, 3)
  await fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, partial.id, [{ productId: fx.producto.id, quantity: 2 }], randomUUID()))
  await expect(
    fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, partial.id, [{ productId: fx.producto.id, quantity: 2 }], randomUUID())),
  ).rejects.toMatchObject({ code: "CONFLICT", message: "La recepción supera lo pedido: de ese producto faltan 1" })
  expect((await fx.run((tx) => getPurchaseOrder(tx, "org_a", partial.id))).status).toBe("parcialmente_recibida")
})

it("alertas: stock bajo en la consulta, lotes sin saldo fuera y «hoy» en la zona de la clínica", async () => {
  const fx = await inventoryFixture({ minStock: 5 })
  const holgado = await fx.run((tx) =>
    createProduct(tx, "org_a", fx.actor, { sku: `INS-HOLGADO-${tagOf()}`, name: "Holgado", unit: "unidad", minStock: 0 }),
  )
  const order = await fx.run((tx) =>
    createPurchaseOrder(tx, "org_a", fx.actor, {
      supplierId: fx.proveedor.id,
      warehouseId: fx.almacen.id,
      lines: [{ productId: fx.producto.id, quantity: 4, unitCostCents: 100 }],
    }),
  )
  await fx.run((tx) => confirmPurchaseOrder(tx, "org_a", fx.actor, order.id))
  // org_a está en America/Lima: a las 22:00 del 31 de diciembre en Lima ya es 1 de enero en UTC.
  const now = new Date("2030-01-01T03:00:00Z")
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 2, lotCode: "VENCE-HOY", expiresAt: "2029-12-31" }], randomUUID()),
  )
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 1, lotCode: "VENCIDO", expiresAt: "2029-12-30" }], randomUUID()),
  )
  await fx.run((tx) =>
    receivePurchaseOrder(tx, "org_a", fx.actor, order.id, [{ productId: fx.producto.id, quantity: 1, lotCode: "VENCIDO-VACIO", expiresAt: "2029-12-29" }], randomUUID()),
  )
  const empty = (await fx.run((tx) => getProductDetail(tx, "org_a", fx.producto.id))).lots.find((lot) => lot.code === "VENCIDO-VACIO")!
  await fx.run((tx) =>
    recordMovement(tx, "org_a", fx.actor, { productId: fx.producto.id, kind: "ajuste", quantity: -1, lotId: empty.id, reason: "Se descartó", idempotencyKey: randomUUID() }),
  )

  const low = await fx.run((tx) => listProducts(tx, "org_a", { lowStock: true }))
  expect(low.map((item) => item.id)).toContain(fx.producto.id)
  expect(low.map((item) => item.id)).not.toContain(holgado.id)
  expect(low.every((item) => item.lowStock)).toBe(true)

  const alerts = await fx.run((tx) => getAlerts(tx, "org_a", 30, now))
  expect(alerts.lowStock.find((item) => item.productId === fx.producto.id)).toMatchObject({ onHand: 3, minStock: 5, unit: "unidad" })
  const mine = (rows: typeof alerts.expired) => rows.filter((row) => row.sku === fx.producto.sku).map((row) => row.code)
  expect(mine(alerts.expiring)).toContain("VENCE-HOY")
  expect(mine(alerts.expired)).toContain("VENCIDO")
  expect(mine(alerts.expired)).not.toContain("VENCE-HOY")
  expect(mine(alerts.expired)).not.toContain("VENCIDO-VACIO")
})

it("el aviso de stock bajo llega a quien lee el inventario, con la unidad del producto, y no a quien hizo el movimiento", async () => {
  const fx = await inventoryFixture({ unit: "caja x 50", minStock: 5 })
  const owner = await memberWithRole("owner")
  const admin = await memberWithRole("admin")
  const reception = await memberWithRole("reception")
  const lot = await stockedLot(fx, 6)
  await fx.run((tx) =>
    recordMovement(tx, "org_a", admin, {
      productId: fx.producto.id,
      kind: "consumo",
      quantity: 3,
      lotId: lot.id,
      reason: "Cirugía",
      patientId: fx.patientId,
      idempotencyKey: randomUUID(),
    }),
  )
  const notices = await ownerDb
    .select({ userId: workspaceNotification.userId, body: workspaceNotification.body })
    .from(workspaceNotification)
    .where(and(eq(workspaceNotification.organizationId, "org_a"), eq(workspaceNotification.subject, `producto:${fx.producto.id}`)))
  const to = notices.map((row) => row.userId)
  expect(to).toContain(owner)
  expect(to).not.toContain(admin)
  expect(to).not.toContain(reception)
  expect(notices.find((row) => row.userId === owner)?.body).toBe(
    "Quedan 3 (caja x 50) y el mínimo es 5. Revisa el inventario para reponer.",
  )
})

it("la unidad y el tipo de un producto usado no cambian; la sede de un almacén con historia tampoco", async () => {
  const fx = await inventoryFixture({ unit: "caja x 100" })
  // Sin historia se corrige libremente.
  await fx.run((tx) => updateProduct(tx, "org_a", fx.actor, fx.producto.id, { unit: "caja x 50", kind: "producto" }))
  await confirmedOrder(fx, 2)
  await expect(
    fx.run((tx) => updateProduct(tx, "org_a", fx.actor, fx.producto.id, { unit: "unidad" })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("«caja x 50»") })
  await expect(
    fx.run((tx) => updateProduct(tx, "org_a", fx.actor, fx.producto.id, { kind: "insumo" })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("El tipo no se puede cambiar") })
  // Repetir el mismo valor o cambiar otra cosa sí se puede.
  const renamed = await fx.run((tx) =>
    updateProduct(tx, "org_a", fx.actor, fx.producto.id, { unit: "caja x 50", name: "Insumo renombrado", minStock: 3 }),
  )
  expect(renamed).toMatchObject({ unit: "caja x 50", name: "Insumo renombrado", minStock: 3 })

  const [otraSede] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Otra sede ${tagOf()}` }).returning()
  await expect(
    fx.run((tx) => updateWarehouse(tx, "org_a", fx.actor, fx.almacen.id, { branchId: otraSede.id })),
  ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("no se puede pasar a otra") })
  const nuevo = await fx.run((tx) => createWarehouse(tx, "org_a", fx.actor, { branchId: fx.sede.id, name: "Recién creado" }))
  const moved = await fx.run((tx) => updateWarehouse(tx, "org_a", fx.actor, nuevo.id, { branchId: otraSede.id, name: "Ya en la otra sede" }))
  expect(moved).toMatchObject({ branchId: otraSede.id, name: "Ya en la otra sede" })
  // Renombrar uno con historia sí se puede.
  await fx.run((tx) => updateWarehouse(tx, "org_a", fx.actor, fx.almacen.id, { name: "Almacén renombrado", branchId: fx.sede.id }))
})

it("el documento de un proveedor exige su tipo: no se asume el de ningún país", async () => {
  const fx = await inventoryFixture()
  const tag = tagOf()
  await expect(
    fx.run((tx) => createSupplier(tx, "org_a", fx.actor, { name: "Sin tipo", docNumber: `RFC${tag}` })),
  ).rejects.toMatchObject({ status: 400 })
  const supplier = await fx.run((tx) =>
    createSupplier(tx, "org_a", fx.actor, { name: "Proveedor mexicano", docType: "RFC", docNumber: `XAXX${tag}` }),
  )
  expect(supplier).toMatchObject({ docType: "RFC", docNumber: `XAXX${tag}` })
  // Tampoco al editar: quitar el tipo dejando el número no rellena otro por defecto.
  await expect(
    fx.run((tx) => updateSupplier(tx, "org_a", fx.actor, supplier.id, { docType: null })),
  ).rejects.toMatchObject({ status: 400 })
  // Un proveedor sin documento sigue siendo válido.
  const plain = await fx.run((tx) => createSupplier(tx, "org_a", fx.actor, { name: `Sin documento ${tag}` }))
  expect(plain).toMatchObject({ docType: null, docNumber: null })
  await expect(
    fx.run((tx) => updateSupplier(tx, "org_a", fx.actor, plain.id, { docNumber: `NIT${tag}` })),
  ).rejects.toMatchObject({ status: 400 })
})

it("los mensajes de inventario no llevan códigos internos", async () => {
  const fx = await inventoryFixture()
  await expect(
    fx.run((tx) =>
      createPurchaseOrder(tx, "org_a", fx.actor, {
        supplierId: fx.proveedor.id,
        warehouseId: fx.almacen.id,
        lines: [{ productId: fx.producto.id, quantity: 1, unitCostCents: 3_000_000_000 }],
      }),
    ),
  ).rejects.toMatchObject({ message: "El costo por unidad es demasiado alto" })
  await expect(
    fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, randomUUID(), [{ productId: fx.producto.id, quantity: 1 }], randomUUID())),
  ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Orden de compra no encontrada" })
  await expect(
    fx.run((tx) => receivePurchaseOrder(tx, "org_a", fx.actor, randomUUID(), [{ productId: fx.producto.id, quantity: 1 }], "")),
  ).rejects.toMatchObject({ message: expect.not.stringMatching(/idempotencia|inventory\.|2147483647/) })
  // Ningún movimiento de la recepción guarda fragmentos de UUID en su motivo.
  const movements = await ownerDb
    .select({ reason: stockMovement.reason })
    .from(stockMovement)
    .where(and(eq(stockMovement.organizationId, "org_a"), like(stockMovement.reason, "Recepción%")))
  for (const row of movements) expect(row.reason).toMatch(/^Recepción de OC-\d{4,} · lote /)
})
