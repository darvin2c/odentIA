import type { Db } from "@odentia/db"
import { aiUsage } from "@odentia/db/schema/agent"
import { organization, user } from "@odentia/db/schema/auth"
import { auditEvent } from "@odentia/db/schema/org"
import { saasNegotiation, saasNotice, saasPlan, saasSeller, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, desc, eq, sql } from "drizzle-orm"
import type { AdminActor } from "./admin-core.js"
import { notFound, ServiceError, validation } from "./errors.js"
import { formatMoney } from "@odentia/clinical"
import { findOrgLocale } from "./locale.js"
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
  if (!Number.isInteger(input.discountBps) || input.discountBps < 0) throw validation("El descuento debe ser un porcentaje válido")
  const endsAt = input.discountBps > 0 ? (input.discountEndsAt ?? null) : null
  if (endsAt && (Number.isNaN(endsAt.getTime()) || endsAt.getTime() <= now.getTime())) throw validation("El vencimiento tiene que ser una fecha futura")
  const { plan } = await subscriptionAndPlan(tx, orgId)
  if (input.discountBps > plan.maxDiscountBps) {
    throw new ServiceError(
      "SAAS_PRICE_BELOW_FLOOR",
      409,
      `El descuento máximo es ${plan.maxDiscountBps / 100} %: con más, los precios quedarían bajo el precio mínimo`,
    )
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
  if (!Number.isSafeInteger(input.trialCreditCents) || input.trialCreditCents < 0) throw validation("El saldo de prueba debe ser un importe válido")
  if (!Number.isInteger(input.trialDays) || input.trialDays < 1) throw validation("La prueba debe durar al menos un día")
  const { sub, plan } = await subscriptionAndPlan(tx, orgId)
  if (input.trialCreditCents > plan.trialMaxCreditCents || input.trialDays > plan.trialMaxDays) {
    throw validation(`La prueba puede llegar como mucho a ${formatMoney(plan.trialMaxCreditCents, plan.currency, "es")} y ${plan.trialMaxDays} días`)
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
  if (actor.role !== "admin") throw forbidden("Solo la administración de odentIA aprueba un descuento o una prueba fuera de lo de siempre")
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
  if (capCents !== null && (!Number.isSafeInteger(capCents) || capCents < 0)) throw validation("El presupuesto debe ser un importe válido")
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
        message: `Tus condiciones de Fundador terminan el ${fmtDay(sub.guaranteedUntil)}. Desde el día siguiente pasas al plan de lista de odentIA.`,
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
    : await tx.select().from(saasPlan).where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true))).limit(1)
  const notices = await tx
    .select({ kind: saasNotice.kind, sentAt: saasNotice.sentAt, emailTo: saasNotice.emailTo })
    .from(saasNotice)
    .where(eq(saasNotice.organizationId, orgId))
    .orderBy(desc(saasNotice.createdAt))
    .limit(10)
  const terms = await currentSaasTerms(tx, now)
  const periodTerms = sub.currentPeriodStart ? await saasTermsAt(tx, sub.currentPeriodStart) : terms
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


