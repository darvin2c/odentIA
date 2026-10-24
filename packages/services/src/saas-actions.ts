import type { Db } from "@odentia/db"
import { agentProposal } from "@odentia/db/schema/agent"
import { appointment } from "@odentia/db/schema/agenda"
import { user } from "@odentia/db/schema/auth"
import { encounter, encounterDictationSuggestion, patientContact } from "@odentia/db/schema/clinical"
import { channelConnection, contact, conversation } from "@odentia/db/schema/crm"
import {
  type SaasActionKind,
  type SaasActionTier,
  saasAction,
  saasActionReview,
  saasPlan,
  saasSubscription,
} from "@odentia/db/schema/saas-billing"
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm"
import { adminLineOf } from "./admin-lines.js"
import { APPOINTMENT_NOTICE_KEYS } from "./automation-messages.js"
import { ServiceError } from "./errors.js"
import { orgProduct } from "./locale.js"
import { SAAS_TERMS_INITIAL, saasTermsAt } from "./saas-commercial-terms.js"

/* ---------- Lo que hicieron los agentes, por acción (ADR 0031 y 0085) ---------- */

/**
 * Una conversación por persona en la ventana de las condiciones comerciales
 * (`conversationWindowHours`, ADR 0074), aunque escriba diez mensajes o cambie
 * de canal. Vale la que regía al llegar el mensaje.
 */
async function conversationWindowMs(tx: Db, at: Date): Promise<number> {
  return (await saasTermsAt(tx, at)).conversationWindowHours * 60 * 60 * 1000
}
/**
 * Lo que escribe el Administrador y no recupera nada: los recordatorios y los
 * avisos de una cita reservada, movida o cancelada (ADR 0031), y el saldo
 * vencido, que cobra y no trae de vuelta a nadie (ADR 0085). El aviso de un
 * control sí puede recuperar: lo decide si la persona ya tenía su cita.
 */
export const NOT_RECOVERY_KINDS: readonly string[] = ["recordatorio_cita", "cobranza_vencida", ...APPOINTMENT_NOTICE_KEYS]
/**
 * ¿El paciente ya tiene su cita (ADR 0085)? Una cita por venir o un
 * tratamiento aceptado sin terminar: lo que Argos le escriba entonces es
 * servicio, no recuperación; sigue al llegar al presupuesto y no se cobra
 * como cita recuperada (la misma regla de `recoveredSql`, mirada ahora).
 */
export async function patientHasItsAppointment(tx: Db, orgId: string, patientId: string, now: Date): Promise<boolean> {
  const [row] = (await tx.execute(sql`
    select (
      exists (
        select 1 from appointment o
        where o.organization_id = ${orgId} and o.patient_id = ${patientId}
          and o.status in ('programada', 'confirmada') and o.starts_at >= ${now.toISOString()}::timestamptz)
      or exists (
        select 1 from treatment_plan_item i
        where i.organization_id = ${orgId} and i.patient_id = ${patientId}
          and i.decision_status = 'aceptado' and i.completed_at is null
          and i.status not in ('cancelado', 'reemplazado'))
    ) as has`)) as unknown as Array<{ has: boolean }>
  return row?.has === true
}
/** Por dónde reservó el agente: en su conversación o desde su enlace. La que agenda el equipo no cuenta. */
export const AGENT_SOURCES = ["agent", "enlace"]
/** Lo que hizo Sofi en la agenda y cambia el tipo de la conversación a «Gestiona» (ADR 0085). */
export const AGENDA_ACTIONS = ["reservar_cita", "reprogramar_cita", "cancelar_cita"]

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

/** 1 GB de almacenamiento, en bytes (el mismo GB del tope de una tomografía). */
export const STORAGE_GB_BYTES = 1024 ** 3

/** Lo que cobra un tipo de acción, o la acción sin tipo (cita, paquete de preguntas, GB extra). */
export type SaasPriceKey = SaasActionTier | "cita" | "preguntas" | "almacenamiento"

export interface ActionPricing {
  planId: string | null
  currency: string | null
  creditCents: number
  discountBps: number
  maxDiscountBps: number
  /** Precio base de cada acción en el tipo con que se compara (Gestiona, Completa) y de lo que no tiene tipo. */
  base: Record<SaasActionKind, number | null>
  /** Precio base de cada tipo (ADR 0085). */
  prices: Record<SaasPriceKey, number | null>
  /** Lo que no admite descuento negociado: siempre a su precio base. */
  fixed: ReadonlySet<SaasPriceKey>
  argos: { included: number; packQuestions: number }
  storageIncludedGb: number
}

/**
 * Los precios de un plan, por tipo; sin plan, todos null. Un plan sin precio
 * para un tipo cobra ese tipo como antes de la ADR 0085, con el único precio
 * de su acción (y la conversación no sube a «Agenda»).
 */
export function planPrices(plan: typeof saasPlan.$inferSelect | undefined): Record<SaasPriceKey, number | null> {
  return {
    informa: plan?.conversationInformMicros ?? plan?.conversationMicros ?? null,
    gestiona: plan?.conversationMicros ?? null,
    agenda: plan?.conversationAgendaMicros ?? plan?.conversationMicros ?? null,
    simple: plan?.consultationSimpleMicros ?? plan?.consultationMicros ?? null,
    estandar: plan?.consultationStandardMicros ?? plan?.consultationMicros ?? null,
    completa: plan?.consultationMicros ?? null,
    cita: plan?.recoveryMicros ?? null,
    preguntas: plan?.argosPackMicros ?? null,
    almacenamiento: plan?.storageGbMicros ?? null,
  }
}

/**
 * Precios con los que se cuenta hoy en una clínica: los de su plan o, si aún
 * no eligió, los del plan por defecto; con su descuento negociado mientras no
 * haya vencido (issue 168: pasado su último instante se cuenta a precio de
 * lista). Sin plan con precio, las acciones se cuentan sin importe (nunca 0).
 */
export async function getActionPricing(tx: Db, orgId: string, now = new Date()): Promise<ActionPricing> {
  const [sub] = await tx
    .select({
      planId: saasSubscription.planId,
      discountBps: saasSubscription.discountBps,
      discountEndsAt: saasSubscription.discountEndsAt,
    })
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
  const prices = planPrices(plan)
  return {
    planId: plan?.id ?? null,
    currency: plan?.currency ?? null,
    creditCents: plan?.creditCents ?? 0,
    discountBps: Math.min(activeDiscountBps(sub ?? null, now), plan?.maxDiscountBps ?? 0),
    maxDiscountBps: plan?.maxDiscountBps ?? 0,
    base: {
      conversacion: prices.gestiona,
      consulta: prices.completa,
      cita: prices.cita,
      preguntas: prices.preguntas,
      almacenamiento: prices.almacenamiento,
    },
    prices,
    fixed: new Set((plan?.fixedPriceTiers ?? []) as SaasPriceKey[]),
    argos: { included: plan?.argosIncludedQuestions ?? 0, packQuestions: plan?.argosPackQuestions ?? 100 },
    storageIncludedGb: plan?.storageIncludedGb ?? 0,
  }
}

/** El descuento negociado que rige en `now`: el de la clínica hasta su vencimiento; después, ninguno. */
export function activeDiscountBps(
  sub: { discountBps: number; discountEndsAt: Date | null } | null,
  now: Date,
): number {
  if (!sub) return 0
  if (sub.discountEndsAt && sub.discountEndsAt.getTime() <= now.getTime()) return 0
  return sub.discountBps
}

/** Precio con descuento, redondeado a la millonésima. */
export function discountedMicros(baseMicros: number, discountBps: number): number {
  return Math.round((baseMicros * (10_000 - discountBps)) / 10_000)
}

/** Precio base, propio y descuento de una acción de ese tipo; lo fijo no se negocia (ADR 0085). */
export function priceFor(
  pricing: Pick<ActionPricing, "prices" | "fixed" | "discountBps">,
  key: SaasPriceKey,
  units = 1,
): { basePriceMicros: number | null; priceMicros: number | null; discountBps: number } {
  const unit = pricing.prices[key]
  if (unit === null) return { basePriceMicros: null, priceMicros: null, discountBps: 0 }
  const discount = pricing.fixed.has(key) ? 0 : pricing.discountBps
  const base = unit * units
  return { basePriceMicros: base, priceMicros: discountedMicros(base, discount), discountBps: discount }
}

/**
 * Lo que se cobra cuando la cita que reservó Sofi se da (ADR 0085): la
 * diferencia de «Gestiona» a «Agenda», con el descuento si se negocia. Null
 * si el plan no tiene uno de los dos precios.
 */
export function agendaUpgradePrice(
  pricing: Pick<ActionPricing, "prices" | "fixed" | "discountBps">,
): { basePriceMicros: number | null; priceMicros: number | null; discountBps: number } {
  const agenda = pricing.prices.agenda
  const gestiona = pricing.prices.gestiona
  if (agenda === null || gestiona === null) return { basePriceMicros: null, priceMicros: null, discountBps: 0 }
  const diff = agenda - gestiona
  const discount = pricing.fixed.has("agenda") ? 0 : pricing.discountBps
  return { basePriceMicros: diff, priceMicros: discountedMicros(diff, discount), discountBps: discount }
}

/** La clave de precio de una acción: su tipo, o la acción si no tiene. */
const priceKeyOf = (kind: SaasActionKind, tier: SaasActionTier | null): SaasPriceKey =>
  tier ?? (kind === "conversacion" ? "gestiona" : kind === "consulta" ? "completa" : kind)

export async function insertAction(
  tx: Db,
  orgId: string,
  kind: SaasActionKind,
  values: Omit<typeof saasAction.$inferInsert, "organizationId" | "kind" | "basePriceMicros" | "priceMicros" | "discountBps" | "currency">,
  pricing?: ActionPricing,
): Promise<boolean> {
  const own = pricing ?? (await getActionPricing(tx, orgId))
  const [row] = await tx
    .insert(saasAction)
    .values({
      ...values,
      organizationId: orgId,
      kind,
      currency: own.currency,
      // El GB extra se cobra por cada GB; el paquete de preguntas, por paquete.
      ...priceFor(own, priceKeyOf(kind, (values.tier as SaasActionTier | null | undefined) ?? null), kind === "almacenamiento" ? (values.units ?? 1) : 1),
    })
    .onConflictDoNothing({ target: [saasAction.organizationId, saasAction.dedupeKey] })
    .returning({ id: saasAction.id })
  return Boolean(row)
}

/* ---------- Sofi: según lo que pasó en la agenda (ADR 0085) ---------- */

/**
 * Quién conversó por cada cita: la persona de su conversación, quien abrió el
 * enlace y el propio paciente. La madre que reserva para su hijo es quien
 * conversó, no el hijo.
 */
async function appointmentBookers(tx: Db, orgId: string, appointmentIds: string[]): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>()
  if (!appointmentIds.length) return result
  const rows = (await tx.execute(sql`
    select a.id as appointment_id, b.contact_id
    from appointment a
    cross join lateral (
      select cv.contact_id from conversation cv where cv.organization_id = a.organization_id and cv.id = a.conversation_id
      union
      select l.contact_id from appointment_booking_link l where l.organization_id = a.organization_id and l.appointment_id = a.id
      union
      select pc.contact_id from patient_contact pc
      where pc.organization_id = a.organization_id and pc.patient_id = a.patient_id and pc.relationship = 'self'
    ) b
    where a.organization_id = ${orgId}
      and a.id in (${sql.join(appointmentIds.map((id) => sql`${id}`), sql`, `)})`)) as unknown as Array<{ appointment_id: string; contact_id: string }>
  for (const row of rows) {
    const set = result.get(row.appointment_id) ?? new Set<string>()
    set.add(row.contact_id)
    result.set(row.appointment_id, set)
  }
  return result
}

export const SOFI_DETAIL: Record<"informa" | "gestiona", string> = {
  informa: "Atendió una conversación",
  gestiona: "Atendió una conversación y gestionó una cita",
}

/**
 * El tipo de la conversación de una persona en su ventana: «Gestiona» si Sofi
 * reservó, movió o canceló una cita (sus propuestas ejecutadas) o la persona
 * reservó desde el enlace; si no, «Informa». Una cita que mueve el equipo no
 * cuenta como trabajo de Sofi.
 */
export async function conversationTierOf(
  tx: Db,
  orgId: string,
  input: { contactId: string; from: Date; to: Date },
): Promise<"informa" | "gestiona"> {
  const [proposal] = await tx
    .select({ id: agentProposal.id })
    .from(agentProposal)
    .where(
      and(
        eq(agentProposal.organizationId, orgId),
        eq(agentProposal.contactId, input.contactId),
        eq(agentProposal.status, "ejecutada"),
        inArray(agentProposal.action, AGENDA_ACTIONS),
        gte(agentProposal.executedAt, input.from),
        lt(agentProposal.executedAt, input.to),
      ),
    )
    .limit(1)
  if (proposal) return "gestiona"
  const links = await tx
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        eq(appointment.source, "enlace"),
        gte(appointment.createdAt, input.from),
        lt(appointment.createdAt, input.to),
      ),
    )
  // Reservó desde el enlace quien conversó: la propia persona o quien habla por ella.
  const bookers = await appointmentBookers(tx, orgId, links.map((row) => row.id))
  return [...bookers.values()].some((contacts) => contacts.has(input.contactId)) ? "gestiona" : "informa"
}

/**
 * Sube de tipo la conversación de esa persona cuya ventana contiene `at`, si
 * aún no se cobró: lo cobrado no se reescribe (lo impide la base).
 */
export async function refreshConversationTier(tx: Db, orgId: string, input: { contactId: string; at: Date }): Promise<void> {
  const windowMs = await conversationWindowMs(tx, input.at)
  const [row] = await tx
    .select({ id: saasAction.id, tier: saasAction.tier, occurredAt: saasAction.occurredAt, channel: saasAction.channel })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.contactId, input.contactId),
        eq(saasAction.kind, "conversacion"),
        inArray(saasAction.tier, ["informa", "gestiona"]),
        lte(saasAction.occurredAt, input.at),
        gt(saasAction.occurredAt, new Date(input.at.getTime() - windowMs)),
        isNull(saasAction.chargeId),
      ),
    )
    .orderBy(asc(saasAction.occurredAt))
    .limit(1)
  if (!row || row.tier === "gestiona") return
  const tier = await conversationTierOf(tx, orgId, {
    contactId: input.contactId,
    from: row.occurredAt,
    to: new Date(row.occurredAt.getTime() + windowMs),
  })
  if (tier === row.tier) return
  const pricing = await getActionPricing(tx, orgId)
  await tx
    .update(saasAction)
    .set({
      tier,
      detail: `${SOFI_DETAIL[tier]} por ${CHANNEL_NAME[row.channel ?? ""] ?? row.channel ?? "un canal"}`,
      ...priceFor(pricing, tier),
    })
    .where(and(eq(saasAction.organizationId, orgId), eq(saasAction.id, row.id), isNull(saasAction.chargeId)))
}

/**
 * Recepción atendió con IA (la corrida respondió y llamó al modelo): una
 * conversación por persona en la ventana de las condiciones (24 horas al
 * empezar), con el tipo de lo que pasó en la agenda (ADR 0085). No cuentan lo
 * que respondió el equipo, la derivación sin IA, el texto fijo ni la corrida
 * que falló: quien llama solo lo pide con una corrida `ok` que llamó al
 * modelo. Una corrida siguiente de la misma ventana sube su tipo.
 */
export async function countConversationAction(tx: Db, orgId: string, input: { conversationId: string; at: Date }): Promise<boolean> {
  const [conv] = await tx
    .select({ contactId: conversation.contactId, channel: channelConnection.channel, isTest: conversation.isTest })
    .from(conversation)
    .innerJoin(channelConnection, eq(channelConnection.id, conversation.channelConnectionId))
    .where(and(eq(conversation.organizationId, orgId), eq(conversation.id, input.conversationId)))
    .limit(1)
  // La prueba del chat web desde Configuración no se cobra (fase 6 del pulido).
  if (!conv || conv.isTest) return false
  // Dos corridas a la vez de la misma persona (dos canales) no cuentan dos.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`saas-action:${orgId}:${conv.contactId}`}, 0))`)
  const windowMs = await conversationWindowMs(tx, input.at)
  const [recent] = await tx
    .select({ id: saasAction.id })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        eq(saasAction.contactId, conv.contactId),
        eq(saasAction.kind, "conversacion"),
        inArray(saasAction.tier, ["informa", "gestiona"]),
        gt(saasAction.occurredAt, new Date(input.at.getTime() - windowMs)),
      ),
    )
    .limit(1)
  if (recent) {
    await refreshConversationTier(tx, orgId, { contactId: conv.contactId, at: input.at })
    return false
  }
  const tier = await conversationTierOf(tx, orgId, {
    contactId: conv.contactId,
    from: input.at,
    to: new Date(input.at.getTime() + windowMs),
  })
  return insertAction(tx, orgId, "conversacion", {
    tier,
    occurredAt: input.at,
    contactId: conv.contactId,
    conversationId: input.conversationId,
    channel: conv.channel,
    detail: `${SOFI_DETAIL[tier]} por ${CHANNEL_NAME[conv.channel] ?? conv.channel}`,
    dedupeKey: `conversacion:${conv.contactId}:${input.at.toISOString()}`,
  })
}

/**
 * La cita que reservó Sofi se dio (ADR 0085): la conversación sube de
 * «Gestiona» a «Agenda» con una fila aparte por la diferencia, una sola vez.
 * No pasa si la cita ya se cobró como recuperada: nunca se cobra doble.
 * Si la persona no tiene una conversación cobrada que la reservó, no hay nada
 * que subir.
 */
export async function countAgendaUpgrade(tx: Db, orgId: string, appointmentId: string, at: Date): Promise<boolean> {
  const [appt] = await tx
    .select({ id: appointment.id, source: appointment.source, createdAt: appointment.createdAt, patientId: appointment.patientId })
    .from(appointment)
    .where(and(eq(appointment.organizationId, orgId), eq(appointment.id, appointmentId)))
    .limit(1)
  if (!appt || !AGENT_SOURCES.includes(appt.source ?? "")) return false
  const [recovered] = await tx
    .select({ id: saasAction.id })
    .from(saasAction)
    .where(and(eq(saasAction.organizationId, orgId), eq(saasAction.kind, "cita"), eq(saasAction.appointmentId, appointmentId)))
    .limit(1)
  if (recovered) return false
  // La conversación que la reservó es de quien conversó: la madre que reservó para su hijo, no el hijo.
  const bookers = [...((await appointmentBookers(tx, orgId, [appointmentId])).get(appointmentId) ?? [])]
  if (!bookers.length) return false
  const windowMs = await conversationWindowMs(tx, appt.createdAt)
  const [booking] = await tx
    .select({ id: saasAction.id, contactId: saasAction.contactId, conversationId: saasAction.conversationId, channel: saasAction.channel, discountBps: saasAction.discountBps })
    .from(saasAction)
    .where(
      and(
        eq(saasAction.organizationId, orgId),
        inArray(saasAction.contactId, bookers),
        eq(saasAction.kind, "conversacion"),
        eq(saasAction.tier, "gestiona"),
        lte(saasAction.occurredAt, appt.createdAt),
        gt(saasAction.occurredAt, new Date(appt.createdAt.getTime() - windowMs)),
      ),
    )
    .orderBy(asc(saasAction.occurredAt))
    .limit(1)
  if (!booking) return false
  const pricing = await getActionPricing(tx, orgId)
  const upgrade = agendaUpgradePrice(pricing)
  // Sin diferencia (un plan con un solo precio) no hay nada que subir.
  if (upgrade.basePriceMicros !== null && upgrade.basePriceMicros <= 0) return false
  const [row] = await tx
    .insert(saasAction)
    .values({
      organizationId: orgId,
      kind: "conversacion",
      tier: "agenda",
      occurredAt: at,
      contactId: booking.contactId,
      conversationId: booking.conversationId,
      appointmentId,
      channel: booking.channel,
      detail: "Vino a la cita que reservó Sofi: sube de Gestiona a Agenda",
      currency: pricing.currency,
      ...upgrade,
      dedupeKey: `agenda:${appointmentId}`,
    })
    .onConflictDoNothing({ target: [saasAction.organizationId, saasAction.dedupeKey] })
    .returning({ id: saasAction.id })
  return Boolean(row)
}

/* ---------- Clío: según lo que dejó hecho (ADR 0085) ---------- */

/**
 * El tipo de una atención por lo que Clío dejó hecho y el profesional
 * confirmó: «Completa» si armó un presupuesto (una indicación del plan);
 * «Estándar» con un diagnóstico, el odontograma (en latidIA, el examen
 * físico) o dos bloques o más; «Simple» con un solo bloque (receta, nota,
 * control o, en latidIA, los signos vitales).
 */
export function consultationTierOf(kinds: ReadonlySet<string>): "simple" | "estandar" | "completa" {
  if (kinds.has("plan")) return "completa"
  if (kinds.has("diagnostico") || kinds.has("odontograma") || kinds.has("examen") || kinds.size > 1) return "estandar"
  return "simple"
}

export const CLIO_DETAIL: Record<"simple" | "estandar" | "completa", string> = {
  simple: "Dejó lista una cosa de la consulta dictada",
  estandar: "Ordenó la consulta dictada",
  completa: "Ordenó la consulta dictada y armó el presupuesto",
}

/** En latidIA, «Completa» es dejar indicado lo que sigue: un consultorio no arma presupuestos (issue 229). */
const CLIO_DETAIL_MEDICAL: Partial<typeof CLIO_DETAIL> = {
  completa: "Ordenó la consulta dictada y dejó indicado lo que sigue",
}

/**
 * El Asistente clínico ordenó lo dictado y el odontólogo lo confirmó: una
 * consulta por atención, al cerrarla, con el tipo de lo que dejó hecho. Sin
 * sugerencias confirmadas no cuenta (el borrador descartado no se cobra).
 */
export async function countConsultationAction(
  tx: Db,
  orgId: string,
  input: { patientId: string; encounterId: string; at: Date },
): Promise<boolean> {
  const confirmed = await tx
    .selectDistinct({ kind: encounterDictationSuggestion.kind })
    .from(encounterDictationSuggestion)
    .where(
      and(
        eq(encounterDictationSuggestion.organizationId, orgId),
        eq(encounterDictationSuggestion.patientId, input.patientId),
        eq(encounterDictationSuggestion.encounterId, input.encounterId),
        eq(encounterDictationSuggestion.status, "confirmada"),
      ),
    )
  if (!confirmed.length) return false
  const tier = consultationTierOf(new Set(confirmed.map((row) => row.kind)))
  const [row] = await tx
    .select({ professional: user.name })
    .from(encounter)
    .leftJoin(user, eq(user.id, encounter.professionalUserId))
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
  const did = ((await orgProduct(tx, orgId)) === "medical" && CLIO_DETAIL_MEDICAL[tier]) || CLIO_DETAIL[tier]
  return insertAction(tx, orgId, "consulta", {
    tier,
    occurredAt: input.at,
    contactId: self?.contactId ?? null,
    encounterId: input.encounterId,
    detail: row?.professional ? `${did} por ${row.professional}` : did,
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
 * su conversación o desde su enlace) dentro de los días siguientes a un
 * mensaje del Administrador a esa persona que no fue un recordatorio, un
 * aviso de cita ni el saldo vencido. Los días son los de las condiciones que
 * regían al reservar (`recovery_window_days`, ADR 0074): una reserva hecha
 * conserva su plazo. Mira la cita creada después del mensaje: la que Sofi
 * mueve tras un «No podré ir» no es nueva y no cuenta (ADR 0031). Y lo decide
 * si la persona ya tenía su cita (ADR 0085): no cuenta si, cuando Argos le
 * escribió, tenía otra cita por venir o un tratamiento aceptado sin terminar.
 */
function recoveredSql(orgId: string, where: ReturnType<typeof sql>) {
  return sql`
    select a.id as appointment_id, a.status, a.source, a.created_at, a.starts_at, a.conversation_id,
           coalesce(j.contact_id, pc.contact_id) as contact_id, j.kind as line_kind, j.sent_at
    from appointment a
    join patient_contact pc
      on pc.organization_id = a.organization_id and pc.patient_id = a.patient_id and pc.relationship = 'self'
    join lateral (
      select j.kind, j.contact_id, coalesce(m.created_at, j.updated_at) as sent_at
      from automation_job j
      left join message m on m.id = j.sent_message_id and m.organization_id = j.organization_id
      where j.organization_id = a.organization_id
        -- A la persona o a quien habla por ella: Argos escribe a su contacto preferido (la madre de un niño).
        and (j.contact_id = pc.contact_id or j.patient_id = a.patient_id)
        and j.status = 'enviado'
        and j.kind not in (${sql.join(NOT_RECOVERY_KINDS.map((kind) => sql`${kind}`), sql`, `)})
        and coalesce(m.created_at, j.updated_at) <= a.created_at
        and coalesce(m.created_at, j.updated_at) > a.created_at - make_interval(days => coalesce((
          select t.recovery_window_days from saas_commercial_terms t
          where t.effective_from <= a.created_at order by t.effective_from desc limit 1), ${SAAS_TERMS_INITIAL.recoveryWindowDays}))
        and not exists (
          select 1 from appointment o
          where o.organization_id = a.organization_id and o.patient_id = a.patient_id and o.id <> a.id
            and o.created_at <= coalesce(m.created_at, j.updated_at) and o.starts_at > coalesce(m.created_at, j.updated_at)
            and o.status <> 'cancelada')
        and not exists (
          select 1 from treatment_plan_item i
          where i.organization_id = a.organization_id and i.patient_id = a.patient_id
            and i.decision_status = 'aceptado' and i.decided_at <= coalesce(m.created_at, j.updated_at)
            and (i.completed_at is null or i.completed_at > coalesce(m.created_at, j.updated_at))
            and i.status not in ('cancelado', 'reemplazado'))
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
  return line ? `Volvió tras «${line}» y ${how}` : `Volvió tras un mensaje de Argos y ${how}`
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

/** `devuelta`: odentIA la devolvió al revisarla antes de cobrarla (ADR 0054); no se cobra. */
export type SaasActionState = "prueba" | "credito" | "sobre_credito" | "dentro_de_cita" | "esperando" | "sin_precio" | "anulada" | "devuelta"

/** La revisión que pidió la clínica sobre una fila (ADR 0054). */
export interface SaasReviewView {
  id: string
  status: "pendiente" | "devuelta" | "mantenida"
  reason: string
  /** Se devolvió sola (spam dentro del tope). */
  automatic: boolean
  requestedAt: Date
  /** Lo que odentIA le dijo a la clínica al decidir. */
  answer: string | null
  decidedAt: Date | null
  /** Ya cobrada y devuelta en un cargo siguiente. */
  credited: boolean
  /** Quien la pidió (o marcó «Es spam»). */
  byName: string | null
  /** El caso de Soporte donde la sigue la clínica; nulo si se devolvió sola. */
  caseId: string | null
  /**
   * Devuelta después de cobrarse, pero la cubrió el crédito (o la prueba):
   * la clínica no pagó nada aparte por ella, así que no hay importe que devolver.
   */
  coveredByCredit: boolean
}

export interface SaasActionRow {
  id: string
  kind: SaasActionKind
  /** Su tipo (ADR 0085); null en la cita recuperada, las preguntas y el almacenamiento. */
  tier: SaasActionTier | null
  /** Preguntas del paquete o GB extra; null en lo demás. */
  units: number | null
  occurredAt: Date
  contactId: string | null
  personName: string | null
  conversationId: string | null
  /** La atención de una consulta dictada. */
  encounterId: string | null
  appointmentId: string | null
  channel: string | null
  detail: string
  basePriceMicros: number | null
  priceMicros: number | null
  discountBps: number
  state: SaasActionState
  chargeId: string | null
  /** De una cita recuperada: las conversaciones que llevaron a ella y ya se cobraron; se devuelven con la cita. */
  refunds: SaasRefund[]
  /** La revisión que pidió la clínica, si pidió (ADR 0054). */
  review: SaasReviewView | null
  /**
   * De la acción con que se pasó del crédito, la parte que el crédito cubrió:
   * se cobra solo lo que pasó (el crédito vuelve íntegro, ADR 0031). 0 en las demás.
   */
  creditPartMicros?: number
}

export interface SaasRefund {
  actionId: string
  occurredAt: Date
  basePriceMicros: number
  priceMicros: number
}

/** Lo que cuesta una acción en su tramo: la cita, menos lo que devuelve. */
export const netMicros = (row: Pick<SaasActionRow, "priceMicros" | "refunds">): number =>
  Math.max(0, (row.priceMicros ?? 0) - row.refunds.reduce((sum, refund) => sum + refund.priceMicros, 0))

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
  const pricing = await getActionPricing(tx, orgId, now)
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

/**
 * Las acciones de un tramo con su estado: del saldo de prueba o del crédito
 * hasta agotarlo, después por encima del crédito; la cita cuya asistencia se
 * deshizo queda anulada. Una sola definición para la pantalla y el cobro.
 *
 * La conversación que llevó a una cita recuperada se cobra en su tramo, como
 * cualquiera; si la persona asiste, la cita la devuelve (`refunds`) y cuesta
 * su precio menos esa conversación. Si aún no se cobró cuando se cuenta la
 * cita (el mismo tramo), va dentro de ella y no se cobra.
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
      tier: saasAction.tier,
      units: saasAction.units,
      occurredAt: saasAction.occurredAt,
      contactId: saasAction.contactId,
      personName: contact.displayName,
      conversationId: saasAction.conversationId,
      encounterId: saasAction.encounterId,
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
  // La cita recuperada y la subida a «Agenda» existen mientras el paciente asistió: si se deshace, se anulan.
  const needsVisit = (row: (typeof rows)[number]) => row.kind === "cita" || (row.kind === "conversacion" && row.tier === "agenda")
  const appointmentIds = rows.filter((row) => needsVisit(row) && row.appointmentId).map((row) => row.appointmentId as string)
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
    row.tier !== "agenda" &&
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
  const refunds = await refundsOf(
    tx,
    orgId,
    rows.filter((row) => row.kind === "cita" && row.appointmentId !== null && attended.has(row.appointmentId)),
  )
  const reviews = await reviewsOf(tx, orgId, rows.map((row) => row.id))
  let usedMicros = 0
  const creditMicros = period.creditCents * 10_000
  return rows.map((row) => {
    let state: SaasActionState
    let creditPartMicros = 0
    const own = refunds.get(row.id) ?? []
    const review = reviews.get(row.id) ?? null
    if (needsVisit(row) && row.appointmentId && !attended.has(row.appointmentId)) state = "anulada"
    // Devuelta antes de cobrarse: no gasta crédito ni se cobra (ADR 0054). Ya cobrada, la devuelve el cargo siguiente.
    else if (row.chargeId === null && review?.status === "devuelta") state = "devuelta"
    // La que aún no se cobró va dentro de la cita; la ya cobrada se devuelve con ella.
    else if (row.chargeId === null && insideCita(row)) state = "dentro_de_cita"
    else if (row.priceMicros === null) state = "sin_precio"
    else {
      const before = usedMicros
      usedMicros += netMicros({ priceMicros: row.priceMicros, refunds: own })
      state = period.credit === "prueba" ? "prueba" : usedMicros <= creditMicros ? "credito" : "sobre_credito"
      // La que cruza el crédito usa lo que quedaba de él: se cobra solo lo que pasó.
      if (state === "sobre_credito" && before < creditMicros) creditPartMicros = creditMicros - before
    }
    return {
      refunds: state === "anulada" ? [] : own,
      id: row.id,
      kind: row.kind as SaasActionKind,
      tier: (row.tier as SaasActionTier | null) ?? null,
      units: row.units,
      occurredAt: row.occurredAt,
      contactId: row.contactId,
      personName: row.personName,
      conversationId: row.conversationId,
      encounterId: row.encounterId,
      appointmentId: row.appointmentId,
      channel: row.channel,
      detail: row.detail,
      basePriceMicros: row.basePriceMicros,
      priceMicros: row.priceMicros,
      discountBps: row.discountBps,
      state,
      chargeId: row.chargeId,
      ...(creditPartMicros > 0 ? { creditPartMicros } : {}),
      review:
        review && review.status === "devuelta" && row.chargeId !== null
          ? { ...review, coveredByCredit: state === "credito" || state === "prueba" }
          : review,
    }
  })
}

/**
 * Las conversaciones «Gestiona» cuya cita, reservada por Sofi en su ventana,
 * aún no se da (tablero C2): si la persona viene, suben a «Agenda». Por fila,
 * lo que sumaría (null si el plan no tiene los dos precios).
 */
export async function agendaPendingOf(tx: Db, orgId: string, rows: SaasActionRow[]): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>()
  const candidates = rows.filter((row) => row.kind === "conversacion" && row.tier === "gestiona" && row.contactId)
  if (!candidates.length) return result
  const upgrade = agendaUpgradePrice(await getActionPricing(tx, orgId)).priceMicros
  // Sin diferencia (un plan con un solo precio) no hay nada que subir, como en `countAgendaUpgrade`.
  if (upgrade !== null && upgrade <= 0) return result
  const windowMs = await conversationWindowMs(tx, new Date())
  const firstFrom = Math.min(...candidates.map((row) => row.occurredAt.getTime()))
  const lastTo = Math.max(...candidates.map((row) => row.occurredAt.getTime())) + windowMs
  const upcoming = await tx
    .select({ id: appointment.id, createdAt: appointment.createdAt })
    .from(appointment)
    .where(
      and(
        eq(appointment.organizationId, orgId),
        inArray(appointment.source, AGENT_SOURCES),
        inArray(appointment.status, ["programada", "confirmada"]),
        gt(appointment.startsAt, new Date()),
        gte(appointment.createdAt, new Date(firstFrom)),
        lt(appointment.createdAt, new Date(lastTo)),
      ),
    )
  if (!upcoming.length) return result
  // La que se cobrará como cita recuperada no sube a «Agenda»: la conversación va dentro de ella.
  const ids = upcoming.map((row) => row.id)
  const recovering = new Set(
    ((await tx.execute(recoveredSql(orgId, sql`a.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`))) as unknown as RecoveredRow[]).map((row) => row.appointment_id),
  )
  const bookers = await appointmentBookers(tx, orgId, ids)
  for (const row of candidates) {
    const from = row.occurredAt.getTime()
    const booked = upcoming.some(
      (item) =>
        !recovering.has(item.id) &&
        bookers.get(item.id)?.has(row.contactId as string) &&
        item.createdAt.getTime() >= from &&
        item.createdAt.getTime() < from + windowMs,
    )
    if (booked) result.set(row.id, upgrade)
  }
  return result
}

/** Las revisiones de estas acciones, por acción. */
export async function reviewsOf(tx: Db, orgId: string, actionIds: string[]): Promise<Map<string, SaasReviewView>> {
  const result = new Map<string, SaasReviewView>()
  if (!actionIds.length) return result
  const rows = await tx
    .select({ review: saasActionReview, byName: user.name })
    .from(saasActionReview)
    .leftJoin(user, eq(user.id, saasActionReview.requestedByUserId))
    .where(and(eq(saasActionReview.organizationId, orgId), inArray(saasActionReview.actionId, actionIds)))
  for (const { review: row, byName } of rows) {
    result.set(row.actionId, {
      id: row.id,
      status: row.status as SaasReviewView["status"],
      reason: row.reason,
      automatic: row.automatic,
      requestedAt: row.requestedAt,
      answer: row.answer,
      decidedAt: row.decidedAt,
      credited: row.creditChargeId !== null,
      byName,
      caseId: row.supportCaseId,
      coveredByCredit: false,
    })
  }
  return result
}

/**
 * Las conversaciones ya cobradas que llevaron a cada una de estas citas
 * recuperadas (atendidas): de esa persona, entre el mensaje del Administrador
 * y la reserva, en cualquier tramo. Si dos citas cubren la misma
 * conversación, la devuelve la primera que se contó: nunca dos veces.
 */
async function refundsOf(
  tx: Db,
  orgId: string,
  citas: Array<{ id: string; contactId: string | null; chargeId: string | null }>,
): Promise<Map<string, SaasRefund[]>> {
  const result = new Map<string, SaasRefund[]>()
  const contactIds = [...new Set(citas.map((cita) => cita.contactId).filter((id): id is string => id !== null))]
  if (!contactIds.length) return result
  const found = (await tx.execute(sql`
    with cita as (
      select s.id, s.contact_id, s.window_start, a.created_at as booked_at, s.occurred_at
      from saas_action s
      join appointment a on a.id = s.appointment_id and a.organization_id = s.organization_id
      where s.organization_id = ${orgId} and s.kind = 'cita' and a.status = 'atendida' and s.window_start is not null
        and s.contact_id in (${sql.join(contactIds.map((id) => sql`${id}`), sql`, `)})
    )
    select v.id, v.occurred_at, v.base_price_micros, v.price_micros, v.charge_id,
      (select cita.id from cita
        where cita.contact_id = v.contact_id and v.occurred_at >= cita.window_start and v.occurred_at <= cita.booked_at
        order by cita.occurred_at, cita.id limit 1) as cita_id
    from saas_action v
    where v.organization_id = ${orgId} and v.kind = 'conversacion' and v.tier <> 'agenda' and v.charge_id is not null and v.price_micros is not null
      and v.contact_id in (${sql.join(contactIds.map((id) => sql`${id}`), sql`, `)})
    order by v.occurred_at, v.id`)) as unknown as Array<{
    id: string
    occurred_at: Date | string
    base_price_micros: string | number | null
    price_micros: string | number
    charge_id: string
    cita_id: string | null
  }>
  const chargeOf = new Map(citas.map((cita) => [cita.id, cita.chargeId]))
  for (const row of found) {
    if (!row.cita_id || !chargeOf.has(row.cita_id)) continue
    // Cobrada en el mismo cargo que su cita no pasa: lo que se cobra junto ya va dentro.
    if (chargeOf.get(row.cita_id) === row.charge_id) continue
    const list = result.get(row.cita_id) ?? []
    list.push({
      actionId: row.id,
      occurredAt: asDate(row.occurred_at),
      basePriceMicros: Number(row.base_price_micros ?? row.price_micros),
      priceMicros: Number(row.price_micros),
    })
    result.set(row.cita_id, list)
  }
  return result
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
    tier: null,
    units: null,
    occurredAt: asDate(row.created_at),
    contactId: row.contact_id,
    personName: nameOf.get(row.contact_id) ?? null,
    conversationId: row.conversation_id,
    encounterId: null,
    appointmentId: row.appointment_id,
    channel: row.source,
    detail: recoveryDetail(row),
    basePriceMicros: base,
    priceMicros: base === null ? null : discountedMicros(base, pricing.discountBps),
    discountBps: base === null ? 0 : pricing.discountBps,
    state: "esperando",
    chargeId: null,
    refunds: [],
    review: null,
  }))
}

export interface SaasConsumptionTier {
  tier: SaasActionTier
  count: number
  basePriceMicros: number | null
  priceMicros: number | null
  amountCents: number
}

export interface SaasConsumptionLine {
  kind: SaasActionKind
  count: number
  /** Preguntas sumadas o GB extra: las unidades de lo que no se cuenta por acción. */
  units: number
  basePriceMicros: number | null
  priceMicros: number | null
  amountCents: number
  baseAmountCents: number
  /** Por tipo (ADR 0085): Sofi y Clío; vacío en lo demás. */
  tiers: SaasConsumptionTier[]
}

/** Los tipos de cada acción, en el orden en que se muestran. */
export const SAAS_TIERS_OF: Partial<Record<SaasActionKind, SaasActionTier[]>> = {
  conversacion: ["informa", "gestiona", "agenda"],
  consulta: ["simple", "estandar", "completa"],
}

/** Lo que se cobra, en el orden de la factura. */
export const SAAS_BILLED_KINDS: SaasActionKind[] = ["conversacion", "consulta", "cita", "preguntas", "almacenamiento"]

export interface SaasConsumption {
  period: { start: Date; end: Date; credit: "prueba" | "mes" }
  currency: string | null
  /** false: el plan aún no tiene precios por acción; se cuenta sin importes. */
  priced: boolean
  discountBps: number
  lines: SaasConsumptionLine[]
  /** Conversaciones ya cobradas que devuelven las citas recuperadas del tramo (restadas de la línea de la cita). */
  refunds: { count: number; amountCents: number }
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
  /**
   * El presupuesto del mes (ADR 0085): lo que va por encima del crédito, sin
   * el almacenamiento (guardar nunca detiene a un agente), frente al que fijó
   * la clínica. `after`: lo que se cobró después de llegar, porque era el
   * resultado de un trabajo ya hecho (la cita que vino, lo que ya empezó).
   */
  budget: {
    capCents: number | null
    spentCents: number
    reachedAt: Date | null
    after: { count: number; amountCents: number; lines: Array<{ kind: SaasActionKind; tier: SaasActionTier | null; count: number; amountCents: number }> }
    storageCents: number
  }
}

/** C2: lo que hicieron los agentes en el tramo, con precio base, precio propio e importe. */
export async function getSaasConsumption(tx: Db, orgId: string, now = new Date()): Promise<SaasConsumption> {
  const period = await currentSaasPeriod(tx, orgId, now)
  const pricing = await getActionPricing(tx, orgId, now)
  const actions = await listPeriodActions(tx, orgId, period)
  const pending = await listPendingRecoveries(tx, orgId)
  const billable = actions.filter((row) => row.state !== "anulada" && row.state !== "dentro_de_cita" && row.state !== "devuelta")
  const kinds = SAAS_BILLED_KINDS
  const lines = kinds.map((kind) => {
    const ofKind = billable.filter((row) => row.kind === kind)
    const price = ofKind.reduce((sum, row) => sum + netMicros(row), 0)
    const base = ofKind.reduce(
      (sum, row) => sum + Math.max(0, (row.basePriceMicros ?? 0) - row.refunds.reduce((total, refund) => total + refund.basePriceMicros, 0)),
      0,
    )
    const current = priceFor(pricing, priceKeyOf(kind, null))
    return {
      kind,
      count: ofKind.length,
      units: ofKind.reduce((sum, row) => sum + (row.units ?? 0), 0),
      basePriceMicros: current.basePriceMicros,
      priceMicros: current.priceMicros,
      amountCents: microsToCents(price),
      baseAmountCents: microsToCents(base),
      tiers: (SAAS_TIERS_OF[kind] ?? []).map((tier) => {
        const ofTier = ofKind.filter((row) => row.tier === tier)
        // «Agenda» se cobra aparte por la diferencia: es lo que dice cada fila.
        const own = tier === "agenda" ? agendaUpgradePrice(pricing) : priceFor(pricing, tier)
        return {
          tier,
          count: ofTier.length,
          basePriceMicros: own.basePriceMicros,
          priceMicros: own.priceMicros,
          amountCents: microsToCents(ofTier.reduce((sum, row) => sum + netMicros(row), 0)),
        }
      }),
    }
  })
  const subtotalCents = lines.reduce((sum, line) => sum + line.amountCents, 0)
  const creditMicros = period.creditCents * 10_000
  let used = 0
  let exhaustedAt: Date | null = null
  for (const row of billable) {
    if (row.priceMicros === null) continue
    used += netMicros(row)
    if (exhaustedAt === null && creditMicros > 0 && used >= creditMicros) exhaustedAt = row.occurredAt
  }
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - period.start.getTime()) / (period.end.getTime() - period.start.getTime())))
  const budget = await budgetOf(tx, orgId, billable, creditMicros)
  return {
    period: { start: period.start, end: period.end, credit: period.credit },
    currency: pricing.currency,
    priced: Object.values(pricing.prices).some((price) => price !== null),
    discountBps: pricing.discountBps,
    lines,
    refunds: {
      count: billable.reduce((sum, row) => sum + row.refunds.length, 0),
      amountCents: microsToCents(billable.reduce((sum, row) => sum + (row.priceMicros ?? 0) - netMicros(row), 0)),
    },
    pendingRecoveries: pending.length,
    subtotalCents,
    baseSubtotalCents: lines.reduce((sum, line) => sum + line.baseAmountCents, 0),
    creditCents: period.creditCents,
    creditUsedCents: Math.min(period.creditCents, subtotalCents),
    creditExhaustedAt: exhaustedAt,
    overCreditCents: Math.max(0, subtotalCents - period.creditCents),
    // Con menos de un día de tramo la proyección no dice nada.
    projectedCents: elapsed > 0 && now.getTime() - period.start.getTime() >= 24 * 60 * 60 * 1000 ? Math.round(subtotalCents / elapsed) : null,
    budget,
  }
}

/**
 * El presupuesto del tramo: lo que pasa del crédito, en el orden en que se
 * hizo y sin el almacenamiento. Lo que se cobra después de llegar (la cita
 * que vino, la conversación que ya estaba abierta) se dice aparte.
 */
async function budgetOf(
  tx: Db,
  orgId: string,
  billable: SaasActionRow[],
  creditMicros: number,
): Promise<SaasConsumption["budget"]> {
  const [sub] = await tx
    .select({ capCents: saasSubscription.spendCapCents })
    .from(saasSubscription)
    .where(eq(saasSubscription.organizationId, orgId))
    .limit(1)
  const capMicros = sub?.capCents && sub.capCents > 0 ? sub.capCents * 10_000 : null
  let used = 0
  let reachedAt: Date | null = null
  const after: SaasActionRow[] = []
  for (const row of billable) {
    if (row.priceMicros === null || row.kind === "almacenamiento") continue
    if (reachedAt) after.push(row)
    used += netMicros(row)
    if (!reachedAt && capMicros !== null && used - creditMicros >= capMicros) reachedAt = row.occurredAt
  }
  const keys = [...new Set(after.map((row) => `${row.kind}:${row.tier ?? ""}`))]
  return {
    capCents: sub?.capCents && sub.capCents > 0 ? sub.capCents : null,
    spentCents: microsToCents(Math.max(0, used - creditMicros)),
    reachedAt,
    after: {
      count: after.length,
      amountCents: microsToCents(after.reduce((sum, row) => sum + netMicros(row), 0)),
      lines: keys.map((key) => {
        const rows = after.filter((row) => `${row.kind}:${row.tier ?? ""}` === key)
        return {
          kind: rows[0]!.kind,
          tier: rows[0]!.tier,
          count: rows.length,
          amountCents: microsToCents(rows.reduce((sum, row) => sum + netMicros(row), 0)),
        }
      }),
    },
    storageCents: microsToCents(billable.filter((row) => row.kind === "almacenamiento").reduce((sum, row) => sum + netMicros(row), 0)),
  }
}

/* ---------- Precio mínimo: ningún precio por debajo del doble de su peor costo ---------- */

/**
 * Peor costo medido de cada tipo en millonésimas de USD (estudio de precios
 * del 2026-10-23, ADR 0085): una conversación muy larga de Sofi (unas 20
 * respuestas), una atención de 60 pausas de Clío, la cita recuperada con su
 * conversación, 100 preguntas a Argos en su versión más larga y un GB guardado
 * un mes en el proveedor. Se actualiza con `eval:month` y el costo real de
 * `ai_usage`.
 */
export const SAAS_WORST_COST_MICROS: Record<SaasPriceKey, number> = {
  informa: 15_000,
  gestiona: 60_000,
  agenda: 60_000,
  simple: 52_000,
  estandar: 52_000,
  completa: 52_000,
  cita: 43_000,
  preguntas: 500_000,
  almacenamiento: 15_000,
}
/** Cuántas veces su peor costo debe valer como mínimo una acción, al precio más bajo negociable. */
export const SAAS_PRICE_FLOOR_MULTIPLE = 2

export interface ActionPriceCheck {
  kind: SaasPriceKey
  baseMicros: number | null
  minimumMicros: number | null
  /** El peor costo medido con que se compara (USD); null en otra moneda. */
  worstMicros: number | null
  /** Veces su peor costo, a precio base y al mínimo. */
  baseMultiple: number | null
  minimumMultiple: number | null
  /** No se negocia: su mínimo es su precio base (ADR 0085). */
  fixed: boolean
  ok: boolean
  /** Fijo y por debajo del doble en el peor caso: se puede guardar, y se muestra «Atento». */
  watch: boolean
}

/** Los precios de un plan que se comprueban: los que ya existían y los de cada tipo (ADR 0085). */
export interface PlanPriceInput {
  conversationMicros: number | null
  consultationMicros: number | null
  recoveryMicros: number | null
  conversationInformMicros?: number | null
  conversationAgendaMicros?: number | null
  consultationSimpleMicros?: number | null
  consultationStandardMicros?: number | null
  argosPackMicros?: number | null
  storageGbMicros?: number | null
  fixedPriceTiers?: readonly string[]
  maxDiscountBps: number
  currency: string
}

/**
 * Comprobación del plan antes de guardar (tablero O1): cada precio base y su
 * mínimo contra el peor costo. Lo que se negocia, al descuento máximo, vale
 * al menos el doble. Lo fijo es barato a propósito y su peor costo es un caso
 * extremo (una atención de 60 pausas que deja una receta): por debajo del
 * doble se puede guardar y queda «Atento» (ADR 0085). La pantalla la
 * anticipa; el servidor la exige.
 */
export function checkActionPricing(plan: PlanPriceInput): ActionPriceCheck[] {
  const bases: Record<SaasPriceKey, number | null> = {
    informa: plan.conversationInformMicros ?? null,
    gestiona: plan.conversationMicros,
    agenda: plan.conversationAgendaMicros ?? null,
    simple: plan.consultationSimpleMicros ?? null,
    estandar: plan.consultationStandardMicros ?? null,
    completa: plan.consultationMicros,
    cita: plan.recoveryMicros,
    preguntas: plan.argosPackMicros ?? null,
    almacenamiento: plan.storageGbMicros ?? null,
  }
  const fixedSet = new Set(plan.fixedPriceTiers ?? [])
  return (Object.keys(bases) as SaasPriceKey[]).flatMap((kind): ActionPriceCheck[] => {
    const base = bases[kind]
    const fixed = fixedSet.has(kind)
    if (base === null) return []
    const minimum = fixed ? base : discountedMicros(base, plan.maxDiscountBps)
    const worst = SAAS_WORST_COST_MICROS[kind]
    // El peor costo está en dólares: en otra moneda no hay con qué comparar y no se afirma nada.
    if (plan.currency !== "USD") return [{ kind, baseMicros: base, minimumMicros: minimum, worstMicros: null, baseMultiple: null, minimumMultiple: null, fixed, ok: true, watch: false }]
    const double = minimum >= worst * SAAS_PRICE_FLOOR_MULTIPLE
    const ok = double || fixed
    return [
      {
        kind,
        baseMicros: base,
        minimumMicros: minimum,
        worstMicros: worst,
        baseMultiple: Math.round((base / worst) * 10) / 10,
        minimumMultiple: Math.round((minimum / worst) * 10) / 10,
        fixed,
        ok,
        watch: ok && !double,
      },
    ]
  })
}

const KIND_WORDS: Record<SaasPriceKey, string> = {
  informa: "La conversación que informa",
  gestiona: "La conversación que gestiona una cita",
  agenda: "La conversación cuya cita se dio",
  simple: "La consulta simple",
  estandar: "La consulta estándar",
  completa: "La consulta completa",
  cita: "La cita recuperada",
  preguntas: "El paquete de preguntas a Argos",
  almacenamiento: "El GB extra",
}

/** Lanza `SAAS_PRICE_BELOW_FLOOR` si algún precio queda bajo lo que exige la comprobación. */
export function assertActionPricingFloor(plan: PlanPriceInput): void {
  const failed = checkActionPricing(plan).find((item) => !item.ok)
  if (!failed) return
  const price = new Intl.NumberFormat("es", { style: "currency", currency: plan.currency, maximumFractionDigits: 3 }).format((failed.minimumMicros ?? 0) / 1_000_000)
  throw new ServiceError(
    "SAAS_PRICE_BELOW_FLOOR",
    409,
    `${KIND_WORDS[failed.kind]} quedaría en ${price} con el descuento máximo: menos del doble de su peor costo. Sube el precio, baja el descuento máximo o deja ese precio sin descuento.`,
  )
}

/**
 * ¿Esta persona ya tiene su conversación contada en la ventana que rige
 * (24 horas al empezar)?
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
        inArray(saasAction.tier, ["informa", "gestiona"]),
        gt(saasAction.occurredAt, new Date(now.getTime() - (await conversationWindowMs(tx, now)))),
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
    const cost = conversations * SAAS_WORST_COST_MICROS.gestiona + SAAS_UNBILLED_AI_MICROS
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
