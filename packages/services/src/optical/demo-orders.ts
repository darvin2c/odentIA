import { randomUUID } from "node:crypto"
import type { Db } from "@odentia/db"
import { member } from "@odentia/db/schema/auth"
import { organizationPaymentMethod as paymentMethod } from "@odentia/db/schema/org-payments"
import { product } from "@odentia/db/schema/inventory"
import { jobOrder, jobOrderEvent, jobOrderLine } from "@odentia/db/schema/orders"
import { branch } from "@odentia/db/schema/org"
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { clinicToday } from "../inventory-stock.js"
import { advanceJobOrder, createJobOrderSale, JOB_ORDER_STEPS, type JobOrderStep } from "../job-orders.js"
import { ServiceError } from "../errors.js"
import { collectCharge } from "../payments.js"

/**
 * Los pedidos de lentes de una demo de óptica (entrega 4): la primera vez, una
 * venta por cada una de las últimas recetas de anteojos, con su adelanto en
 * efectivo, en cada paso (uno atrasado en el laboratorio y uno listo con saldo,
 * para mostrar lo que pide atención); después, cada noche, el taller avanza lo
 * que lleva su tiempo en un paso, hasta «Listo». Entregar lo hace quien presenta.
 * Todo por los servicios de siempre: los cargos, el stock y la caja son los reales.
 */
const PLAN: ReadonlyArray<{ status: JobOrderStep; late?: boolean }> = [
  { status: "entregado" },
  { status: "listo" },
  { status: "listo" },
  { status: "por_revisar" },
  { status: "en_laboratorio", late: true },
  { status: "en_laboratorio" },
  { status: "por_enviar" },
  { status: "por_enviar" },
]

const FRAME_SKU = "VEN-MONTURA-ACETATO"
const LENS_SKU = "VEN-LUNA-ANTIRREFLEJO"
/** Días que el taller deja un pedido en cada paso antes de pasarlo al siguiente. */
const DAYS_IN_STEP: Partial<Record<JobOrderStep, { days: number; next: JobOrderStep }>> = {
  por_enviar: { days: 1, next: "en_laboratorio" },
  en_laboratorio: { days: 3, next: "por_revisar" },
  por_revisar: { days: 1, next: "listo" },
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

async function staff(tx: Db, orgId: string) {
  const rows = await tx
    .select({ userId: member.userId, role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["sales", "reception", "workshop", "owner"])))
    .orderBy(asc(member.userId))
  const first = (...roles: string[]) => roles.map((role) => rows.find((row) => row.role === role)?.userId).find(Boolean) ?? null
  return { desk: first("sales", "reception", "owner"), workshop: first("workshop", "sales", "reception", "owner") }
}

export async function seedDemoJobOrders(tx: Db, orgId: string, now = new Date()): Promise<void> {
  const [existing] = await tx.select({ id: jobOrder.id }).from(jobOrder).where(eq(jobOrder.organizationId, orgId)).limit(1)
  const { desk, workshop } = await staff(tx, orgId)
  if (!desk || !workshop) return
  if (existing) return advanceDemoJobOrders(tx, orgId, workshop, now)

  const [site] = await tx.select({ id: branch.id }).from(branch).where(eq(branch.organizationId, orgId)).orderBy(asc(branch.createdAt)).limit(1)
  const [cash] = await tx
    .select({ id: paymentMethod.id })
    .from(paymentMethod)
    .where(and(eq(paymentMethod.organizationId, orgId), eq(paymentMethod.typeCode, "10"), eq(paymentMethod.isActive, true)))
    .limit(1)
  const items = await tx
    .select({ id: product.id, sku: product.sku, priceCents: product.salePriceCents })
    .from(product)
    .where(and(eq(product.organizationId, orgId), inArray(product.sku, [FRAME_SKU, LENS_SKU]), isNotNull(product.salePriceCents)))
  const frame = items.find((item) => item.sku === FRAME_SKU)
  const lens = items.find((item) => item.sku === LENS_SKU)
  if (!site || !cash || !frame || !lens) return
  const total = (frame.priceCents ?? 0) + (lens.priceCents ?? 0)
  // La mitad como adelanto, redondeada a la unidad de la moneda.
  const deposit = Math.max(100, Math.round(total / 200) * 100)

  // La receta de anteojos más reciente de cada persona, de la más nueva a la más antigua.
  const recent = (await tx.execute(sql`
    select id, patient_id from (
      select distinct on (patient_id) id, patient_id, issued_on, created_at
      from optical.lens_prescription
      where organization_id = ${orgId} and kind = 'anteojos' and voided_at is null
      order by patient_id, issued_on desc, created_at desc
    ) latest
    order by issued_on desc, created_at desc
    limit ${PLAN.length}`)) as unknown as Array<{ id: string; patient_id: string }>
  const today = await clinicToday(tx, orgId)

  for (const [index, prescription] of recent.entries()) {
    const plan = PLAN[index]!
    const { order } = await createJobOrderSale(tx, orgId, desk, prescription.patient_id, {
      branchId: site.id,
      requestId: randomUUID(),
      title: "Anteojos monofocales con antirreflejo",
      maker: index % 3 === 0 ? "Taller propio" : "Laboratorio Visión Andina",
      promisedOn: addDays(today, 2 + (index % 4)),
      lines: [
        { kind: "montura", productId: frame.id },
        { kind: "lunas", productId: lens.id },
      ],
      referenceId: prescription.id,
      fitting: { alturaOd: 18 + (index % 3), alturaOi: 18 + (index % 3) },
      payments: [{ paymentMethodId: cash.id, amountCents: deposit }],
      cashReceivedCents: deposit,
    })
    const target = JOB_ORDER_STEPS.indexOf(plan.status)
    for (const step of JOB_ORDER_STEPS.slice(1, target + 1)) {
      if (step === "entregado") {
        // Lo entregado se pagó entero: el saldo, al recogerlo.
        const lines = await tx
          .select({ chargeId: jobOrderLine.chargeId })
          .from(jobOrderLine)
          .where(and(eq(jobOrderLine.organizationId, orgId), eq(jobOrderLine.jobOrderId, order.id)))
        const due = total - deposit
        if (due > 0)
          await collectCharge(tx, orgId, desk, prescription.patient_id, {
            branchId: site.id,
            chargeIds: lines.flatMap((line) => (line.chargeId ? [line.chargeId] : [])),
            payments: [{ paymentMethodId: cash.id, amountCents: due }],
            cashReceivedCents: due,
            requestId: randomUUID(),
          })
      }
      await advanceJobOrder(tx, orgId, step === "entregado" ? desk : workshop, order.id, { status: step })
    }
    // Uno se atrasó en el laboratorio: la fecha prometida ya pasó.
    if (plan.late) await tx.update(jobOrder).set({ promisedOn: addDays(today, -1) }).where(eq(jobOrder.id, order.id))
  }
}

/** Cada noche, el taller pasa al siguiente paso lo que ya lleva su tiempo en el suyo. */
async function advanceDemoJobOrders(tx: Db, orgId: string, workshop: string, now: Date): Promise<void> {
  const rows = await tx
    .select({ id: jobOrder.id, status: jobOrder.status, last: sql<Date>`max(${jobOrderEvent.at})` })
    .from(jobOrder)
    .innerJoin(jobOrderEvent, and(eq(jobOrderEvent.organizationId, jobOrder.organizationId), eq(jobOrderEvent.jobOrderId, jobOrder.id)))
    .where(and(eq(jobOrder.organizationId, orgId), inArray(jobOrder.status, Object.keys(DAYS_IN_STEP))))
    .groupBy(jobOrder.id, jobOrder.status)
  for (const row of rows) {
    const rule = DAYS_IN_STEP[row.status as JobOrderStep]
    if (!rule) continue
    if (now.getTime() - new Date(row.last).getTime() < rule.days * 86_400_000) continue
    // Lo reemplazado por un rehecho no avanza: sigue en el nuevo.
    await advanceJobOrder(tx, orgId, workshop, row.id, { status: rule.next }, { at: now }).catch((error: unknown) => {
      if (!(error instanceof ServiceError && error.code === "JOB_ORDER_REMADE")) throw error
    })
  }
}
