/**
 * Semilla de Reportes: el avance de los tratamientos y los materiales usados
 * (issue 192, examen de Argos). Corre después de la historia de Reportes y de
 * su fase 3. Sin esto lo aceptado figura «realizado» sin fechas o «pendiente»
 * y ninguna atención de la historia gastó materiales: «¿cuántos tratamientos
 * están en proceso?» o «¿qué materiales se usan más?» no tienen con qué
 * responderse.
 * - Avance: lo aceptado de la historia y de las promociones toma fecha de
 *   inicio y de fin; parte queda en curso y parte suspendido o cancelado ya
 *   empezado, con su motivo.
 * - Materiales: resina, endodoncia y exodoncia con los suyos, una reposición
 *   recibida hace 100 días en cada sede y las atenciones de esos servicios de
 *   los últimos 90 días descontadas, cada movimiento con la fecha de su
 *   atención. La limpieza no se descuenta: el algodón que vence pronto es el
 *   de la demostración de Inventario.
 * Determinista: el orden sale del número de presupuesto y de la hora de la
 * atención, y el azar de un generador con semilla fija. Idempotente: lo ya
 * avanzado tiene fecha de inicio y cada descuento lleva su clave.
 */
import type { Db } from "@odentia/db"
import { encounter, encounterProcedure, serviceCatalog } from "@odentia/db/schema/clinical"
import { product, purchaseOrder, serviceMaterial, supplier } from "@odentia/db/schema/inventory"
import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm"
import { createPurchaseOrder, receivePurchaseOrder } from "./inventory.js"
import { discountEncounterMaterials, setServiceMaterials } from "./service-materials.js"
import { chunks, generator } from "./seed-reports.js"

export interface ReportsProgressSeedInput {
  orgId: string
  ownerUserId: string
  /** Sedes con historia: cada una recibe su reposición. */
  branchIds: string[]
}

const DAY_MS = 86_400_000
/** Igual que la historia de Reportes: termina dos días antes de hoy. */
const HISTORY_GAP_DAYS = 2
/** Días de la atención a la última sesión, por servicio; lo demás se termina en 0 a 3 días. */
const SPAN_DAYS: Record<string, [number, number]> = {
  OBTURACION: [0, 7],
  ENDODONCIA: [7, 21],
  CORONA: [14, 35],
  BLANQUEAMIENTO: [7, 14],
}
const PAUSED = ["Pidió pausarlo por un viaje", "Lo retomará cuando reúna el pago", "Espera que mejore la encía"]
const DROPPED = ["Dejó de venir", "Siguió el tratamiento en otra clínica", "Decidió no continuar"]
/** Lo que usa cada servicio, en la unidad de uso. */
const MATERIALS: Record<string, Array<{ sku: string; quantity: number }>> = {
  OBTURACION: [
    { sku: "INS-GUANTE-NITRILO", quantity: 2 },
    { sku: "INS-PUNTAS-APLIC", quantity: 1 },
  ],
  ENDODONCIA: [
    { sku: "INS-GUANTE-NITRILO", quantity: 2 },
    { sku: "INS-ANESTESIA-LIDO", quantity: 2 },
  ],
  EXODONCIA: [
    { sku: "INS-GUANTE-NITRILO", quantity: 2 },
    { sku: "INS-ANESTESIA-LIDO", quantity: 2 },
  ],
}
/** Desde cuándo se descuentan los materiales de la historia. */
const MATERIAL_DAYS = 90
/** Cuándo llegó la reposición: antes de la primera atención descontada. */
const RESTOCK_DAYS = 100

type Progress = { status: string; startedAt: Date | null; completedAt: Date | null; reason: string | null }

export async function seedReportsProgress(tx: Db, input: ReportsProgressSeedInput) {
  const { orgId, ownerUserId } = input
  const random = generator(192)
  const now = Date.now()
  const historyEnd = now - HISTORY_GAP_DAYS * DAY_MS

  // --- Avance de lo aceptado ---------------------------------------------------------------
  // Solo la historia («Plan de tratamiento» con su atención de origen) y las promociones;
  // lo agendado y lo de la demostración queda como está.
  const accepted = await tx.execute<{ id: string; status: string; code: string | null; decidedAt: Date | string; number: number; title: string }>(sql`
    select distinct on (pi.id) pi.id, pi.status, s.code, b.decided_at as "decidedAt", b.budget_number as number, pi.title
    from treatment_plan_item pi
    join treatment_plan p on p.organization_id = pi.organization_id and p.id = pi.plan_id
    join treatment_budget_item i on i.organization_id = pi.organization_id and i.plan_item_id = pi.id and i.decision = 'aceptado'
    join treatment_budget b on b.organization_id = i.organization_id and b.id = i.budget_id
      and b.status in ('aceptado','parcial') and b.decided_at is not null
    left join service_catalog s on s.organization_id = pi.organization_id and s.id = pi.service_id
    where pi.organization_id = ${orgId} and pi.decision_status = 'aceptado' and pi.started_at is null
      and pi.status in ('pendiente','realizado')
      and ((p.title = 'Plan de tratamiento' and p.origin_encounter_id is not null) or i.promotion_id is not null)
      and not exists (select 1 from appointment_plan_item a where a.organization_id = pi.organization_id and a.plan_item_id = pi.id)
    order by pi.id, b.decided_at`)
  const ordered = [...accepted].sort((a, b) => a.number - b.number || a.title.localeCompare(b.title))
  const done = (code: string | null, startedAt: Date): Progress => {
    const [min, max] = SPAN_DAYS[code ?? ""] ?? [0, 3]
    const completedAt = new Date(startedAt.getTime() + random.int(min, max) * DAY_MS + random.int(1, 3) * 3_600_000)
    return completedAt.getTime() > historyEnd
      ? { status: "en_curso", startedAt, completedAt: null, reason: null }
      : { status: "realizado", startedAt, completedAt, reason: null }
  }
  const updates: Array<{ id: string } & Progress> = []
  for (const row of ordered) {
    const startedAt = new Date(new Date(row.decidedAt).getTime() + random.int(0, 14) * DAY_MS + random.int(1, 6) * 3_600_000)
    const roll = random.next()
    // Lo aceptado hace más de dos meses ya figura hecho: casi todo se termina y unos pocos se dejaron.
    if (row.status === "realizado") {
      if (roll < 0.06) updates.push({ id: row.id, status: "suspendido", startedAt, completedAt: null, reason: random.pick(PAUSED) })
      else if (roll < 0.1) updates.push({ id: row.id, status: "cancelado", startedAt, completedAt: null, reason: random.pick(DROPPED) })
      else updates.push({ id: row.id, ...done(row.code, startedAt) })
      continue
    }
    // Lo aceptado hace poco: lo que aún no empezó se queda pendiente.
    if (startedAt.getTime() > historyEnd) continue
    if (roll < 0.4) updates.push({ id: row.id, status: "en_curso", startedAt, completedAt: null, reason: null })
    else if (roll < 0.6) updates.push({ id: row.id, ...done(row.code, startedAt) })
    else if (roll < 0.65) updates.push({ id: row.id, status: "suspendido", startedAt, completedAt: null, reason: random.pick(PAUSED) })
  }
  for (const batch of chunks(updates))
    await tx.execute(sql`
      update treatment_plan_item pi set status = v.status, started_at = v.started_at, completed_at = v.completed_at,
        status_reason = v.reason, updated_at = now()
      from (values ${sql.join(
        batch.map(
          (row) =>
            sql`(${row.id}::uuid, ${row.status}::text, ${row.startedAt?.toISOString() ?? null}::timestamptz, ${row.completedAt?.toISOString() ?? null}::timestamptz, ${row.reason}::text)`,
        ),
        sql`, `,
      )}) as v(id, status, started_at, completed_at, reason)
      where pi.organization_id = ${orgId} and pi.id = v.id`)
  const progress: Record<string, number> = {}
  for (const row of updates) progress[row.status] = (progress[row.status] ?? 0) + 1

  // --- Materiales de cada servicio ---------------------------------------------------------
  const products = await tx
    .select({ id: product.id, sku: product.sku })
    .from(product)
    .where(and(eq(product.organizationId, orgId), inArray(product.sku, ["INS-GUANTE-NITRILO", "INS-PUNTAS-APLIC", "INS-ANESTESIA-LIDO"])))
  const productOf = new Map(products.map((row) => [row.sku, row.id]))
  const idOf = (sku: string): string => {
    const id = productOf.get(sku)
    if (!id) throw new Error(`Falta el producto ${sku} de la semilla de Inventario`)
    return id
  }
  const services = await tx
    .select({ id: serviceCatalog.id, code: serviceCatalog.code })
    .from(serviceCatalog)
    .where(and(eq(serviceCatalog.organizationId, orgId), inArray(serviceCatalog.code, Object.keys(MATERIALS))))
  for (const service of services) {
    const lines = MATERIALS[service.code ?? ""] ?? []
    await setServiceMaterials(tx, orgId, ownerUserId, service.id, lines.map((line) => ({ productId: idOf(line.sku), quantity: line.quantity })), { prices: true })
  }

  // --- Reposición en cada sede, recibida hace 100 días -------------------------------------
  const [andina] = await tx
    .select({ id: supplier.id })
    .from(supplier)
    .where(and(eq(supplier.organizationId, orgId), eq(supplier.name, "Dental Andina SAC")))
    .limit(1)
  if (!andina) throw new Error("Falta el proveedor de la semilla de Inventario")
  const restockAt = new Date(now - RESTOCK_DAYS * DAY_MS)
  for (const [index, branchId] of input.branchIds.entries()) {
    const notes = `Semilla: reposición trimestral de insumos (sede ${index + 1})`
    const [existing] = await tx
      .select({ id: purchaseOrder.id })
      .from(purchaseOrder)
      .where(and(eq(purchaseOrder.organizationId, orgId), eq(purchaseOrder.notes, notes)))
      .limit(1)
    if (existing) continue
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: andina.id,
      branchId,
      mode: "pedir",
      notes,
      lines: [
        { productId: idOf("INS-GUANTE-NITRILO"), quantity: 4, unitCostCents: 3800 },
        { productId: idOf("INS-ANESTESIA-LIDO"), quantity: 4, unitCostCents: 20500 },
        { productId: idOf("INS-PUNTAS-APLIC"), quantity: 2, unitCostCents: 4500 },
      ],
    })
    await receivePurchaseOrder(
      tx,
      orgId,
      ownerUserId,
      order.id,
      [
        { productId: idOf("INS-GUANTE-NITRILO"), quantity: 4, lotCode: `SEED-GNT-T${index + 1}`, expiresAt: "2029-03-31" },
        { productId: idOf("INS-ANESTESIA-LIDO"), quantity: 4, lotCode: `SEED-ANE-T${index + 1}`, expiresAt: "2028-09-30" },
        { productId: idOf("INS-PUNTAS-APLIC"), quantity: 2, lotCode: `SEED-PUN-T${index + 1}`, expiresAt: "2029-12-31" },
      ],
      `seed:reposicion:${orgId}:${index + 1}`,
      { notify: false },
    )
    // Llegó antes de las atenciones que la usan: la orden, sus lotes y su entrada llevan esa fecha.
    const at = restockAt.toISOString()
    await tx.execute(sql`update purchase_order set created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where organization_id = ${orgId} and id = ${order.id}`)
    await tx.execute(sql`update purchase_order_line set created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where organization_id = ${orgId} and order_id = ${order.id}`)
    await tx.execute(sql`update product_lot set created_at = ${at}::timestamptz, updated_at = ${at}::timestamptz where organization_id = ${orgId} and purchase_order_id = ${order.id}`)
    await tx.execute(sql`update stock_movement set created_at = ${at}::timestamptz where organization_id = ${orgId} and purchase_order_id = ${order.id}`)
  }

  // --- Atenciones de los últimos 90 días, descontadas --------------------------------------
  const since = new Date(now - MATERIAL_DAYS * DAY_MS)
  const visits = await tx
    .selectDistinct({ id: encounter.id, patientId: encounter.patientId, branchId: encounter.branchId, startedAt: encounter.startedAt, endedAt: encounter.endedAt })
    .from(encounter)
    .innerJoin(encounterProcedure, and(eq(encounterProcedure.organizationId, encounter.organizationId), eq(encounterProcedure.encounterId, encounter.id)))
    .where(
      and(
        eq(encounter.organizationId, orgId),
        eq(encounter.status, "finalizada"),
        gte(encounter.startedAt, since),
        lt(encounter.startedAt, new Date(now - HISTORY_GAP_DAYS * DAY_MS)),
        isNull(encounterProcedure.voidedAt),
        inArray(
          encounterProcedure.serviceId,
          services.map((service) => service.id),
        ),
      ),
    )
    .orderBy(asc(encounter.startedAt), asc(encounter.id))
  let discounted = 0
  for (const visit of visits) {
    const result = await discountEncounterMaterials(tx, orgId, ownerUserId, visit)
    if (result && !result.failed) discounted += 1
  }
  // Cada uso con la hora en que terminó su atención, no la de hoy.
  await tx.execute(sql`
    update stock_movement m set created_at = coalesce(e.ended_at, e.started_at)
    from encounter e
    where m.organization_id = ${orgId} and m.kind = 'consumo' and m.idempotency_key like 'atencion:%'
      and e.organization_id = m.organization_id and e.id = m.encounter_id and e.started_at >= ${since.toISOString()}::timestamptz`)
  const configured = await tx
    .select({ serviceId: serviceMaterial.serviceId })
    .from(serviceMaterial)
    .where(eq(serviceMaterial.organizationId, orgId))
  return { progress, discounted, services: new Set(configured.map((row) => row.serviceId)).size }
}
