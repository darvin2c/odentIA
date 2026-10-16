import type { Db } from "@odentia/db"
import { aiUsage } from "@odentia/db/schema/agent"
import { organization, user } from "@odentia/db/schema/auth"
import { channelConnection, channelTemplate, conversation, message } from "@odentia/db/schema/crm"
import { auditEvent, orgProfile } from "@odentia/db/schema/org"
import { saasAction, saasNegotiation, saasNotice, saasPlan, saasSeller, saasSubscription, saasWhatsappRate } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { getOrgLocale } from "./locale.js"
import { currentSaasPeriod, getSaasConsumption, microsToCents, type SaasConsumption } from "./saas-actions.js"

/* ---------- Negociación por clínica (ADR 0030, tablero O2) ---------- */

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
    : await tx.select().from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
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
  values: { kind: "descuento" | "prueba"; discountBps?: number; trialCreditCents?: number; trialDays?: number; note?: string | null },
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
 * no tiene descuento. Rige lo que se cuente desde ahora.
 */
export async function setSaasDiscount(
  tx: Db,
  actor: AdminActor,
  orgId: string,
  input: { discountBps: number; note?: string | null },
): Promise<NegotiationOutcome> {
  if (!Number.isInteger(input.discountBps) || input.discountBps < 0) throw validation("El descuento debe ser un porcentaje válido")
  const { plan } = await subscriptionAndPlan(tx, orgId)
  if (input.discountBps > plan.maxDiscountBps) {
    throw new ServiceError(
      "SAAS_PRICE_BELOW_FLOOR",
      409,
      `El descuento máximo es ${plan.maxDiscountBps / 100} %: con más, los precios quedarían bajo el precio mínimo`,
    )
  }
  if (actor.role !== "admin" && input.discountBps > plan.sellerDiscountBps) {
    return requestApproval(tx, orgId, actor, { kind: "descuento", discountBps: input.discountBps, note: input.note ?? null })
  }
  await tx.update(saasSubscription).set({ discountBps: input.discountBps, updatedAt: new Date() }).where(eq(saasSubscription.organizationId, orgId))
  await audit(tx, orgId, actor.userId, "saas.discount_set", { discountBps: input.discountBps })
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
  if (!Number.isSafeInteger(input.trialCreditCents) || input.trialCreditCents < 0) throw validation("El saldo de prueba debe ser un importe válido")
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) throw validation("La prueba debe durar al menos un día")
  const { sub, plan } = await subscriptionAndPlan(tx, orgId)
  if (input.trialCreditCents > plan.trialMaxCreditCents || input.trialDays > plan.trialMaxDays) {
    throw validation(`La prueba puede llegar como mucho a ${plan.trialMaxCreditCents / 100} ${plan.currency} y ${plan.trialMaxDays} días`)
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
  if (actor.role !== "admin") throw forbidden("Solo la administración de odentIA aprueba un descuento o una prueba fuera de lo de siempre")
  const [row] = await tx.select().from(saasNegotiation).where(eq(saasNegotiation.id, negotiationId)).limit(1).for("update")
  if (!row) throw notFound("Pedido")
  if (row.status !== "pendiente") throw new ServiceError("SAAS_NEGOTIATION_DECIDED", 409, "Ese pedido ya se decidió")
  if (approve) {
    if (row.kind === "descuento" && row.discountBps !== null) {
      await setSaasDiscount(tx, actor, row.organizationId, { discountBps: row.discountBps })
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

/* ---------- Tope de gasto y ciclo (tableros C5 y O2) ---------- */

/**
 * Lo máximo que la clínica paga al mes por encima del crédito; null lo quita.
 * Lo decide quien administra la clínica. Distinto del tope técnico de
 * corridas por día de Recepción: ese protege el sistema; este es dinero.
 */
export async function setSaasSpendCap(tx: Db, orgId: string, actorUserId: string, capCents: number | null): Promise<void> {
  if (capCents !== null && (!Number.isSafeInteger(capCents) || capCents < 0)) throw validation("El tope debe ser un importe válido")
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

/* ---------- Avisos, alarma y límite (tablero C4) ---------- */

export type SaasAlertFamily = "saldo_prueba" | "dias_prueba" | "credito" | "tope"
export type SaasAlertLevel = "aviso" | "alarma" | "limite"

export interface SaasAlert {
  family: SaasAlertFamily
  level: SaasAlertLevel
  /** Identifica el tramo: un aviso por nivel y por tramo. */
  periodKey: string
  title: string
  message: string
  action: "elegir_plan" | "cambiar_tope" | "ver_consumo"
}

/** Desde qué parte usada avisa y alarma: los mismos niveles del medidor. */
export const SAAS_WARN_AT = 0.75
export const SAAS_ALARM_AT = 0.9
const DAY = 86_400_000

function levelOf(used: number, total: number, alarmByDate: boolean): SaasAlertLevel | null {
  if (total <= 0) return null
  if (used >= total) return "limite"
  if (used >= total * SAAS_ALARM_AT || alarmByDate) return "alarma"
  if (used >= total * SAAS_WARN_AT) return "aviso"
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
  const locale = await getOrgLocale(tx, orgId).catch(() => null)
  const fmtDay = (date: Date) =>
    new Intl.DateTimeFormat(locale?.locale ?? "es-PE", { weekday: "long", day: "numeric", month: "long", timeZone: locale?.timezone ?? "UTC" }).format(date)
  const money = (cents: number) =>
    new Intl.NumberFormat(locale?.locale ?? "es-PE", { style: "currency", currency: consumption.currency ?? "USD" }).format(cents / 100)
  const periodKey = consumption.period.start.toISOString().slice(0, 10)
  const alerts: SaasAlert[] = []

  if (sub.status === "prueba" && consumption.priced && consumption.creditCents > 0) {
    const used = consumption.subtotalCents
    const ends = exhaustionDate(used, consumption.creditCents, consumption.period.start, now)
    const soon = ends !== null && ends.getTime() - now.getTime() <= 3 * DAY && ends < consumption.period.end
    const level = levelOf(used, consumption.creditCents, soon)
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
        action: "elegir_plan",
      })
    }
  }

  if (sub.status !== "prueba" && consumption.priced && consumption.creditCents > 0) {
    const level = levelOf(consumption.subtotalCents, consumption.creditCents, false)
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
        action: "ver_consumo",
      })
    }
  }

  if (sub.status !== "prueba" && sub.spendCapCents !== null && sub.spendCapCents > 0) {
    const level = levelOf(consumption.overCreditCents, sub.spendCapCents, false)
    if (level) {
      alerts.push({
        family: "tope",
        level,
        periodKey,
        title: level === "limite" ? "Tope alcanzado" : level === "alarma" ? "Alarma" : "Aviso",
        message:
          level === "limite"
            ? "Llegaste a tu tope de gasto: Recepción pasa los casos nuevos a tu equipo con un mensaje fijo. El dictado y las citas en curso siguen."
            : `Los agentes llevan ${money(consumption.overCreditCents)} de tu tope de ${money(sub.spendCapCents)} este mes.`,
        action: "cambiar_tope",
      })
    }
  }
  return alerts
}

export interface AgentSpendGate {
  /** Se usó todo el saldo de prueba: los agentes se pausan. */
  trialExhausted: boolean
  /** Se llegó al tope del mes: Recepción pasa los casos nuevos al equipo. */
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

/** Para el dictado y el Administrador: con el saldo de prueba agotado los agentes no trabajan. */
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

/* ---------- Estimación de WhatsApp (tablero C2) ---------- */

export interface WhatsappEstimate {
  /** Plantillas enviadas en el tramo por categoría. */
  templates: { marketing: number; utility: number; authentication: number }
  currency: string | null
  /** null si la administración aún no cargó las tarifas de Meta para el país de la clínica. */
  estimateMicros: number | null
}

/**
 * Lo que Meta le cobraría a la clínica por las plantillas del tramo, con las
 * tarifas que cargó la administración para su país. Es una estimación: lo
 * cobra Meta directo y depende por completo de Meta.
 */
export async function getWhatsappEstimate(tx: Db, orgId: string, now = new Date()): Promise<WhatsappEstimate> {
  const period = await currentSaasPeriod(tx, orgId, now)
  const rows = await tx
    .select({ category: channelTemplate.category, n: sql<number>`count(*)::int` })
    .from(message)
    .innerJoin(conversation, eq(conversation.id, message.conversationId))
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .innerJoin(
      channelTemplate,
      and(
        eq(channelTemplate.connectionId, channelConnection.id),
        eq(channelTemplate.name, message.templateName),
        eq(channelTemplate.language, sql`coalesce(${message.templateLanguage}, ${channelTemplate.language})`),
      ),
    )
    .where(
      and(
        eq(message.organizationId, orgId),
        eq(message.direction, "out"),
        eq(message.contentType, "template"),
        eq(channelConnection.channel, "whatsapp"),
        gte(message.createdAt, period.start),
        lt(message.createdAt, period.end),
      ),
    )
    .groupBy(channelTemplate.category)
  const templates = { marketing: 0, utility: 0, authentication: 0 }
  for (const row of rows) {
    if (row.category === "marketing" || row.category === "utility" || row.category === "authentication") templates[row.category] = Number(row.n)
  }
  const [profile] = await tx.select({ country: orgProfile.countryCode }).from(orgProfile).where(eq(orgProfile.organizationId, orgId)).limit(1)
  const rates = profile
    ? await tx.select().from(saasWhatsappRate).where(eq(saasWhatsappRate.countryCode, profile.country)).orderBy(asc(saasWhatsappRate.category))
    : []
  const used = (Object.keys(templates) as Array<keyof typeof templates>).filter((category) => templates[category] > 0)
  const rateOf = (category: string) => rates.find((rate) => rate.category === category)
  const complete = used.every((category) => rateOf(category))
  return {
    templates,
    currency: rates[0]?.currency ?? null,
    estimateMicros: complete && rates.length ? used.reduce((sum, category) => sum + templates[category] * (rateOf(category)?.priceMicros ?? 0), 0) : null,
  }
}

export interface WhatsappRateRow {
  countryCode: string
  category: "marketing" | "utility" | "authentication"
  currency: string
  priceMicros: number
  updatedAt: Date
}

export async function listWhatsappRates(tx: Db): Promise<WhatsappRateRow[]> {
  const rows = await tx.select().from(saasWhatsappRate).orderBy(asc(saasWhatsappRate.countryCode), asc(saasWhatsappRate.category))
  return rows.map((row) => ({
    countryCode: row.countryCode,
    category: row.category as WhatsappRateRow["category"],
    currency: row.currency,
    priceMicros: row.priceMicros,
    updatedAt: row.updatedAt,
  }))
}

/** Carga o cambia la tarifa de Meta de un país y categoría (administración, con owner). */
export async function upsertWhatsappRate(
  tx: Db,
  actor: AdminActor,
  input: { countryCode: string; category: string; currency: string; priceMicros: number },
): Promise<void> {
  if (actor.role !== "admin") throw forbidden("Solo la administración carga las tarifas de WhatsApp")
  const country = input.countryCode.trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) throw validation("País inválido (ISO 3166-1 alfa-2)")
  if (!["marketing", "utility", "authentication"].includes(input.category)) throw validation("Categoría inválida")
  const currencyCode = input.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currencyCode)) throw validation("Moneda inválida (ISO 4217)")
  if (!Number.isSafeInteger(input.priceMicros) || input.priceMicros < 0) throw validation("La tarifa debe ser un importe válido")
  await tx
    .insert(saasWhatsappRate)
    .values({ countryCode: country, category: input.category, currency: currencyCode, priceMicros: input.priceMicros, updatedBy: actor.userId })
    .onConflictDoUpdate({
      target: [saasWhatsappRate.countryCode, saasWhatsappRate.category],
      set: { currency: currencyCode, priceMicros: input.priceMicros, updatedBy: actor.userId, updatedAt: new Date() },
    })
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
  } | null
  status: string
  trial: { creditCents: number; days: number; startedAt: Date | null; endsAt: Date | null }
  discountBps: number
  spendCapCents: number | null
  billingCycle: "mensual" | "quincenal"
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
    : await tx.select().from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
  const notices = await tx
    .select({ kind: saasNotice.kind, sentAt: saasNotice.sentAt, emailTo: saasNotice.emailTo })
    .from(saasNotice)
    .where(eq(saasNotice.organizationId, orgId))
    .orderBy(desc(saasNotice.createdAt))
    .limit(10)
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
        }
      : null,
    status: sub.status,
    trial: {
      creditCents: sub.trialCreditCents ?? plan?.trialCreditCents ?? 0,
      days: sub.trialDays ?? plan?.trialDays ?? 0,
      startedAt: sub.trialStartedAt,
      endsAt: sub.trialEndsAt,
    },
    discountBps: sub.discountBps,
    spendCapCents: sub.spendCapCents,
    billingCycle: sub.billingCycle as "mensual" | "quincenal",
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

/**
 * Pruebas por vencer (7 días o menos) o con el saldo de prueba en aviso, con
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
  for (const trial of trials) {
    const consumption = await getSaasConsumption(tx, trial.orgId, now)
    const daysLeft = trial.endsAt ? Math.ceil((trial.endsAt.getTime() - now.getTime()) / DAY) : null
    const left = consumption.priced ? Math.max(0, consumption.creditCents - consumption.subtotalCents) : null
    const used = consumption.creditCents > 0 ? consumption.subtotalCents / consumption.creditCents : 0
    const state: SaasTrialWatchRow["state"] | null =
      consumption.priced && consumption.creditCents > 0 && used >= 1
        ? "en_pausa"
        : consumption.priced && used >= SAAS_WARN_AT
          ? "sin_saldo"
          : daysLeft !== null && daysLeft <= 7
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

export interface SaasLowMarginRow {
  organizationId: string
  organizationName: string
  currency: string
  months: Array<{ label: string; revenueCents: number; costCents: number; marginPct: number }>
}

/** Margen bajo: menos de este porcentaje dos meses seguidos. */
export const SAAS_LOW_MARGIN_PCT = 50

/**
 * Clínicas activas con margen bajo los dos últimos meses cerrados: lo que se
 * les cobra (la cuota más lo que pasó del crédito, con su precio) frente a lo
 * que odentIA pagó a los proveedores de IA (`ai_usage`). Se revisa plan, uso
 * anómalo o precio.
 */
export async function getSaasLowMargin(tx: Db, now = new Date()): Promise<SaasLowMarginRow[]> {
  const subs = await tx
    .select({ orgId: saasSubscription.organizationId, planId: saasSubscription.planId, name: organization.name })
    .from(saasSubscription)
    .innerJoin(organization, eq(organization.id, saasSubscription.organizationId))
    .where(and(eq(saasSubscription.status, "activa"), eq(saasSubscription.isDemo, false)))
  const months = [2, 1].map((back) => {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1))
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back + 1, 1))
    return { start, end, label: start.toISOString().slice(0, 7) }
  })
  const rows: SaasLowMarginRow[] = []
  for (const sub of subs) {
    if (!sub.planId) continue
    const [plan] = await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    if (!plan) continue
    const result: SaasLowMarginRow["months"] = []
    for (const month of months) {
      const [actions] = await tx
        .select({ micros: sql<number>`coalesce(sum(${saasAction.priceMicros}), 0)` })
        .from(saasAction)
        .where(and(eq(saasAction.organizationId, sub.orgId), gte(saasAction.occurredAt, month.start), lt(saasAction.occurredAt, month.end)))
      const [cost] = await tx
        .select({ micros: sql<number>`coalesce(sum(${aiUsage.costMicros}), 0)` })
        .from(aiUsage)
        .where(and(eq(aiUsage.organizationId, sub.orgId), gte(aiUsage.createdAt, month.start), lt(aiUsage.createdAt, month.end)))
      const actionsCents = microsToCents(Number(actions?.micros ?? 0))
      const revenueCents = plan.priceCents + Math.max(0, actionsCents - plan.creditCents)
      const costCents = microsToCents(Number(cost?.micros ?? 0))
      result.push({ label: month.label, revenueCents, costCents, marginPct: revenueCents > 0 ? Math.round((1 - costCents / revenueCents) * 100) : 0 })
    }
    if (result.every((month) => month.costCents > 0 && month.marginPct < SAAS_LOW_MARGIN_PCT)) {
      rows.push({ organizationId: sub.orgId, organizationName: sub.name, currency: plan.currency, months: result })
    }
  }
  return rows
}
