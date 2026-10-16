import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDictationSuggestion, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import { type SaasActionKind, saasAction, saasCharge, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, sql } from "drizzle-orm"
import { adminLineOf } from "./admin-lines.js"
import { ServiceError } from "./errors.js"

/* ---------- Lo que hicieron los agentes, por acción (ADR 0031) ---------- */

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
    return { start: sub.trialStartedAt, end: sub.trialEndsAt, credit: "prueba", creditCents: sub.trialCreditCents ?? plan?.trialCreditCents ?? 0 }
  }
  if (sub?.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
    return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd, credit: "mes", creditCents: pricing.creditCents }
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { start, end, credit: "mes", creditCents: pricing.creditCents }
}

const ACTION_COLUMNS = {
  id: saasAction.id,
  kind: saasAction.kind,
  occurredAt: saasAction.occurredAt,
  contactId: saasAction.contactId,
  personName: contact.displayName,
  conversationId: saasAction.conversationId,
  appointmentId: saasAction.appointmentId,
  channel: saasAction.channel,
  detail: saasAction.detail,
  basePriceMicros: saasAction.basePriceMicros,
  priceMicros: saasAction.priceMicros,
  discountBps: saasAction.discountBps,
  chargeId: saasAction.chargeId,
}

const actionsFrom = (tx: Db, where: ReturnType<typeof and>) =>
  tx
    .select(ACTION_COLUMNS)
    .from(saasAction)
    .leftJoin(contact, and(eq(contact.id, saasAction.contactId), eq(contact.organizationId, saasAction.organizationId)))
    .where(where)
    .orderBy(asc(saasAction.occurredAt), asc(saasAction.id))

/**
 * Las acciones de un tramo con su estado: del saldo de prueba o del crédito
 * hasta agotarlo, después por encima del crédito; la cita cuya asistencia se
 * deshizo queda anulada. Una sola definición para la pantalla y el cobro.
 *
 * La conversación que llevó a una cita recuperada va dentro de ella aunque la
 * cita se cuente en otro tramo: mientras esa cita sigue en pie, la
 * conversación queda «esperando» (no se cobra ni gasta crédito); si la persona
 * asiste, va dentro de la cita; si la cita no se da, se cobra en el primer
 * tramo que se cierre después, como una conversación más.
 */
export async function listPeriodActions(
  tx: Db,
  orgId: string,
  period: SaasPeriod & { creditCents: number },
): Promise<SaasActionRow[]> {
  const own = await actionsFrom(
    tx,
    and(eq(saasAction.organizationId, orgId), gte(saasAction.occurredAt, period.start), lt(saasAction.occurredAt, period.end)),
  )
  const carried = period.credit === "mes" ? await heldConversations(tx, orgId, period.start) : []
  const rows = [...carried, ...own]
  const windows = await recoveryWindows(tx, orgId, rows)
  const within = (row: (typeof rows)[number], state: RecoveryWindow["state"]) =>
    row.kind === "conversacion" &&
    windows.some(
      (window) =>
        window.state === state && window.contactId === row.contactId && row.occurredAt >= window.from && row.occurredAt <= window.to,
    )
  const attended = new Set(windows.filter((window) => window.state === "contada").map((window) => window.appointmentId))
  let usedMicros = 0
  const creditMicros = period.creditCents * 10_000
  const result = rows.map((row) => {
    let state: SaasActionState
    if (row.kind === "cita" && row.appointmentId && !attended.has(row.appointmentId)) state = "anulada"
    else if (within(row, "contada")) state = "dentro_de_cita"
    else if (within(row, "en_pie")) state = "esperando"
    else if (row.priceMicros === null) state = "sin_precio"
    else {
      usedMicros += row.priceMicros
      state = period.credit === "prueba" ? "prueba" : usedMicros <= creditMicros ? "credito" : "sobre_credito"
    }
    return { ...row, kind: row.kind as SaasActionKind, state }
  })
  // De lo que viene de tramos cerrados solo queda lo que este tramo cobra.
  const carriedIds = new Set(carried.map((row) => row.id))
  return result.filter((row) => !carriedIds.has(row.id) || row.state === "credito" || row.state === "sobre_credito")
}

interface RecoveryWindow {
  appointmentId: string
  contactId: string
  /** Del mensaje del Administrador a la reserva. */
  from: Date
  to: Date
  /** `contada`: la persona asistió y la cita se contó; `en_pie`: reservada y aún sin cerrar. */
  state: "contada" | "en_pie"
}

/**
 * Las ventanas de cita recuperada de estas acciones, de cualquier tramo. Las
 * contadas salen de la acción `cita` con su cita atendida; las que siguen en
 * pie, de la misma regla de la cita recuperada (`recoveredSql`).
 */
async function recoveryWindows(
  tx: Db,
  orgId: string,
  rows: Array<{ kind: string; contactId: string | null; appointmentId: string | null }>,
): Promise<RecoveryWindow[]> {
  const contactIds = [...new Set(rows.filter((row) => row.kind === "conversacion" && row.contactId).map((row) => row.contactId as string))]
  const appointmentIds = rows.filter((row) => row.kind === "cita" && row.appointmentId).map((row) => row.appointmentId as string)
  if (!contactIds.length && !appointmentIds.length) return []
  const list = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `)
  const counted = (await tx.execute(sql`
    select s.appointment_id, s.contact_id, s.window_start, a.created_at
    from saas_action s
    join appointment a on a.id = s.appointment_id and a.organization_id = s.organization_id
    where s.organization_id = ${orgId} and s.kind = 'cita' and a.status = 'atendida'
      and (${contactIds.length ? sql`s.contact_id in (${list(contactIds)})` : sql`false`}
        or ${appointmentIds.length ? sql`s.appointment_id in (${list(appointmentIds)})` : sql`false`})`)) as unknown as Array<{
    appointment_id: string
    contact_id: string
    window_start: Date | string | null
    created_at: Date | string
  }>
  const windows: RecoveryWindow[] = counted.map((row) => ({
    appointmentId: row.appointment_id,
    contactId: row.contact_id,
    from: asDate(row.window_start ?? row.created_at),
    to: asDate(row.created_at),
    state: "contada",
  }))
  if (contactIds.length) {
    const standing = (await tx.execute(
      recoveredSql(orgId, sql`a.status in ('programada', 'confirmada') and pc.contact_id in (${list(contactIds)})`),
    )) as unknown as RecoveredRow[]
    for (const row of standing) {
      windows.push({ appointmentId: row.appointment_id, contactId: row.contact_id, from: asDate(row.sent_at), to: asDate(row.created_at), state: "en_pie" })
    }
  }
  return windows
}

/**
 * Conversaciones con precio de tramos ya cerrados que quedaron sin cobrar.
 * Con el plan activo, lo único que deja una conversación sin cargo al cerrar
 * su tramo es esperar su cita recuperada o ir dentro de ella: se vuelven a
 * mirar en cada tramo hasta que se cobran o la cita las cubre.
 */
async function heldConversations(tx: Db, orgId: string, before: Date) {
  const [sub] = await tx
    .select({ activatedAt: saasSubscription.activatedAt })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  if (!sub?.activatedAt) return []
  const [closed] = await tx
    .select({ until: sql<Date | string | null>`max(${saasCharge.periodEnd})` })
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), like(saasCharge.dedupeKey, "ciclo:%:final")))
  if (!closed?.until) return []
  const until = new Date(Math.min(asDate(closed.until).getTime(), before.getTime()))
  if (until <= sub.activatedAt) return []
  return actionsFrom(
    tx,
    and(
      eq(saasAction.organizationId, orgId),
      eq(saasAction.kind, "conversacion"),
      isNull(saasAction.chargeId),
      isNotNull(saasAction.priceMicros),
      gte(saasAction.occurredAt, sub.activatedAt),
      lt(saasAction.occurredAt, until),
    ),
  )
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
  // Lo anulado, lo que va dentro de una cita y lo que la espera no suman.
  const billable = actions.filter((row) => row.state !== "anulada" && row.state !== "dentro_de_cita" && row.state !== "esperando")
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

/* ---------- Precio mínimo: ningún precio por debajo del doble de su peor costo ---------- */

/**
 * Peor costo medido de cada acción en millonésimas de USD (estudio de precios
 * del 2026-10-15, con los dos modelos y el caso más largo): conversación
 * S/ 0,15, dictado S/ 0,19 y cita S/ 0,16, a 3,75 por dólar. Se actualiza
 * con `eval:month` y el costo real de `ai_usage`.
 */
export const SAAS_WORST_COST_MICROS: Record<SaasActionKind, number> = {
  conversacion: 40_000,
  consulta: 51_000,
  cita: 43_000,
}
/** Cuántas veces su peor costo debe valer como mínimo una acción, al precio más bajo negociable. */
export const SAAS_PRICE_FLOOR_MULTIPLE = 2

export interface ActionPriceCheck {
  kind: SaasActionKind
  baseMicros: number | null
  minimumMicros: number | null
  /** Veces su peor costo, a precio base y al mínimo. */
  baseMultiple: number | null
  minimumMultiple: number | null
  ok: boolean
}

/**
 * Comprobación del plan antes de guardar (tablero O1): cada precio base y su
 * mínimo (el base con el descuento máximo) contra el peor costo. La pantalla
 * la anticipa; el servidor la exige.
 */
export function checkActionPricing(plan: {
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  maxDiscountBps: number
  currency: string
}): ActionPriceCheck[] {
  const bases: Record<SaasActionKind, number | null> = {
    conversacion: plan.conversationMicros,
    consulta: plan.consultationMicros,
    cita: plan.recoveryMicros,
  }
  return (Object.keys(bases) as SaasActionKind[]).map((kind) => {
    const base = bases[kind]
    if (base === null) return { kind, baseMicros: null, minimumMicros: null, baseMultiple: null, minimumMultiple: null, ok: true }
    const minimum = discountedMicros(base, plan.maxDiscountBps)
    const worst = SAAS_WORST_COST_MICROS[kind]
    // El peor costo está en dólares: en otra moneda no hay con qué comparar y no se afirma nada.
    if (plan.currency !== "USD") return { kind, baseMicros: base, minimumMicros: minimum, baseMultiple: null, minimumMultiple: null, ok: true }
    return {
      kind,
      baseMicros: base,
      minimumMicros: minimum,
      baseMultiple: Math.round((base / worst) * 10) / 10,
      minimumMultiple: Math.round((minimum / worst) * 10) / 10,
      ok: minimum >= worst * SAAS_PRICE_FLOOR_MULTIPLE,
    }
  })
}

const KIND_WORDS: Record<SaasActionKind, string> = { conversacion: "La conversación", consulta: "La consulta", cita: "La cita recuperada" }

/** Lanza `SAAS_PRICE_BELOW_FLOOR` si algún precio, al descuento máximo, queda bajo el doble de su peor costo. */
export function assertActionPricingFloor(plan: Parameters<typeof checkActionPricing>[0]): void {
  const failed = checkActionPricing(plan).find((item) => !item.ok)
  if (!failed) return
  throw new ServiceError(
    "SAAS_PRICE_BELOW_FLOOR",
    409,
    `${KIND_WORDS[failed.kind]} quedaría en ${new Intl.NumberFormat("es-PE", { style: "currency", currency: plan.currency, maximumFractionDigits: 3 }).format((failed.minimumMicros ?? 0) / 1_000_000)} con el descuento máximo: menos del doble de su peor costo. Sube el precio o baja el descuento máximo.`,
  )
}

/**
 * ¿Esta persona ya tiene su conversación contada en las últimas 24 horas?
 * Seguir atendiéndola no cuesta otra: al llegar al tope solo se cortan los
 * casos nuevos.
 */
export async function hasOpenConversationAction(tx: Db, orgId: string, contactId: string, now = new Date()): Promise<boolean> {
  const [row] = await tx
    .select({ id: saasAction.id })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.contactId, contactId),
        eq(saasAction.kind, "conversacion"),
        gt(saasAction.occurredAt, new Date(now.getTime() - CONVERSATION_WINDOW_MS)),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * IA que odentIA paga y no se cobra por acción (Administrador, Probar,
 * vectores, transcripción) por clínica y mes: USD 1,62 en el estudio de
 * precios del 2026-10-15. Entra en el margen del peor caso.
 */
export const SAAS_UNBILLED_AI_MICROS = 1_620_000

/**
 * El peor caso de un plan (tablero O1): una clínica que gasta todo su crédito
 * en conversaciones del costo más alto. Margen sobre la cuota a precio base y
 * negociada al mínimo; null si no hay con qué calcularlo.
 */
export function planMarginScenario(plan: {
  priceCents: number
  creditCents: number
  conversationMicros: number | null
  maxDiscountBps: number
  currency: string
}): { atBase: number | null; atMinimum: number | null } {
  if (plan.currency !== "USD" || !plan.conversationMicros || plan.priceCents <= 0) return { atBase: null, atMinimum: null }
  const margin = (price: number) => {
    const conversations = (plan.creditCents * 10_000) / price
    const cost = conversations * SAAS_WORST_COST_MICROS.conversacion + SAAS_UNBILLED_AI_MICROS
    return Math.round((1 - cost / (plan.priceCents * 10_000)) * 100)
  }
  return { atBase: margin(plan.conversationMicros), atMinimum: margin(discountedMicros(plan.conversationMicros, plan.maxDiscountBps)) }
}

/**
 * ¿Lo de este tramo se factura? Sí con el plan activo (o en gracia) y fuera
 * de la demo: el ciclo emite el cargo al cerrar el tramo.
 */
export function isChargingPeriod(status: string, isDemo: boolean): boolean {
  return !isDemo && (status === "activa" || status === "gracia")
}

/** Impuesto que se suma a la factura de odentIA según el país de la clínica. */
export interface SaasTax {
  label: string
  rateBps: number
}

/**
 * Perú: IGV de 18 % (16 % de IGV más 2 % del Impuesto de Promoción
 * Municipal). Otro país entra con su perfil: mientras no esté, la factura se
 * emite sin impuesto y la pantalla no lo menciona.
 */
export const SAAS_TAX_BY_COUNTRY: Record<string, SaasTax> = {
  PE: { label: "IGV", rateBps: 1800 },
}

export async function saasTaxOf(tx: Db, orgId: string): Promise<SaasTax | null> {
  const rows = (await tx.execute(sql`select country_code from org_profile where organization_id = ${orgId} limit 1`)) as unknown as Array<{ country_code: string }>
  const country = rows[0]?.country_code
  return country ? SAAS_TAX_BY_COUNTRY[country] ?? null : null
}

/** Impuesto de un importe sin impuestos, redondeado al centavo. */
export function taxCents(amountCents: number, tax: SaasTax | null): number {
  return tax ? Math.round((amountCents * tax.rateBps) / 10_000) : 0
}
