/**
 * La operación de una clínica de demo (ADR 0096): lo que el equipo ya usa
 * además de la agenda y la historia. Inventario con compras en cada estado,
 * lotes vencidos y por vencer y lo que hace falta reponer; los materiales de
 * cada servicio descontados en las atenciones de las dos últimas semanas;
 * productos vendidos en Caja; promociones de su tarifario, creadas antes de
 * la historia para que sus cobros las lleven (`seedPromotions`); comisiones
 * con el mes pasado pagado; oportunidades de quienes escribieron; y las
 * respuestas que Sofi ya tiene publicadas.
 *
 * Lo usan `buildDemo` («Crear demo» de la administración) y el consultorio de
 * latidIA de la semilla de desarrollo. Todo pasa por las operaciones de cada
 * pantalla; solo lo que tiene que quedar con fecha de antes (cuándo llegó una
 * compra, cuándo se gastó un material) se fecha después, como escribe su
 * historia `seedReports`. No envía mensajes ni activa nada.
 */
import { randomUUID } from "node:crypto"
import { supplierDocumentTypes } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  encounter,
  encounterProcedure,
  serviceCatalog,
  treatmentTemplate,
} from "@odentia/db/schema/clinical"
import { contact } from "@odentia/db/schema/crm"
import { branch } from "@odentia/db/schema/org"
import { promotion, promotionServicePrice } from "@odentia/db/schema/promotions"
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm"
import type { DemoCountry, DemoKindRecipe, DemoProductRecipe } from "./demo-recipes.js"
import { demoPriceCents } from "./demo-recipes.js"
import {
  getMonthlyCommissions,
  payMonthCommission,
  payPurchaseOrder,
  setCommissionRate,
} from "./finance.js"
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
  receivePurchaseOrder,
  registerUse,
  setProductActive,
  transferStock,
} from "./inventory.js"
import { createKnowledgeEntry, setKnowledgeStatus } from "./knowledge.js"
import { getOrgLocale, orgClinicalProfile } from "./locale.js"
import {
  closeOpportunity,
  createOpportunity,
  moveOpportunity,
  setOpportunityTask,
} from "./opportunities.js"
import { listPaymentMethods } from "./payment-methods.js"
import { collectCharge, createCharge } from "./payments.js"
import { ensureDefaultPipeline } from "./pipelines.js"
import { createPromotion } from "./promotions.js"
import {
  addDays,
  addMonths,
  currentMonthIn,
  dayStart,
  monthStart,
  reportDayOf,
} from "./report-periods.js"
import { generator, type Random, type ReportsSeedPromotion } from "./seed-reports.js"
import { discountEncounterMaterials, setServiceMaterials } from "./service-materials.js"

export interface OperationSeedInput {
  orgId: string
  /** Quien lo hace en las pantallas: la dueña o quien presenta la demo. */
  ownerUserId: string
  recipe: Pick<DemoKindRecipe, "inventory" | "promotions" | "knowledge" | "budgets">
  country: DemoCountry
  seed: number
}

export interface OperationSeedResult {
  products: number
  orders: number
  discounted: number
  settlements: number
  opportunities: number
  knowledge: number
}

const DAY_MS = 86_400_000
/** Las atenciones de estos últimos días descuentan sus materiales. */
const DISCOUNT_DAYS = 14
/** Tope de atenciones que descuentan: una demo grande no tarda minutos en esto. */
const DISCOUNT_MAX = 120
/** Porcentaje de comisión de cada profesional, por orden. */
const RATES = [3500, 3000, 4000, 3000]

interface Offered {
  id: string
  name: string
  priceCents: number
  key: string
  /** El tipo de la biblioteca: lo de ginecología no se le ofrece a un hombre. */
  kind: string
}

interface Context {
  tx: Db
  orgId: string
  ownerUserId: string
  country: DemoCountry
  random: Random
  timezone: string
  currency: string
  now: Date
  today: string
  branches: string[]
  services: Map<string, Offered>
  /** Si la clínica presenta presupuestos: sin ellos, ninguna oportunidad espera uno. */
  budgets: boolean
}

/** Lo que necesitan las partes: la zona y la moneda de la clínica, sus sedes y su tarifario. */
async function contextOf(tx: Db, input: OperationSeedInput): Promise<Context> {
  const { timezone, currency } = await getOrgLocale(tx, input.orgId)
  const now = new Date()
  const branches = await tx
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.organizationId, input.orgId), eq(branch.isActive, true)))
    .orderBy(asc(branch.createdAt))
  if (branches.length === 0) throw new Error("La demo no tiene sedes")
  const services = await tx
    .select({
      id: serviceCatalog.id,
      name: serviceCatalog.name,
      priceCents: serviceCatalog.priceCents,
      key: treatmentTemplate.key,
      kind: treatmentTemplate.kind,
    })
    .from(serviceCatalog)
    .innerJoin(treatmentTemplate, eq(treatmentTemplate.id, serviceCatalog.templateId))
    .where(and(eq(serviceCatalog.organizationId, input.orgId), eq(serviceCatalog.isActive, true)))
  return {
    tx,
    orgId: input.orgId,
    ownerUserId: input.ownerUserId,
    country: input.country,
    random: generator(input.seed ^ 0x0be7a710),
    timezone,
    currency,
    now,
    today: reportDayOf(timezone, now),
    branches: branches.map((row) => row.id),
    budgets: input.recipe.budgets,
    services: new Map(
      services.flatMap((row) =>
        row.priceCents === null ? [] : [[row.key, { ...row, priceCents: row.priceCents }] as const],
      ),
    ),
  }
}

export async function seedOperation(
  tx: Db,
  input: OperationSeedInput,
): Promise<OperationSeedResult> {
  const ctx = await contextOf(tx, input)
  const inventory = await seedInventoryOf(ctx, input.recipe.inventory)
  const settlements = await seedCommissionsOf(ctx)
  const opportunities = await seedOpportunitiesOf(ctx)
  const knowledge = await seedKnowledgeOf(ctx, input.recipe.knowledge)
  return { ...inventory, settlements, opportunities, knowledge }
}

/** Mediodía de un día de la clínica, a `days` de hoy. */
function dayAt(ctx: Context, days: number, hour = 12): Date {
  const [year, month, date] = addDays(ctx.today, days).split("-").map(Number) as [
    number,
    number,
    number,
  ]
  return new Date(dayStart(ctx.timezone, year, month, date).getTime() + hour * 3_600_000)
}

// --- Inventario -------------------------------------------------------------------------------

/**
 * Lo que entra: lo que no gasta ningún servicio (stock general, lo que se
 * vende y lo retirado) y lo que gasta algún servicio que la clínica ofrece.
 */
function productsFor(ctx: Context, recipe: DemoKindRecipe["inventory"]): DemoProductRecipe[] {
  const usedBy = new Map<string, string[]>()
  for (const [template, items] of Object.entries(recipe.materials))
    for (const item of items) usedBy.set(item.sku, [...(usedBy.get(item.sku) ?? []), template])
  return recipe.products.filter((item) => {
    const templates = usedBy.get(item.sku)
    return !templates || templates.some((template) => ctx.services.has(template))
  })
}

async function seedInventoryOf(ctx: Context, recipe: DemoKindRecipe["inventory"]) {
  const { tx, orgId, ownerUserId, country, random } = ctx
  const [main, second] = ctx.branches as [string, string | undefined]
  const included = productsFor(ctx, recipe)
  const care = included.filter((item) => !item.retired)

  // Las atenciones que van a descontar sus materiales: de ahí sale cuánto se compró.
  const materialServices = Object.keys(recipe.materials).flatMap((template) => {
    const service = ctx.services.get(template)
    return service ? [{ template, serviceId: service.id }] : []
  })
  const visits =
    materialServices.length === 0
      ? []
      : await tx
          .select({
            id: encounter.id,
            patientId: encounter.patientId,
            branchId: encounter.branchId,
            startedAt: encounter.startedAt,
            endedAt: encounter.endedAt,
            serviceId: encounterProcedure.serviceId,
          })
          .from(encounter)
          .innerJoin(
            encounterProcedure,
            and(
              eq(encounterProcedure.organizationId, encounter.organizationId),
              eq(encounterProcedure.encounterId, encounter.id),
            ),
          )
          .where(
            and(
              eq(encounter.organizationId, orgId),
              eq(encounter.status, "finalizada"),
              isNull(encounter.voidedAt),
              isNull(encounterProcedure.voidedAt),
              eq(encounter.branchId, main),
              gte(encounter.startedAt, new Date(ctx.now.getTime() - DISCOUNT_DAYS * DAY_MS)),
              inArray(
                encounterProcedure.serviceId,
                materialServices.map((item) => item.serviceId),
              ),
            ),
          )
          .orderBy(desc(encounter.startedAt))
          .limit(DISCOUNT_MAX)
  const templateOf = new Map(materialServices.map((item) => [item.serviceId, item.template]))
  const need = new Map<string, number>()
  for (const visit of visits)
    for (const item of recipe.materials[templateOf.get(visit.serviceId ?? "") ?? ""] ?? [])
      need.set(item.sku, (need.get(item.sku) ?? 0) + item.quantity)

  // Cuánto se compra de cada uno, en unidades de compra: lo que se va a gastar y lo
  // que debe quedar. Lo que hace falta reponer queda con menos que su mínimo.
  const sold = (item: DemoProductRecipe) => (item.sale !== undefined ? 3 : 0)
  const plan = care.map((item) => {
    const factor = item.purchase?.factor ?? 1
    const low = recipe.low.includes(item.sku)
    const used = (need.get(item.sku) ?? 0) + sold(item)
    const boxes = low
      ? Math.ceil((used + 1) / factor)
      : Math.ceil((used + item.min * 2) / factor) + random.int(0, 1)
    const left = boxes * factor - used
    // El mínimo de la sede: si lo que queda de la última caja pasa el de la receta, el de
    // la clínica es más alto (repone antes de abrir la última).
    const min = low && left >= item.min ? left + Math.max(1, Math.ceil(item.min / 2)) : item.min
    return { item, boxes, min }
  })

  // Proveedores del país, con su documento tributario.
  const docType = supplierDocumentTypes(await orgClinicalProfile(tx, orgId))[0] ?? null
  const suppliers: string[] = []
  for (const name of recipe.suppliers) {
    const domain = name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z]+/g, "")
    const phone = `${country.mobile.prefix}${String(random.int(10 ** (country.mobile.digits - 1), 10 ** country.mobile.digits - 1))}`
    const row = await createSupplier(tx, orgId, ownerUserId, {
      name: `${name} ${country.company.suffix}`,
      docType,
      docNumber: docType ? country.company.taxNumber(random) : null,
      email: `ventas@${domain}.example.com`,
      phone,
      address: `Av. Principal ${random.int(100, 2_900)}, ${random.pick(country.places)}`,
    })
    suppliers.push(row.id)
  }
  const [mainSupplier, otherSupplier] = suppliers as [string, string]

  const ids = new Map<string, string>()
  for (const { item, min } of [
    ...plan,
    ...included.filter((item) => item.retired).map((item) => ({ item, min: 0 })),
  ]) {
    const row = await createProduct(tx, orgId, ownerUserId, {
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      purchaseUnit: item.purchase?.unit ?? null,
      purchaseFactor: item.purchase?.factor ?? 1,
      usedInCare: !item.onlySale,
      forSale: item.sale !== undefined,
      salePriceCents: item.sale !== undefined ? demoPriceCents(item.sale, country) : null,
      minimums:
        min > 0
          ? [
              { branchId: main, minQuantity: min },
              ...(second ? [{ branchId: second, minQuantity: Math.ceil(min / 2) }] : []),
            ]
          : [],
    })
    ids.set(item.sku, row.id)
    if (item.retired) await setProductActive(tx, orgId, ownerUserId, row.id, false)
  }
  const id = (sku: string) => ids.get(sku) as string
  const costOf = (item: DemoProductRecipe) => demoPriceCents(item.cost, country)
  const expiring = recipe.expiring.filter((sku) =>
    care.some((item) => item.sku === sku && !item.onlySale),
  )
  const [expiredSku, soonSku] = expiring
  const lotOf = (sku: string, days: number) => ({
    lotCode: `L${reportDayOf(ctx.timezone, new Date(ctx.now.getTime() - days * DAY_MS))
      .replaceAll("-", "")
      .slice(2)}-${sku.split("-")[1] ?? "A"}`,
    expiresAt: sku === soonSku ? addDays(ctx.today, 20) : addDays(ctx.today, random.int(380, 720)),
  })
  const backdate = async (orderId: string, createdDaysAgo: number, receivedDaysAgo?: number) => {
    await tx.execute(sql`update purchase_order set created_at = ${dayAt(ctx, -createdDaysAgo, 10).toISOString()}::timestamptz
      where organization_id = ${orgId} and id = ${orderId}::uuid`)
    if (receivedDaysAgo !== undefined)
      await tx.execute(sql`update stock_movement set created_at = ${dayAt(ctx, -receivedDaysAgo, 11).toISOString()}::timestamptz
        where organization_id = ${orgId} and purchase_order_id = ${orderId}::uuid`)
  }
  let orders = 0

  // Una compra anterior, cerrada con lo que llegó: de ahí el lote que ya venció.
  const expired = expiredSku ? plan.find((line) => line.item.sku === expiredSku) : undefined
  if (expired) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: otherSupplier,
      branchId: main,
      mode: "pedir",
      notes: "Llegó una sola caja; el proveedor no tenía el resto",
      lines: [
        { productId: id(expired.item.sku), quantity: 2, unitCostCents: costOf(expired.item) },
      ],
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      [
        {
          productId: id(expired.item.sku),
          quantity: 1,
          lotCode: "L-ANT-01",
          expiresAt: addDays(ctx.today, -12),
        },
      ],
      `demo:recepcion-anterior:${orgId}`,
      { notify: false },
    )
    await closePurchaseOrder(tx, orgId, ownerUserId, order.id)
    await backdate(order.id, 52, 47)
    orders += 1
  }

  // La compra grande del mes: llegó entera hace tres semanas y está pagada.
  // Lo que se vende llega en su propia compra.
  const big = plan.filter((line) => line.item.sale === undefined)
  if (big.length > 0) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: mainSupplier,
      branchId: main,
      mode: "pedir",
      notes: "Reposición del mes",
      lines: big.map((line) => ({
        productId: id(line.item.sku),
        quantity: line.boxes,
        unitCostCents: costOf(line.item),
      })),
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      big.map((line) => ({
        productId: id(line.item.sku),
        quantity: line.boxes,
        ...lotOf(line.item.sku, 21),
      })),
      `demo:recepcion-mes:${orgId}`,
      { notify: false },
    )
    const total = big.reduce((sum, line) => sum + line.boxes * costOf(line.item), 0)
    await payPurchaseOrder(tx, orgId, ownerUserId, {
      orderId: order.id,
      amountCents: total,
      spentAt: dayAt(ctx, -15, 16).toISOString(),
      fromCash: false,
      receiptKind: "Factura",
      receiptNumber: `F001-${random.int(1_000, 9_999)}`,
    })
    await backdate(order.id, 24, 21)
    orders += 1
  }

  // Lo que se vende, de otro proveedor: llegó en parte y se pagó la mitad.
  const forSale = plan.filter((line) => line.item.sale !== undefined)
  if (forSale.length > 0) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: otherSupplier,
      branchId: main,
      mode: "pedir",
      notes: "Productos para la venta en recepción",
      lines: forSale.map((line) => ({
        productId: id(line.item.sku),
        quantity: line.boxes + 1,
        unitCostCents: costOf(line.item),
      })),
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      forSale.map((line) => ({
        productId: id(line.item.sku),
        quantity: line.boxes,
        ...lotOf(line.item.sku, 6),
      })),
      `demo:recepcion-venta:${orgId}`,
      { notify: false },
    )
    const received = forSale.reduce((sum, line) => sum + line.boxes * costOf(line.item), 0)
    await payPurchaseOrder(tx, orgId, ownerUserId, {
      orderId: order.id,
      amountCents: Math.round(received / 2 / 100) * 100,
      spentAt: dayAt(ctx, -5, 16).toISOString(),
      fromCash: false,
      receiptKind: "Factura",
      receiptNumber: `F002-${random.int(100, 999)}`,
    })
    await backdate(order.id, 9, 6)
    orders += 1
  }

  // Lo que hace falta: uno ya pedido que aún no llega, otro en borrador.
  const lows = plan.filter((line) => recipe.low.includes(line.item.sku))
  const [coming] = lows
  // Sin un segundo que haga falta, el borrador repone otro de uso.
  const draft = lows[1] ?? big.find((line) => line !== coming)
  if (coming) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: mainSupplier,
      branchId: main,
      mode: "pedir",
      notes: "Pedido por stock bajo",
      lines: [
        {
          productId: id(coming.item.sku),
          quantity: Math.max(2, coming.boxes),
          unitCostCents: costOf(coming.item),
        },
      ],
    })
    await backdate(order.id, 2)
    orders += 1
  }
  if (draft) {
    await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: otherSupplier,
      branchId: main,
      notes: "Falta confirmar el precio con el proveedor",
      lines: [
        {
          productId: id(draft.item.sku),
          quantity: Math.max(1, draft.boxes),
          unitCostCents: costOf(draft.item),
        },
      ],
    })
    orders += 1
  }
  // Y una que se canceló: el proveedor no tenía stock.
  const anyCare = big[0]
  if (anyCare) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: otherSupplier,
      branchId: main,
      notes: "El proveedor no tenía stock",
      lines: [
        { productId: id(anyCare.item.sku), quantity: 2, unitCostCents: costOf(anyCare.item) },
      ],
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await cancelPurchaseOrder(tx, orgId, ownerUserId, order.id)
    await backdate(order.id, 30)
    orders += 1
  }

  // Materiales de cada servicio y lo que gastaron las atenciones de estos días,
  // como al firmarlas: cada salida dice de qué atención y servicio fue.
  for (const { template, serviceId } of materialServices) {
    const items = (recipe.materials[template] ?? []).filter((item) => ids.has(item.sku))
    if (items.length > 0)
      await setServiceMaterials(
        tx,
        orgId,
        ownerUserId,
        serviceId,
        items.map((item) => ({ productId: id(item.sku), quantity: item.quantity })),
        { prices: true },
      )
  }
  let discounted = 0
  for (const visit of [...visits].reverse()) {
    const done = await discountEncounterMaterials(tx, orgId, ownerUserId, visit)
    if (!done) continue
    discounted += 1
    await tx.execute(sql`update stock_movement set created_at = ${(visit.endedAt ?? visit.startedAt).toISOString()}::timestamptz
      where organization_id = ${orgId} and idempotency_key like ${`atencion:${visit.id}:%`}`)
  }

  // Movimientos sueltos: una caja dañada, una muestra, lo usado en recepción y lo que va a la otra sede.
  const sturdy = big.find(
    (line) => !recipe.low.includes(line.item.sku) && (line.item.purchase?.factor ?? 1) >= 50,
  )
  if (sturdy) {
    const detail = await getProductDetail(tx, orgId, id(sturdy.item.sku), { branchId: main })
    const lot = detail.lots.find((item) => item.quantityOnHand > 10)
    if (lot)
      await adjustLot(tx, orgId, ownerUserId, {
        lotId: lot.id,
        counted: lot.quantityOnHand - Math.ceil((sturdy.item.purchase?.factor ?? 10) / 10),
        reason: "se_dano",
        note: "Un paquete llegó abierto",
        idempotencyKey: `demo-ajuste-${orgId}`,
      })
  }
  const both = plan.find((line) => line.item.sale !== undefined && !line.item.onlySale)
  if (both)
    await addStock(tx, orgId, ownerUserId, {
      productId: id(both.item.sku),
      branchId: main,
      quantity: 2,
      reason: "muestra",
      note: "Muestras que dejó el proveedor",
      idempotencyKey: `demo-muestra-${orgId}`,
    })
  const [lastVisit] = visits
  const gloves = big.find((line) => line.item.sku === "INS-GUANTE-NITRILO")
  if (gloves && lastVisit)
    await registerUse(tx, orgId, ownerUserId, {
      productId: id(gloves.item.sku),
      branchId: main,
      quantity: 2,
      patientId: lastVisit.patientId,
      note: "Se usaron al revisarlo en recepción",
      idempotencyKey: `demo-uso-${orgId}`,
    })
  if (gloves && second)
    await transferStock(tx, orgId, ownerUserId, {
      productId: id(gloves.item.sku),
      fromBranchId: main,
      toBranchId: second,
      quantity: gloves.item.purchase?.factor ?? 100,
      idempotencyKey: `demo-traslado-${orgId}`,
    })

  // Lo vendido en Caja: dos pacientes de esta semana se llevaron lo que se vende.
  const buyers = [...new Set(visits.map((visit) => visit.patientId))].slice(0, forSale.length)
  const cash = (await listPaymentMethods(tx, orgId)).find((method) => method.typeCode === "10")
  for (const [index, patientId] of buyers.entries()) {
    const line = forSale[index]
    if (!line) continue
    const charge = await createCharge(tx, orgId, ownerUserId, patientId, {
      productId: id(line.item.sku),
      quantity: 1,
      branchId: main,
      requestKey: `demo:venta:${index}`,
    })
    // La primera se pagó; la otra quedó por cobrar.
    if (index === 0 && cash)
      await collectCharge(tx, orgId, ownerUserId, patientId, {
        branchId: main,
        chargeIds: [charge.id],
        payments: [{ paymentMethodId: cash.id, amountCents: charge.amountCents }],
        requestId: randomUUID(),
      })
  }
  return { products: ids.size, orders, discounted }
}

// --- Promociones ------------------------------------------------------------------------------

/**
 * Las promociones de la receta sobre servicios que la clínica ofrece: la
 * vigente empezó hace tres semanas y sigue; la terminada duró el mes pasado.
 * Se crean antes de la historia para que sus cobros nazcan con su precio
 * (`demoPromotionsOf`): un pago no se reescribe después.
 */
export async function seedPromotions(tx: Db, input: OperationSeedInput): Promise<number> {
  const ctx = await contextOf(tx, input)
  const month = currentMonthIn(ctx.timezone, ctx.now)
  const last = addMonths(month, -1)
  let created = 0
  for (const recipe of input.recipe.promotions) {
    const service = ctx.services.get(recipe.template)
    if (!service) continue
    // Una promoción siempre baja algo: si la tarifa ya es menor, queda un 20 % por debajo.
    const offer = demoPriceCents(recipe.price, ctx.country)
    const priceCents =
      offer < service.priceCents ? offer : Math.floor((service.priceCents * 0.8) / 100) * 100
    if (priceCents <= 0) continue
    const startsAt =
      recipe.when === "vigente"
        ? dayAt(ctx, -21, 0)
        : monthStart(ctx.timezone, last.year, last.month)
    const endsAt =
      recipe.when === "vigente"
        ? null
        : new Date(monthStart(ctx.timezone, month.year, month.month).getTime() - 1000)
    await createPromotion(tx, ctx.orgId, ctx.ownerUserId, {
      name: recipe.name,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt?.toISOString() ?? null,
      conditions: recipe.conditions,
      items: [
        {
          serviceId: service.id,
          mode: recipe.mode ?? "fixed",
          priceCents,
        },
      ],
    })
    created += 1
  }
  return created
}

/**
 * Las promociones de la clínica como las usa la historia de la demo: dos de
 * cada cinco cobros de su servicio en sus fechas la llevan. Con «desde», lo
 * acordado va del mínimo a la tarifa en cuatro escalones.
 */
export async function demoPromotionsOf(tx: Db, orgId: string): Promise<ReportsSeedPromotion[]> {
  const rows = await tx
    .select({
      id: promotion.id,
      name: promotion.name,
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      serviceId: promotionServicePrice.serviceId,
      mode: promotionServicePrice.mode,
      priceCents: promotionServicePrice.priceCents,
      tariffCents: serviceCatalog.priceCents,
    })
    .from(promotion)
    .innerJoin(
      promotionServicePrice,
      and(
        eq(promotionServicePrice.organizationId, promotion.organizationId),
        eq(promotionServicePrice.promotionId, promotion.id),
      ),
    )
    .innerJoin(
      serviceCatalog,
      and(
        eq(serviceCatalog.organizationId, promotion.organizationId),
        eq(serviceCatalog.id, promotionServicePrice.serviceId),
      ),
    )
    .where(
      and(
        eq(promotion.organizationId, orgId),
        eq(promotion.isActive, true),
        eq(promotionServicePrice.isActive, true),
      ),
    )
  return rows.map((row) => {
    const gap = (row.tariffCents ?? row.priceCents) - row.priceCents
    const step = Math.max(0, Math.floor(gap / 3 / 100) * 100)
    return {
      id: row.id,
      name: row.name,
      serviceId: row.serviceId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      share: 0.4,
      priceCents: (random) =>
        row.mode === "from" ? row.priceCents + random.int(0, 3) * step : row.priceCents,
    }
  })
}

// --- Comisiones -------------------------------------------------------------------------------

/** Cada profesional con su porcentaje y lo del mes pasado ya pagado; lo de este mes queda por pagar. */
async function seedCommissionsOf(ctx: Context): Promise<number> {
  const { tx, orgId, ownerUserId } = ctx
  const month = currentMonthIn(ctx.timezone, ctx.now)
  const last = addMonths(month, -1)
  const lastStart = monthStart(ctx.timezone, last.year, last.month)
  const professionals = await tx.execute<{ userId: string; branchId: string; first: Date }>(sql`
    select e.professional_user_id as "userId", mode() within group (order by e.branch_id) as "branchId", min(e.started_at) as first
    from encounter e
    where e.organization_id = ${orgId} and e.status = 'finalizada' and e.voided_at is null and e.branch_id is not null
      and e.started_at >= ${lastStart.toISOString()}::timestamptz
    group by e.professional_user_id
    order by first, e.professional_user_id`)
  let settlements = 0
  for (const [index, professional] of [...professionals].entries()) {
    await setCommissionRate(tx, orgId, ownerUserId, {
      professionalUserId: professional.userId,
      rateBps: RATES[index % RATES.length] as number,
    })
    const view = await getMonthlyCommissions(tx, orgId, {
      professionalUserId: professional.userId,
      year: last.year,
      month: last.month,
    })
    if (view.pendingCents <= 0) continue
    await payMonthCommission(tx, orgId, ownerUserId, {
      professionalUserId: professional.userId,
      year: last.year,
      month: last.month,
      branchId: professional.branchId,
      expectedCents: view.pendingCents,
    })
    settlements += 1
  }
  return settlements
}

// --- Oportunidades ----------------------------------------------------------------------------

/**
 * Quienes escribieron hace poco y preguntaron por un tratamiento: una en cada
 * paso del embudo, una ganada y una perdida. El interés es de lo que más vale
 * en su tarifario.
 */
async function seedOpportunitiesOf(ctx: Context): Promise<number> {
  const { tx, orgId, ownerUserId } = ctx
  const interests = [...ctx.services.values()]
    .sort((a, b) => b.priceCents - a.priceCents)
    .slice(0, 3)
  if (interests.length === 0) return 0
  const people = await tx.execute<{
    contactId: string
    patientId: string | null
    conversationId: string | null
    sex: string | null
  }>(sql`
    select c.id as "contactId", p.id as "patientId", c.sex, (
      select v.id from conversation v where v.organization_id = c.organization_id and v.contact_id = c.id
      order by v.last_message_at desc nulls last limit 1
    ) as "conversationId"
    from contact c
    left join patient p on p.organization_id = c.organization_id and p.person_id = c.id
    where c.organization_id = ${orgId} and c.is_active
      and exists (select 1 from conversation v where v.organization_id = c.organization_id and v.contact_id = c.id)
    order by (select max(v.last_message_at) from conversation v where v.organization_id = c.organization_id and v.contact_id = c.id) desc nulls last
    limit 5`)
  // Sin conversaciones (un consultorio recién abierto), son sus pacientes.
  const chosen =
    people.length > 0
      ? [...people]
      : (
          await tx
            .select({ contactId: contact.id, sex: contact.sex })
            .from(contact)
            .where(and(eq(contact.organizationId, orgId), eq(contact.isActive, true)))
            .orderBy(asc(contact.createdAt))
            .limit(3)
        ).map((row) => ({ ...row, patientId: null, conversationId: null }))
  const { stages } = await ensureDefaultPipeline(tx, orgId)
  const stage = (moment: string) => stages.find((item) => item.moment === moment)
  const actor = { userId: ownerUserId }
  let created = 0
  for (const [index, person] of chosen.entries()) {
    // Lo de ginecología es de mujeres: a un hombre le interesa lo siguiente de la lista.
    const service = [...interests.slice(index % interests.length), ...interests].find(
      (item) => item.kind !== "ginecologia" || person.sex !== "M",
    )
    if (!service) continue
    const opportunity = await createOpportunity(
      tx,
      orgId,
      {
        contactId: person.contactId,
        patientId: person.patientId,
        title: service.name,
        serviceId: service.id,
        conversationId: person.conversationId,
      },
      actor,
    )
    created += 1
    if (index === 0) {
      await setOpportunityTask(
        tx,
        orgId,
        opportunity.id,
        {
          title: "Llamar para resolver sus dudas del precio",
          dueAt: dayAt(ctx, 1, 10).toISOString(),
        },
        { userId: ownerUserId, createdBy: "user" },
      )
    } else if (index === 1) {
      const next = stage("evaluacion_agendada")
      if (next) await moveOpportunity(tx, orgId, opportunity.id, next.id, actor)
    } else if (index === 2) {
      const next = stage(ctx.budgets ? "presupuesto_enviado" : "evaluacion_agendada")
      if (next) await moveOpportunity(tx, orgId, opportunity.id, next.id, actor)
    } else if (index === 3) {
      await closeOpportunity(tx, orgId, opportunity.id, { outcome: "won", reason: "acepto" }, actor)
    } else {
      await closeOpportunity(
        tx,
        orgId,
        opportunity.id,
        {
          outcome: "lost",
          reason: "precio",
          note: "Le pareció caro; pidió que le avisemos si hay promoción.",
        },
        actor,
      )
    }
  }
  return created
}

// --- Conocimiento -----------------------------------------------------------------------------

/** Las respuestas oficiales que Sofi ya usa con los pacientes. */
async function seedKnowledgeOf(
  ctx: Context,
  recipes: DemoKindRecipe["knowledge"],
): Promise<number> {
  for (const recipe of recipes) {
    const entry = await createKnowledgeEntry(ctx.tx, ctx.orgId, ctx.ownerUserId, {
      kind: "faq",
      title: recipe.title,
      body: recipe.body,
      basicKey: recipe.basicKey ?? null,
      askForms: [...(recipe.askForms ?? [])],
    })
    await setKnowledgeStatus(ctx.tx, ctx.orgId, ctx.ownerUserId, entry.id, "publicada")
  }
  return recipes.length
}
