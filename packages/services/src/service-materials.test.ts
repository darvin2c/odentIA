/**
 * Materiales de cada servicio y lo que se usó en cada atención (ADR 0067):
 * - La lista de un servicio se reemplaza entera, solo con productos que se
 *   usan en las atenciones, y dice lo que cuesta cada vez con el último
 *   precio de compra (solo para quien ve precios).
 * - «Empieza por estos 5»: los servicios más hechos del mes sin materiales.
 * - Al firmar la atención se descuentan del lote que vence primero en la sede
 *   de la atención; lo que no alcanza queda como faltante; un reintento no
 *   descuenta dos veces; sin sede no se descuenta ni se anuncia.
 * - «Fueron 4, no 2»: corregir hacia arriba y hacia abajo, enlazado a la
 *   atención, por quien atendió o quien lleva el inventario.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterProcedure, serviceCatalog } from "@odentia/db/schema/clinical"
import {
  product,
  productLot,
  purchaseOrder,
  purchaseOrderLine,
  serviceMaterial,
  stockMovement,
  supplier,
} from "@odentia/db/schema/inventory"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { and, eq } from "drizzle-orm"
import { expect, it } from "vitest"
import { clinicalFixture } from "./clinical-test-fixture.js"
import {
  addEncounterProcedure,
  finalizeEncounter,
  getEncounterClosing,
  updateEncounterDraft,
  voidEncounterProcedure,
} from "./encounters.js"
import { defaultWarehouse, lotFor, receiveIntoLot, shortageOf } from "./inventory-stock.js"
import { nextPatientNumber } from "./patients.js"
import {
  correctEncounterMaterial,
  discountEncounterMaterials,
  getEncounterMaterials,
  listMaterialProducts,
  listServiceMaterials,
  serviceMaterialSummaries,
  setServiceMaterials,
  topServicesWithoutMaterials,
} from "./service-materials.js"
import { insertTestPatients } from "./test-patient.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

setupTestDb()

type Fixture = Awaited<ReturnType<typeof clinicalFixture>>

const tagOf = () => randomUUID().replace(/-/g, "").slice(0, 8)
const all = () => true
const none = () => false

async function newProduct(values: Partial<typeof product.$inferInsert> & { name: string }, orgId = "org_a") {
  const [row] = await ownerDb
    .insert(product)
    .values({ organizationId: orgId, sku: `MAT-${tagOf()}`, unit: "unidad", ...values })
    .returning()
  if (!row) throw new Error("Sin producto")
  return row
}

async function newBranch(name = `Sede Miraflores ${tagOf()}`) {
  const [row] = await ownerDb
    .insert(branch)
    .values({ organizationId: "org_a", name, timezone: "America/Lima" })
    .returning()
  if (!row) throw new Error("Sin sede")
  return row
}

/** Entra mercadería a un lote del almacén, como una compra o «Agregar sin compra». */
async function stockIn(
  f: Fixture,
  input: { productId: string; warehouseId: string; quantity: number; code: string; expiresAt?: string; purchaseOrderId?: string },
) {
  return f.run(async (tx) => {
    const lot = await lotFor(tx, "org_a", {
      productId: input.productId,
      warehouseId: input.warehouseId,
      code: input.code,
      expiresAt: input.expiresAt ?? null,
      purchaseOrderId: input.purchaseOrderId ?? null,
      actorUserId: f.actor,
    })
    await receiveIntoLot(tx, "org_a", {
      lot,
      quantity: input.quantity,
      base: {
        kind: "ingreso",
        reason: "Prueba",
        actorUserId: f.actor,
        keyPrefix: `prueba:${randomUUID()}`,
        purchaseOrderId: input.purchaseOrderId ?? null,
      },
    })
    return lot
  })
}

/** Una compra recibida de un producto, con su precio por unidad de compra y su factor. */
async function bought(
  f: Fixture,
  input: { productId: string; warehouseId: string; unitCostCents: number; unitFactor: number; boxes: number },
) {
  const [vendor] = await ownerDb.insert(supplier).values({ organizationId: "org_a", name: `Dental ${tagOf()}` }).returning()
  const [order] = await ownerDb
    .insert(purchaseOrder)
    .values({
      organizationId: "org_a",
      supplierId: vendor!.id,
      warehouseId: input.warehouseId,
      orderNumber: Math.floor(Math.random() * 1_000_000_000),
      status: "recibida",
      currency: "PEN",
    })
    .returning()
  await ownerDb.insert(purchaseOrderLine).values({
    organizationId: "org_a",
    orderId: order!.id,
    productId: input.productId,
    quantity: input.boxes,
    unitCostCents: input.unitCostCents,
    receivedQuantity: input.boxes,
    purchaseUnit: "caja",
    unitFactor: input.unitFactor,
  })
  await stockIn(f, {
    productId: input.productId,
    warehouseId: input.warehouseId,
    quantity: input.boxes * input.unitFactor,
    code: `OC-${tagOf()}`,
    purchaseOrderId: order!.id,
  })
}

async function lotQuantity(lotId: string): Promise<number> {
  const [row] = await ownerDb.select({ quantity: productLot.quantityOnHand }).from(productLot).where(eq(productLot.id, lotId))
  return row?.quantity ?? -1
}

it("los materiales de un servicio se reemplazan enteros, solo con lo que se usa en las atenciones, y dicen su costo por vez", async () => {
  const f = await clinicalFixture()
  const site = await newBranch()
  const store = await f.run((tx) => defaultWarehouse(tx, "org_a", site.id))
  const gloves = await newProduct({ name: "Guantes de nitrilo", unit: "guante", purchaseUnit: "caja", purchaseFactor: 100 })
  const paste = await newProduct({ name: "Pasta profiláctica", unit: "sobre" })
  const brush = await newProduct({ name: "Cepillo dental suave", unit: "cepillo", usedInCare: false, forSale: true })
  const old = await newProduct({ name: "Eyector viejo", isActive: false })

  const saved = await f.run((tx) =>
    setServiceMaterials(tx, "org_a", f.actor, f.service.id, [
      { productId: paste.id, quantity: 1 },
      { productId: gloves.id, quantity: 2 },
    ], { prices: false }),
  )
  expect(saved.items.map((item) => [item.name, item.quantityText, item.discounted])).toEqual([
    ["Guantes de nitrilo", "2 guantes", true],
    ["Pasta profiláctica", "1 sobre", true],
  ])
  // Sin permiso de precios no viaja ningún costo.
  expect(saved.cost).toBeNull()
  expect(saved.items.every((item) => item.costCents === null)).toBe(true)

  // Un producto va una vez; lo que solo se vende o está desactivado no entra.
  await expect(
    f.run((tx) =>
      setServiceMaterials(tx, "org_a", f.actor, f.service.id, [
        { productId: gloves.id, quantity: 2 },
        { productId: gloves.id, quantity: 1 },
      ], { prices: false }),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION" })
  await expect(
    f.run((tx) => setServiceMaterials(tx, "org_a", f.actor, f.service.id, [{ productId: brush.id, quantity: 1 }], { prices: false })),
  ).rejects.toMatchObject({ code: "PRODUCT_NOT_FOR_CARE", message: expect.stringContaining("Cepillo dental suave") })
  await expect(
    f.run((tx) => setServiceMaterials(tx, "org_a", f.actor, f.service.id, [{ productId: old.id, quantity: 1 }], { prices: false })),
  ).rejects.toMatchObject({ code: "PRODUCT_INACTIVE" })
  await expect(
    f.run((tx) => setServiceMaterials(tx, "org_a", f.actor, f.service.id, [{ productId: gloves.id, quantity: 0 }], { prices: false })),
  ).rejects.toMatchObject({ code: "VALIDATION" })

  // El costo por vez: precio de la última compra ÷ su factor × cantidad.
  await bought(f, { productId: gloves.id, warehouseId: store.id, unitCostCents: 1250, unitFactor: 100, boxes: 1 })
  await bought(f, { productId: gloves.id, warehouseId: store.id, unitCostCents: 1500, unitFactor: 100, boxes: 2 })
  const priced = await f.run((tx) => listServiceMaterials(tx, "org_a", f.service.id, { prices: true }))
  expect(priced.items.find((item) => item.productId === gloves.id)?.costCents).toBe(30)
  expect(priced.items.find((item) => item.productId === paste.id)?.costCents).toBeNull()
  expect(priced.cost).toEqual({ cents: 30, currency: "PEN", unpriced: 1, shareOfPrice: 30 / 120000 })
  const summaries = await f.run((tx) => serviceMaterialSummaries(tx, "org_a", [f.service.id], { prices: true }))
  expect(summaries.get(f.service.id)).toEqual({ count: 2, cost: { cents: 30, currency: "PEN", unpriced: 1 } })
  const blind = await f.run((tx) => serviceMaterialSummaries(tx, "org_a", [f.service.id], { prices: false }))
  expect(blind.get(f.service.id)).toEqual({ count: 2, cost: null })

  // Reemplazar quita lo que ya no está. Lo que se desactivó después puede
  // quedarse al guardar otro cambio, pero ya no se descuenta.
  await ownerDb.update(product).set({ isActive: false }).where(eq(product.id, paste.id))
  const replaced = await f.run((tx) =>
    setServiceMaterials(tx, "org_a", f.actor, f.service.id, [
      { productId: paste.id, quantity: 2 },
    ], { prices: false }),
  )
  expect(replaced.items).toEqual([expect.objectContaining({ productId: paste.id, quantity: 2, discounted: false })])
  const rows = await ownerDb.select().from(serviceMaterial).where(eq(serviceMaterial.serviceId, f.service.id))
  expect(rows).toHaveLength(1)
  const [trace] = await ownerDb
    .select()
    .from(auditEvent)
    .where(and(eq(auditEvent.entityId, f.service.id), eq(auditEvent.action, "stock.service_materials_set")))
    .limit(1)
  expect(trace).toBeTruthy()

  // Para «+ Agregar material» solo vienen los activos que se usan en las atenciones.
  const options = await f.run((tx) => listMaterialProducts(tx, "org_a", { q: "guantes nitrilo" }))
  expect(options.map((option) => option.productId)).toContain(gloves.id)
  const others = await f.run((tx) => listMaterialProducts(tx, "org_a", { q: "cepillo" }))
  expect(others.map((option) => option.productId)).not.toContain(brush.id)
})

it("«Empieza por estos 5»: los servicios más hechos del mes sin materiales y qué parte de las atenciones cubren", async () => {
  // Una clínica aparte: lo que cuentan las demás pruebas no se mezcla.
  await insertOrg(ownerDb, "org_m", "materiales")
  const dentist = randomUUID()
  await ownerDb.insert(user).values({ id: dentist, name: "Dra. Mat", email: `${dentist}@example.test` })
  const service = async (name: string, isActive = true) => {
    const [row] = await ownerDb
      .insert(serviceCatalog)
      .values({ organizationId: "org_m", name, scope: "general", source: "custom", priceCents: 10000, currency: "PEN", isActive })
      .returning()
    return row!
  }
  const cleaning = await service("Limpieza dental")
  const sealant = await service("Sellante por pieza")
  const resin = await service("Restauración con resina")
  const evaluation = await service("Evaluación", false)
  const resinA2 = await newProduct({ name: "Resina A2", unit: "jeringa" }, "org_m")
  await ownerDb.insert(serviceMaterial).values({ organizationId: "org_m", serviceId: resin.id, productId: resinA2.id, quantity: 1 })
  const [person] = await insertTestPatients(ownerDb, {
    organizationId: "org_m",
    displayName: "Paciente de materiales",
    patientNumber: await nextPatientNumber(ownerDb, "org_m"),
  })
  /** Una atención con sus actos; firmada hace `daysAgo` días, o en borrador. */
  const visit = async (acts: Array<{ serviceId: string; quantity?: number; voided?: boolean }>, daysAgo: number | null) => {
    const [row] = await ownerDb
      .insert(encounter)
      .values({ organizationId: "org_m", patientId: person!.id, dentistUserId: dentist, reason: "Control" })
      .returning()
    for (const act of acts)
      await ownerDb.insert(encounterProcedure).values({
        organizationId: "org_m",
        encounterId: row!.id,
        serviceId: act.serviceId,
        description: "Acto",
        quantity: act.quantity ?? 1,
        ...(act.voided ? { voidedAt: new Date(), voidedBy: dentist, voidReason: "Error" } : {}),
      })
    if (daysAgo !== null) {
      const at = new Date(Date.now() - daysAgo * 86_400_000)
      await ownerDb
        .update(encounter)
        .set({
          status: "finalizada",
          startedAt: at,
          finalizedAt: at,
          endedAt: at,
          finalizedBy: dentist,
          signerName: "Dra. Mat",
          signerTitle: "Cirujano dentista",
          signerRegistration: "COP 12345",
        })
        .where(eq(encounter.id, row!.id))
    }
  }
  await visit([{ serviceId: cleaning.id }], 2)
  await visit([{ serviceId: cleaning.id }, { serviceId: sealant.id, quantity: 4 }], 5)
  await visit([{ serviceId: cleaning.id }], 10)
  await visit([{ serviceId: resin.id }], 3)
  await visit([{ serviceId: evaluation.id }, { serviceId: cleaning.id, voided: true }], 4)
  // Fuera del mes y sin firmar: no cuentan.
  await visit([{ serviceId: cleaning.id, quantity: 9 }], 40)
  await visit([{ serviceId: cleaning.id, quantity: 9 }], null)

  const top = await withOrgContext(appDb, "org_m", (tx) => topServicesWithoutMaterials(tx, "org_m"))
  expect(top.services).toEqual([
    { serviceId: sealant.id, name: "Sellante por pieza", times: 4 },
    { serviceId: cleaning.id, name: "Limpieza dental", times: 3 },
  ])
  expect(top).toMatchObject({ days: 30, totalEncounters: 5, coveredEncounters: 3, share: 0.6 })
  const one = await withOrgContext(appDb, "org_m", (tx) => topServicesWithoutMaterials(tx, "org_m", { limit: 1 }))
  expect(one).toMatchObject({ services: [{ serviceId: sealant.id }], coveredEncounters: 1 })
})

/** Atención en una sede con materiales y lotes: 2 guantes y 1 sobre por vez. */
async function careScenario() {
  const f = await clinicalFixture()
  const site = await newBranch()
  const store = await f.run((tx) => defaultWarehouse(tx, "org_a", site.id))
  const gloves = await newProduct({ name: "Guantes de nitrilo", unit: "guante" })
  const paste = await newProduct({ name: "Pasta profiláctica", unit: "sobre" })
  const retired = await newProduct({ name: "Eyector de saliva", unit: "unidad" })
  await f.run((tx) =>
    setServiceMaterials(tx, "org_a", f.actor, f.service.id, [
      { productId: gloves.id, quantity: 2 },
      { productId: paste.id, quantity: 1 },
      { productId: retired.id, quantity: 1 },
    ], { prices: false }),
  )
  // Ya no se usa en las atenciones: no se descuenta.
  await ownerDb.update(product).set({ usedInCare: false, forSale: true }).where(eq(product.id, retired.id))
  const later = await stockIn(f, { productId: gloves.id, warehouseId: store.id, quantity: 3, code: "L-2027", expiresAt: "2027-01-01" })
  const sooner = await stockIn(f, { productId: gloves.id, warehouseId: store.id, quantity: 2, code: "L-2026", expiresAt: "2026-12-01" })
  await f.run((tx) => updateEncounterDraft(tx, ...f.args, f.encounter.id, { branchId: site.id }))
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id, quantity: 2 }))
  const wrong = await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }))
  await f.run((tx) => voidEncounterProcedure(tx, ...f.args, f.encounter.id, wrong.id, { reason: "Se registró dos veces" }))
  await f.ready(f.encounter.id)
  return { f, site, store, gloves, paste, retired, later, sooner }
}

it("al firmar descuenta del lote que vence primero, deja el faltante, no repite y el cierre lo anuncia antes", async () => {
  const { f, site, store, gloves, paste, retired, later, sooner } = await careScenario()

  const closing = await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))
  expect(closing.materials).toEqual({
    branch: { id: site.id, name: site.name },
    items: [
      expect.objectContaining({ productId: gloves.id, quantity: 4, quantityText: "4 guantes" }),
      expect.objectContaining({ productId: paste.id, quantity: 2, quantityText: "2 sobres" }),
    ],
  })

  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(done.materials).toMatchObject({
    failed: false,
    branch: { id: site.id },
    items: [
      { productId: gloves.id, quantity: 4, shortage: 0 },
      { productId: paste.id, quantity: 2, shortage: 2 },
    ],
  })
  // Primero el lote que vence antes (2), después el otro (2 de 3).
  expect(await lotQuantity(sooner.id)).toBe(0)
  expect(await lotQuantity(later.id)).toBe(1)
  // No había pasta: queda como faltante, la atención se firmó igual.
  expect(await f.run((tx) => shortageOf(tx, "org_a", paste.id, store.id))).toBe(2)
  const moves = await ownerDb.select().from(stockMovement).where(eq(stockMovement.encounterId, f.encounter.id))
  expect(moves.every((move) => move.kind === "consumo" && move.patientId === f.patient.id)).toBe(true)
  expect(moves.some((move) => move.productId === retired.id)).toBe(false)
  expect(moves[0]?.reason).toMatch(/^Atención del .+ · Tratamiento propio$/)

  // Un reintento con la misma atención no descuenta otra vez.
  const again = await f.run((tx) =>
    discountEncounterMaterials(tx, "org_a", f.actor, {
      id: f.encounter.id,
      patientId: f.patient.id,
      branchId: site.id,
      startedAt: f.encounter.startedAt,
    }),
  )
  expect(again?.failed).toBe(false)
  const after = await ownerDb.select().from(stockMovement).where(eq(stockMovement.encounterId, f.encounter.id))
  expect(after).toHaveLength(moves.length)
  expect(await lotQuantity(later.id)).toBe(1)

  const used = await f.run((tx) => getEncounterMaterials(tx, ...f.args, f.encounter.id, none))
  expect(used).toMatchObject({
    branch: { id: site.id },
    canCorrect: true,
    items: [
      { productId: gloves.id, quantity: 4, quantityText: "4 guantes" },
      { productId: paste.id, quantity: 2, quantityText: "2 sobres" },
    ],
  })
})

it("sin sede en la atención no se descuenta nada y el cierre no lo anuncia", async () => {
  const f = await clinicalFixture()
  const gloves = await newProduct({ name: "Guantes sin sede", unit: "guante" })
  await f.run((tx) =>
    setServiceMaterials(tx, "org_a", f.actor, f.service.id, [{ productId: gloves.id, quantity: 2 }], { prices: false }),
  )
  await f.run((tx) => addEncounterProcedure(tx, ...f.args, f.encounter.id, { serviceId: f.service.id }))
  await f.ready(f.encounter.id)
  const closing = await f.run((tx) => getEncounterClosing(tx, "org_a", f.actor, f.patient.id, f.encounter.id))
  expect(closing.materials).toBeNull()
  const done = await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(done.materials).toBeNull()
  const moves = await ownerDb.select().from(stockMovement).where(eq(stockMovement.encounterId, f.encounter.id))
  expect(moves).toHaveLength(0)
  const used = await f.run((tx) => getEncounterMaterials(tx, ...f.args, f.encounter.id, all))
  expect(used).toEqual({ branch: null, items: [], canCorrect: false })
})

it("«Fueron 4, no 2»: corregir hacia arriba y hacia abajo queda unido a la atención y lo hace quien atendió o inventario", async () => {
  const { f, store, gloves, later, sooner } = await careScenario()
  // Mientras está en borrador no hay nada que corregir.
  await expect(
    f.run((tx) =>
      correctEncounterMaterial(tx, ...f.args, f.encounter.id, { productId: gloves.id, quantity: 6, idempotencyKey: "k0" }, all),
    ),
  ).rejects.toMatchObject({ code: "ENCOUNTER_NOT_FINALIZED" })
  await f.run((tx) => finalizeEncounter(tx, ...f.args, f.encounter.id))
  expect(await lotQuantity(later.id)).toBe(1)

  // Se usaron 6, no 4: sale 1 del lote que queda y 1 queda como faltante.
  const more = await f.run((tx) =>
    correctEncounterMaterial(tx, ...f.args, f.encounter.id, { productId: gloves.id, quantity: 6, idempotencyKey: "k1" }, none),
  )
  expect(more).toMatchObject({ changed: 2, replayed: false })
  expect(more.items.find((item) => item.productId === gloves.id)).toMatchObject({ quantity: 6, quantityText: "6 guantes" })
  expect(await lotQuantity(later.id)).toBe(0)
  expect(await f.run((tx) => shortageOf(tx, "org_a", gloves.id, store.id))).toBe(1)
  // El mismo formulario otra vez no descuenta de nuevo; con otro dato es un conflicto.
  const again = await f.run((tx) =>
    correctEncounterMaterial(tx, ...f.args, f.encounter.id, { productId: gloves.id, quantity: 6, idempotencyKey: "k1" }, none),
  )
  expect(again).toMatchObject({ changed: 2, replayed: true })
  expect(await f.run((tx) => shortageOf(tx, "org_a", gloves.id, store.id))).toBe(1)
  await expect(
    f.run((tx) =>
      correctEncounterMaterial(tx, ...f.args, f.encounter.id, { productId: gloves.id, quantity: 5, idempotencyKey: "k1" }, none),
    ),
  ).rejects.toMatchObject({ code: "CONFLICT" })

  // Se usó 1, no 6: vuelven 5; primero cubren el faltante y el resto va al lote.
  const less = await f.run((tx) =>
    correctEncounterMaterial(tx, ...f.args, f.encounter.id, { productId: gloves.id, quantity: 1, idempotencyKey: "k2" }, none),
  )
  expect(less).toMatchObject({ changed: -5, replayed: false })
  expect(await f.run((tx) => shortageOf(tx, "org_a", gloves.id, store.id))).toBe(0)
  expect((await lotQuantity(later.id)) + (await lotQuantity(sooner.id))).toBe(4)
  const moves = await ownerDb
    .select()
    .from(stockMovement)
    .where(and(eq(stockMovement.encounterId, f.encounter.id), eq(stockMovement.productId, gloves.id)))
  expect(moves.filter((move) => move.kind === "devolucion").reduce((sum, move) => sum + move.quantityDelta, 0)).toBe(5)
  expect(moves.every((move) => move.patientId === f.patient.id)).toBe(true)
  expect(moves.some((move) => move.reason.includes("fueron 1 guante, no 6 guantes"))).toBe(true)

  // Otro profesional sin inventario no corrige; quien lleva el inventario sí.
  const other = randomUUID()
  await ownerDb.insert(user).values({ id: other, name: "Otro", email: `${other}@example.test` })
  await expect(
    f.run((tx) =>
      correctEncounterMaterial(tx, "org_a", other, f.patient.id, f.encounter.id, { productId: gloves.id, quantity: 2, idempotencyKey: "k3" }, none),
    ),
  ).rejects.toMatchObject({ code: "FORBIDDEN" })
  const byOwner = await f.run((tx) =>
    correctEncounterMaterial(
      tx,
      "org_a",
      other,
      f.patient.id,
      f.encounter.id,
      { productId: gloves.id, quantity: 2, idempotencyKey: "k3" },
      (permission) => permission === "inventory.write",
    ),
  )
  expect(byOwner.items.find((item) => item.productId === gloves.id)?.quantity).toBe(2)
  const readByOther = await f.run((tx) => getEncounterMaterials(tx, "org_a", other, f.patient.id, f.encounter.id, none))
  expect(readByOther.canCorrect).toBe(false)
})
