import type { Db } from "@odentia/db"
import { aiUsage } from "@odentia/db/schema/agent"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { organization, user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { saasNegotiation, saasNotice, saasPlan, saasSeller, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { invalidField, notFound, ServiceError, validation } from "./errors.js"
import { formatMoney } from "@odentia/clinical"
import { findOrgLocale, orgProduct } from "./locale.js"
import { defaultPlanOf } from "./saas-plan-product.js"
import { currentSaasTerms, saasTermsAt } from "./saas-commercial-terms.js"
import { activeDiscountBps, getSaasConsumption, planPrices, type SaasConsumption, type SaasPriceKey } from "./saas-actions.js"

/* ---------- Negociación por clínica (ADR 0031, tablero O2) ---------- */

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

async function audit(tx: Db, orgId: string, actorUserId: string, action: string, metadata: Record<string, unknown>): Promise<void> {
  await tx.insert(auditEvent).values({ organizationId: orgId, actorUserId, entity: "saas_subscription", entityId: orgId, action, metadata })
}

async function subscriptionAndPlan(tx: Db, orgId: string) {
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  if (!sub) throw notFound("Suscripción")
  const [plan] = sub.planId
    ? await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : await tx.select().from(saasPlan).where(defaultPlanOf(await orgProduct(tx, orgId))).limit(1)
  if (!plan) throw new ServiceError("SAAS_NO_PLAN", 409, "No hay un plan con precios por acción: configúralo en Facturación › Planes")
  return { sub, plan }
}

export interface NegotiationOutcome {
  /** `aplicado`: quedó vigente. `pendiente`: espera la aprobación de la administración. */
  status: "aplicado" | "pendiente"
  negotiationId: string | null
}

async function requestApproval(
  tx: Db,
  orgId: string,
  actor: AdminActor,
  values: { kind: "descuento" | "prueba"; discountBps?: number; discountEndsAt?: Date | null; trialCreditCents?: number; trialDays?: number; note?: string | null },
): Promise<NegotiationOutcome> {
  // Una pendiente por tipo: la nueva reemplaza a la anterior sin decidir.
  await tx
    .update(saasNegotiation)
    .set({ status: "rechazada", decidedBy: actor.userId, decidedAt: new Date(), note: "Reemplazada por un pedido nuevo", updatedAt: new Date() })
    .where(and(eq(saasNegotiation.organizationId, orgId), eq(saasNegotiation.kind, values.kind), eq(saasNegotiation.status, "pendiente")))
  const [row] = await tx
    .insert(saasNegotiation)
    .values({
      organizationId: orgId,
      kind: values.kind,
      discountBps: values.discountBps ?? null,
      discountEndsAt: values.discountEndsAt ?? null,
      trialCreditCents: values.trialCreditCents ?? null,
      trialDays: values.trialDays ?? null,
      note: values.note?.trim() ? values.note.trim().slice(0, 500) : null,
      requestedBy: actor.userId,
    })
    .returning({ id: saasNegotiation.id })
  await audit(tx, orgId, actor.userId, "saas.negotiation_requested", { kind: values.kind })
  return { status: "pendiente", negotiationId: row?.id ?? null }
}

/**
 * Descuento sobre el precio base de cada acción. La administración lo fija
 * hasta el descuento máximo del plan (el precio mínimo); soporte o el
 * vendedor, hasta lo que da el vendedor, y por encima queda pedido. La cuota
 * no tiene descuento. Rige lo que se cuente desde ahora y, con `discountEndsAt`,
 * hasta ese instante (issue 168): después se cuenta a precio de lista.
 */
export async function setSaasDiscount(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: { discountBps: number; discountEndsAt?: Date | null; note?: string | null },
  now = new Date(),
): Promise<NegotiationOutcome> {
  if (!Number.isInteger(input.discountBps) || input.discountBps < 0) throw invalidField("discountBps", "El descuento debe ser un porcentaje válido")
  const endsAt = input.discountBps > 0 ? (input.discountEndsAt ?? null) : null
  if (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime()))
    throw invalidField("discountEndsAt", "El vencimiento tiene que ser una fecha futura")
  const { plan } = await subscriptionAndPlan(tx, orgId)
  if (input.discountBps > plan.maxDiscountBps) {
    const message = `El descuento máximo es ${plan.maxDiscountBps / 100} %: con más, los precios quedarían bajo el precio mínimo`
    throw new ServiceError("SAAS_PRICE_BELOW_FLOOR", 409, message, { discountBps: message })
  }
  if (actor.role !== "admin" && input.discountBps > plan.sellerDiscountBps) {
    return requestApproval(tx, orgId, actor, { kind: "descuento", discountBps: input.discountBps, discountEndsAt: endsAt, note: input.note ?? null })
  }
  await tx
    .update(saasSubscription)
    .set({ discountBps: input.discountBps, discountEndsAt: endsAt, updatedAt: now })
    .where(eq(saasSubscription.organizationId, orgId))
  await audit(tx, orgId, actor.userId, "saas.discount_set", { discountBps: input.discountBps, discountEndsAt: endsAt?.toISOString() ?? null })
  return { status: "aplicado", negotiationId: null }
}

/**
 * Prueba de esta clínica: saldo de regalo y días. Hasta los del plan los fija
 * cualquier persona del personal; por encima, hasta el máximo del plan, la
 * administración, y soporte o el vendedor lo piden. Mover los días mueve el
 * fin de una prueba en curso.
 */
export async function setSaasTrialTerms(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: { trialCreditCents: number; trialDays: number; note?: string | null },
): Promise<NegotiationOutcome> {
  if (!Number.isSafeInteger(input.trialCreditCents) || input.trialCreditCents < 0)
    throw invalidField("trialCreditCents", "El saldo de prueba debe ser un importe válido")
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) throw invalidField("trialDays", "La prueba debe durar al menos un día")
  const { sub, plan } = await subscriptionAndPlan(tx, orgId)
  const creditAbove = input.trialCreditCents > plan.trialMaxCreditCents
  const daysAbove = input.trialDays > plan.trialMaxDays
  if (creditAbove || daysAbove) {
    const message = `La prueba puede llegar como mucho a ${formatMoney(plan.trialMaxCreditCents, plan.currency, "es")} y ${plan.trialMaxDays} días`
    // El tope se dice en el dato que lo pasa (o en los dos).
    throw validation(message, {
      ...(creditAbove ? { trialCreditCents: message } : {}),
      ...(daysAbove ? { trialDays: message } : {}),
    })
  }
  const aboveDefault = input.trialCreditCents > plan.trialCreditCents || input.trialDays > plan.trialDays
  if (aboveDefault && actor.role !== "admin") {
    return requestApproval(tx, orgId, actor, { kind: "prueba", trialCreditCents: input.trialCreditCents, trialDays: input.trialDays, note: input.note ?? null })
  }
  await applyTrialTerms(tx, orgId, sub, input)
  await audit(tx, orgId, actor.userId, "saas.trial_terms_set", { trialCreditCents: input.trialCreditCents, trialDays: input.trialDays })
  return { status: "aplicado", negotiationId: null }
}

async function applyTrialTerms(
  tx: Db,
  orgId: string,
  sub: typeof saasSubscription.$inferSelect,
  input: { trialCreditCents: number; trialDays: number },
): Promise<void> {
  const patch: Partial<typeof saasSubscription.$inferInsert> = {
    trialCreditCents: input.trialCreditCents,
    trialDays: input.trialDays,
    updatedAt: new Date(),
  }
  if (sub.status === "prueba" && sub.trialStartedAt) {
    const ends = new Date(sub.trialStartedAt.getTime() + input.trialDays * 86_400_000)
    patch.trialEndsAt = ends
    patch.currentPeriodEnd = ends
  }
  await tx.update(saasSubscription).set(patch).where(eq(saasSubscription.organizationId, orgId))
}

export interface SaasNegotiationRow {
  id: string
  organizationId: string
  kind: "descuento" | "prueba"
  discountBps: number | null
  discountEndsAt: Date | null
  trialCreditCents: number | null
  trialDays: number | null
  note: string | null
  status: "pendiente" | "aprobada" | "rechazada"
  requestedBy: string | null
  requestedByName: string | null
  createdAt: Date
  decidedAt: Date | null
}

/** Lo pedido para una clínica (o para todas, sin `orgId`), lo pendiente primero. Con owner. */
export async function listSaasNegotiations(tx: Db, input: { orgId?: string; status?: "pendiente" } = {}): Promise<SaasNegotiationRow[]> {
  const filters = []
  if (input.orgId) filters.push(eq(saasNegotiation.organizationId, input.orgId))
  if (input.status) filters.push(eq(saasNegotiation.status, input.status))
  const rows = await tx
    .select({ row: saasNegotiation, requestedByName: user.name })
    .from(saasNegotiation)
    .leftJoin(user, eq(user.id, saasNegotiation.requestedBy))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(sql`${saasNegotiation.status} = 'pendiente' desc`, desc(saasNegotiation.createdAt))
    .limit(50)
  return rows.map(({ row, requestedByName }) => ({
    id: row.id,
    organizationId: row.organizationId,
    kind: row.kind as SaasNegotiationRow["kind"],
    discountBps: row.discountBps,
    discountEndsAt: row.discountEndsAt,
    trialCreditCents: row.trialCreditCents,
    trialDays: row.trialDays,
    note: row.note,
    status: row.status as SaasNegotiationRow["status"],
    requestedBy: row.requestedBy,
    requestedByName,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  }))
}

/** Aprobar o rechazar un pedido: solo la administración. Aprobar lo aplica con los mismos límites del plan. */
export async function decideSaasNegotiation(tx: Db, actor: AdminActor, negotiationId: string, approve: boolean): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo el rol Administración aprueba un descuento o una prueba fuera de lo de siempre")
  const [row] = await tx.select().from(saasNegotiation).where(eq(saasNegotiation.id, negotiationId)).limit(1).for("update")
  if (!row) throw notFound("Pedido")
  if (row.status !== "pendiente") throw new ServiceError("SAAS_NEGOTIATION_DECIDED", 409, "Ese pedido ya se decidió")
  if (approve) {
    if (row.kind === "descuento" && row.discountBps !== null) {
      await setSaasDiscount(tx, actor, row.organizationId, { discountBps: row.discountBps, discountEndsAt: row.discountEndsAt })
    } else if (row.kind === "prueba" && row.trialCreditCents !== null && row.trialDays !== null) {
      await setSaasTrialTerms(tx, actor, row.organizationId, { trialCreditCents: row.trialCreditCents, trialDays: row.trialDays })
    }
  }
  await tx
    .update(saasNegotiation)
    .set({ status: approve ? "aprobada" : "rechazada", decidedBy: actor.userId, decidedAt: new Date(), updatedAt: new Date() })
    .where(eq(saasNegotiation.id, negotiationId))
  await audit(tx, row.organizationId, actor.userId, approve ? "saas.negotiation_approved" : "saas.negotiation_rejected", { kind: row.kind })
}

/** ¿Quién vende esta clínica? Para que soporte vea si le toca negociar. */
export async function saasSellerOf(tx: Db, orgId: string): Promise<{ id: string; name: string; userId: string | null } | null> {
  const [row] = await tx
    .select({ id: saasSeller.id, name: saasSeller.displayName, userId: saasSeller.userId })
    .from(saasSubscription)
    .innerJoin(saasSeller, eq(saasSeller.id, saasSubscription.sellerId))
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  return row ?? null
}

/* ---------- Presupuesto del mes y ciclo (tableros C5 y O2) ---------- */

/**
 * El presupuesto del mes: lo máximo que la clínica paga por encima del
 * crédito; null lo quita. Lo decide quien administra la clínica y es el único
 * límite de los agentes (ADR 0085).
 */
export async function setSaasSpendCap(tx: Db, orgId: string, actorUserId: string, capCents: number | null): Promise<void> {
  if (capCents !== null && (!Number.isSafeInteger(capCents) || capCents < 0))
    throw invalidField("capCents", "El presupuesto debe ser un importe válido")
  const [row] = await tx
    .update(saasSubscription)
    .set({ spendCapCents: capCents, updatedAt: new Date() })
    .where(eq(saasSubscription.organizationId, orgId))
    .returning({ id: saasSubscription.organizationId })
  if (!row) throw notFound("Suscripción")
  await audit(tx, orgId, actorUserId, "saas.spend_cap_set", { capCents })
}

/** Cada cuánto se factura lo que pasa del crédito. Lo decide la administración de odentIA. */
export async function setSaasBillingCycle(tx: Db, actor: AdminActor, orgId: string, cycle: "mensual" | "quincenal"): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo la administración cambia cada cuánto se factura")
  if (cycle !== "mensual" && cycle !== "quincenal") throw validation("Ciclo inválido")
  await tx.update(saasSubscription).set({ billingCycle: cycle, updatedAt: new Date() }).where(eq(saasSubscription.organizationId, orgId))
  await audit(tx, orgId, actor.userId, "saas.billing_cycle_set", { cycle })
}

/* ---------- Cambios del plan (Plan y pagos y el historial, ADR 0196) ---------- */

/** Un cambio del plan de una clínica, en palabras: lo que dice Plan y pagos y el historial. */
export interface SaasPlanChange {
  /** La fila de donde sale (`evento:<id>` o `auditoria:<id>`): única. */
  id: string
  at: Date
  action: string
  /** Qué cambió, con lo que dice su fila: el plan, el precio especial, la prueba… */
  words: string
  /** Quien lo hizo; nulo, lo hizo el sistema. */
  by: { userId: string; name: string } | null
  /** Soporte lo lee en el historial: no dice importes ni condiciones negociadas. */
  support: boolean
}

type PlanChangeMeta = Record<string, unknown>
interface PlanChangeContext {
  currency: string
  /** El nombre del plan de la fila; nulo si no se sabe o si lee Soporte. */
  planName: (meta: PlanChangeMeta) => string | null
  /** Lee Soporte: sin el nombre del plan ni el motivo de la pausa (pueden ser de la venta). */
  forSupport: boolean
}

const metaNumber = (meta: PlanChangeMeta, key: string): number | null =>
  typeof meta[key] === "number" && Number.isFinite(meta[key]) ? (meta[key] as number) : null
const metaText = (meta: PlanChangeMeta, key: string): string | null =>
  typeof meta[key] === "string" && (meta[key] as string).trim() ? (meta[key] as string).trim() : null
const longDay = (iso: string | null): string | null => {
  const at = iso ? new Date(iso) : null
  return at && !Number.isNaN(at.getTime())
    ? new Intl.DateTimeFormat("es-PE", { timeZone: "America/Lima", day: "numeric", month: "long", year: "numeric" }).format(at)
    : null
}
const percent = (bps: number) => `${new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 }).format(bps / 100)} %`

/**
 * Lo que cuenta como cambio del plan y cómo se dice. Las filas están en dos auditorías: la de la
 * clínica (`audit_event`, lo que escriben `saas-billing` y estas condiciones) y la de la
 * administración (`admin_audit`, lo que escriben las rutas de Cobros y Fundadores); una misma
 * acción puede quedar en las dos en la misma transacción, con la misma hora, y se dice una vez.
 * Lo que no está aquí no se muestra, nunca con su código.
 */
const PLAN_CHANGE_WORDS: Record<string, { support: boolean; words: (meta: PlanChangeMeta, ctx: PlanChangeContext) => string }> = {
  "saas.trial_started": {
    support: true,
    words: (meta) => {
      const until = longDay(metaText(meta, "trialEndsAt"))
      return until ? `Empezó su prueba, hasta el ${until}` : "Empezó su prueba"
    },
  },
  "saas.trial_terms_set": {
    support: false,
    words: (meta, ctx) => {
      const credit = metaNumber(meta, "trialCreditCents")
      const days = metaNumber(meta, "trialDays")
      const parts = [credit !== null ? `${formatMoney(Math.round(credit), ctx.currency, "es")} de regalo` : null, days !== null ? `${days} días` : null].filter(Boolean)
      return parts.length ? `Su prueba pasó a ${parts.join(" y ")}` : "Cambió su prueba"
    },
  },
  "saas.trial_completed": {
    support: true,
    words: (meta, ctx) => {
      const plan = ctx.planName(meta)
      return plan ? `Terminó su prueba y empezó su plan: ${plan}` : "Terminó su prueba y empezó su plan"
    },
  },
  "saas.trial_ended": { support: true, words: () => "Terminó su prueba y empezó su plan" },
  "saas.activated": {
    support: true,
    words: (meta, ctx) => {
      const plan = ctx.planName(meta)
      return plan ? `Se activó su plan: ${plan}` : "Se activó su plan"
    },
  },
  "saas.activated_now": {
    support: true,
    words: (meta, ctx) => {
      const plan = ctx.planName(meta)
      return plan ? `Empezó su plan sin prueba: ${plan}` : "Empezó su plan sin prueba"
    },
  },
  "saas.plan_changed": {
    support: true,
    words: (meta, ctx) => {
      const plan = ctx.planName(meta)
      return plan ? `Cambió de plan: ${plan}` : "Cambió de plan"
    },
  },
  "saas.paused": {
    support: true,
    words: (meta, ctx) => {
      const why = ctx.forSupport ? null : metaText(meta, "pauseReason")
      return why ? `Se pausó su plan: ${why}` : "Se pausó su plan"
    },
  },
  "saas.resumed": { support: true, words: () => "Se reanudó su plan" },
  "saas.restricted": { support: true, words: () => "Pasó a solo lectura por un cobro sin pagar" },
  "saas.restricted_no_plan": { support: true, words: () => "Pasó a solo lectura: terminó su prueba sin plan" },
  "saas.founders_entered": {
    support: false,
    words: (meta, ctx) => {
      const plan = ctx.planName(meta)
      const discount = metaNumber(meta, "discountBps")
      return `Pasó a Fundadores${plan ? ` (${plan})` : ""}${discount ? `; se quitó su precio especial de ${percent(discount)}` : ""}`
    },
  },
  "saas.guarantee_ended": {
    support: false,
    words: (meta, ctx) => {
      const plan = ctx.planName({ planId: meta.toPlanId })
      return plan ? `Terminaron sus condiciones de Fundadora; ahora rige ${plan}` : "Terminaron sus condiciones de Fundadora"
    },
  },
  "saas.discount_set": {
    support: false,
    words: (meta) => {
      const bps = metaNumber(meta, "discountBps") ?? 0
      if (bps <= 0) return "Se quitó su precio especial"
      const until = longDay(metaText(meta, "discountEndsAt"))
      return `Precio especial: ${percent(bps)} menos en cada acción${until ? ` hasta el ${until}` : ", sin fecha de fin"}`
    },
  },
  "saas.discount_expired": { support: false, words: () => "Terminó su precio especial" },
  "saas.billing_cycle_set": {
    support: false,
    words: (meta) =>
      meta.cycle === "quincenal" ? "Lo que pasa del crédito se factura a mitad y al cerrar el mes" : "Lo que pasa del crédito se factura al cerrar el mes",
  },
  "saas.spend_cap_set": {
    support: false,
    words: (meta, ctx) => {
      const cap = metaNumber(meta, "capCents")
      return cap === null ? "Se quitó su presupuesto del mes" : `Su presupuesto del mes pasó a ${formatMoney(Math.round(cap), ctx.currency, "es")}`
    },
  },
  "saas.spend_cap_default": {
    support: false,
    words: (meta, ctx) => {
      const cap = metaNumber(meta, "capCents")
      return cap === null ? "Su presupuesto del mes quedó sin tope" : `Su presupuesto del mes siguió a su plan: ${formatMoney(Math.round(cap), ctx.currency, "es")}`
    },
  },
  "saas.negotiation_requested": {
    support: false,
    words: (meta) => (meta.kind === "prueba" ? "Se pidió aprobar una prueba más larga" : "Se pidió aprobar un precio especial"),
  },
  "saas.negotiation_approved": {
    support: false,
    words: (meta) => (meta.kind === "prueba" ? "Se aprobó la prueba pedida" : "Se aprobó el precio especial pedido"),
  },
  "saas.negotiation_rejected": {
    support: false,
    words: (meta) => (meta.kind === "prueba" ? "No se aprobó la prueba pedida" : "No se aprobó el precio especial pedido"),
  },
}

/** Las acciones que son cambios del plan (las mismas que dice el historial en «Plan y pagos»). */
export const SAAS_PLAN_CHANGE_ACTIONS: readonly string[] = Object.keys(PLAN_CHANGE_WORDS)

/**
 * Los cambios del plan de una clínica, del más nuevo al más viejo, con quién los hizo: de las
 * dos auditorías, sin repetir lo que quedó en ambas. `before` y `limit` paginan como el
 * historial; `forSupport` deja solo lo que Soporte lee, sin nombres de plan ni motivos. Solo
 * lee; con owner.
 */
export async function listSaasPlanChanges(
  tx: Db,
  orgId: string,
  options: { before?: Date | null; limit?: number; forSupport?: boolean } = {},
): Promise<SaasPlanChange[]> {
  const forSupport = options.forSupport === true
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
  const before = options.before ?? null
  const events = await tx
    .select({ id: auditEvent.id, at: auditEvent.createdAt, action: auditEvent.action, actorUserId: auditEvent.actorUserId, metadata: auditEvent.metadata })
    .from(auditEvent)
    .where(and(eq(auditEvent.organizationId, orgId), inArray(auditEvent.action, SAAS_PLAN_CHANGE_ACTIONS as string[]), before ? lt(auditEvent.createdAt, before) : undefined))
    .orderBy(desc(auditEvent.createdAt))
    .limit(limit)
  const admins = await tx
    .select({ id: adminAudit.id, at: adminAudit.createdAt, action: adminAudit.action, actorUserId: adminAudit.actorUserId, metadata: adminAudit.metadata })
    .from(adminAudit)
    .where(and(eq(adminAudit.organizationId, orgId), inArray(adminAudit.action, SAAS_PLAN_CHANGE_ACTIONS as string[]), before ? lt(adminAudit.createdAt, before) : undefined))
    .orderBy(desc(adminAudit.createdAt))
    .limit(limit)
  // Lo que quedó en las dos auditorías en la misma transacción tiene la misma hora: una sola fila,
  // con lo que dice cada una (la de la clínica trae el detalle) y la persona que lo hizo.
  const rows = new Map<string, { id: string; at: Date; action: string; actorUserId: string | null; metadata: PlanChangeMeta }>()
  const person = (id: string | null) => (id && id !== "system" ? id : null)
  for (const [prefix, list] of [["evento", events], ["auditoria", admins]] as const) {
    for (const row of list) {
      const key = `${row.action}|${row.at.getTime()}`
      const meta = (row.metadata && typeof row.metadata === "object" ? row.metadata : {}) as PlanChangeMeta
      const seen = rows.get(key)
      if (seen) {
        seen.metadata = { ...meta, ...seen.metadata }
        seen.actorUserId = seen.actorUserId ?? person(row.actorUserId)
        continue
      }
      rows.set(key, { id: `${prefix}:${row.id}`, at: row.at, action: row.action, actorUserId: person(row.actorUserId), metadata: meta })
    }
  }
  const list = [...rows.values()].sort((a, b) => b.at.getTime() - a.at.getTime() || (a.id < b.id ? -1 : 1)).slice(0, limit)
  if (!list.length) return []

  const userIds = [...new Set(list.map((row) => row.actorUserId).filter((id): id is string => Boolean(id)))]
  const names = new Map(
    userIds.length ? (await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, userIds))).map((row) => [row.id, row.name]) : [],
  )
  const codes = [...new Set(list.map((row) => metaText(row.metadata, "planCode")).filter((code): code is string => Boolean(code)))]
  const planIds = [
    ...new Set(
      list.flatMap((row) => [metaText(row.metadata, "planId"), metaText(row.metadata, "toPlanId")]).filter((id): id is string => Boolean(id && /^[0-9a-f-]{36}$/i.test(id))),
    ),
  ]
  const plans =
    codes.length || planIds.length
      ? await tx
          .select({ id: saasPlan.id, code: saasPlan.code, name: saasPlan.name })
          .from(saasPlan)
          .where(or(codes.length ? inArray(saasPlan.code, codes) : undefined, planIds.length ? inArray(saasPlan.id, planIds) : undefined))
      : []
  const [current] = await tx
    .select({ currency: saasPlan.currency })
    .from(saasSubscription)
    .innerJoin(saasPlan, eq(saasPlan.id, saasSubscription.planId))
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  const ctx: PlanChangeContext = {
    currency: current?.currency ?? "USD",
    planName: (meta) => {
      if (forSupport) return null
      const code = metaText(meta, "planCode")
      const id = metaText(meta, "planId")
      return plans.find((plan) => (code && plan.code === code) || (id && plan.id === id))?.name ?? null
    },
    forSupport,
  }
  return list.flatMap((row) => {
    const phrase = PLAN_CHANGE_WORDS[row.action]
    if (!phrase || (forSupport && !phrase.support)) return []
    return [
      {
        id: row.id,
        at: row.at,
        action: row.action,
        words: phrase.words(row.metadata, ctx),
        by: row.actorUserId ? { userId: row.actorUserId, name: names.get(row.actorUserId) ?? "Alguien del equipo" } : null,
        support: phrase.support,
      },
    ]
  })
}

/* ---------- Avisos, alarma y límite (tablero C4) ---------- */

export type SaasAlertFamily = "saldo_prueba" | "dias_prueba" | "credito" | "tope" | "precio_especial" | "condiciones"
export type SaasAlertLevel = "aviso" | "alarma" | "limite"

export interface SaasAlert {
  family: SaasAlertFamily
  level: SaasAlertLevel
  /** Identifica el tramo: un aviso por nivel y por tramo. */
  periodKey: string
  title: string
  message: string
  /** Una línea para la franja en el teléfono (ADR 0065). */
  short: string
  action: "elegir_plan" | "cambiar_tope" | "ver_consumo" | "ver_plan"
}

const DAY = 86_400_000

/** Desde qué parte usada avisa y alarma: las condiciones comerciales que rigen (ADR 0074), los mismos niveles del medidor. */
interface AlertLevels {
  warnPercent: number
  alarmPercent: number
}

function levelOf(levels: AlertLevels, used: number, total: number, alarmByDate: boolean): SaasAlertLevel | null {
  if (total <= 0) return null
  if (used >= total) return "limite"
  if (used * 100 >= total * levels.alarmPercent || alarmByDate) return "alarma"
  if (used * 100 >= total * levels.warnPercent) return "aviso"
  return null
}

/** Cuándo se acaba a este ritmo; null si no hay ritmo para saberlo. */
function exhaustionDate(usedCents: number, totalCents: number, start: Date, now: Date): Date | null {
  const elapsed = now.getTime() - start.getTime()
  if (usedCents <= 0 || elapsed < DAY) return null
  const perMs = usedCents / elapsed
  return new Date(now.getTime() + (totalCents - usedCents) / perMs)
}

function did(consumption: SaasConsumption): string {
  const count = (kind: string) => consumption.lines.find((line) => line.kind === kind)?.count ?? 0
  const parts = [`atendieron ${count("conversacion")} conversaciones`, `ordenaron ${count("consulta")} consultas`]
  if (count("cita")) parts.push(`recuperaron ${count("cita")} citas`)
  return `Los agentes ${parts.join(", ")}.`
}

/**
 * Lo que hoy merece avisar a quien administra la clínica, calculado al leer:
 * se cierra solo cuando se resuelve. Una sola definición para el aviso de la
 * plataforma, el correo del ciclo y la pausa de los agentes. Demo exenta.
 */
export async function getSaasAlerts(tx: Db, orgId: string, now = new Date()): Promise<SaasAlert[]> {
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  if (!sub || sub.isDemo) return []
  const consumption = await getSaasConsumption(tx, orgId, now)
  // El formato de la clínica (issue 36); sin perfil, el neutro, nunca el de un país.
  const { locale: lang, timezone } = await findOrgLocale(tx, orgId)
  const fmtDay = (date: Date) => new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long", timeZone: timezone }).format(date)
  // «vie 30 oct»: lo que cabe en una línea del teléfono.
  const fmtShort = (date: Date) =>
    new Intl.DateTimeFormat(lang, { weekday: "short", day: "numeric", month: "short", timeZone: timezone })
      .format(date)
      .replace(/\./g, "")
  const money = (cents: number) => formatMoney(Math.round(cents), consumption.currency ?? "USD", lang)
  const periodKey = consumption.period.start.toISOString().slice(0, 10)
  const levels = await currentSaasTerms(tx, now)
  const alerts: SaasAlert[] = []

  if (sub.status === "prueba" && consumption.priced && consumption.creditCents > 0) {
    const used = consumption.subtotalCents
    const ends = exhaustionDate(used, consumption.creditCents, consumption.period.start, now)
    const soon = ends !== null && ends.getTime() - now.getTime() <= 3 * DAY && ends < consumption.period.end
    const level = levelOf(levels, used, consumption.creditCents, soon)
    if (level) {
      const left = Math.max(0, consumption.creditCents - used)
      alerts.push({
        family: "saldo_prueba",
        level,
        periodKey,
        title: level === "limite" ? "En pausa" : level === "alarma" ? "Alarma" : "Aviso",
        message:
          level === "limite"
            ? "Los agentes están en pausa: se usó todo el saldo de prueba. Las conversaciones nuevas las ve tu equipo en la Bandeja."
            : level === "alarma" && ends
              ? `A este ritmo, tu saldo de prueba se acaba el ${fmtDay(ends)}. Cuando se acabe, los agentes se pausan.`
              : `Te quedan ${money(left)} de tu saldo de prueba. ${did(consumption)}`,
        short:
          level === "limite"
            ? "Agentes en pausa: se usó el saldo de prueba"
            : level === "alarma" && ends
              ? `Tu saldo de prueba se acaba el ${fmtShort(ends)}`
              : `Te quedan ${money(left)} de saldo de prueba`,
        action: "elegir_plan",
      })
    }
  }

  if (sub.status === "prueba" && sub.trialEndsAt && !sub.planId) {
    const daysLeft = Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / DAY)
    const level: SaasAlertLevel | null = daysLeft <= 2 ? "alarma" : daysLeft <= 7 ? "aviso" : null
    if (level) {
      alerts.push({
        family: "dias_prueba",
        level,
        periodKey,
        title: level === "alarma" ? "Alarma" : "Aviso",
        message: `Tu prueba termina en ${Math.max(daysLeft, 0)} ${daysLeft === 1 ? "día" : "días"}, el ${fmtDay(sub.trialEndsAt)}. Después, el sistema queda en solo lectura hasta que elijas un plan. No se pierde ningún dato.`,
        short: `Tu prueba termina el ${fmtShort(sub.trialEndsAt)}`,
        action: "elegir_plan",
      })
    }
  }

  if (sub.status !== "prueba" && consumption.priced && consumption.creditCents > 0) {
    const level = levelOf(levels, consumption.subtotalCents, consumption.creditCents, false)
    if (level) {
      alerts.push({
        family: "credito",
        level,
        periodKey,
        title: level === "limite" ? "Crédito usado" : "Aviso",
        message:
          level === "limite"
            ? `Tu crédito del mes se acabó${consumption.creditExhaustedAt ? ` el ${fmtDay(consumption.creditExhaustedAt)}` : ""}. Desde entonces cada acción se cobra con tu precio y los agentes siguen atendiendo.`
            : `Tus agentes usaron ${Math.round((consumption.subtotalCents / consumption.creditCents) * 100)} % del crédito del mes.`,
        short:
          level === "limite"
            ? "Se acabó el crédito del mes"
            : `Usaste ${Math.round((consumption.subtotalCents / consumption.creditCents) * 100)} % del crédito`,
        action: "ver_consumo",
      })
    }
  }

  // El presupuesto del mes (ADR 0085): lo que va por encima del crédito, sin el almacenamiento.
  if (sub.status !== "prueba" && sub.spendCapCents !== null && sub.spendCapCents > 0) {
    const spent = consumption.budget.spentCents
    const level = levelOf(levels, spent, sub.spendCapCents, false)
    // Cuándo se llega a este ritmo: lo de encima del crédito corre desde que se acabó.
    const reachesAt =
      level && level !== "limite"
        ? exhaustionDate(spent, sub.spendCapCents, consumption.creditExhaustedAt ?? consumption.period.start, now)
        : null
    const reachesThisPeriod = reachesAt !== null && reachesAt < consumption.period.end ? reachesAt : null
    if (level) {
      alerts.push({
        family: "tope",
        level,
        periodKey,
        title: level === "limite" ? "Presupuesto alcanzado" : level === "alarma" ? "Alarma" : "Aviso",
        message:
          level === "limite"
            ? `Llegaste al presupuesto del mes (${money(sub.spendCapCents)}): Sofi pasa todo a tu equipo, Clío no escucha en las atenciones nuevas y Argos no escribe para recuperar. Lo que ya empezó se termina.`
            : `Los agentes llevan ${money(spent)} de tu presupuesto de ${money(sub.spendCapCents)} este mes.${reachesThisPeriod ? ` A este ritmo llegas el ${fmtDay(reachesThisPeriod)}.` : ""}`,
        short:
          level === "limite"
            ? "Llegaste al presupuesto del mes"
            : `Llevas ${money(spent)} de tu presupuesto de ${money(sub.spendCapCents)}`,
        action: "cambiar_tope",
      })
    }
  }

  // Precio negociado con vencimiento (issue 168): se avisa desde los días que
  // dicen las condiciones comerciales (15 al empezar).
  const discount = activeDiscountBps(sub, now)
  if (discount > 0 && sub.discountEndsAt) {
    const daysLeft = Math.ceil((sub.discountEndsAt.getTime() - now.getTime()) / DAY)
    if (daysLeft <= levels.discountNoticeDays) {
      alerts.push({
        family: "precio_especial",
        level: daysLeft <= 3 ? "alarma" : "aviso",
        periodKey: sub.discountEndsAt.toISOString().slice(0, 10),
        title: daysLeft <= 3 ? "Alarma" : "Aviso",
        message: `Tu precio especial (${discount / 100} % menos en cada acción) termina el ${fmtDay(sub.discountEndsAt)}. Desde el día siguiente pagas el precio de lista. ¿Quieres conversarlo? Escríbenos desde Soporte.`,
        short: `Tu precio especial termina el ${fmtShort(sub.discountEndsAt)}`,
        action: "ver_plan",
      })
    }
  }

  // Condiciones garantizadas de quien entró por invitación (Fundadores): se
  // avisa desde los días que dicen las condiciones comerciales (30 al empezar).
  if (sub.guaranteedUntil && sub.guaranteedUntil.getTime() > now.getTime()) {
    const daysLeft = Math.ceil((sub.guaranteedUntil.getTime() - now.getTime()) / DAY)
    if (daysLeft <= levels.guaranteeNoticeDays) {
      alerts.push({
        family: "condiciones",
        level: daysLeft <= 7 ? "alarma" : "aviso",
        periodKey: sub.guaranteedUntil.toISOString().slice(0, 10),
        title: daysLeft <= 7 ? "Alarma" : "Aviso",
        message: `Tus condiciones de Fundador terminan el ${fmtDay(sub.guaranteedUntil)}. Desde el día siguiente pasas al plan de lista.`,
        short: `Tus condiciones de Fundador terminan el ${fmtShort(sub.guaranteedUntil)}`,
        action: "ver_plan",
      })
    }
  }
  return alerts
}


export interface AgentSpendGate {
  /** Se usó todo el saldo de prueba: los agentes se pausan. */
  trialExhausted: boolean
  /**
   * Se llegó al presupuesto del mes (ADR 0085): Sofi pasa al equipo a quien no
   * estaba conversando, Clío no escucha en las atenciones nuevas y Argos no
   * escribe para recuperar ni suma preguntas. Lo que ya empezó se termina.
   */
  capReached: boolean
}

/** Lo que detiene a los agentes por dinero, desde los mismos avisos. */
export async function getAgentSpendGate(tx: Db, orgId: string, now = new Date()): Promise<AgentSpendGate> {
  const alerts = await getSaasAlerts(tx, orgId, now)
  return {
    trialExhausted: alerts.some((alert) => alert.family === "saldo_prueba" && alert.level === "limite"),
    capReached: alerts.some((alert) => alert.family === "tope" && alert.level === "limite"),
  }
}

/**
 * Antes de que Clío escuche un tramo (ADR 0085): con el saldo de prueba
 * agotado no trabaja; con el presupuesto del mes alcanzado no empieza a
 * escuchar en una atención nueva, pero la que ya dictaba sigue hasta firmarse.
 * Lo sabe por el gasto de IA de esa atención (`ai_usage.encounter_id`).
 */
export async function assertClioCanListen(tx: Db, orgId: string, encounterId: string): Promise<void> {
  await assertAgentsNotPaused(tx, orgId)
  const gate = await getAgentSpendGate(tx, orgId)
  if (!gate.capReached) return
  const [started] = await tx
    .select({ id: aiUsage.id })
    .from(aiUsage)
    .where(and(eq(aiUsage.organizationId, orgId), eq(aiUsage.encounterId, encounterId)))
    .limit(1)
  if (started) return
  throw new ServiceError(
    "CLIO_BUDGET_REACHED",
    409,
    "Llegaste al presupuesto del mes: Clío no escucha en esta atención. Puedes escribir como siempre.",
  )
}

/** Lo que dice la atención antes de dictar (tablero C4): por qué Clío no escucha aquí, o null si escucha. */
export async function clioListenBlock(tx: Db, orgId: string, encounterId: string): Promise<{ code: string; message: string } | null> {
  try {
    await assertClioCanListen(tx, orgId, encounterId)
    return null
  } catch (error) {
    if (error instanceof ServiceError && (error.code === "CLIO_BUDGET_REACHED" || error.code === "AGENTS_PAUSED")) return { code: error.code, message: error.message }
    throw error
  }
}

/** Para el dictado (Clío) y Argos: con el saldo de prueba agotado los agentes no trabajan. */
export async function assertAgentsNotPaused(tx: Db, orgId: string): Promise<void> {
  const gate = await getAgentSpendGate(tx, orgId)
  if (gate.trialExhausted) {
    throw new ServiceError(
      "AGENTS_PAUSED",
      409,
      "Los agentes están en pausa: se usó todo el saldo de prueba. Quien administra la clínica puede elegir el plan en Plan y pagos.",
    )
  }
}

/* ---------- Ficha de la clínica en la administración (tablero O2) ---------- */

export interface OrganizationBillingTerms {
  plan: {
    id: string
    name: string
    currency: string
    priceCents: number
    creditCents: number
    maxDiscountBps: number
    sellerDiscountBps: number
    trialCreditCents: number
    trialDays: number
    trialMaxCreditCents: number
    trialMaxDays: number
    base: Record<"conversacion" | "consulta" | "cita", number | null>
    /** El precio de cada tipo y lo que no se negocia (ADR 0085). */
    prices: Record<SaasPriceKey, number | null>
    fixed: SaasPriceKey[]
  } | null
  status: string
  trial: { creditCents: number; days: number; startedAt: Date | null; endsAt: Date | null }
  discountBps: number
  /** Último instante del descuento; null = no vence. */
  discountEndsAt: Date | null
  /** Entró por invitación con condiciones garantizadas: hasta cuándo. */
  guaranteedUntil: Date | null
  /**
   * El plan que rige cuando terminan sus condiciones garantizadas: el de lista de su producto,
   * el mismo que pone `endFounderGuarantees` al llegar `startsAt`. null si nada cambia solo.
   */
  next: {
    name: string
    currency: string
    priceCents: number
    creditCents: number
    prices: Record<SaasPriceKey, number | null>
    startsAt: Date
  } | null
  spendCapCents: number | null
  billingCycle: "mensual" | "quincenal"
  /** Con ciclo quincenal, a los cuántos días del tramo en curso se cobra (lo que regía al empezar el tramo). */
  halfCycleDays: number
  /** Desde qué parte del crédito avisa y alarma el medidor (las condiciones que rigen). */
  warnPercent: number
  alarmPercent: number
  /** Días antes del fin de un precio especial en que se avisa (las condiciones que rigen). */
  discountNoticeDays: number
  activatedAt: Date | null
  seller: { id: string; name: string; userId: string | null } | null
  consumption: SaasConsumption
  alerts: SaasAlert[]
  negotiations: SaasNegotiationRow[]
  notices: Array<{ kind: string; sentAt: Date | null; emailTo: string | null }>
}

/** Todo lo de cobro de una clínica para quien la atiende en odentIA. Con owner. */
export async function getOrganizationBillingTerms(tx: Db, orgId: string, now = new Date()): Promise<OrganizationBillingTerms | null> {
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  if (!sub) return null
  const [plan] = sub.planId
    ? await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : await tx.select().from(saasPlan).where(defaultPlanOf(await orgProduct(tx, orgId))).limit(1)
  const notices = await tx
    .select({ kind: saasNotice.kind, sentAt: saasNotice.sentAt, emailTo: saasNotice.emailTo })
    .from(saasNotice)
    .where(eq(saasNotice.organizationId, orgId))
    .orderBy(desc(saasNotice.createdAt))
    .limit(10)
  const terms = await currentSaasTerms(tx, now)
  const periodTerms = sub.currentPeriodStart ? await saasTermsAt(tx, sub.currentPeriodStart) : terms
  const [list] =
    sub.guaranteedUntil && sub.guaranteedUntil > now
      ? await tx.select().from(saasPlan).where(defaultPlanOf(await orgProduct(tx, orgId))).limit(1)
      : []
  return {
    plan: plan
      ? {
          id: plan.id,
          name: plan.name,
          currency: plan.currency,
          priceCents: plan.priceCents,
          creditCents: plan.creditCents,
          maxDiscountBps: plan.maxDiscountBps,
          sellerDiscountBps: plan.sellerDiscountBps,
          trialCreditCents: plan.trialCreditCents,
          trialDays: plan.trialDays,
          trialMaxCreditCents: plan.trialMaxCreditCents,
          trialMaxDays: plan.trialMaxDays,
          base: { conversacion: plan.conversationMicros, consulta: plan.consultationMicros, cita: plan.recoveryMicros },
          prices: planPrices(plan),
          fixed: plan.fixedPriceTiers as SaasPriceKey[],
        }
      : null,
    status: sub.status,
    trial: {
      creditCents: sub.trialCreditCents ?? plan?.trialCreditCents ?? 0,
      days: sub.trialDays ?? plan?.trialDays ?? 0,
      startedAt: sub.trialStartedAt,
      endsAt: sub.trialEndsAt,
    },
    discountBps: activeDiscountBps(sub, now),
    discountEndsAt: activeDiscountBps(sub, now) > 0 ? sub.discountEndsAt : null,
    guaranteedUntil: sub.guaranteedUntil,
    next:
      list && sub.guaranteedUntil && list.id !== plan?.id
        ? {
            name: list.name,
            currency: list.currency,
            priceCents: list.priceCents,
            creditCents: list.creditCents,
            prices: planPrices(list),
            startsAt: sub.guaranteedUntil,
          }
        : null,
    spendCapCents: sub.spendCapCents,
    billingCycle: sub.billingCycle as "mensual" | "quincenal",
    halfCycleDays: periodTerms.halfCycleDays,
    warnPercent: terms.warnPercent,
    alarmPercent: terms.alarmPercent,
    discountNoticeDays: terms.discountNoticeDays,
    activatedAt: sub.activatedAt,
    seller: await saasSellerOf(tx, orgId),
    consumption: await getSaasConsumption(tx, orgId, now),
    alerts: await getSaasAlerts(tx, orgId, now),
    negotiations: await listSaasNegotiations(tx, { orgId }),
    notices,
  }
}

/* ---------- Hoy en la administración (tablero O3) ---------- */

export interface SaasTrialWatchRow {
  organizationId: string
  organizationName: string
  /** Lo que más apura: la pausa, el saldo o los días. */
  state: "en_pausa" | "sin_saldo" | "por_vencer"
  creditLeftCents: number | null
  currency: string | null
  daysLeft: number | null
  did: { conversacion: number; consulta: number; cita: number }
  sellerName: string | null
}

/** Una prueba que termina en estos días o menos está «por vencer» (Hoy y Kairós). */
export const SAAS_TRIAL_WARN_DAYS = 7

/**
 * Pruebas por vencer (`SAAS_TRIAL_WARN_DAYS` o menos) o con el saldo de prueba en aviso, con
 * lo que hicieron los agentes: el argumento de la llamada. «En pausa» primero:
 * la clínica ya vio el valor y se le acabó.
 */
export async function getSaasTrialWatch(tx: Db, now = new Date()): Promise<SaasTrialWatchRow[]> {
  const trials = await tx
    .select({ orgId: saasSubscription.organizationId, endsAt: saasSubscription.trialEndsAt, name: organization.name })
    .from(saasSubscription)
    .innerJoin(organization, eq(organization.id, saasSubscription.organizationId))
    .where(and(eq(saasSubscription.status, "prueba"), eq(saasSubscription.isDemo, false)))
  const rows: SaasTrialWatchRow[] = []
  const { warnPercent } = await currentSaasTerms(tx, now)
  for (const trial of trials) {
    const consumption = await getSaasConsumption(tx, trial.orgId, now)
    const daysLeft = trial.endsAt ? Math.ceil((trial.endsAt.getTime() - now.getTime()) / DAY) : null
    const left = consumption.priced ? Math.max(0, consumption.creditCents - consumption.subtotalCents) : null
    const used = consumption.creditCents > 0 ? consumption.subtotalCents / consumption.creditCents : 0
    const state: SaasTrialWatchRow["state"] | null =
      consumption.priced && consumption.creditCents > 0 && used >= 1
        ? "en_pausa"
        : consumption.priced && used * 100 >= warnPercent
          ? "sin_saldo"
          : daysLeft !== null && daysLeft <= SAAS_TRIAL_WARN_DAYS
            ? "por_vencer"
            : null
    if (!state) continue
    const count = (kind: "conversacion" | "consulta" | "cita") => consumption.lines.find((line) => line.kind === kind)?.count ?? 0
    rows.push({
      organizationId: trial.orgId,
      organizationName: trial.name,
      state,
      creditLeftCents: left,
      currency: consumption.currency,
      daysLeft,
      did: { conversacion: count("conversacion"), consulta: count("consulta"), cita: count("cita") },
      sellerName: (await saasSellerOf(tx, trial.orgId))?.name ?? null,
    })
  }
  const order = { en_pausa: 0, sin_saldo: 1, por_vencer: 2 }
  return rows.sort((a, b) => order[a.state] - order[b.state] || (a.daysLeft ?? 99) - (b.daysLeft ?? 99))
}


