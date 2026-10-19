/**
 * Reportes › Agente: lo que hizo el agente en el periodo, lo que se pagó por
 * él a odentIA, lo cobrado en las citas que agendó y cómo se respondió a quien
 * escribió (lo que antes era la pestaña «Atención»). Solo lecturas; ninguna
 * cifra sale de un modelo.
 *
 * - Lo que hizo: conversaciones con una respuesta suya, citas que reservó (en
 *   su conversación o desde su enlace, `AGENT_SOURCES`), citas recuperadas y
 *   consultas dictadas confirmadas. Las dos últimas son las acciones del cobro
 *   por valor (ADR 0031), contadas el día en que se contaron.
 * - Lo pagado: las mismas cuentas de Facturación. El estado de cada acción
 *   (prueba, crédito, por encima del crédito…) lo da `listPeriodActions` sobre
 *   su tramo de la suscripción entero, y el periodo toma las que caen en él.
 *   Cada tramo dice si se factura (`chargeable`, la regla del cobro, o el
 *   cargo que ya emitió): en una cuenta demo, sin plan o sin activar no se
 *   dice «pagaste». En la moneda del plan, sin convertir.
 * - Lo cobrado en sus citas: los pagos aplicados a los cargos de su atención,
 *   en la moneda de la clínica, sin lo devuelto según la regla de las
 *   comisiones (`allocateRefunds`). No es lo que «ganó» el agente (decisión 5):
 *   quizá esos pacientes habrían venido igual.
 *
 * Cada cifra se calcula para varios tramos en una sola consulta (`spansSql`):
 * el periodo, el anterior y los 12 meses de su línea.
 */
import type { Db } from "@odentia/db"
import { saasCharge, saasPlan, saasSubscription } from "@odentia/db/schema/saas-billing"
import { and, eq, isNull, like, sql, type SQL } from "drizzle-orm"
import { screenedSql } from "./conversation-state.js"
import { allocateRefunds } from "./finance.js"
import { lastMonths } from "./report-periods.js"
import {
  at,
  bySpan,
  hullOf,
  type ReportQuery,
  reportHead,
  reportScope,
  safeCents,
  scopeBuckets,
  serializeBucket,
  type Span,
  spansSql,
} from "./report-scope.js"
import type { ReportListRow } from "./reports.js"
import {
  AGENT_SOURCES,
  currentSaasPeriod,
  getActionPricing,
  listPeriodActions,
  microsToCents,
  netMicros,
  type SaasActionRow,
  type SaasPeriod,
  saasTaxOf,
} from "./saas-actions.js"
import { addMonth, chargeable } from "./saas-invoicing.js"

const agentSources = (): SQL =>
  sql.join(
    AGENT_SOURCES.map((source) => sql`${source}`),
    sql`, `,
  )

/** Una respuesta que el canal aceptó: los envíos de prueba y los que no salieron no cuentan. */
const accepted = (alias: string): SQL =>
  sql.raw(`${alias}.status in ('sent','delivered','read') and coalesce(${alias}.external_id, '') not like 'mock-%'`)

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value))

// --- Lo que hizo ----------------------------------------------------------------------------

export interface AgentConversations {
  /** Conversaciones con al menos una respuesta del agente en el tramo. */
  attended: number
  /** De ellas, las que no tuvieron mensajes del equipo ni paso al equipo en el tramo. */
  alone: number
}

/** Conversaciones que atendió el agente en cada tramo. Son de toda la clínica: no tienen sede. */
export async function agentConversationsMany(tx: Db, orgId: string, spans: Span[]): Promise<AgentConversations[]> {
  const hull = hullOf(spans)
  const rows = await tx.execute<{ idx: number; attended: number; alone: number }>(sql`
    select x.idx, count(*)::int as attended, count(*) filter (where not x.team)::int as alone
    from (
      select b.idx, m.conversation_id,
        exists (
          select 1 from message t where t.organization_id = ${orgId} and t.conversation_id = m.conversation_id
            and t.direction = 'out' and t.sender_kind = 'user' and t.created_at >= b.start_at and t.created_at < b.end_at
        ) or exists (
          select 1 from agent_handoff h where h.organization_id = ${orgId} and h.conversation_id = m.conversation_id
            and h.created_at >= b.start_at and h.created_at < b.end_at
        ) as team
      from ${spansSql(spans)}
      join message m on m.organization_id = ${orgId} and m.created_at >= b.start_at and m.created_at < b.end_at
        and m.created_at >= ${at(hull.start)} and m.created_at < ${at(hull.end)}
        and m.direction = 'out' and m.sender_kind = 'agent' and ${accepted("m")}
      join conversation c on c.organization_id = ${orgId} and c.id = m.conversation_id and not ${screenedSql(sql.raw("c"))}
      group by b.idx, b.start_at, b.end_at, m.conversation_id
    ) x
    group by x.idx`)
  return bySpan(spans, [...rows], () => ({ attended: 0, alone: 0 }), (_, row) => ({ attended: row.attended, alone: row.alone }))
}

export type AgentBooked = {
  /** Citas que reservó el agente (en su conversación o desde su enlace), por el día en que se reservaron. */
  booked: number
  /** De ellas, las que ya están atendidas. */
  attended: number
  /** Todas las citas reservadas en el tramo, por quien sea: la base de su parte. */
  all: number
}

export async function agentBookedMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<AgentBooked[]> {
  const rows = await tx.execute<{ idx: number } & AgentBooked>(sql`
    select b.idx,
      count(*) filter (where a.source in (${agentSources()}))::int as booked,
      count(*) filter (where a.source in (${agentSources()}) and a.status = 'atendida')::int as attended,
      count(*)::int as "all"
    from ${spansSql(spans)}
    join appointment a on a.organization_id = ${orgId} and a.created_at >= b.start_at and a.created_at < b.end_at
      ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    group by b.idx`)
  return bySpan(spans, [...rows], () => ({ booked: 0, attended: 0, all: 0 }), (_, row) => ({ booked: row.booked, attended: row.attended, all: row.all }))
}

/**
 * Citas recuperadas: las acciones `cita` del cobro por valor (ADR 0031), por
 * el día en que se contaron, que el cobro no anuló: si se deshizo la
 * asistencia, `listPeriodActions` la anula y aquí tampoco cuenta. Con una sede
 * elegida, solo las de citas de esa sede.
 */
function recoveredSql(orgId: string, spans: Span[], branchId: string | undefined): SQL {
  return sql`
    select b.idx, x.appointment_id
    from ${spansSql(spans)}
    join saas_action x on x.organization_id = ${orgId} and x.kind = 'cita' and x.occurred_at >= b.start_at and x.occurred_at < b.end_at
    left join appointment a on a.organization_id = x.organization_id and a.id = x.appointment_id
    where (x.appointment_id is null or a.status = 'atendida') ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}`
}

export async function agentRecoveredMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    select r.idx, count(*)::int as count from (${recoveredSql(orgId, spans, branchId)}) r group by r.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

/** Consultas dictadas y confirmadas por el odontólogo: las acciones `consulta`, por el día en que se cerró la atención. */
export async function agentDictatedMany(tx: Db, orgId: string, branchId: string | undefined, spans: Span[]): Promise<number[]> {
  const rows = await tx.execute<{ idx: number; count: number }>(sql`
    select b.idx, count(*)::int as count
    from ${spansSql(spans)}
    join saas_action x on x.organization_id = ${orgId} and x.kind = 'consulta' and x.occurred_at >= b.start_at and x.occurred_at < b.end_at
    ${branchId ? sql`join encounter e on e.organization_id = x.organization_id and e.id = x.encounter_id and e.branch_id = ${branchId}` : sql``}
    group by b.idx`)
  return bySpan(spans, [...rows], () => 0, (_, row) => row.count)
}

// --- Lo cobrado en sus citas ----------------------------------------------------------------

type Money = Array<{ currency: string; cents: number }>

function addMoney(list: Money, currency: string, cents: number): void {
  const found = list.find((item) => item.currency === currency)
  if (found) found.cents += cents
  else list.push({ currency, cents })
}

/**
 * Lo pagado hasta hoy en cada cita, por moneda: los pagos aplicados a los
 * cargos de su atención cerrada, sin lo anulado y sin lo devuelto con la regla
 * de las comisiones y de «Por profesional» (`allocateRefunds`): cada
 * devolución gasta primero lo que el pago dejó sin aplicar y solo el resto
 * baja lo aplicado, repartido entre los cargos de atenciones que pagó.
 */
async function appointmentsPaid(tx: Db, orgId: string, appointmentIds: string[], now: Date): Promise<Map<string, Money>> {
  const out = new Map<string, Money>()
  if (!appointmentIds.length) return out
  const wanted = new Set(appointmentIds)
  // Todas las aplicaciones vigentes de los pagos que tocaron esas citas, también las de otras atenciones:
  // entre ellas se reparte lo devuelto, como en las comisiones.
  const rows = await tx.execute<{
    id: string
    amount_cents: number
    created_at: Date | string
    payment_id: string
    payment_cents: number
    charge_id: string
    currency: string
    appointment_id: string | null
  }>(sql`
    with paid as (
      select distinct pa.payment_id
      from encounter e
      join encounter_procedure ep on ep.organization_id = e.organization_id and ep.encounter_id = e.id and ep.voided_at is null
      join patient_charge c on c.organization_id = e.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null
      join patient_payment_application pa on pa.organization_id = e.organization_id and pa.charge_id = c.id and pa.voided_at is null
      where e.organization_id = ${orgId} and e.status = 'finalizada' and e.voided_at is null
        and e.appointment_id in (${sql.join(appointmentIds.map((id) => sql`${id}`), sql`, `)})
    )
    select pa.id, pa.amount_cents, pa.created_at, pa.payment_id, p.amount_cents as payment_cents, pa.charge_id, c.currency, e.appointment_id
    from paid
    join patient_payment_application pa on pa.organization_id = ${orgId} and pa.payment_id = paid.payment_id and pa.voided_at is null
    join patient_payment p on p.organization_id = pa.organization_id and p.id = pa.payment_id and p.voided_at is null
    join patient_charge c on c.organization_id = pa.organization_id and c.id = pa.charge_id and c.voided_at is null
    join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id and ep.voided_at is null
    join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id and e.status = 'finalizada' and e.voided_at is null`)
  const apps = [...rows].map((row) => ({
    appId: row.id,
    appCents: Number(row.amount_cents),
    appCreatedAt: asDate(row.created_at),
    chargeId: row.charge_id,
    chargePromotionId: null,
    chargePromotionName: null,
    chargeBudgetItemId: null,
    paymentId: row.payment_id,
  }))
  const totals = new Map([...rows].map((row) => [row.payment_id, Number(row.payment_cents)]))
  // Todo lo devuelto hasta hoy, no solo lo de un mes.
  const refunded = await allocateRefunds(tx, orgId, apps, totals, new Date(0), now)
  for (const row of rows) {
    if (!row.appointment_id || !wanted.has(row.appointment_id)) continue
    const cents = Number(row.amount_cents)
    const list = out.get(row.appointment_id) ?? []
    addMoney(list, row.currency, cents - Math.min(cents, refunded.get(row.id) ?? 0))
    out.set(row.appointment_id, list)
  }
  return out
}

export interface AgentCollected {
  /** Citas que agendó en el tramo y ya vinieron, sin las que el cobro contó como recuperadas (de cualquier tramo). */
  booked: { visits: number; byCurrency: Money }
  /** Citas recuperadas del tramo. */
  recovered: { visits: number; byCurrency: Money }
}

/**
 * Lo cobrado en las citas del agente en cada tramo: las que reservó en el
 * tramo y las recuperadas del tramo, cada cita en una sola línea y un solo
 * tramo: la que tiene su acción `cita` va en «recuperadas» del tramo en que se
 * contó, aunque se haya reservado en otro. Lo pagado hasta hoy, por moneda:
 * nunca se suman monedas.
 */
export async function agentCollectedMany(
  tx: Db,
  orgId: string,
  branchId: string | undefined,
  spans: Span[],
  now: Date = new Date(),
): Promise<AgentCollected[]> {
  const rows = await tx.execute<{ idx: number; recovered: boolean; appointment_id: string }>(sql`
    select b.idx, false as recovered, a.id as appointment_id
    from ${spansSql(spans)}
    join appointment a on a.organization_id = ${orgId} and a.created_at >= b.start_at and a.created_at < b.end_at
      and a.source in (${agentSources()}) and a.status = 'atendida'
      ${branchId ? sql`and a.branch_id = ${branchId}` : sql``}
    where not exists (select 1 from saas_action x where x.organization_id = a.organization_id and x.kind = 'cita' and x.appointment_id = a.id)
    union
    select r.idx, true, r.appointment_id from (${recoveredSql(orgId, spans, branchId)}) r where r.appointment_id is not null`)
  const paid = await appointmentsPaid(tx, orgId, [...new Set([...rows].map((row) => row.appointment_id))], now)
  const out: AgentCollected[] = spans.map(() => ({ booked: { visits: 0, byCurrency: [] }, recovered: { visits: 0, byCurrency: [] } }))
  for (const row of rows) {
    const entry = out[Number(row.idx)]
    if (!entry) continue
    const part = row.recovered ? entry.recovered : entry.booked
    part.visits += 1
    for (const item of paid.get(row.appointment_id) ?? []) addMoney(part.byCurrency, item.currency, item.cents)
  }
  return out
}

/** Lo cobrado en una moneda, sumando las dos líneas: lo que dice el Resumen junto a la cifra. */
export function collectedIn(collected: AgentCollected, currency: string): number {
  const of = (list: Money) => list.find((item) => item.currency === currency)?.cents ?? 0
  return of(collected.booked.byCurrency) + of(collected.recovered.byCurrency)
}

// --- Lo pagado a odentIA --------------------------------------------------------------------

type Tramo = SaasPeriod & {
  creditCents: number
  /** `plan`: un mes de la suscripción; `calendario`: un mes sin ella, como lo cuenta `currentSaasPeriod`; `prueba`. */
  kind: "plan" | "calendario" | "prueba"
  /** Lo que se cuenta en él se factura: la regla `chargeable` del cobro, o el cargo que el cobro ya emitió. */
  charged: boolean
  /** El que corre hoy: lo que pase del crédito se cobra al cerrarlo. */
  open: boolean
}

/** Por qué no se cobra nada, como lo dice Facturación: cuenta demo, la prueba, o sin plan activo. */
export type AgentBillingNotCharged = "demo" | "prueba" | "sin_plan"

interface SaasTramos {
  tramos: Tramo[]
  /** Hoy: si la suscripción cobra y, si no, por qué. */
  chargingNow: boolean
  reasonNow: AgentBillingNotCharged
}

/**
 * Los tramos de la suscripción que tocan `hull`, enteros: el que corre hoy
 * (`currentSaasPeriod`, el mismo de Facturación); antes, los meses desde que
 * se activó el plan (cada uno empieza el mismo día, como los cierra el
 * cobro), la prueba y, donde no hubo nada de eso, meses calendario enteros,
 * como hace `currentSaasPeriod` sin suscripción, recortados solo donde
 * termina el tramo anterior o empieza el siguiente. Nada antes de la primera
 * acción.
 */
async function saasTramos(tx: Db, orgId: string, hull: Span, now: Date): Promise<SaasTramos> {
  const [sub] = await tx.select().from(saasSubscription).where(eq(saasSubscription.organizationId, orgId)).limit(1)
  const current = await currentSaasPeriod(tx, orgId, now)
  // Restringida por deuda no deja de facturar: el cobro no avanza su mes y, al
  // regularizarse, `closeSaasPeriods` cierra cada tramo vencido con sus acciones.
  const chargingNow = sub ? chargeable(sub) || (chargeable({ ...sub, status: "activa" }) && sub.status === "restringida") : false
  const reasonNow: AgentBillingNotCharged = sub?.isDemo ? "demo" : current.credit === "prueba" ? "prueba" : "sin_plan"
  const [first] = await tx.execute<{ at: string | null }>(sql`select min(occurred_at)::text as at from saas_action where organization_id = ${orgId}`)
  if (!first?.at) return { tramos: [], chargingNow, reasonNow }
  const from = new Date(Math.max(hull.start.getTime(), new Date(first.at).getTime()))
  const pricing = await getActionPricing(tx, orgId)
  // Los meses que el cobro ya cerró se facturaron, con el crédito que guardó su cargo (aunque el plan cambie después).
  const charges = await tx
    .select({ start: saasCharge.periodStart, creditCents: saasCharge.creditCents })
    .from(saasCharge)
    .where(and(eq(saasCharge.organizationId, orgId), like(saasCharge.dedupeKey, "ciclo:%:final"), isNull(saasCharge.voidedAt)))
  const closed = new Map(charges.map((row) => [row.start.getTime(), row.creditCents]))
  const past: Tramo[] = []
  if (sub?.activatedAt && sub.activatedAt < current.start) {
    let start = sub.activatedAt
    let end = addMonth(start)
    while (start < current.start) {
      const issued = closed.has(start.getTime())
      past.push({
        start,
        end: end < current.start ? end : current.start,
        credit: "mes",
        kind: "plan",
        creditCents: closed.get(start.getTime()) ?? pricing.creditCents,
        charged: issued || chargingNow,
        open: false,
      })
      start = end
      end = addMonth(end)
    }
  }
  if (sub?.trialStartedAt && current.credit !== "prueba") {
    const ends = [sub.trialEndsAt ?? sub.activatedAt ?? current.start, sub.activatedAt ?? current.start, current.start]
    const end = new Date(Math.min(...ends.map((date) => date.getTime())))
    if (sub.trialStartedAt < end) {
      const [plan] = pricing.planId ? await tx.select({ trialCreditCents: saasPlan.trialCreditCents }).from(saasPlan).where(eq(saasPlan.id, pricing.planId)).limit(1) : []
      past.push({ start: sub.trialStartedAt, end, credit: "prueba", kind: "prueba", creditCents: sub.trialCreditCents ?? plan?.trialCreditCents ?? 0, charged: false, open: false })
    }
  }
  // Lo que no cubre ningún tramo se cuenta por mes calendario (en UTC, como `currentSaasPeriod`): el mes
  // entero, recortado solo donde termina el tramo anterior y donde empieza el siguiente.
  past.sort((a, b) => a.start.getTime() - b.start.getTime())
  const gaps: Tramo[] = []
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  const fill = (until: Date) => {
    while (cursor < until) {
      const next = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
      const end = next < until ? next : until
      gaps.push({ start: cursor, end, credit: "mes", kind: "calendario", creditCents: pricing.creditCents, charged: false, open: false })
      cursor = end
    }
  }
  for (const tramo of past) {
    if (tramo.end <= cursor) continue
    fill(tramo.start)
    cursor = tramo.end
  }
  fill(current.start)
  const kind: Tramo["kind"] = current.credit === "prueba" ? "prueba" : sub?.currentPeriodStart?.getTime() === current.start.getTime() ? "plan" : "calendario"
  const today: Tramo = { ...current, kind, charged: kind === "plan" && chargingNow, open: true }
  return { tramos: [...past, ...gaps, today].filter((tramo) => tramo.end > from && tramo.start < hull.end), chargingNow, reasonNow }
}

export interface AgentBillingLine {
  kind: "conversacion" | "consulta" | "cita"
  count: number
  /** Precio de cada una si todas lo comparten (un cambio de precio a mitad de mes deja varios). */
  unitMicros: number | null
  amountCents: number
}

export interface AgentBilling {
  /** Moneda del plan de odentIA (no la de la clínica); null sin plan: no hay importe que mostrar. */
  currency: string | null
  /**
   * Si lo contado en el tramo se factura: `si`, `no` (nada: lo de abajo es «así sería tu factura», como
   * dice Facturación) o `en_parte` (el tramo junta meses que se cobran y otros que no; las cuentas son de
   * los que se cobran y `uncharged` dice el resto).
   */
  charging: "si" | "no" | "en_parte"
  /** Con `charging` en `no`: por qué. */
  notCharged: AgentBillingNotCharged | null
  /** Acciones pagadas (con el crédito del plan o por encima), por tipo, a su precio. */
  lines: AgentBillingLine[]
  /** Conversaciones ya cobradas que devuelven las citas recuperadas. */
  refunds: { count: number; amountCents: number }
  /** Lo que costaron: las líneas menos la devolución. */
  totalCents: number
  /** De ese total, lo que cubrió el crédito del plan y lo que se cobró por encima (lo que la factura suma a la cuota). */
  coveredCents: number
  overCents: number
  /** De lo que pasó del crédito, lo del mes que aún corre y no se facturó: se cobrará al cerrarlo. */
  pendingCents: number
  /** Con `en_parte`: lo contado en los meses que no se cobran, fuera de las cuentas. */
  uncharged: { count: number; amountCents: number }
  /** Lo que salió del saldo de prueba, de regalo: no es parte de lo pagado. */
  trial: { count: number; amountCents: number }
  /** Acciones contadas sin precio (el plan aún no lo tenía). */
  unpriced: number
  /** Cuántos meses de la suscripción toca el tramo: cada uno trae su crédito (el mes del plan empieza el día que se activó). */
  planMonths: number
  /** Cuándo empieza el primero de esos meses (ISO): de ahí el día en que se renueva el crédito. Null sin meses de la suscripción. */
  planStart: string | null
  /** El crédito de cada mes del tramo; null si no todos traen el mismo. */
  planCreditCents: number | null
}

const KINDS = ["conversacion", "consulta", "cita"] as const

interface Counted {
  row: SaasActionRow
  tramo: Tramo
}

/**
 * Lo que cuenta como pagado. Lo que odentIA devolvió por «Pedir revisión» ya
 * cobrado no: la factura lo resta en el cargo siguiente (línea `revision`) y
 * aquí se descuenta en el mes de la acción, una sola vez.
 */
const isPaid = (row: SaasActionRow): boolean => (row.state === "credito" || row.state === "sobre_credito") && row.review?.status !== "devuelta"

/**
 * Lo pagado por el agente en un conjunto de acciones, con la aritmética de la
 * factura (`issueCycleCharge`): cada línea redondea su suma al centavo y la
 * devolución va aparte, restando. Solo cuenta lo de los tramos que se
 * facturan; si ninguno se factura, todo, como «así sería tu factura».
 */
function billingOf(entries: Counted[], currency: string | null, tramos: Tramo[], now: Pick<SaasTramos, "chargingNow" | "reasonNow">): AgentBilling {
  const months = tramos.filter((tramo) => tramo.credit === "mes")
  const charging: AgentBilling["charging"] =
    months.length === 0
      ? tramos.length === 0 && now.chargingNow
        ? "si"
        : "no"
      : months.every((tramo) => tramo.charged)
        ? "si"
        : months.some((tramo) => tramo.charged)
          ? "en_parte"
          : "no"
  const notCharged: AgentBilling["notCharged"] =
    charging !== "no" ? null : now.reasonNow === "demo" ? "demo" : months.length === 0 && tramos.length > 0 ? "prueba" : months.length === 0 ? now.reasonNow : "sin_plan"
  const counted = charging === "no" ? entries : entries.filter((entry) => entry.tramo.charged)
  const paid = counted.filter((entry) => isPaid(entry.row)).map((entry) => entry.row)
  const over = paid.filter((row) => row.state === "sobre_credito")
  const gross = (list: SaasActionRow[], kind: string): number => microsToCents(list.filter((row) => row.kind === kind).reduce((sum, row) => sum + (row.priceMicros ?? 0), 0))
  const refunded = (list: SaasActionRow[]): number => microsToCents(list.reduce((sum, row) => sum + (row.priceMicros ?? 0) - netMicros(row), 0))
  const overOf = (list: SaasActionRow[]): number => KINDS.reduce((sum, kind) => sum + gross(list, kind), 0) - refunded(list)
  const lines = KINDS.map((kind) => {
    const ofKind = paid.filter((row) => row.kind === kind)
    const prices = new Set(ofKind.map((row) => row.priceMicros))
    return { kind, count: ofKind.length, unitMicros: prices.size === 1 ? (ofKind[0]?.priceMicros ?? null) : null, amountCents: gross(paid, kind) }
  })
  const refunds = { count: paid.reduce((sum, row) => sum + row.refunds.length, 0), amountCents: refunded(paid) }
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0) - refunds.amountCents
  const overCents = overOf(over)
  // Lo del mes que corre que aún no entró en un cargo (con ciclo quincenal, parte ya pudo cobrarse).
  const pending = counted.filter((entry) => entry.tramo.open && entry.row.state === "sobre_credito" && entry.row.chargeId === null).map((entry) => entry.row)
  const outside = charging === "en_parte" ? entries.filter((entry) => !entry.tramo.charged && isPaid(entry.row)).map((entry) => entry.row) : []
  const trial = entries.filter((entry) => entry.row.state === "prueba").map((entry) => entry.row)
  const plans = months.filter((tramo) => tramo.kind === "plan").sort((a, b) => a.start.getTime() - b.start.getTime())
  const credits = new Set(months.map((tramo) => tramo.creditCents))
  return {
    currency,
    charging,
    notCharged,
    lines,
    refunds,
    totalCents,
    coveredCents: totalCents - overCents,
    overCents,
    pendingCents: overOf(pending),
    uncharged: { count: outside.length, amountCents: microsToCents(outside.reduce((sum, row) => sum + netMicros(row), 0)) },
    trial: { count: trial.length, amountCents: microsToCents(trial.reduce((sum, row) => sum + netMicros(row), 0)) },
    unpriced: entries.filter((entry) => entry.row.state === "sin_precio").length,
    planMonths: plans.length,
    planStart: plans[0]?.start.toISOString() ?? null,
    planCreditCents: credits.size === 1 ? ([...credits][0] ?? null) : null,
  }
}

/**
 * Lo pagado por el agente en cada tramo: las acciones que ocurrieron en él,
 * cada una con el estado que le da su tramo de la suscripción entero
 * (`listPeriodActions`, la única definición de Facturación y del cobro). Para
 * un tramo que es el mes de la suscripción, lo que pasó del crédito es lo que
 * la factura de ese mes suma a la cuota. De toda la clínica.
 */
export async function agentBillingMany(tx: Db, orgId: string, spans: Span[], now: Date = new Date()): Promise<AgentBilling[]> {
  const { tramos, chargingNow, reasonNow } = await saasTramos(tx, orgId, hullOf(spans), now)
  const entries: Counted[] = []
  for (const tramo of tramos) for (const row of await listPeriodActions(tx, orgId, tramo)) entries.push({ row, tramo })
  const { currency } = await getActionPricing(tx, orgId)
  return spans.map((span) =>
    billingOf(
      entries.filter((entry) => entry.row.occurredAt >= span.start && entry.row.occurredAt < span.end),
      currency,
      tramos.filter((tramo) => tramo.end > span.start && tramo.start < span.end),
      { chargingNow, reasonNow },
    ),
  )
}

// --- Cómo respondimos -----------------------------------------------------------------------

export type FirstResponses = {
  /** Conversaciones cuyo primer mensaje de la persona cae en el tramo. */
  conversations: number
  responded: number
  byAgent: number
  byTeam: number
  /** Mediana en segundos hasta la primera respuesta, del agente y del equipo por separado; null sin respuestas medidas. */
  agentMedianSeconds: number | null
  teamMedianSeconds: number | null
  /** De esas conversaciones, las que el agente pasó al equipo, hasta hoy: nunca más que quienes escribieron. */
  handedOff: number
  /** Por dónde escribieron, de más a menos. */
  byChannel: Array<{ channel: string | null; count: number }>
}

/**
 * Las conversaciones cuyo primer mensaje de la persona cae en `hull`, sin
 * recorrer la historia entera: las que tuvieron un entrante en el tramo y
 * ninguno antes (el índice de mensajes por conversación lo responde).
 */
function firstInboundSql(orgId: string, hull: Span): SQL {
  return sql`
    select m.conversation_id, min(m.created_at) as created_at
    from message m
    where m.organization_id = ${orgId} and m.direction = 'in' and m.created_at >= ${at(hull.start)} and m.created_at < ${at(hull.end)}
      and not exists (
        select 1 from message p
        where p.organization_id = ${orgId} and p.conversation_id = m.conversation_id and p.direction = 'in' and p.created_at < ${at(hull.start)}
      )
    group by m.conversation_id`
}

/**
 * Primera respuesta: del primer mensaje de la persona a la primera respuesta
 * aceptada por el canal (la misma regla de la antigua «Atención»), con
 * mediana en vez de promedio: unas pocas respuestas de horas no la mueven.
 * En la misma consulta, por dónde escribieron y cuántas pasaron al equipo.
 */
export async function firstResponsesMany(tx: Db, orgId: string, spans: Span[]): Promise<FirstResponses[]> {
  const rows = await tx.execute<{ idx: number } & Omit<FirstResponses, "byChannel"> & { byChannel: FirstResponses["byChannel"] | null }>(sql`
    with first_inbound as (${firstInboundSql(orgId, hullOf(spans))}),
    cohort as (
      select b.idx, i.conversation_id, i.created_at, r.sent_at, r.id as response_id, r.sender_kind, cc.channel,
        exists (
          select 1 from agent_handoff h where h.organization_id = ${orgId} and h.conversation_id = i.conversation_id and h.created_by = 'agent'
        ) as handed
      from ${spansSql(spans)}
      join first_inbound i on i.created_at >= b.start_at and i.created_at < b.end_at
      join conversation c on c.id = i.conversation_id and c.organization_id = ${orgId} and not ${screenedSql(sql.raw("c"))}
      left join channel_connection cc on cc.id = c.channel_connection_id and cc.organization_id = ${orgId}
      left join lateral (
        select m.id, m.sent_at, m.sender_kind from message m
        where m.organization_id = ${orgId} and m.conversation_id = i.conversation_id
          and m.direction = 'out' and ${accepted("m")} and m.created_at >= i.created_at
        order by coalesce(m.sent_at, m.created_at), m.id limit 1
      ) r on true
    ), channels as (
      select idx, channel, count(*)::int as count from cohort group by idx, channel
    )
    select k.idx, count(*)::int as conversations, count(k.response_id)::int as responded,
      count(*) filter (where k.sender_kind = 'agent')::int as "byAgent",
      count(*) filter (where k.response_id is not null and k.sender_kind <> 'agent')::int as "byTeam",
      percentile_cont(0.5) within group (order by extract(epoch from (k.sent_at - k.created_at)))
        filter (where k.sender_kind = 'agent' and k.sent_at >= k.created_at)::float8 as "agentMedianSeconds",
      percentile_cont(0.5) within group (order by extract(epoch from (k.sent_at - k.created_at)))
        filter (where k.response_id is not null and k.sender_kind <> 'agent' and k.sent_at >= k.created_at)::float8 as "teamMedianSeconds",
      count(*) filter (where k.handed)::int as "handedOff",
      (select json_agg(json_build_object('channel', x.channel, 'count', x.count) order by x.count desc, x.channel) from channels x where x.idx = k.idx) as "byChannel"
    from cohort k group by k.idx`)
  return bySpan(
    spans,
    [...rows],
    (): FirstResponses => ({ conversations: 0, responded: 0, byAgent: 0, byTeam: 0, agentMedianSeconds: null, teamMedianSeconds: null, handedOff: 0, byChannel: [] }),
    (_, row) => ({
      conversations: row.conversations,
      responded: row.responded,
      byAgent: row.byAgent,
      byTeam: row.byTeam,
      agentMedianSeconds: row.agentMedianSeconds === null ? null : Math.round(Number(row.agentMedianSeconds)),
      teamMedianSeconds: row.teamMedianSeconds === null ? null : Math.round(Number(row.teamMedianSeconds)),
      handedOff: row.handedOff,
      byChannel: row.byChannel ?? [],
    }),
  )
}

/**
 * Desde cuándo trabaja el agente: su primera respuesta, su primera cita o su
 * primera acción contada. La respuesta se busca solo antes de las otras dos y
 * en orden de fecha: la base se detiene en la primera, sin recorrer los mensajes.
 */
async function agentSince(tx: Db, orgId: string): Promise<Date | null> {
  const [row] = await tx.execute<{ since: string | null }>(sql`
    with known as (
      select least(
        (select min(created_at) from appointment where organization_id = ${orgId} and source in (${agentSources()})),
        (select min(occurred_at) from saas_action where organization_id = ${orgId})
      ) as at
    )
    select least(k.at, (
      select m.created_at from message m
      where m.organization_id = ${orgId} and m.created_at < coalesce(k.at, 'infinity'::timestamptz)
        and m.direction = 'out' and m.sender_kind = 'agent'
      order by m.created_at limit 1
    ))::text as since
    from known k`)
  return row?.since ? new Date(row.since) : null
}

// --- La pestaña -----------------------------------------------------------------------------

export async function getReportAgent(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date(), options: { billing?: boolean } = {}) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  // El periodo, el anterior y los 12 meses que terminan en el último mes del periodo.
  const months = lastMonths(scope.timezone, window.to, 12, window.end)
  const spans: Span[] = [window, window.previous, ...months]
  const conversations = await agentConversationsMany(tx, orgId, spans)
  const booked = await agentBookedMany(tx, orgId, branchId, spans)
  const recovered = await agentRecoveredMany(tx, orgId, branchId, spans)
  const dictated = await agentDictatedMany(tx, orgId, branchId, spans)
  const [collected] = await agentCollectedMany(tx, orgId, branchId, [window], now)
  const responses = await firstResponsesMany(tx, orgId, [window, window.previous])
  const since = await agentSince(tx, orgId)
  // Lo pagado a odentIA solo lo ve quien ve Facturación.
  const [paid] = options.billing ? await agentBillingMany(tx, orgId, [window], now) : [null]
  const tax = paid ? await saasTaxOf(tx, orgId) : null

  // Las citas que agendó por tramo del gráfico; en un periodo de meses son los mismos 12 meses.
  const buckets = scopeBuckets(scope)
  const chart = window.kind === "months" ? booked.slice(2) : await agentBookedMany(tx, orgId, branchId, buckets)
  const nth = <T>(list: T[], index: number): T => list[index] as T
  const inCurrency = (list: Money) => list.find((item) => item.currency === currency)?.cents ?? 0
  const othersOf = (list: Money) => list.filter((item) => item.currency !== currency)
  const empty: AgentCollected = { booked: { visits: 0, byCurrency: [] }, recovered: { visits: 0, byCurrency: [] } }
  const money = collected ?? empty
  const others: Money = []
  for (const item of [...othersOf(money.booked.byCurrency), ...othersOf(money.recovered.byCurrency)]) addMoney(others, item.currency, item.cents)
  const { handedOff, byChannel, ...current } = nth(responses, 0)
  const { handedOff: previousHandedOff, byChannel: _previousChannels, ...previous } = nth(responses, 1)

  return {
    ...reportHead(scope),
    /** Los 12 meses de cada línea pequeña. */
    months: months.map(serializeBucket),
    conversations: { current: nth(conversations, 0), previous: nth(conversations, 1), months: conversations.slice(2).map((item) => item.attended) },
    booked: {
      current: { booked: nth(booked, 0).booked, attended: nth(booked, 0).attended },
      previous: { booked: nth(booked, 1).booked, attended: nth(booked, 1).attended },
      months: booked.slice(2).map((item) => item.booked),
    },
    recovered: { current: nth(recovered, 0), previous: nth(recovered, 1), months: recovered.slice(2) },
    dictated: { current: nth(dictated, 0), previous: nth(dictated, 1), months: dictated.slice(2) },
    /** Lo cobrado en sus citas, hasta hoy, en la moneda de la clínica; las otras monedas aparte, nunca sumadas. */
    collected: {
      currency,
      booked: { visits: money.booked.visits, cents: inCurrency(money.booked.byCurrency) },
      recovered: { visits: money.recovered.visits, cents: inCurrency(money.recovered.byCurrency) },
      others,
    },
    /** Lo pagado a odentIA por el agente, en la moneda del plan; null para quien no ve Facturación. */
    paid: paid ? { ...paid, tax } : null,
    /** Citas que agendó el agente por tramo del gráfico y todas las reservadas; null antes de que empezara a trabajar. */
    chart: buckets.map((bucket, index) => {
      const item = chart[index] ?? { booked: 0, attended: 0, all: 0 }
      const before = since === null || bucket.end.getTime() <= since.getTime()
      return { ...serializeBucket(bucket), booked: before ? null : item.booked, all: item.all }
    }),
    since: since?.toISOString() ?? null,
    responses: { current, previous, handedOff, previousHandedOff, byChannel },
    /** Las conversaciones y el cobro de odentIA no pertenecen a una sede. */
    wholeClinic: scope.branch ? (["conversations", "responses", "paid"] as const) : ([] as const),
  }
}

// --- Las listas detrás de sus cifras --------------------------------------------------------

export const AGENT_REPORT_LISTS = ["agent_booked", "agent_handoffs"] as const
export type AgentReportListKey = (typeof AGENT_REPORT_LISTS)[number]

const AGENT_LIST_LIMIT = 200

/** «vie 3 oct, 10:00», en el idioma y la zona de la clínica. */
function dayAndHour(date: Date, locale: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone }).format(date).replace(/[.,]/g, "")
  const hour = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(date)
  return `${day}, ${hour}`
}

/**
 * «Citas que agendó» (con lo pagado en cada una) y «Pasaron al equipo» (una
 * fila por conversación, con el motivo; lleva a la conversación en la
 * Bandeja). Las mismas consultas de sus cifras: las citas por el día en que se
 * reservaron (esa es la fecha de la fila; la de la cita va en el texto) y las
 * conversaciones de quienes escribieron por primera vez en el periodo.
 */
export async function getAgentReportList(tx: Db, orgId: string, query: ReportQuery & { list: AgentReportListKey }, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  type Row = Omit<ReportListRow, "cents"> & { cents: number | null; total: number }
  let rows: Row[]
  if (query.list === "agent_booked") {
    const booked = await tx.execute<Omit<Row, "title" | "cents" | "currency"> & { startsAt: Date | string; service: string }>(sql`
      select a.id, a.created_at as at, a.starts_at as "startsAt", a.service_name as service, a.patient_id as "patientId",
        pp.display_name as "personName", u.name as "professionalName", br.name as "branchName",
        exists (select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = a.patient_id
          and n.starts_at > ${at(now)} and n.status in ('programada','confirmada')) as "hasNextAppointment",
        null::uuid as "conversationId", count(*) over()::int as total
      from appointment a
      join patient p on p.id = a.patient_id and p.organization_id = ${orgId}
      join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
      join branch br on br.id = a.branch_id and br.organization_id = ${orgId}
      join "user" u on u.id = a.dentist_user_id
      where a.organization_id = ${orgId} and a.created_at >= ${at(window.start)} and a.created_at < ${at(window.end)}
        and a.source in (${agentSources()}) ${scope.branch ? sql`and a.branch_id = ${scope.branch.id}` : sql``}
      order by a.created_at desc, a.id limit ${AGENT_LIST_LIMIT}`)
    const paid = await appointmentsPaid(tx, orgId, [...booked].map((row) => row.id), now)
    rows = [...booked].map(({ startsAt, service, ...row }) => {
      const cents = paid.get(row.id)?.find((item) => item.currency === currency)?.cents ?? null
      return {
        ...row,
        title: `Cita el ${dayAndHour(asDate(startsAt), scope.locale, scope.timezone)} · ${service}`,
        cents,
        currency: cents === null ? null : currency,
      }
    })
  } else {
    rows = [
      ...(await tx.execute<Row>(sql`
        with first_inbound as (${firstInboundSql(orgId, window)}),
        passed as (
          select distinct on (h.conversation_id) h.id, h.created_at, h.reason, h.conversation_id,
            coalesce(h.contact_id, c.contact_id) as contact_id
          from first_inbound i
          join conversation c on c.organization_id = ${orgId} and c.id = i.conversation_id and not ${screenedSql(sql.raw("c"))}
          join agent_handoff h on h.organization_id = ${orgId} and h.conversation_id = i.conversation_id and h.created_by = 'agent'
          order by h.conversation_id, h.created_at desc
        )
        select x.id, x.created_at as at, pt.id as "patientId", coalesce(pp.display_name, 'Sin nombre') as "personName",
          x.reason as title, null::text as "professionalName", null::text as "branchName", false as "hasNextAppointment",
          null::bigint as cents, null::text as currency, x.conversation_id as "conversationId", count(*) over()::int as total
        from passed x
        left join contact pp on pp.organization_id = ${orgId} and pp.id = x.contact_id
        left join patient pt on pt.organization_id = ${orgId} and pt.person_id = x.contact_id
        order by x.created_at desc, x.id limit ${AGENT_LIST_LIMIT}`)),
    ]
  }
  return {
    ...reportHead(scope),
    list: query.list,
    /** Las conversaciones no tienen sede: con una elegida, los pases al equipo son de toda la clínica. */
    wholeClinic: scope.branch !== null && query.list === "agent_handoffs",
    /** Filas que existen; la respuesta trae como mucho `AGENT_LIST_LIMIT`. */
    total: rows[0]?.total ?? 0,
    rows: rows.map(({ total: _total, cents, at: when, ...row }) => ({
      ...row,
      at: asDate(when).toISOString(),
      cents: cents === null ? null : safeCents(cents),
    })),
  }
}
