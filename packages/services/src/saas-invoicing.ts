import type { Db } from "@odentia/db"
import { auditEvent } from "@odentia/db/schema/org"
import { type SaasActionKind, saasAction, saasCharge, saasChargeLine, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, inArray, isNotNull, isNull, lte } from "drizzle-orm"
import { markReviewsCredited, pendingReviewCredits } from "./saas-action-review.js"
import { listPeriodActions, microsToCents, netMicros, type SaasActionRow, saasTaxOf, taxCents } from "./saas-actions.js"

/* ---------- Cobrar (ADR 0031, fase 4) ---------- */

/** Días que tiene la clínica para pagar un cargo emitido; después corre la gracia. */
export const SAAS_PAYMENT_DAYS = 7
/** Con ciclo quincenal, a los cuántos días del tramo se cobra lo que pasó del crédito. */
export const SAAS_HALF_DAYS = 15

const DAY = 86_400_000

/** Un mes después, el mismo día (el último del mes si no existe: 31 de enero → 28 de febrero). */
export function addMonth(date: Date): Date {
  const next = new Date(date)
  const day = next.getUTCDate()
  next.setUTCDate(1)
  next.setUTCMonth(next.getUTCMonth() + 1)
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()
  next.setUTCDate(Math.min(day, last))
  return next
}

const KIND_LINE: Record<SaasActionKind, (count: number) => string> = {
  conversacion: (n) => `Recepción: ${n} ${n === 1 ? "conversación atendida" : "conversaciones atendidas"} por encima del crédito`,
  consulta: (n) => `Asistente clínico: ${n} ${n === 1 ? "consulta dictada y confirmada" : "consultas dictadas y confirmadas"} por encima del crédito`,
  cita: (n) => `Administrador: ${n} ${n === 1 ? "cita recuperada" : "citas recuperadas"} por encima del crédito`,
}

/** ¿Cobra esta suscripción por acción? Activa o en gracia, con plan, no demo y con su mes empezado. */
export function chargeable(sub: typeof saasSubscription.$inferSelect): boolean {
  return !sub.isDemo && sub.planId !== null && sub.activatedAt !== null && (sub.status === "activa" || sub.status === "gracia")
}

/**
 * Emite el cargo de un tramo con sus líneas. `final`: la cuota, lo que pasó
 * del crédito y no se cobró aún, y lo que cubrió el crédito (a la vista,
 * sin importe). Mitad del tramo (quincenal): solo lo que ya pasó del
 * crédito. Las acciones quedan anotadas con su cargo: nada se cobra dos
 * veces. Las citas se cobran en el tramo en que el paciente asistió y
 * devuelven la conversación ya cobrada que llevó a ellas. Sin
 * nada que cobrar a mitad de tramo no se emite cargo. Con owner.
 */
async function issueCycleCharge(
  tx: Db,
  sub: typeof saasSubscription.$inferSelect,
  plan: typeof saasPlan.$inferSelect,
  input: { periodStart: Date; periodEnd: Date; until: Date; final: boolean; now: Date },
): Promise<string | null> {
  const orgId = sub.organizationId
  const dedupeKey = `ciclo:${input.periodStart.toISOString()}:${input.final ? "final" : "mitad"}`
  const [existing] = await tx
    .select({ id: saasCharge.id })
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), eq(saasCharge.dedupeKey, dedupeKey)))
    .limit(1)
  if (existing) return existing.id
  const all = await listPeriodActions(tx, orgId, { start: input.periodStart, end: input.periodEnd, credit: "mes", creditCents: plan.creditCents })
  const pending = all.filter((row) => row.chargeId === null && row.occurredAt < input.until)
  const over = pending.filter((row) => row.state === "sobre_credito")
  const covered = pending.filter((row) => row.state === "credito")
  const kinds: SaasActionKind[] = ["conversacion", "consulta", "cita"]
  const lines: Array<Omit<typeof saasChargeLine.$inferInsert, "organizationId" | "chargeId">> = []
  let sort = 0
  if (input.final) {
    lines.push({
      kind: "cuota",
      description: `${plan.name}: cuota del mes, que vuelve en crédito para los agentes`,
      quantity: 1,
      amountCents: plan.priceCents,
      sortOrder: sort++,
    })
  }
  for (const kind of kinds) {
    const rows = over.filter((row) => row.kind === kind)
    if (!rows.length) continue
    const amount = microsToCents(rows.reduce((sum, row) => sum + (row.priceMicros ?? 0), 0))
    const prices = new Set(rows.map((row) => row.priceMicros))
    const bases = new Set(rows.map((row) => row.basePriceMicros))
    lines.push({
      kind,
      description: KIND_LINE[kind](rows.length),
      quantity: rows.length,
      // Un precio por línea solo si todas las acciones lo comparten (un cambio de precio a mitad de mes deja varios).
      unitBaseMicros: bases.size === 1 ? (rows[0]?.basePriceMicros ?? null) : null,
      unitPriceMicros: prices.size === 1 ? (rows[0]?.priceMicros ?? null) : null,
      amountCents: amount,
      sortOrder: sort++,
    })
  }
  // La cita recuperada devuelve la conversación ya cobrada que llevó a ella.
  const refunds = over.flatMap((row) => row.refunds)
  if (refunds.length) {
    lines.push({
      kind: "devolucion",
      description: `Devolución: ${refunds.length} ${refunds.length === 1 ? "conversación ya cobrada que llevó a una cita recuperada" : "conversaciones ya cobradas que llevaron a citas recuperadas"}`,
      quantity: refunds.length,
      amountCents: -microsToCents(over.reduce((sum, row) => sum + (row.priceMicros ?? 0) - netMicros(row), 0)),
      sortOrder: sort++,
    })
  }
  // Lo que odentIA devolvió al revisar un cobro ya facturado (ADR 0054): en el
  // cargo final, de la más antigua a la más nueva, sin dejar el cargo en negativo;
  // lo que no cabe espera al siguiente.
  const creditedReviews: string[] = []
  if (input.final) {
    const before = lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0)
    let amount = 0
    for (const item of await pendingReviewCredits(tx, orgId)) {
      const cents = microsToCents(item.priceMicros)
      if (amount + cents > before) break
      amount += cents
      creditedReviews.push(item.reviewId)
    }
    if (creditedReviews.length) {
      const n = creditedReviews.length
      lines.push({
        kind: "revision",
        description: `Devolución por revisión: ${n} ${n === 1 ? "cobro que odentIA devolvió al revisarlo" : "cobros que odentIA devolvió al revisarlos"}`,
        quantity: n,
        amountCents: -amount,
        sortOrder: sort++,
      })
    }
  }
  if (covered.length) {
    const value = microsToCents(covered.reduce((sum, row) => sum + netMicros(row), 0))
    lines.push({
      kind: "credito",
      description: `${covered.length} ${covered.length === 1 ? "acción cubierta" : "acciones cubiertas"} por el crédito del mes (${(value / 100).toFixed(2)} ${plan.currency}): sin cargo`,
      quantity: covered.length,
      amountCents: 0,
      sortOrder: sort++,
    })
  }
  const subtotal = lines.reduce((sum, line) => sum + (line.amountCents ?? 0), 0)
  if (!input.final && subtotal === 0) return null
  const tax = await saasTaxOf(tx, orgId)
  const taxAmount = taxCents(subtotal, tax)
  if (tax && taxAmount > 0) {
    lines.push({
      kind: "impuesto",
      description: `${tax.label} (${tax.rateBps / 100} %)`,
      quantity: 1,
      amountCents: taxAmount,
      sortOrder: sort++,
    })
  }
  const [charge] = await tx
    .insert(saasCharge)
    .values({
      organizationId: orgId,
      planId: plan.id,
      planCode: plan.code,
      planName: plan.name,
      periodStart: input.periodStart,
      periodEnd: input.final ? input.periodEnd : input.until,
      amountCents: subtotal + taxAmount,
      subtotalCents: subtotal,
      taxCents: taxAmount,
      taxLabel: tax?.label ?? null,
      // El crédito con que se decidió qué cubre y qué pasa: lo que se lea de este mes después usa este.
      creditCents: plan.creditCents,
      currency: plan.currency,
      dueAt: new Date(input.now.getTime() + SAAS_PAYMENT_DAYS * DAY),
      dedupeKey,
    })
    .returning({ id: saasCharge.id })
  if (!charge) return null
  await tx.insert(saasChargeLine).values(lines.map((line) => ({ ...line, organizationId: orgId, chargeId: charge.id })))
  await markReviewsCredited(tx, orgId, creditedReviews, charge.id)
  const charged = [...over, ...covered].map((row: SaasActionRow) => row.id)
  if (charged.length) {
    await tx.update(saasAction).set({ chargeId: charge.id }).where(and(eq(saasAction.organizationId, orgId), inArray(saasAction.id, charged)))
  }
  await tx.insert(auditEvent).values({
    organizationId: orgId,
    entity: "saas_charge",
    entityId: charge.id,
    action: "saas.charge_generated",
    metadata: { final: input.final, subtotalCents: subtotal, taxCents: taxAmount, actions: charged.length },
  })
  return charge.id
}

/**
 * El ciclo del cobro por acción (lo llama el reloj SaaS): a mitad de tramo
 * con ciclo quincenal cobra lo que ya pasó del crédito; al cerrar el tramo
 * emite el cargo final y abre el mes siguiente, que empieza el mismo día en
 * que la clínica activó. Idempotente por tramo. Con owner.
 */
export async function closeSaasPeriods(tx: Db, now = new Date()): Promise<{ issued: number }> {
  const subs = await tx
    .select()
    .from(saasSubscription)
    .where(and(isNotNull(saasSubscription.activatedAt), isNotNull(saasSubscription.planId), inArray(saasSubscription.status, ["activa", "gracia"])))
    .orderBy(asc(saasSubscription.organizationId))
  let issued = 0
  for (const sub of subs) {
    if (!chargeable(sub) || !sub.currentPeriodStart || !sub.currentPeriodEnd || !sub.planId) continue
    const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    if (!plan) continue
    let start = sub.currentPeriodStart
    let end = sub.currentPeriodEnd
    if (sub.billingCycle === "quincenal") {
      const half = new Date(start.getTime() + SAAS_HALF_DAYS * DAY)
      if (now >= half && half < end) {
        if (await issueCycleCharge(tx, sub, plan, { periodStart: start, periodEnd: end, until: half, final: false, now })) issued += 1
      }
    }
    // Un worker parado varios meses cierra cada tramo vencido, en orden.
    while (now >= end) {
      if (await issueCycleCharge(tx, sub, plan, { periodStart: start, periodEnd: end, until: end, final: true, now })) issued += 1
      start = end
      end = addMonth(end)
      await tx
        .update(saasSubscription)
        .set({ currentPeriodStart: start, currentPeriodEnd: end, updatedAt: now })
        .where(eq(saasSubscription.organizationId, sub.organizationId))
    }
  }
  return { issued }
}

/** Líneas de un cargo, en su orden, para la clínica y la administración. */
export async function listSaasChargeLines(tx: Db, orgId: string, chargeIds: string[]) {
  if (!chargeIds.length) return []
  return tx
    .select()
    .from(saasChargeLine)
    .where(and(eq(saasChargeLine.organizationId, orgId), inArray(saasChargeLine.chargeId, chargeIds)))
    .orderBy(asc(saasChargeLine.chargeId), asc(saasChargeLine.sortOrder))
}

/** Suscripciones activas con un cargo vencido sin pagar: pasan a gracia. */
export async function overdueChargeOrgs(tx: Db, now = new Date()): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ orgId: saasCharge.organizationId })
    .from(saasCharge)
    .innerJoin(saasSubscription, eq(saasSubscription.organizationId, saasCharge.organizationId))
    .where(
      and(
        eq(saasSubscription.status, "activa"),
        eq(saasSubscription.isDemo, false),
        inArray(saasCharge.status, ["pendiente", "parcial"]),
        isNull(saasCharge.voidedAt),
        lte(saasCharge.dueAt, now),
      ),
    )
  return rows.map((row) => row.orgId)
}
