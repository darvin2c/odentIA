/**
 * Seed de inventario determinista e idempotente (lo conecta el padre en
 * seed-dev). Crea proveedor, almacén de la sede, tres productos, una orden
 * de compra con recepción parcial (lotes + ingresos trazables) y un consumo
 * clínico vinculado al paciente semilla. Re-ejecutable sin duplicar.
 */
import type { Db } from "@odentia/db"
import { product, productLot, supplier, warehouse } from "@odentia/db/schema/inventory"
import { and, eq } from "drizzle-orm"
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

export interface SeedInventoryInput {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
  contactId: string
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

  const [existingWarehouse] = await tx
    .select({ id: warehouse.id })
    .from(warehouse)
    .where(
      and(
        eq(warehouse.organizationId, orgId),
        eq(warehouse.branchId, branchId),
        eq(warehouse.name, "Almacén principal"),
      ),
    )
    .limit(1)
  const warehouseId =
    existingWarehouse?.id ??
    (await createWarehouse(tx, orgId, ownerUserId, { branchId, name: "Almacén principal" })).id

  const catalog = [
    { sku: "INS-GUANTE-NITRILO", name: "Guantes de nitrilo", kind: "insumo", unit: "caja x 100", minStock: 10 },
    { sku: "INS-ANESTESIA-LIDO", name: "Lidocaína 2% con epinefrina", kind: "insumo", unit: "caja x 50 cartuchos", minStock: 5 },
    { sku: "PRO-RESINA-A2", name: "Resina compuesta A2", kind: "producto", unit: "jeringa 4 g", minStock: 8 },
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

  // Orden idempotente: si ya existe una orden seed con estas líneas, se
  // reutiliza en vez de duplicarla.
  const [existingLot] = await tx
    .select({ id: productLot.id })
    .from(productLot)
    .where(and(eq(productLot.organizationId, orgId), eq(productLot.code, "SEED-GNT-001")))
    .limit(1)
  if (!existingLot) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId,
      warehouseId,
      currency: "PEN",
      notes: "Seed determinista: reposición mensual de insumos",
      lines: [
        { productId: productIds["INS-GUANTE-NITRILO"]!, quantity: 20, unitCostCents: 2850 },
        { productId: productIds["INS-ANESTESIA-LIDO"]!, quantity: 10, unitCostCents: 9400 },
        { productId: productIds["PRO-RESINA-A2"]!, quantity: 12, unitCostCents: 15900 },
      ],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    // Recepción parcial a propósito: anestesia completa, guantes parcial,
    // resina pendiente (la orden queda parcialmente_recibida).
    await receivePurchaseOrder(tx, orgId, ownerUserId, order.id, [
      { productId: productIds["INS-GUANTE-NITRILO"]!, quantity: 12, lotCode: "SEED-GNT-001", expiresAt: "2028-06-30" },
      { productId: productIds["INS-ANESTESIA-LIDO"]!, quantity: 10, lotCode: "SEED-ANE-001", expiresAt: "2027-03-31" },
    ], `seed:recepcion:${orgId}`)
  }

  // Consumo clínico vinculado al paciente semilla (trazable, con motivo).
  const detail = await getProductDetail(tx, orgId, productIds["INS-GUANTE-NITRILO"]!)
  const seedLot = detail.lots.find((lot) => lot.code === "SEED-GNT-001")
  if (seedLot) {
    await recordMovement(tx, orgId, ownerUserId, {
      productId: productIds["INS-GUANTE-NITRILO"]!,
      kind: "consumo",
      quantity: 1,
      lotId: seedLot.id,
      reason: "Seed: consumo en profilaxis del paciente semilla",
      patientId,
      idempotencyKey: `seed:consumo:${orgId}:guantes`,
    })
  }
}
