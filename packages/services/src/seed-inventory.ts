/**
 * Semilla de inventario determinista e idempotente (la conecta `seed-dev`).
 * Dos sedes (la de la semilla y San Isidro) con lo que muestran las pantallas
 * (ADR 0067, lienzo de Inventario):
 * - Productos con unidad de uso y de compra: guantes por caja de 100,
 *   lidocaína por caja de 50 cartuchos, resina por jeringa, un cepillo que
 *   solo se vende con su precio, un enjuague que se usa y se vende, rollos de
 *   algodón por bolsa y una amalgama desactivada. Mínimos por sede.
 * - Un faltante (cepillos que salieron sin haber), un lote vencido y uno que
 *   vence en menos de 30 días.
 * - Compras en cada estado: borrador, por llegar, llegada en parte, cerrada
 *   con lo recibido y cancelada.
 * - Movimientos sueltos: un ajuste, un traslado a San Isidro, un uso con la
 *   paciente semilla y una muestra agregada sin compra.
 * Re-ejecutable sin duplicar: cada paso se busca antes por su código, su nota
 * o la clave de su movimiento.
 */
import type { Db } from "@odentia/db"
import { branch } from "@odentia/db/schema/org"
import { product, purchaseOrder, supplier } from "@odentia/db/schema/inventory"
import { and, asc, eq, ne } from "drizzle-orm"
import {
  addStock,
  adjustLot,
  cancelPurchaseOrder,
  closePurchaseOrder,
  confirmPurchaseOrder,
  createProduct,
  createPurchaseOrder,
  createSupplier,
  getProductDetail,
  type ProductInput,
  receivePurchaseOrder,
  registerUse,
  setProductActive,
  transferStock,
  updateProduct,
} from "./inventory.js"
import { consumeFefo, defaultWarehouse, movementsWithPrefix } from "./inventory-stock.js"

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
  // La segunda sede con historia; sin ella, todo queda en la de la semilla.
  const [sanIsidro] = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.organizationId, orgId), eq(branch.name, "Sede San Isidro")))
    .limit(1)
  const [otherSede] = sanIsidro
    ? [sanIsidro]
    : await tx
        .select({ id: branch.id })
        .from(branch)
        .where(and(eq(branch.organizationId, orgId), ne(branch.id, branchId), eq(branch.isActive, true)))
        .orderBy(asc(branch.createdAt))
        .limit(1)
  const secondId = otherSede?.id ?? null
  await defaultWarehouse(tx, orgId, branchId)
  if (secondId) await defaultWarehouse(tx, orgId, secondId)

  const supplierOf = async (values: { name: string; docNumber: string; email: string; phone: string; address: string }) => {
    const [existing] = await tx
      .select({ id: supplier.id })
      .from(supplier)
      .where(and(eq(supplier.organizationId, orgId), eq(supplier.name, values.name)))
      .limit(1)
    return existing?.id ?? (await createSupplier(tx, orgId, ownerUserId, { ...values, docType: "RUC" })).id
  }
  const andina = await supplierOf({
    name: "Dental Andina SAC",
    docNumber: "20123456789",
    email: "ventas@dentalandina.pe",
    phone: "+51 1 555 0134",
    address: "Av. Arequipa 2450, Lima",
  })
  const medica = await supplierOf({
    name: "Distribuidora Médica Lima",
    docNumber: "20555012345",
    email: "ventas@dmlima.pe",
    phone: "+51 1 555 0177",
    address: "Jr. Huallaga 310, Lima",
  })

  const minimums = (here: number, there: number) => [
    { branchId, minQuantity: here },
    ...(secondId ? [{ branchId: secondId, minQuantity: there }] : []),
  ]
  const catalog: Array<ProductInput & { sku: string }> = [
    { sku: "INS-GUANTE-NITRILO", name: "Guantes de nitrilo", unit: "guante", purchaseUnit: "caja", purchaseFactor: 100, minimums: minimums(1000, 500) },
    { sku: "INS-ANESTESIA-LIDO", name: "Lidocaína 2% con epinefrina", unit: "cartucho", purchaseUnit: "caja", purchaseFactor: 50, minimums: minimums(50, 30) },
    { sku: "PRO-RESINA-A2", name: "Resina compuesta A2", unit: "jeringa", minimums: minimums(8, 4) },
    { sku: "INS-ALGODON-ROLLO", name: "Rollos de algodón", unit: "rollo", purchaseUnit: "bolsa", purchaseFactor: 500, minimums: minimums(500, 0) },
    // Solo se vende: aparece en «Cobrar» con su precio.
    {
      sku: "VEN-CEPILLO-SUAVE",
      name: "Cepillo dental suave",
      usedInCare: false,
      forSale: true,
      unit: "cepillo",
      purchaseUnit: "caja",
      purchaseFactor: 12,
      salePriceCents: 1500,
      minimums: minimums(5, 0),
    },
    // Se usa en la limpieza y también se vende.
    {
      sku: "VEN-ENJUAGUE-250",
      name: "Enjuague bucal 250 ml",
      usedInCare: true,
      forSale: true,
      unit: "frasco",
      purchaseUnit: "caja",
      purchaseFactor: 12,
      salePriceCents: 2800,
      minimums: minimums(4, 2),
    },
    // Ya no se usa en la clínica: queda desactivado, con su historia.
    { sku: "INS-AMALGAMA-CAP", name: "Amalgama en cápsulas", unit: "unidad", purchaseUnit: "frasco", purchaseFactor: 50 },
  ]
  const productIds: Record<string, string> = {}
  for (const item of catalog) {
    const [existing] = await tx
      .select({ id: product.id })
      .from(product)
      .where(and(eq(product.organizationId, orgId), eq(product.sku, item.sku)))
      .limit(1)
    // Los mínimos se ponen otra vez: una semilla vieja con el mínimo de antes queda al día.
    productIds[item.sku] = existing
      ? (await updateProduct(tx, orgId, ownerUserId, existing.id, { minimums: item.minimums ?? [] })).id
      : (await createProduct(tx, orgId, ownerUserId, item)).id
  }
  const id = (sku: string) => productIds[sku] as string
  const [amalgama] = await tx
    .select({ isActive: product.isActive })
    .from(product)
    .where(and(eq(product.organizationId, orgId), eq(product.id, id("INS-AMALGAMA-CAP"))))
  if (amalgama?.isActive) await setProductActive(tx, orgId, ownerUserId, id("INS-AMALGAMA-CAP"), false)

  const orderWith = async (notes: string) => {
    const [order] = await tx
      .select({ id: purchaseOrder.id })
      .from(purchaseOrder)
      .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.notes, notes)))
      .limit(1)
    return order?.id ?? null
  }

  // Llegada en parte, en la moneda de la clínica: guantes en parte, la anestesia
  // completa y la resina pendiente (como OC-0014 del lienzo).
  const partNotes = "Semilla: reposición mensual de insumos, llegó en parte"
  if (!(await orderWith(partNotes))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: andina,
      branchId,
      mode: "pedir",
      notes: partNotes,
      lines: [
        { productId: id("INS-GUANTE-NITRILO"), quantity: 20, unitCostCents: 3800 },
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 1, unitCostCents: 21000 },
        { productId: id("PRO-RESINA-A2"), quantity: 12, unitCostCents: 6500 },
      ],
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      [
        { productId: id("INS-GUANTE-NITRILO"), lots: [{ quantity: 12, lotCode: "SEED-GNT-001", expiresAt: "2028-06-30" }] },
        // La factura trajo otro precio: lo pedido queda como referencia.
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 1, lotCode: "SEED-ANE-001", expiresAt: "2027-03-31", unitCostCents: 20500 },
      ],
      `seed:recepcion:${orgId}`,
      { notify: false },
    )
  }

  // Cerrada con lo recibido: el algodón llegó con un lote que vence en menos
  // de 30 días y la anestesia con un lote ya vencido que sigue en el almacén.
  const closedNotes = "Semilla: compra cerrada con lo recibido, el proveedor no mandó el resto"
  if (!(await orderWith(closedNotes))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: medica,
      branchId,
      mode: "pedir",
      notes: closedNotes,
      lines: [
        { productId: id("INS-ALGODON-ROLLO"), quantity: 2, unitCostCents: 1200 },
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 3, unitCostCents: 20000 },
      ],
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      [
        { productId: id("INS-ALGODON-ROLLO"), quantity: 1, lotCode: "SEED-ALG-VENCE", expiresAt: dayFromToday(20) },
        { productId: id("INS-ANESTESIA-LIDO"), quantity: 1, lotCode: "SEED-ANE-VENCIDO", expiresAt: dayFromToday(-10) },
      ],
      `seed:recepcion-vencimientos:${orgId}`,
      { notify: false },
    )
    await closePurchaseOrder(tx, orgId, ownerUserId, order.id)
  }

  // Por llegar: los cepillos y el enjuague que se venden.
  const comingNotes = "Semilla: cepillos y enjuague por llegar"
  if (!(await orderWith(comingNotes)))
    await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: medica,
      branchId,
      mode: "pedir",
      notes: comingNotes,
      lines: [
        { productId: id("VEN-CEPILLO-SUAVE"), quantity: 2, unitCostCents: 9600 },
        { productId: id("VEN-ENJUAGUE-250"), quantity: 1, unitCostCents: 19800 },
      ],
    })

  // Un borrador que falta confirmar y otra que se canceló sin recibir nada.
  const draftNotes = "Semilla: pedido en borrador, falta confirmarlo con el proveedor"
  if (!(await orderWith(draftNotes)))
    await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: andina,
      branchId,
      notes: draftNotes,
      lines: [{ productId: id("PRO-RESINA-A2"), quantity: 6, unitCostCents: 6500 }],
    })
  const cancelledNotes = "Semilla: pedido cancelado, el proveedor no tenía stock"
  if (!(await orderWith(cancelledNotes))) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: andina,
      branchId,
      notes: cancelledNotes,
      lines: [{ productId: id("INS-GUANTE-NITRILO"), quantity: 5, unitCostCents: 3800 }],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await cancelPurchaseOrder(tx, orgId, ownerUserId, order.id)
  }

  // Movimientos de guantes, cada uno con su clave: re-ejecutar devuelve lo ya hecho.
  const gloves = await getProductDetail(tx, orgId, id("INS-GUANTE-NITRILO"), { branchId })
  const seedLot = gloves.lots.find((lot) => lot.code === "SEED-GNT-001")
  if (seedLot) {
    // Una caja llegó rota: el lote queda con 100 guantes menos.
    if ((await movementsWithPrefix(tx, orgId, `ajuste:seed-ajuste-${orgId}`)).length === 0)
      await adjustLot(tx, orgId, ownerUserId, {
        lotId: seedLot.id,
        counted: seedLot.quantityOnHand - 100,
        reason: "se_dano",
        note: "Una caja llegó rota",
        idempotencyKey: `seed-ajuste-${orgId}`,
      })
    if (secondId)
      await transferStock(tx, orgId, ownerUserId, {
        productId: id("INS-GUANTE-NITRILO"),
        fromBranchId: branchId,
        toBranchId: secondId,
        quantity: 200,
        idempotencyKey: `seed-traslado-${orgId}`,
      })
    // Usados con la paciente semilla fuera de una atención (se une a su atención de hoy si la tiene).
    await registerUse(tx, orgId, ownerUserId, {
      productId: id("INS-GUANTE-NITRILO"),
      branchId,
      quantity: 2,
      patientId,
      note: "Semilla: se usaron al revisarla en recepción",
      idempotencyKey: `seed-uso-${orgId}`,
    })
  }

  // Una muestra del proveedor que entró sin compra.
  await addStock(tx, orgId, ownerUserId, {
    productId: id("VEN-ENJUAGUE-250"),
    branchId,
    quantity: 2,
    reason: "muestra",
    note: "Dejó dos frascos la visitadora",
    idempotencyKey: `seed-muestra-${orgId}`,
  })

  // El faltante: tres cepillos salieron cuando no había ninguno registrado.
  const main = await defaultWarehouse(tx, orgId, branchId)
  await consumeFefo(tx, orgId, {
    productId: id("VEN-CEPILLO-SUAVE"),
    warehouseId: main.id,
    quantity: 3,
    allowShortage: true,
    base: {
      kind: "consumo",
      reason: "Semilla: se regalaron en la campaña escolar sin haberlos registrado",
      actorUserId: ownerUserId,
      keyPrefix: `seed-faltante-${orgId}`,
    },
  })
}
