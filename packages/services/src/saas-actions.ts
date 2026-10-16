import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDictationSuggestion, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { type SaasActionKind, saasAction, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm"
import { adminLineOf } from "./admin-lines.js"

/* ---------- Lo que hicieron los agentes, por acción (ADR 0030) ---------- */

/** Una conversación por persona en esta ventana, aunque escriba diez mensajes o cambie de canal. */
export const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000
/** Plazo entre el mensaje del Administrador y la reserva para que la cita cuente como recuperada. */
export const RECOVERY_WINDOW_DAYS = 7
/** Lo que escribe el Administrador y no recupera nada: los recordatorios. */
const NOT_RECOVERY_KINDS = ["recordatorio_cita", "recordatorio_control"]
/** Por dónde reservó el agente: en su conversación o desde su enlace. La que agenda el equipo no cuenta. */
const AGENT_SOURCES = ["agent", "enlace"]

const CHANNEL_NAME: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  messenger: "Messenger",
  email: "correo",
  webchat: "el chat web",
}

/** 1 centavo = 10.000 millonésimas. */
export const microsToCents = (micros: number): number => Math.round(micros / 10_000)

export interface ActionPricing {
  planId: string | null
  currency: string | null
  creditCents: number
  discountBps: number
  maxDiscountBps: number
  base: Record<SaasActionKind, number | null>
}

/**
 * Precios con los que se cuenta hoy en una clínica: los de su plan o, si aún
 * no eligió, los del plan por defecto; con su descuento negociado. Sin plan
 * con precio, las acciones se cuentan sin importe (nunca 0).
 */
export async function getActionPricing(tx: Db, orgId: string): Promise<ActionPricing> {
  const [sub] = await tx
    .select({ planId: saasSubscription.planId, discountBps: saasSubscription.discountBps })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  const [plan] = sub?.planId
    ? await tx.select().from(saasPlan).where(eq(saasPlan.id, sub.planId)).limit(1)
    : await tx
        .select()
        .from(saasPlan)
        .where(and(eq(saasPlan.isDefault, true), eq(saasPlan.isActive, true)))
        .limit(1)
  return {
    planId: plan?.id ?? null,
    currency: plan?.currency ?? null,
    creditCents: plan?.creditCents ?? 0,
    discountBps: Math.min(sub?.discountBps ?? 0, plan?.maxDiscountBps ?? 0),
    maxDiscountBps: plan?.maxDiscountBps ?? 0,
    base: {
      conversacion: plan?.conversationMicros ?? null,
      consulta: plan?.consultationMicros ?? null,
      cita: plan?.recoveryMicros ?? null,
    },
  }
}

/** Precio con descuento, redondeado a la millonésima. */
export function discountedMicros(baseMicros: number, discountBps: number): number {
  return Math.round((baseMicros * (10_000 - discountBps)) / 10_000)
}

async function insertAction(
  tx: Db,
  orgId: string,
  kind: SaasActionKind,
  values: Omit<typeof saasAction.$inferInsert, "organizationId" | "kind" | "basePriceMicros" | "priceMicros" | "discountBps" | "currency">,
): Promise<boolean> {
  const pricing = await getActionPricing(tx, orgId)
  const base = pricing.base[kind]
  const [row] = await tx
    .insert(saasAction)
    .values({
      ...values,
      organizationId: orgId,
      kind,
      currency: pricing.currency,
      basePriceMicros: base,
      priceMicros: base === null ? null : discountedMicros(base, pricing.discountBps),
      discountBps: base === null ? 0 : pricing.discountBps,
    })
    .onConflictDoNothing({ target: [saasAction.organizationId, saasAction.dedupeKey] })
    .returning({ id: saasAction.id })
  return Boolean(row)
}

/**
 * Recepción atendió con IA (la corrida respondió y llamó al modelo): una
 * conversación por persona cada 24 horas. No cuentan lo que respondió el
 * equipo, la derivación sin IA, el texto fijo ni la corrida que falló: quien
 * llama solo lo pide con una corrida `ok` que llamó al modelo.
 */
export async function countConversationAction(tx: Db, orgId: string, input: { conversationId: string; at: Date }): Promise<boolean> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId, channel: channelConnection.channel })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .limit(1)
  if (!conv) return false
  // Dos corridas a la vez de la misma persona (dos canales) no cuentan dos.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas-action:${orgId}:${conv.contactId}`}, 0))`)
  const [recent] = await tx
    .select({ id: saasAction.id })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.contactId, conv.contactId),
        eq(saasAction.kind, "conversacion"),
        gt(saasAction.occurredAt, new Date(input.at.getTime() - CONVERSATION_WINDOW_MS)),
      ),
    )
    .limit(1)
  if (recent) return false
  return insertAction(tx, orgId, "conversacion", {
    occurredAt: input.at,
    contactId: conv.contactId,
    conversationId: input.conversationId,
    channel: conv.channel,
    detail: `Atendió una conversación por ${CHANNEL_NAME[conv.channel] ?? conv.channel}`,
    dedupeKey: `conversacion:${conv.contactId}:${input.at.toISOString()}`,
  })
}

/**
 * El Asistente clínico ordenó lo dictado y el odontólogo lo confirmó: una
 * consulta por atención, al cerrarla. Sin sugerencias confirmadas no cuenta
 * (el borrador descartado no se cobra).
 */
export async function countConsultationAction(
  tx: Db,
  orgId: string,
  input: { patientId: string; encounterId: string; at: Date },
): Promise<boolean> {
  const [confirmed] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, input.patientId),
        eq(encounterDictationSuggestion.encounterId, input.encounterId),
        eq(encounterDictationSuggestion.status, "confirmada"),
      ),
    )
  if (!confirmed?.n) return false
  const [row] = await tx
    .select({ dentist: user.name })
    .from(encounter)
    .leftJoin(user, eq(user.id, encounter.dentistUserId))
    .where(and(eq(encounter.organizationId, orgId), eq(encounter.id, input.encounterId)))
    .limit(1)
  const [self] = await tx
    .select({ contactId: patientContact.contactId })
    .from(patientContact)
    .where(
      and(
        eq(patientContact.organizationId, orgId),
        eq(patientContact.patientId, input.patientId),
        eq(patientContact.relationship, "self"),
      ),
    )
    .limit(1)
  return insertAction(tx, orgId, "consulta", {
    occurredAt: input.at,
    contactId: self?.contactId ?? null,
    encounterId: input.encounterId,
    detail: row?.dentist ? `Ordenó la consulta dictada por ${row.dentist}` : "Ordenó una consulta dictada",
    dedupeKey: `consulta:${input.encounterId}`,
  })
}

interface RecoveredRow {
  appointment_id: string
  status: string
  source: string
  created_at: Date | string
  starts_at: Date | string
  conversation_id: string | null
  contact_id: string
  line_kind: string
  sent_at: Date | string
}

/**
 * La regla de la cita recuperada, una sola vez: reservada por el agente (en
 * su conversación o desde su enlace) dentro de los 7 días siguientes a un
 * mensaje del Administrador a esa persona que no fue un recordatorio.
 */
function recoveredSql(orgId: string, where: ReturnType<typeof sql>) {
  return sql`
    select a.id as appointment_id, a.status, a.source, a.created_at, a.starts_at, a.conversation_id,
           pc.contact_id, j.kind as line_kind, j.sent_at
    from appointment a
    join patient_contact pc
      on pc.organization_id = a.organization_id and pc.patient_id = a.patient_id and pc.relationship = 'self'
    join lateral (
      select j.kind, coalesce(m.created_at, j.updated_at) as sent_at
      from automation_job j
      left join message m on m.id = j.sent_message_id and m.organization_id = j.organization_id
      where j.organization_id = a.organization_id
        and j.contact_id = pc.contact_id
        and j.status = 'enviado'
        and j.kind not in (${sql.join(NOT_RECOVERY_KINDS.map((kind) => sql`${kind}`), sql`, `)})
        and coalesce(m.created_at, j.updated_at) <= a.created_at
        and coalesce(m.created_at, j.updated_at) > a.created_at - make_interval(days => ${RECOVERY_WINDOW_DAYS})
      order by coalesce(m.created_at, j.updated_at) desc
      limit 1
    ) j on true
    where a.organization_id = ${orgId}
      and a.source in (${sql.join(AGENT_SOURCES.map((source) => sql`${source}`), sql`, `)})
      and ${where}`
}

const asDate = (value: Date | string) => (value instanceof Date ? value : new Date(value))

function recoveryDetail(row: RecoveredRow): string {
  const line = adminLineOf(row.line_kind)?.name
  const how = row.source === "enlace" ? "reservó desde el enlace" : "reservó en la conversación"
  return line ? `Volvió tras «${line}» y ${how}` : `Volvió tras un mensaje del Administrador y ${how}`
}

/**
 * Cita recuperada: se cuenta cuando el paciente asiste (la cita pasa a
 * «atendida»). La conversación de esa persona entre el mensaje y la reserva
 * va dentro de la cita.
 */
export async function countRecoveredAppointment(tx: Db, orgId: string, appointmentId: string, at: Date): Promise<boolean> {
  const rows = (await tx.execute(recoveredSql(orgId, sql`a.id = ${appointmentId}`))) as unknown as RecoveredRow[]
  const row = rows[0]
  if (!row) return false
  return insertAction(tx, orgId, "cita", {
    occurredAt: at,
    contactId: row.contact_id,
    conversationId: row.conversation_id,
    appointmentId,
    channel: row.source,
    windowStart: asDate(row.sent_at),
    detail: recoveryDetail(row),
    dedupeKey: `cita:${appointmentId}`,
  })
}

/* ---------- Lo que ve la clínica: el mes y cada fila ---------- */

export type SaasActionState = "prueba" | "credito" | "sobre_credito" | "dentro_de_cita" | "esperando" | "sin_precio" | "anulada"

export interface SaasActionRow {
  id: string
  kind: SaasActionKind
  occurredAt: Date
  contactId: string | null
  personName: string | null
  conversationId: string | null
  appointmentId: string | null
  channel: string | null
  detail: string
  basePriceMicros: number | null
  priceMicros: number | null
  discountBps: number
  state: SaasActionState
  chargeId: string | null
}

export interface SaasPeriod {
  start: Date
  end: Date
  /** `prueba`: el saldo de regalo; `mes`: el crédito de la cuota. */
  credit: "prueba" | "mes"
}

/**
 * El tramo y el crédito que corren hoy: la prueba mientras dura; si no, el
 * periodo de la suscripción; sin suscripción, el mes calendario.
 */
export async function currentSaasPeriod(tx: Db, orgId: string, now = new Date()): Promise<SaasPeriod & { creditCents: number }> {
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  const pricing = await getActionPricing(tx, orgId)
  if (sub?.status === "prueba" && sub.trialStartedAt && sub.trialEndsAt) {
    const [plan] = pricing.planId ? await tx.select().from(saasPlan).where(eq(saasPlan.id, pricing.planId)).limit(1) : []
    return { start: sub.trialStartedAt, end: sub.trialEndsAt, credit: "prueba", creditCents: plan?.trialCreditCents ?? 0 }
  }
  if (sub?.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
    return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd, credit: "mes", creditCents: pricing.creditCents }
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end, credit: "mes", creditCents: pricing.creditCents }
}

/**
 * Las acciones de un tramo con su estado: del saldo de prueba o del crédito
 * hasta agotarlo, después por encima del crédito; la conversación que llevó
 * a una cita recuperada va dentro de ella; la cita cuya asistencia se
 * deshizo queda anulada. Una sola definición para la pantalla y el cobro.
 */
export async function listPeriodActions(
  tx: Db,
  orgId: string,
  period: SaasPeriod & { creditCents: number },
): Promise<SaasActionRow[]> {
  const rows = await tx
    .select({
      id: saasAction.id,
      kind: saasAction.kind,
      occurredAt: saasAction.occurredAt,
      contactId: saasAction.contactId,
      personName: contact.displayName,
      conversationId: saasAction.conversationId,
      appointmentId: saasAction.appointmentId,
      channel: saasAction.channel,
      windowStart: saasAction.windowStart,
      detail: saasAction.detail,
      basePriceMicros: saasAction.basePriceMicros,
      priceMicros: saasAction.priceMicros,
      discountBps: saasAction.discountBps,
      chargeId: saasAction.chargeId,
    })
    .from(saasAction)
    .leftJoin(contact, and(eq(contact.id, saasAction.contactId), eq(contact.organizationId, saasAction.organizationId)))
    .where(and(eq(saasAction.organizationId, orgId), gte(saasAction.occurredAt, period.start), lt(saasAction.occurredAt, period.end)))
    .orderBy(asc(saasAction.occurredAt), asc(saasAction.id))
  const appointmentIds = rows.filter((row) => row.kind === "cita" && row.appointmentId).map((row) => row.appointmentId as string)
  const attended = new Set<string>()
  const bookedAt = new Map<string, Date>()
  if (appointmentIds.length) {
    const found = (await tx.execute(sql`
      select id, status, created_at from appointment
      where organization_id = ${orgId} and id in (${sql.join(appointmentIds.map((id) => sql`${id}`), sql`, `)})`)) as unknown as Array<{
      id: string
      status: string
      created_at: Date | string
    }>
    for (const item of found) {
      if (item.status === "atendida") attended.add(item.id)
      bookedAt.set(item.id, asDate(item.created_at))
    }
  }
  // La conversación de la persona entre el mensaje del Administrador y la reserva va dentro de la cita.
  const insideCita = (row: (typeof rows)[number]) =>
    row.kind === "conversacion" &&
    rows.some(
      (cita) =>
        cita.kind === "cita" &&
        cita.contactId === row.contactId &&
        cita.appointmentId !== null &&
        attended.has(cita.appointmentId) &&
        cita.windowStart !== null &&
        row.occurredAt >= cita.windowStart &&
        row.occurredAt <= (bookedAt.get(cita.appointmentId) ?? cita.occurredAt),
    )
  let usedMicros = 0
  const creditMicros = period.creditCents * 10_000
  return rows.map((row) => {
    let state: SaasActionState
    if (row.kind === "cita" && row.appointmentId && !attended.has(row.appointmentId)) state = "anulada"
    else if (insideCita(row)) state = "dentro_de_cita"
    else if (row.priceMicros === null) state = "sin_precio"
    else {
      usedMicros += row.priceMicros
      state = period.credit === "prueba" ? "prueba" : usedMicros <= creditMicros ? "credito" : "sobre_credito"
    }
    return {
      id: row.id,
      kind: row.kind as SaasActionKind,
      occurredAt: row.occurredAt,
      contactId: row.contactId,
      personName: row.personName,
      conversationId: row.conversationId,
      appointmentId: row.appointmentId,
      channel: row.channel,
      detail: row.detail,
      basePriceMicros: row.basePriceMicros,
      priceMicros: row.priceMicros,
      discountBps: row.discountBps,
      state,
      chargeId: row.chargeId,
    }
  })
}

/** Citas recuperadas que aún esperan que el paciente asista: no se cobran todavía. */
export async function listPendingRecoveries(tx: Db, orgId: string): Promise<SaasActionRow[]> {
  const rows = (await tx.execute(
    recoveredSql(orgId, sql`a.status in ('programada', 'confirmada') and a.starts_at > now() - interval '1 day'`),
  )) as unknown as RecoveredRow[]
  if (!rows.length) return []
  const pricing = await getActionPricing(tx, orgId)
  const base = pricing.base.cita
  const names = await tx
    .select({ id: contact.id, name: contact.displayName })
    .from(contact)
    .where(and(eq(contact.organizationId, orgId), inArray(contact.id, rows.map((row) => row.contact_id))))
  const nameOf = new Map(names.map((item) => [item.id, item.name]))
  return rows.map((row) => ({
    id: `pendiente:${row.appointment_id}`,
    kind: "cita",
    occurredAt: asDate(row.created_at),
    contactId: row.contact_id,
    personName: nameOf.get(row.contact_id) ?? null,
    conversationId: row.conversation_id,
    appointmentId: row.appointment_id,
    channel: row.source,
    detail: recoveryDetail(row),
    basePriceMicros: base,
    priceMicros: base === null ? null : discountedMicros(base, pricing.discountBps),
    discountBps: base === null ? 0 : pricing.discountBps,
    state: "esperando",
    chargeId: null,
  }))
}

export interface SaasConsumptionLine {
  kind: SaasActionKind
  count: number
  basePriceMicros: number | null
  priceMicros: number | null
  amountCents: number
  baseAmountCents: number
}

export interface SaasConsumption {
  period: { start: Date; end: Date; credit: "prueba" | "mes" }
  currency: string | null
  /** false: el plan aún no tiene precios por acción; se cuenta sin importes. */
  priced: boolean
  discountBps: number
  lines: SaasConsumptionLine[]
  pendingRecoveries: number
  subtotalCents: number
  baseSubtotalCents: number
  creditCents: number
  creditUsedCents: number
  /** Cuándo se acabó el crédito o el saldo de prueba en este tramo; null si no se acabó. */
  creditExhaustedAt: Date | null
  overCreditCents: number
  /** Al ritmo de lo transcurrido, cuánto sumarán las acciones al terminar el tramo. */
  projectedCents: number | null
}

/** C2: lo que hicieron los agentes en el tramo, con precio base, precio propio e importe. */
export async function getSaasConsumption(tx: Db, orgId: string, now = new Date()): Promise<SaasConsumption> {
  const period = await currentSaasPeriod(tx, orgId, now)
  const pricing = await getActionPricing(tx, orgId)
  const actions = await listPeriodActions(tx, orgId, period)
  const pending = await listPendingRecoveries(tx, orgId)
  const billable = actions.filter((row) => row.state !== "anulada" && row.state !== "dentro_de_cita")
  const kinds: SaasActionKind[] = ["conversacion", "consulta", "cita"]
  const lines = kinds.map((kind) => {
    const ofKind = billable.filter((row) => row.kind === kind)
    const price = ofKind.reduce((sum, row) => sum + (row.priceMicros ?? 0), 0)
    const base = ofKind.reduce((sum, row) => sum + (row.basePriceMicros ?? 0), 0)
    const currentBase = pricing.base[kind]
    return {
      kind,
      count: ofKind.length,
      basePriceMicros: currentBase,
      priceMicros: currentBase === null ? null : discountedMicros(currentBase, pricing.discountBps),
      amountCents: microsToCents(price),
      baseAmountCents: microsToCents(base),
    }
  })
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const creditMicros = period.creditCents * 10_000
  let used = 0
  let exhaustedAt: Date | null = null
  for (const row of billable) {
    if (row.priceMicros === null) continue
    used += row.priceMicros
    if (exhaustedAt === null && creditMicros > 0 && used >= creditMicros) exhaustedAt = row.occurredAt
  }
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - period.start.getTime()) / (period.end.getTime() - period.start.getTime())))
  return {
    period: { start: period.start, end: period.end, credit: period.credit },
    currency: pricing.currency,
    priced: kinds.some((kind) => pricing.base[kind] !== null),
    discountBps: pricing.discountBps,
    lines,
    pendingRecoveries: pending.length,
    subtotalCents,
    baseSubtotalCents: lines.reduce((sum, line) => sum + line.baseAmountCents, 0),
    creditCents: period.creditCents,
    creditUsedCents: Math.min(period.creditCents, subtotalCents),
    creditExhaustedAt: exhaustedAt,
    overCreditCents: Math.max(0, subtotalCents - period.creditCents),
    // Con menos de un día de tramo la proyección no dice nada.
    projectedCents: elapsed > 0 && now.getTime() - period.start.getTime() >= 24 * 60 * 60 * 1000 ? Math.round(subtotalCents / elapsed) : null,
  }
}
