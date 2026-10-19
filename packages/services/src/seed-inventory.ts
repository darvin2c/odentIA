/**
 * Seed de inventario determinista e idempotente (lo conecta el padre en
 * seed-dev). Crea proveedor, dos almacenes de la sede, productos (uno
 * desactivado), una orden con recepción parcial, otra recibida con un lote por
 * vencer y otro ya vencido con saldo, una en borrador y una cancelada, y los
 * movimientos de cada tipo: consumo clínico vinculado al paciente semilla,
 * ajuste y traslado. Re-ejecutable sin duplicar: cada paso se busca antes por
 * su código, su nota o la clave de su movimiento.
 */
import type { Db } from "@odentia/db"
import { product, productLot, purchaseOrder, supplier, warehouse } from "@odentia/db/schema/inventory"
import { and, eq } from "drizzle-orm"
import {
  cancelPurchaseOrder,
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  createWarehouse,
  getProductDetail,
  receivePurchaseOrder,
  recordMovement,
  setProductActive,
} from "./inventory.js"

export interface SeedInventoryInput {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
  contactId: string
}

/** Un día a `days` de hoy, `AAAA-MM-DD`: lo que vence se mide desde el día en que corre la semilla. */
function dayFromToday(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
}

export async function seedInventory(tx: Db, input: SeedInventoryInput): Promise<void> {
  const { orgId, ownerUserId, branchId, patientId } = input

  const [existingSupplier] = await tx
    .select({ id: supplier.id })
    .from(supplier)
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.name, "Dental Andina SAC")))
    .limit(1)
  const supplierId =
    existingSupplier?.id ??
    (
      await createSupplier(tx, orgId, ownerUserId, {
        name: "Dental Andina SAC",
        docType: "RUC",
        docNumber: "20123456789",
        email: "ventas@dentalandina.pe",
        phone: "+51 1 555 0134",
        address: "Av. Arequipa 2450, Lima",
      })
    ).id

  const warehouseOf = async (name: string) => {
    const [existing] = await tx
      .select({ id: warehouse.id })
      .from(warehouse)
      .where(and(eq(warehouse.organizationId, orgId), eq(warehouse.branchId, branchId), eq(warehouse.name, name)))
      .limit(1)
    return existing?.id ?? (await createWarehouse(tx, orgId, ownerUserId, { branchId, name })).id
  }
  const warehouseId = await warehouseOf("Almacén principal")
  // Lo que se tiene a mano junto a la unidad dental: destino del traslado.
  const cabinetId = await warehouseOf("Gabinete de la unidad dental 1")

  const catalog = [
    { sku: "INS-GUANTE-NITRILO", name: "Guantes de nitrilo", kind: "insumo", unit: "caja x 100", minStock: 10 },
    { sku: "INS-ANESTESIA-LIDO", name: "Lidocaína 2% con epinefrina", kind: "insumo", unit: "caja x 50 cartuchos", minStock: 5 },
    { sku: "PRO-RESINA-A2", name: "Resina compuesta A2", kind: "producto", unit: "jeringa 4 g", minStock: 8 },
    { sku: "INS-ALGODON-ROLLO", name: "Rollos de algodón", kind: "insumo", unit: "bolsa x 500", minStock: 3 },
    // Ya no se usa en la clínica: queda desactivado, con su historia.
    { sku: "INS-AMALGAMA-CAP", name: "Amalgama en cápsulas", kind: "insumo", unit: "frasco x 50 cápsulas", minStock: 0 },
  ] as const
  const productIds: Record<string, string> = {}
  for (const item of catalog) {
    const [existing] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.organizationId, orgId), eq(product.sku, item.sku)))
      .limit(1)
    productIds[item.sku] =
      existing?.id ??
      (
        await createProduct(tx, orgId, ownerUserId, {
          sku: item.sku,
          name: item.name,
          kind: item.kind,
          unit: item.unit,
          minStock: item.minStock,
        })
      ).id
  }
  const id = (sku: (typeof catalog)[number]["sku"]) => productIds[sku]!
  const [amalgama] = await tx
    .select({ isActive: product.isActive })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.id, id("INS-AMALGAMA-CAP"))))
  if (amalgama?.isActive) await setProductActive(tx, orgId, ownerUserId, id("INS-AMALGAMA-CAP"), false)

  const lotExists = async (code: string) => {
    const [lot] = await tx
      .select({ id: productLot.id })
      .from(productLot)
      .where(and(eq(productLot.organizationId, orgId), eq(productLot.code, code)))
      .limit(1)
    return Boolean(lot)
  }
  const orderExists = async (notes: string) => {
    const [order] = await tx
      .select({ id: purchaseOrder.id })
      .from(purchaseOrder)
      .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.notes, notes)))
      .limit(1)
    return Boolean(order)
  }

  // Orden con recepción parcial, en la moneda de la clínica (la orden la toma
  // del perfil): anestesia completa, guantes en parte y resina pendiente.
  if (!(await lotExists("SEED-GNT-001"))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId,
      warehouseId,
      notes: "Seed determinista: reposición mensual de insumos",
      lines: [
        { productId: id("INS-GUANTE-NITRILO"), quantity: 20, unitCostCents: 2850 },
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 10, unitCostCents: 9400 },
        { productId: id("PRO-RESINA-A2"), quantity: 12, unitCostCents: 15900 },
      ],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await receivePurchaseOrder(tx, orgId, ownerUserId, order.id, [
      { productId: id("INS-GUANTE-NITRILO"), quantity: 12, lotCode: "SEED-GNT-001", expiresAt: "2028-06-30" },
      { productId: id("INS-ANESTESIA-LIDO"), quantity: 10, lotCode: "SEED-ANE-001", expiresAt: "2027-03-31" },
    ], `seed:recepcion:${orgId}`)
  }

  // Orden recibida entera con lo que avisa Alertas: algodón que vence en menos
  // de 30 días y anestesia ya vencida que sigue en el almacén.
  if (!(await lotExists("SEED-ALG-VENCE"))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId,
      warehouseId,
      notes: "Semilla: compra con lotes por vencer y vencidos",
      lines: [
        { productId: id("INS-ALGODON-ROLLO"), quantity: 6, unitCostCents: 1200 },
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 2, unitCostCents: 9400 },
      ],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await receivePurchaseOrder(tx, orgId, ownerUserId, order.id, [
      { productId: id("INS-ALGODON-ROLLO"), quantity: 6, lotCode: "SEED-ALG-VENCE", expiresAt: dayFromToday(20) },
      { productId: id("INS-ANESTESIA-LIDO"), quantity: 2, lotCode: "SEED-ANE-VENCIDO", expiresAt: dayFromToday(-10) },
    ], `seed:recepcion-vencimientos:${orgId}`)
  }

  // Una orden que aún no se envía al proveedor y otra que se canceló sin recibir nada.
  const draftNotes = "Semilla: pedido en borrador, falta confirmarlo con el proveedor"
  if (!(await orderExists(draftNotes))) {
    await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId,
      warehouseId,
      notes: draftNotes,
      lines: [{ productId: id("PRO-RESINA-A2"), quantity: 6, unitCostCents: 15900 }],
    })
  }
  const cancelledNotes = "Semilla: pedido cancelado, el proveedor no tenía stock"
  if (!(await orderExists(cancelledNotes))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId,
      warehouseId,
      notes: cancelledNotes,
      lines: [{ productId: id("INS-GUANTE-NITRILO"), quantity: 5, unitCostCents: 2850 }],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await cancelPurchaseOrder(tx, orgId, ownerUserId, order.id)
  }

  // Movimientos de guantes, cada uno con su clave: re-ejecutar devuelve lo ya hecho.
  const detail = await getProductDetail(tx, orgId, id("INS-GUANTE-NITRILO"))
  const seedLot = detail.lots.find((lot) => lot.code === "SEED-GNT-001" && lot.warehouseId === warehouseId)
  if (seedLot) {
    // Consumo clínico vinculado al paciente semilla (trazable, con motivo).
    await recordMovement(tx, orgId, ownerUserId, {
      productId: id("INS-GUANTE-NITRILO"),
      kind: "consumo",
      quantity: 1,
      lotId: seedLot.id,
      reason: "Seed: consumo en profilaxis del paciente semilla",
      patientId,
      idempotencyKey: `seed:consumo:${orgId}:guantes`,
    })
    await recordMovement(tx, orgId, ownerUserId, {
      productId: id("INS-GUANTE-NITRILO"),
      kind: "ajuste",
      quantity: -1,
      lotId: seedLot.id,
      reason: "Semilla: una caja llegó rota y se descartó",
      idempotencyKey: `seed:ajuste:${orgId}:guantes`,
    })
    await recordMovement(tx, orgId, ownerUserId, {
      productId: id("INS-GUANTE-NITRILO"),
      kind: "traslado",
      quantity: 2,
      lotId: seedLot.id,
      destWarehouseId: cabinetId,
      reason: "Semilla: reposición del gabinete de la unidad dental 1",
      idempotencyKey: `seed:traslado:${orgId}:guantes`,
    })
  }
}
