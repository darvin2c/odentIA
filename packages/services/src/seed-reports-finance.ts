/**
 * Semilla manual de Reportes › Finanzas y Agenda (fase 3), sobre la historia
 * de `seed-reports.ts`: porcentajes y pagos de comisiones mes a mes, compras de
 * Inventario pagadas, en partes, por adelantado, de más y sin pagar,
 * promociones que se usaron y horarios con su historia (ADR 0060 y 0061).
 *
 * Determinista: mismas decisiones en cada corrida (generador con semilla fija
 * y elecciones por orden). Lo que la base no deja fechar hacia atrás (un gasto)
 * se registra con su fecha desde el servicio; el resto se fecha después. No
 * envía mensajes ni activa nada.
 */
import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { professionalSchedule } from "@odentia/db/schema/availability"
import { orgCounter, treatmentBudget, treatmentBudgetItem, treatmentBudgetOption, treatmentPlan, treatmentPlanItem } from "@odentia/db/schema/clinical"
import { product, supplier } from "@odentia/db/schema/inventory"
import { and, asc, eq, sql } from "drizzle-orm"
import { payPurchaseOrder, setCommissionRate } from "./finance.js"
import { confirmPurchaseOrder, createProduct, createPurchaseOrder, createSupplier, receivePurchaseOrder } from "./inventory.js"
import { defaultWarehouse } from "./inventory-stock.js"
import { getOrgLocale } from "./locale.js"
import { createPromotion } from "./promotions.js"
import { addMonths, currentMonthIn, monthStart } from "./report-periods.js"

export interface ReportsFinanceSeedInput {
  orgId: string
  ownerUserId: string
  /** Profesionales de la historia, en este orden: la primera es la dueña. */
  professionalIds: string[]
}

/** Porcentaje de comisión de cada profesional, por su orden en la semilla. */
const RATES = [4000, 3500, 3500, 3000]
/** Desde hace cuántos meses guarda su horario cada uno (el último, desde hace 18: antes, Reportes usa el de hoy). */
const SCHEDULE_SINCE = [24, 24, 24, 18]
/** La dueña empezó a atender los miércoles hasta las 7 p. m. hace 8 meses: su horario cambió a mitad de la historia. */
const EVENING_SINCE = [8]
const SERVICE_CODES = ["EVALUACION", "LIMPIEZA", "BLANQUEAMIENTO", "CORONA", "OBTURACION"] as const

/** Lo que la semilla necesita de la historia ya sembrada: sedes, nombres, días de cada profesional y servicios. */
async function readHistory(tx: Db, input: ReportsFinanceSeedInput, timezone: string) {
  const ids = sql.join(input.professionalIds.map((id) => sql`${id}`), sql`, `)
  const branches = await tx.execute<{ id: string; name: string }>(sql`
    select b.id, b.name from appointment a join branch b on b.organization_id = a.organization_id and b.id = a.branch_id
    where a.organization_id = ${input.orgId} and a.status = 'atendida' group by b.id, b.name order by count(*) desc, b.name`)
  const habits = await tx.execute<{ userId: string; name: string; branchId: string; weekdays: number[]; earliest: number }>(sql`
    select a.professional_user_id as "userId", u.name,
      mode() within group (order by a.branch_id) as "branchId",
      array_agg(distinct extract(dow from a.starts_at at time zone ${timezone})::int) as weekdays,
      min(extract(hour from a.starts_at at time zone ${timezone}))::int as earliest
    from appointment a join "user" u on u.id = a.professional_user_id
    where a.organization_id = ${input.orgId} and a.status = 'atendida' and a.professional_user_id in (${ids})
      and a.starts_at > now() - interval '120 days'
    group by a.professional_user_id, u.name`)
  const services = await tx.execute<{ code: string; id: string; name: string; priceCents: number }>(sql`
    select code, id, name, price_cents as "priceCents" from service_catalog
    where organization_id = ${input.orgId} and price_cents is not null
      and code in (${sql.join(SERVICE_CODES.map((code) => sql`${code}`), sql`, `)})`)
  const service = (code: (typeof SERVICE_CODES)[number]) => {
    const found = services.find((row) => row.code === code)
    if (!found) throw new Error(`Falta el servicio semilla ${code}`)
    return { id: found.id, name: found.name, priceCents: Number(found.priceCents) }
  }
  return {
    branches: [...branches],
    professionals: input.professionalIds.flatMap((userId, index) => {
      const habit = habits.find((row) => row.userId === userId)
      if (!habit) return []
      return [
        {
          userId,
          name: habit.name,
          branchId: habit.branchId,
          rateBps: RATES[index] ?? 3000,
          weekdays: [...habit.weekdays].sort(),
          afternoonOnly: habit.earliest >= 13,
          scheduleSinceMonths: SCHEDULE_SINCE[index] ?? 24,
          eveningSinceMonths: EVENING_SINCE[index],
        },
      ]
    }),
    services: {
      EVALUACION: service("EVALUACION"),
      LIMPIEZA: service("LIMPIEZA"),
      BLANQUEAMIENTO: service("BLANQUEAMIENTO"),
      CORONA: service("CORONA"),
      OBTURACION: service("OBTURACION"),
    },
  }
}

const DAY_MS = 86_400_000

/** Generador determinista (mulberry32). */
function generator(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function localDay(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
}

export async function seedReportsFinance(tx: Db, seed: ReportsFinanceSeedInput) {
  const { orgId, ownerUserId } = seed
  const { timezone, currency, locale } = await getOrgLocale(tx, orgId)
  const input = await readHistory(tx, seed, timezone)
  if (input.branches.length === 0 || input.professionals.length === 0) return { settlements: 0, orders: 0, budgets: 0 }
  const random = generator(20_261_103)
  const now = Date.now()
  const current = currentMonthIn(timezone)
  const today = localDay(new Date(now), timezone)

  // --- Horarios con su historia ------------------------------------------------------------
  // El horario de hoy lo dejó la semilla de disponibilidad; el de antes es el que
  // siguió la historia de citas y vale hasta ayer. Cada profesional lo guarda desde
  // `scheduleSinceMonths`; antes no hay registro y Reportes lo dice.
  for (const professional of input.professionals) {
    const since = addMonths(current, -professional.scheduleSinceMonths)
    const sinceDay = localDay(new Date(monthStart(timezone, since.year, since.month).getTime() + 12 * 3_600_000), timezone)
    const turns = (evening: boolean) =>
      professional.weekdays.flatMap((weekday) => {
        if (professional.afternoonOnly) return [{ weekday, startMin: 14 * 60, endMin: 18 * 60 }]
        if (weekday === 6) return [{ weekday, startMin: 9 * 60, endMin: 13 * 60 }]
        return [
          { weekday, startMin: 9 * 60, endMin: 13 * 60 },
          { weekday, startMin: 14 * 60, endMin: (evening && weekday === 3 ? 19 : 18) * 60 },
        ]
      })
    const versions: Array<{ from: string; until: string; evening: boolean }> = []
    if (professional.eveningSinceMonths !== undefined && professional.eveningSinceMonths < professional.scheduleSinceMonths) {
      const change = addMonths(current, -professional.eveningSinceMonths)
      const changeDay = `${change.year}-${String(change.month).padStart(2, "0")}-01`
      versions.push({ from: sinceDay, until: changeDay, evening: false }, { from: changeDay, until: today, evening: true })
    } else versions.push({ from: sinceDay, until: today, evening: false })
    for (const version of versions) {
      if (version.until <= version.from) continue
      await tx.insert(professionalSchedule).values(
        turns(version.evening).map((turn) => ({
          organizationId: orgId,
          branchId: professional.branchId,
          professionalUserId: professional.userId,
          ...turn,
          isActive: false,
          validFrom: version.from,
          validUntil: version.until,
          createdBy: ownerUserId,
        })),
      )
    }
  }

  // --- Comisiones: porcentajes y pagos -----------------------------------------------------
  for (const professional of input.professionals) await setCommissionRate(tx, orgId, ownerUserId, { professionalUserId: professional.userId, rateBps: professional.rateBps })
  // Cada mes se paga el día 10 del siguiente, como lo haría «Pagar comisiones»: congela
  // cada cobro con su porcentaje y deja el gasto de Personal. El mes pasado solo se les
  // pagó a dos; lo demás y el mes en curso quedan por pagar.
  let settlements = 0
  const lastPaid = addMonths(current, -1)
  for (let back = 24; back >= 1; back -= 1) {
    const month = addMonths(current, -back)
    const start = monthStart(timezone, month.year, month.month)
    const next = addMonths(month, 1)
    const end = monthStart(timezone, next.year, next.month)
    const paidAt = new Date(end.getTime() + 9 * DAY_MS + 16 * 3_600_000)
    if (paidAt.getTime() > now) continue
    const label = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.year, month.month - 1, 15)))
    for (const [position, professional] of input.professionals.entries()) {
      if (month.year === lastPaid.year && month.month === lastPaid.month && position % 2 === 1) continue
      const settlementId = randomUUID()
      const expenseId = randomUUID()
      const [totals] = await tx.execute<{ base: string; commission: string; lines: number }>(sql`
        with apps as (
          select a.id, a.amount_cents::bigint as cents, a.created_at, a.charge_id, a.payment_id, a.patient_id, c.description
          from patient_payment_application a
          join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
          join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
          join encounter_procedure ep on ep.organization_id = a.organization_id and ep.id = c.encounter_procedure_id
          join encounter e on e.organization_id = a.organization_id and e.id = ep.encounter_id
          where a.organization_id = ${orgId} and e.professional_user_id = ${professional.userId}
            and a.created_at >= ${start.toISOString()}::timestamptz and a.created_at < ${end.toISOString()}::timestamptz
            and a.voided_at is null and p.voided_at is null and c.voided_at is null and ep.voided_at is null
            and e.status = 'finalizada' and e.voided_at is null and c.currency = ${currency}
        )
        select coalesce(sum(cents), 0)::text as base, coalesce(sum((cents * ${professional.rateBps}) / 10000), 0)::text as commission, count(*)::int as lines from apps`)
      const commission = Number(totals?.commission ?? 0)
      if (!totals || totals.lines === 0 || commission <= 0) continue
      await tx.execute(sql`
        insert into expense (id, organization_id, branch_id, concept, category, amount_cents, currency, spent_at, receipt_kind, created_by, created_at, updated_at)
        values (${expenseId}::uuid, ${orgId}, ${professional.branchId}::uuid, ${`Comisión de ${label} — ${professional.name}`.slice(0, 500)}, 'Personal', ${commission},
          ${currency}, ${paidAt.toISOString()}::timestamptz, 'ninguno', ${ownerUserId}, ${paidAt.toISOString()}::timestamptz, ${paidAt.toISOString()}::timestamptz)`)
      await tx.execute(sql`
        insert into commission_settlement (id, organization_id, professional_user_id, period_year, period_month, base, currency, rate_bps, base_cents,
          commission_cents, status, settled_by, settled_at, expense_id, created_at, updated_at)
        values (${settlementId}::uuid, ${orgId}, ${professional.userId}, ${month.year}, ${month.month}, 'cobrado', ${currency}, ${professional.rateBps},
          ${Number(totals.base)}, ${commission}, 'liquidada', ${ownerUserId}, ${paidAt.toISOString()}::timestamptz, ${expenseId}::uuid,
          ${paidAt.toISOString()}::timestamptz, ${paidAt.toISOString()}::timestamptz)`)
      await tx.execute(sql`
        insert into commission_settlement_line (organization_id, settlement_id, kind, source_key, application_id, charge_id, payment_id, patient_id,
          description, base_cents, commission_cents, rate_bps, occurred_at)
        select ${orgId}, ${settlementId}::uuid, 'cobro', 'app:' || a.id, a.id, a.charge_id, a.payment_id, a.patient_id, c.description,
          a.amount_cents, (a.amount_cents::bigint * ${professional.rateBps}) / 10000, ${professional.rateBps}, a.created_at
        from patient_payment_application a
        join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
        join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
        join encounter_procedure ep on ep.organization_id = a.organization_id and ep.id = c.encounter_procedure_id
        join encounter e on e.organization_id = a.organization_id and e.id = ep.encounter_id
        where a.organization_id = ${orgId} and e.professional_user_id = ${professional.userId}
          and a.created_at >= ${start.toISOString()}::timestamptz and a.created_at < ${end.toISOString()}::timestamptz
          and a.voided_at is null and p.voided_at is null and c.voided_at is null and ep.voided_at is null
          and e.status = 'finalizada' and e.voided_at is null and c.currency = ${currency}`)
      settlements += 1
    }
  }

  // --- Un gasto que falta: Impuestos cada mes en la sede principal, salvo el mes pasado ------
  // Reportes › Finanzas lo avisa en ese mes («Puede faltar un gasto»).
  for (let back = 24; back >= 2; back -= 1) {
    const month = addMonths(current, -back)
    const spentAt = new Date(monthStart(timezone, month.year, month.month).getTime() + 17 * DAY_MS + 15 * 3_600_000)
    await tx.execute(sql`
      insert into expense (organization_id, branch_id, concept, category, amount_cents, currency, spent_at, receipt_kind, created_by, created_at, updated_at)
      values (${orgId}, ${input.branches[0]?.id}::uuid, 'Impuesto a la renta (pago a cuenta)', 'Impuestos', ${1_900_00 + Math.round(random() * 4) * 50_00}, ${currency},
        ${spentAt.toISOString()}::timestamptz, 'Formulario', ${ownerUserId}, ${spentAt.toISOString()}::timestamptz, ${spentAt.toISOString()}::timestamptz)`)
    // Y el impuesto de lo cobrado el mes anterior (ADR 0083): un gasto de Impuestos que no resta de lo que deja.
    const before = addMonths(month, -1)
    const [owed] = await tx.execute<{ cents: string | null }>(sql`
      select sum(tax_cents)::text as cents from patient_payment
      where organization_id = ${orgId} and voided_at is null and currency = ${currency}
        and paid_at >= ${monthStart(timezone, before.year, before.month).toISOString()}::timestamptz
        and paid_at < ${monthStart(timezone, month.year, month.month).toISOString()}::timestamptz`)
    const taxCents = Number(owed?.cents ?? 0)
    if (taxCents > 0) {
      await tx.execute(sql`
        insert into expense (organization_id, branch_id, concept, category, amount_cents, currency, spent_at, receipt_kind, sales_tax, created_by, created_at, updated_at)
        values (${orgId}, ${input.branches[0]?.id}::uuid, 'Impuesto de lo cobrado del mes anterior', 'Impuestos', ${taxCents}, ${currency},
          ${spentAt.toISOString()}::timestamptz, 'Formulario', true, ${ownerUserId}, ${spentAt.toISOString()}::timestamptz, ${spentAt.toISOString()}::timestamptz)`)
    }
  }

  // --- Compras de Inventario en cada estado de pago ---------------------------------------
  const main = input.branches[0] as { id: string; name: string }
  const second = input.branches[1] ?? main
  // Las compras llegan al almacén principal de cada sede (lo crea la base con la sede).
  const mainWarehouse = (await defaultWarehouse(tx, orgId, main.id)).id
  const secondWarehouse = (await defaultWarehouse(tx, orgId, second.id)).id
  const supplierOf = async (name: string, docNumber: string) => {
    const [found] = await tx.select({ id: supplier.id }).from(supplier).where(and(eq(supplier.organizationId, orgId), eq(supplier.name, name))).limit(1)
    return found?.id ?? (await createSupplier(tx, orgId, ownerUserId, { name, docType: "RUC", docNumber })).id
  }
  const dentalPeru = await supplierOf("Dental Perú SAC", "20456789123")
  const insumosLima = await supplierOf("Insumos Lima EIRL", "20567891234")
  const odontoSur = await supplierOf("Odonto Sur SAC", "20678912345")
  const dentalAndina = await supplierOf("Dental Andina SAC", "20123456789")
  // Las cantidades de las compras van en unidades de compra (cajas); el producto dice cuántas trae cada una.
  const productOf = async (sku: string, name: string, unit: string, purchase?: { unit: string; factor: number }) => {
    const [found] = await tx.select({ id: product.id }).from(product).where(and(eq(product.organizationId, orgId), eq(product.sku, sku))).limit(1)
    return (
      found?.id ??
      (await createProduct(tx, orgId, ownerUserId, { sku, name, unit, purchaseUnit: purchase?.unit ?? null, purchaseFactor: purchase?.factor ?? 1 })).id
    )
  }
  const resina = await productOf("PRO-RESINA-A2", "Resina compuesta A2", "jeringa")
  const guantes = await productOf("INS-GUANTE-NITRILO", "Guantes de nitrilo", "guante", { unit: "caja", factor: 100 })
  const acido = await productOf("INS-ACIDO-37", "Ácido grabador 37 %", "jeringa")
  const adhesivo = await productOf("INS-ADHESIVO-5G", "Adhesivo de 5.ª generación", "frasco")
  const puntas = await productOf("INS-PUNTAS-APLIC", "Puntas de aplicación", "punta", { unit: "caja", factor: 100 })
  const ago = (days: number, hour = 11) => new Date(now - days * DAY_MS + (hour - 12) * 3_600_000)
  type Plan = {
    key: string
    supplierId: string
    warehouseId: string
    createdDaysAgo: number
    lines: Array<{ productId: string; quantity: number; unitCostCents: number; received?: number }>
    receivedDaysAgo?: number
    payments?: Array<{ cents: number; daysAgo: number; fromCash?: boolean; receipt?: string }>
  }
  const plans: Plan[] = [
    // Pagada entera: llegó hace 70 días y se pagó a los 10.
    { key: "pagada", supplierId: insumosLima, warehouseId: mainWarehouse, createdDaysAgo: 76, receivedDaysAgo: 70,
      lines: [{ productId: guantes, quantity: 20, unitCostCents: 30_00 }, { productId: acido, quantity: 6, unitCostCents: 30_00 }],
      payments: [{ cents: 780_00, daysAgo: 60, receipt: "F001-2140" }] },
    // Recibida sin pagar hace 34 días: la más antigua del aviso.
    { key: "sin_pagar_vieja", supplierId: insumosLima, warehouseId: mainWarehouse, createdDaysAgo: 38, receivedDaysAgo: 34,
      lines: [{ productId: guantes, quantity: 22, unitCostCents: 30_00 }, { productId: puntas, quantity: 8, unitCostCents: 50_00 }] },
    // Recibida en parte y pagada en parte: faltan 4 cajas de guantes y un adhesivo.
    { key: "en_parte", supplierId: dentalPeru, warehouseId: mainWarehouse, createdDaysAgo: 30, receivedDaysAgo: 26,
      lines: [
        { productId: resina, quantity: 10, unitCostCents: 48_00, received: 10 },
        { productId: puntas, quantity: 4, unitCostCents: 35_00, received: 4 },
        { productId: guantes, quantity: 12, unitCostCents: 30_00, received: 8 },
        { productId: acido, quantity: 5, unitCostCents: 50_00, received: 5 },
        { productId: adhesivo, quantity: 2, unitCostCents: 125_00, received: 1 },
      ],
      payments: [{ cents: 600_00, daysAgo: 6, receipt: "F001-2210" }] },
    // Recibida hace poco en San Isidro, sin pagar.
    { key: "sin_pagar_nueva", supplierId: dentalPeru, warehouseId: secondWarehouse, createdDaysAgo: 14, receivedDaysAgo: 10,
      lines: [{ productId: resina, quantity: 8, unitCostCents: 48_00 }, { productId: acido, quantity: 4, unitCostCents: 55_25 }] },
    // Aún no llega: el proveedor pidió un adelanto.
    { key: "adelanto", supplierId: odontoSur, warehouseId: secondWarehouse, createdDaysAgo: 16,
      lines: [{ productId: adhesivo, quantity: 6, unitCostCents: 125_00 }, { productId: guantes, quantity: 5, unitCostCents: 30_00 }],
      payments: [{ cents: 500_00, daysAgo: 15, receipt: "Recibo 0098" }] },
    // Se pagó más de lo que valió lo recibido: S/ 120 quedan a favor con Dental Andina.
    { key: "a_favor", supplierId: dentalAndina, warehouseId: mainWarehouse, createdDaysAgo: 52, receivedDaysAgo: 45,
      lines: [{ productId: resina, quantity: 10, unitCostCents: 52_00 }, { productId: puntas, quantity: 6, unitCostCents: 40_00 }],
      payments: [{ cents: 880_00, daysAgo: 44, fromCash: false, receipt: "F002-0311" }] },
    // Y otra suya que aún no llega, para usar lo que se tiene a favor.
    { key: "siguiente", supplierId: dentalAndina, warehouseId: mainWarehouse, createdDaysAgo: 5,
      lines: [{ productId: guantes, quantity: 10, unitCostCents: 29_50 }] },
  ]
  let orders = 0
  for (const plan of plans) {
    const order = await createPurchaseOrder(tx, orgId, ownerUserId, {
      supplierId: plan.supplierId,
      warehouseId: plan.warehouseId,
      currency,
      notes: `Semilla de Reportes: ${plan.key}`,
      lines: plan.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, unitCostCents: line.unitCostCents })),
    })
    await confirmPurchaseOrder(tx, orgId, ownerUserId, order.id)
    if (plan.receivedDaysAgo !== undefined) {
      await receivePurchaseOrder(
        tx,
        orgId,
        ownerUserId,
        order.id,
        plan.lines.map((line) => ({ productId: line.productId, quantity: line.received ?? line.quantity })),
        `seed:reportes:${plan.key}:${orgId}`,
        { notify: false },
      )
      await tx.execute(sql`update stock_movement set created_at = ${ago(plan.receivedDaysAgo, 10).toISOString()}::timestamptz
        where organization_id = ${orgId} and purchase_order_id = ${order.id}`)
    }
    await tx.execute(sql`update purchase_order set created_at = ${ago(plan.createdDaysAgo, 9).toISOString()}::timestamptz
      where organization_id = ${orgId} and id = ${order.id}`)
    for (const payment of plan.payments ?? []) {
      await payPurchaseOrder(tx, orgId, ownerUserId, {
        orderId: order.id,
        amountCents: payment.cents,
        spentAt: ago(payment.daysAgo, 15).toISOString(),
        fromCash: payment.fromCash ?? false,
        receiptKind: payment.receipt?.startsWith("F") ? "Factura" : "Recibo",
        receiptNumber: payment.receipt ?? null,
      })
    }
    orders += 1
  }

  // --- Promociones que se usaron --------------------------------------------------------
  // Se presentan presupuestos con la promoción a personas de la historia, justo antes
  // de una cita atendida suya: si era su primera, cuenta como nueva; lo que pagó
  // después y si volvió por otro tratamiento sale de su propia historia.
  const svc = input.services
  const monthAgo = addMonths(current, -1)
  const twoAgo = addMonths(current, -2)
  const startOf = (value: { year: number; month: number }) => monthStart(timezone, value.year, value.month)
  const promotions = [
    {
      name: "Limpieza + flúor",
      startsAt: startOf(monthAgo),
      endsAt: new Date(startOf(current).getTime() - 1000),
      service: svc.LIMPIEZA,
      priceCents: Math.round((svc.LIMPIEZA.priceCents * 0.85) / 100) * 100,
      mode: "fixed" as const,
      fresh: 22,
      returning: 12,
      conditions: "Una limpieza por persona.",
    },
    {
      name: "Blanqueamiento 2×1",
      startsAt: new Date(startOf(twoAgo).getTime() + 14 * DAY_MS),
      endsAt: new Date(startOf(monthAgo).getTime() + 14 * DAY_MS),
      service: svc.BLANQUEAMIENTO,
      priceCents: Math.round(svc.BLANQUEAMIENTO.priceCents / 2 / 100) * 100,
      mode: "fixed" as const,
      fresh: 0,
      returning: 5,
      onlyNoReturn: true,
      conditions: "Dos blanqueamientos al precio de uno, para dos personas que vienen juntas.",
    },
    {
      name: "Evaluación gratis",
      startsAt: startOf(addMonths(current, -6)),
      endsAt: null,
      service: svc.EVALUACION,
      priceCents: 0,
      mode: "fixed" as const,
      fresh: 9,
      returning: 0,
      conditions: "Solo para pacientes nuevos.",
    },
    {
      name: "Corona de porcelana con precio desde",
      startsAt: new Date(startOf(monthAgo).getTime() + 5 * DAY_MS),
      endsAt: null,
      service: svc.CORONA,
      priceCents: Math.round((svc.CORONA.priceCents * 0.7) / 100_00) * 100_00,
      mode: "from" as const,
      fresh: 6,
      returning: 3,
      conditions: "El precio final se define en la evaluación.",
    },
  ]
  // Quién puede llevarla: una cita atendida dentro de la promoción, sin un borrador de presupuesto.
  let budgets = 0
  const taken = new Set<string>()
  for (const promotion of promotions) {
    const created = await createPromotion(tx, orgId, ownerUserId, {
      name: promotion.name,
      startsAt: promotion.startsAt.toISOString(),
      endsAt: promotion.endsAt?.toISOString() ?? null,
      // Lo lee Sofi tal cual a los pacientes: una condición de verdad, nunca una marca de la semilla.
      conditions: promotion.conditions,
      items: [{ serviceId: promotion.service.id, mode: promotion.mode, priceCents: promotion.mode === "from" ? promotion.priceCents : Math.max(promotion.priceCents, 0) }],
    })
    const until = Math.min(promotion.endsAt?.getTime() ?? now, now - 2 * DAY_MS)
    const candidates = await tx.execute<{ patientId: string; startsAt: Date | string; first: boolean; later: boolean }>(sql`
      with visits as (
        select a.patient_id, a.starts_at,
          not exists (select 1 from appointment b where b.organization_id = a.organization_id and b.patient_id = a.patient_id
            and b.status = 'atendida' and b.starts_at < a.starts_at) as first,
          exists (select 1 from patient_charge c where c.organization_id = a.organization_id and c.patient_id = a.patient_id
            and c.voided_at is null and c.created_at > a.starts_at + interval '22 hours') as later
        from appointment a
        where a.organization_id = ${orgId} and a.status = 'atendida'
          and a.starts_at >= ${promotion.startsAt.toISOString()}::timestamptz and a.starts_at < ${new Date(until).toISOString()}::timestamptz
          and not exists (select 1 from treatment_budget d where d.organization_id = a.organization_id and d.patient_id = a.patient_id and d.status = 'borrador')
      )
      select distinct on (patient_id) patient_id as "patientId", starts_at as "startsAt", first, later from visits
      order by patient_id, starts_at`)
    // Barajado con el generador sobre un orden fijo (por fecha de la cita): la misma elección en cada corrida.
    const pick = (fresh: boolean, count: number) =>
      [...candidates]
        .filter((row) => row.first === fresh && !taken.has(row.patientId) && (!("onlyNoReturn" in promotion) || !row.later))
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime() || a.patientId.localeCompare(b.patientId))
        .map((row) => ({ row, key: random() }))
        .sort((a, b) => a.key - b.key)
        .slice(0, count)
        .map((item) => item.row)
    const chosen = [...pick(true, promotion.fresh), ...pick(false, promotion.returning)]
    if (chosen.length === 0) continue
    const [counter] = await tx
      .insert(orgCounter)
      .values({ organizationId: orgId, key: "budget", value: chosen.length })
      .onConflictDoUpdate({ target: [orgCounter.organizationId, orgCounter.key], set: { value: sql`"org_counter"."value" + ${chosen.length}` } })
      .returning({ value: orgCounter.value })
    let number = Number(counter?.value ?? chosen.length) - chosen.length + 1
    for (const person of chosen) {
      taken.add(person.patientId)
      const visit = new Date(person.startsAt)
      const presentedAt = new Date(visit.getTime() - 2 * 3_600_000)
      const accepted = promotion.mode !== "from" || random() < 0.7
      // En una «desde», el precio final queda entre el «desde» y la tarifa.
      const priceCents =
        promotion.mode === "from"
          ? promotion.priceCents + Math.round(random() * Math.max(0, (promotion.service.priceCents - promotion.priceCents) / 100_00)) * 100_00
          : promotion.priceCents
      const planId = randomUUID()
      const planItemId = randomUUID()
      const budgetId = randomUUID()
      const optionId = randomUUID()
      await tx.insert(treatmentPlan).values({ id: planId, organizationId: orgId, patientId: person.patientId, title: promotion.name, createdBy: ownerUserId, createdAt: presentedAt })
      await tx.insert(treatmentPlanItem).values({
        id: planItemId,
        organizationId: orgId,
        patientId: person.patientId,
        planId,
        serviceId: promotion.service.id,
        title: promotion.service.name,
        priceCents,
        currency,
        decisionStatus: accepted ? "aceptado" : "pendiente",
        status: accepted ? "realizado" : "pendiente",
        createdBy: ownerUserId,
        createdAt: presentedAt,
      })
      await tx.insert(treatmentBudget).values({
        id: budgetId,
        organizationId: orgId,
        patientId: person.patientId,
        planId,
        budgetNumber: number,
        title: promotion.name,
        currency,
        createdBy: ownerUserId,
        createdAt: presentedAt,
      })
      number += 1
      await tx.insert(treatmentBudgetOption).values({
        id: optionId,
        organizationId: orgId,
        patientId: person.patientId,
        budgetId,
        position: 1,
        isRecommended: true,
        decision: accepted ? "elegida" : "pendiente",
        createdBy: ownerUserId,
      })
      await tx.insert(treatmentBudgetItem).values({
        organizationId: orgId,
        patientId: person.patientId,
        planId,
        budgetId,
        optionId,
        planItemId,
        serviceId: promotion.service.id,
        title: promotion.service.name,
        priceCents,
        tariffPriceCents: promotion.service.priceCents,
        currency,
        promotionId: created.id,
        promotionName: created.name,
        promotionMode: promotion.mode,
        decision: accepted ? "aceptado" : "pendiente",
        createdBy: ownerUserId,
      })
      // El tratamiento sabe en qué presupuesto está, como cuando lo arma la app.
      await tx.execute(sql`
        update treatment_plan_item set budget_id = ${budgetId}
        where organization_id = ${orgId} and id = ${planItemId}`)
      await tx.execute(sql`
        update treatment_budget set status = ${accepted ? "aceptado" : "presentado"}, presented_at = ${presentedAt.toISOString()}::timestamptz,
          decided_at = ${accepted ? visit.toISOString() : null}::timestamptz, decided_by = ${accepted ? ownerUserId : null}
        where organization_id = ${orgId} and id = ${budgetId}`)
      budgets += 1
    }
  }
  // Lo aceptado hace más de dos meses ya se hizo: la historia lo atendió en sus citas. Sin
  // esto, «Lo que viene» contaría como pendiente todo lo aceptado en dos años.
  await tx.execute(sql`
    update treatment_plan_item pi set status = 'realizado'
    from treatment_budget_item i join treatment_budget b on b.organization_id = i.organization_id and b.id = i.budget_id
    where pi.organization_id = ${orgId} and pi.id = i.plan_item_id and pi.status = 'pendiente'
      and i.decision = 'aceptado' and b.status in ('aceptado','parcial') and b.decided_at < now() - interval '60 days'`)
  return { settlements, orders, budgets }
}
