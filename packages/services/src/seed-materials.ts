/**
 * Semilla de materiales por servicio y venta desde «Cobrar» (ADR 0067): corre
 * después de la de Inventario. Deja dos servicios con sus materiales (así
 * «Empieza por estos 5» muestra el resto), la atención firmada de Rosa con sus
 * «Materiales usados» descontados, un cepillo vendido en Caja, otros dos
 * cobrados de los que devolvió uno (ADR 0068) y un enjuague cobrado. Determinista e idempotente: la
 * purga de la demo (`dental/seed-demo.ts`) borra lo anterior.
 */
import type { Db } from "@odentia/db"
import { encounter, encounterProcedure, serviceCatalog } from "@odentia/db/schema/clinical"
import { product } from "@odentia/db/schema/inventory"
import { and, desc, eq, inArray, isNull } from "drizzle-orm"
import { listPaymentMethods } from "./payment-methods.js"
import { collectCharge, createCharge, returnFromTicket } from "./payments.js"
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
    .where(
      and(
        eq(product.organizationId, orgId),
        inArray(product.sku, ["INS-GUANTE-NITRILO", "INS-ALGODON-ROLLO", "PRO-RESINA-A2", "VEN-CEPILLO-SUAVE", "VEN-ENJUAGUE-250"]),
      ),
    )
  const bySku = new Map(products.map((row) => [row.sku, row.id]))
  const gloves = bySku.get("INS-GUANTE-NITRILO")
  const cotton = bySku.get("INS-ALGODON-ROLLO")
  const resin = bySku.get("PRO-RESINA-A2")
  const brush = bySku.get("VEN-CEPILLO-SUAVE")
  const rinse = bySku.get("VEN-ENJUAGUE-250")
  if (!gloves || !cotton || !resin || !brush || !rinse) throw new Error("Faltan productos de la semilla de Inventario")

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

  // Dos cepillos cobrados; otro día devolvió uno cerrado y se le pagó en efectivo:
  // el ticket sigue valiendo con su «Devolución 000001» y el cepillo volvió a la sede.
  const pair = await createCharge(tx, orgId, ownerUserId, patientId, {
    productId: brush,
    quantity: 2,
    branchId,
    requestKey: "semilla:venta-cepillos-devuelto-uno",
  })
  const cash = (await listPaymentMethods(tx, orgId)).find((method) => method.typeCode === "10")
  if (!cash) throw new Error("Falta el efectivo en los medios de pago de la semilla")
  const paid = await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId,
    chargeIds: [pair.id],
    payments: [{ paymentMethodId: cash.id, amountCents: pair.amountCents }],
    requestId: "50206010-0000-4000-8000-000000000201",
  })
  await returnFromTicket(tx, orgId, ownerUserId, patientId, paid.ticket.id, {
    branchId,
    lines: [{ chargeId: pair.id, quantity: 1 }],
    paymentMethodId: cash.id,
    reason: "Lo trajo cerrado: prefería otro modelo",
    requestId: "50206010-0000-4000-8000-000000000202",
  })

  // Un enjuague vendido y pagado: «¿cuál es mi producto más vendido?» compara dos productos (issue 192).
  const rinseSale = await createCharge(tx, orgId, ownerUserId, patientId, {
    productId: rinse,
    quantity: 1,
    branchId,
    requestKey: "semilla:venta-enjuague",
  })
  await collectCharge(tx, orgId, ownerUserId, patientId, {
    branchId,
    chargeIds: [rinseSale.id],
    payments: [{ paymentMethodId: cash.id, amountCents: rinseSale.amountCents }],
    requestId: "50206010-0000-4000-8000-000000000203",
  })
}
