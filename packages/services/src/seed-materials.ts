/**
 * Semilla de materiales por servicio y venta desde «Cobrar» (ADR 0067): corre
 * después de la de Inventario. Deja dos servicios con sus materiales (así
 * «Empieza por estos 5» muestra el resto), la atención firmada de Rosa con sus
 * «Materiales usados» descontados y un cepillo vendido en Caja. Determinista e
 * idempotente: la purga de `seed-dev.ts` borra lo anterior.
 */
import type { Db } from "@odentia/db"
import { encounter, encounterProcedure, serviceCatalog } from "@odentia/db/schema/clinical"
import { product } from "@odentia/db/schema/inventory"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { createCharge } from "./payments.js"
import { discountEncounterMaterials, setServiceMaterials } from "./service-materials.js"

export interface SeedMaterialsInput {
  orgId: string
  ownerUserId: string
  branchId: string
  patientId: string
}

export async function seedMaterialsAndSales(tx: Db, input: SeedMaterialsInput): Promise<void> {
  const { orgId, ownerUserId, branchId, patientId } = input
  const products = await tx
    .select({ id: product.id, sku: product.sku })
    .from(product)
    .where(and(eq(product.organizationId, orgId), inArray(product.sku, ["INS-GUANTE-NITRILO", "INS-ALGODON-ROLLO", "PRO-RESINA-A2", "VEN-CEPILLO-SUAVE"])))
  const bySku = new Map(products.map((row) => [row.sku, row.id]))
  const gloves = bySku.get("INS-GUANTE-NITRILO")
  const cotton = bySku.get("INS-ALGODON-ROLLO")
  const resin = bySku.get("PRO-RESINA-A2")
  const brush = bySku.get("VEN-CEPILLO-SUAVE")
  if (!gloves || !cotton || !resin || !brush) throw new Error("Faltan productos de la semilla de Inventario")

  const services = await tx
    .select({ id: serviceCatalog.id, code: serviceCatalog.code, name: serviceCatalog.name })
    .from(serviceCatalog)
    .where(eq(serviceCatalog.organizationId, orgId))
  const cleaning = services.find((row) => row.code === "LIMPIEZA")
  if (!cleaning) throw new Error("Falta la limpieza en el tarifario de la semilla")
  await setServiceMaterials(tx, orgId, ownerUserId, cleaning.id, [
    { productId: gloves, quantity: 2 },
    { productId: cotton, quantity: 2 },
  ], { prices: true })

  // La última atención firmada de Rosa con un servicio: ese servicio (su resina)
  // lleva sus materiales y la atención los descuenta como al cerrarla (en la
  // semilla se firmó antes de configurarlos).
  const [signed] = await tx
    .select({
      id: encounter.id,
      patientId: encounter.patientId,
      branchId: encounter.branchId,
      startedAt: encounter.startedAt,
      serviceId: encounterProcedure.serviceId,
    })
    .from(encounter)
    .innerJoin(
      encounterProcedure,
      and(eq(encounterProcedure.organizationId, encounter.organizationId), eq(encounterProcedure.encounterId, encounter.id)),
    )
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.patientId, patientId),
        eq(encounter.status, "finalizada"),
        isNull(encounterProcedure.voidedAt),
      ),
    )
    .orderBy(desc(encounter.finalizedAt))
    .limit(1)
  const filling = signed?.serviceId ?? services.find((row) => row.name === "Obturación con resina")?.id
  if (filling && filling !== cleaning.id)
    await setServiceMaterials(tx, orgId, ownerUserId, filling, [
      { productId: gloves, quantity: 2 },
      { productId: resin, quantity: 1 },
      { productId: cotton, quantity: 4 },
    ], { prices: true })
  if (signed?.branchId) await discountEncounterMaterials(tx, orgId, ownerUserId, signed)

  // Un cepillo vendido en «Cobrar»: el concepto queda por cobrar y ya salió de la sede.
  await createCharge(tx, orgId, ownerUserId, patientId, {
    productId: brush,
    quantity: 1,
    branchId,
    requestKey: "semilla:venta-cepillo",
  })
}
