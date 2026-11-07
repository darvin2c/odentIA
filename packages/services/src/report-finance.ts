/**
 * Reportes › Finanzas: de lo cobrado a lo que deja el mes, las comisiones de
 * cada profesional, lo que te deben y lo que debes, lo que viene y qué dejó
 * cada promoción. Solo lecturas; ninguna cifra sale de un modelo.
 *
 * - Lo cobrado es `collectedNetMany` (la regla de Finanzas). Lo que ya pasó va con
 *   el valor congelado de cada cobro y cada gasto; lo que se debe, por moneda y con
 *   un total aproximado al cambio de hoy (`report-value.ts`).
 * - La comisión cuenta cuando se genera, al cobrar, en su propia línea
 *   (decisión 13): `commissionsMany` es la misma cuenta de Finanzas ›
 *   Comisiones (`getMonthlyCommissions`) para varios tramos en una consulta.
 *   `cashLeftCents` la descuenta cuando se paga, con los demás gastos.
 * - Los gastos son los de Finanzas › Gastos por su tipo; el pago de una
 *   comisión se separa de «Personal» por la liquidación que lo generó y el de
 *   una compra va en Materiales (ADR 0061).
 * - «Te deben» por antigüedad es la regla del saldo vencido (`report-debts.ts`):
 *   cada persona cuenta entera en el tramo de su concepto sin pagar más antiguo.
 */
import { fixedOwedAt } from "./expense-recurring.js"
import type { Db } from "@odentia/db"
import { sql, type SQL } from "drizzle-orm"
import { budgetLineUnitsSql, budgetValueOptionSql } from "./budgets.js"
import { collectedNetMany, EXPENSE_CATEGORIES } from "./finance.js"
import { orgTaxes } from "./clinic-taxes.js"
import { unpaidPurchasesMany } from "./purchase-balance.js"
import { debtDaysSql, debtZoneSql, overdueDebtSql, valuedDebtSql } from "./report-debts.js"
import { firstVisitSql } from "./report-visits.js"
import { toScheduleSql } from "./to-schedule.js"
import { addMonths, currentMonthIn, lastMonths, monthStart, type ReportBucket } from "./report-periods.js"
import {
  at,
  bySpan,
  hullOf,
  type ReportQuery,
  type ReportScope,
  reportHead,
  reportScope,
  safeCents,
  scopeBuckets,
  serializeBucket,
  type Span,
  spansSql,
} from "./report-scope.js"
import {
  businessFirst,
  type CurrencyAmount,
  foreignBreakdown,
  type OrgMoney,
  orgMoneySql,
  paymentFlowSql,
  paymentValueSql,
  todayValueCents,
  todayValueSql,
} from "./report-value.js"

// --- Comisiones -------------------------------------------------------------------------

export interface CommissionTotals {
  userId: string
  /** Lo cobrado de lo que atendió: la base de su comisión. */
  baseCents: number
  commissionCents: number
  /** Lo ya pagado (congelado en un pago registrado), también lo de un cobro que se anuló después. */
  paidCents: number
  /** La parte que aún no entra en ningún pago. */
  freshCents: number
}

/**
 * Las líneas de comisión de un tramo como las cuenta Finanzas › Comisiones:
 * cada cobro de lo que atendió un profesional (aplicación en pie hoy, sobre un
 * cargo de un procedimiento de una atención finalizada) con su porcentaje
 * vigente; lo ya pagado, con el porcentaje y el importe con que se pagó; lo
 * pagado cuyo cobro se anuló después ya no cuenta. También de quien ya dejó la clínica.
 * Lo nuevo va con el valor congelado de su pago; lo pagado no se toca. La base no se
 * redondea por línea: la suma es la que se redondea.
 */
function commissionLinesSql(orgId: string, hull: Span, currency: string, branchId: string | undefined): SQL {
  const branch = branchId ? sql`and p.branch_id = ${branchId}` : sql``
  const line = sql`la.cents, la.payment_cents, la.business_cents, la.currency, op.currency, op.second_currency, op.exchange_factor`
  const commission = sql`money_commission(${line}, coalesce(r.rate_bps, 0))`
  return sql`live_app as materialized (
      select a.id, a.amount_cents::bigint as cents, a.created_at as at, e.professional_user_id as user_id,
        p.amount_cents as payment_cents, p.business_cents, p.currency::text as currency
      from patient_payment_application a
      join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
      join encounter_procedure ep on ep.organization_id = a.organization_id and ep.id = c.encounter_procedure_id
      join encounter e on e.organization_id = a.organization_id and e.id = ep.encounter_id
      where a.organization_id = ${orgId} and a.created_at >= ${at(hull.start)} and a.created_at < ${at(hull.end)}
        and a.voided_at is null and p.voided_at is null and c.voided_at is null and ep.voided_at is null
        and e.status = 'finalizada' and e.voided_at is null ${branch}
    ), frozen as materialized (
      -- Lo ya pagado, con lo que se pagó. Si el cobro se anuló después, se pagó igual
      -- (cuenta en lo pagado) pero ya no es comisión del mes: se descuenta del próximo pago.
      select l.application_id, l.base_cents::bigint as base, l.commission_cents::bigint as commission, l.occurred_at as at,
        s.professional_user_id as user_id,
        (a.voided_at is null and p.voided_at is null and c.voided_at is null) as live
      from commission_settlement_line l
      join commission_settlement s on s.organization_id = l.organization_id and s.id = l.settlement_id and s.voided_at is null
      join patient_payment_application a on a.organization_id = l.organization_id and a.id = l.application_id
      join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
      where l.organization_id = ${orgId} and l.kind = 'cobro' and l.voided_at is null and s.currency = ${currency}
        and l.occurred_at >= ${at(hull.start)} and l.occurred_at < ${at(hull.end)} ${branch}
    ), commission_line as materialized (
      select f.user_id, f.at, (case when f.live then f.base else 0 end)::numeric as base, (case when f.live then f.commission else 0 end)::numeric as commission,
        f.commission::numeric as paid, 0::numeric as fresh
      from frozen f
      union all
      select la.user_id, la.at, org_money_value(${line}), ${commission}, 0, ${commission}
      from live_app la
      left join commission_rule r on r.organization_id = ${orgId} and r.professional_user_id = la.user_id
      cross join ${orgMoneySql(orgId)}
      where not exists (select 1 from frozen f where f.application_id = la.id)
    ), counted_line as (
      -- Lo viejo en otra moneda, sin valor ni factor, no tiene base: no entra. Quien dejó la
      -- clínica sigue contando: lo que ganó es de los meses en que atendió, y sacarlo del equipo
      -- no reescribe esos meses ni lo que se le debe (igual que la vista de Argos).
      select cl.* from commission_line cl
      where cl.base is not null
    )`
}

/** Las comisiones de varios tramos en una consulta, por profesional (la misma cuenta de Finanzas › Comisiones). */
export async function commissionsMany(
  tx: Db,
  orgId: string,
  spans: Span[],
  options: { currency: string; branchId?: string },
): Promise<CommissionTotals[][]> {
  const hull = hullOf(spans)
  const rows = await tx.execute<{ idx: number; userId: string; base: string; commission: string; paid: string; fresh: string }>(sql`
    with ${commissionLinesSql(orgId, hull, options.currency, options.branchId)}
    select s.idx, ml.user_id as "userId", round(sum(ml.base))::text as base, round(sum(ml.commission))::text as commission,
      round(sum(ml.paid))::text as paid, round(sum(ml.fresh))::text as fresh
    from counted_line ml join ${spansSql(spans, "s")} on ml.at >= s.start_at and ml.at < s.end_at
    group by s.idx, ml.user_id`)
  return bySpan(
    spans,
    [...rows],
    (): CommissionTotals[] => [],
    (list, row) => [
      ...list,
      {
        userId: row.userId,
        baseCents: safeCents(row.base),
        commissionCents: safeCents(row.commission),
        paidCents: safeCents(row.paid),
        freshCents: safeCents(row.fresh),
      },
    ],
  )
}

/**
 * Lo pagado de comisiones cuyo cobro se anuló después y aún no se descontó (por profesional): lo
 * que se le descontará en sus próximos pagos. Un descuento puede ir en partes; con sede, el de los
 * cobros anulados de esa sede.
 */
async function pendingCommissionAdjustments(
  tx: Db,
  orgId: string,
  currency: string,
  branchId?: string,
): Promise<Map<string, number>> {
  const rows = await tx.execute<{ userId: string; cents: string }>(sql`
    select s.professional_user_id as "userId", sum(l.commission_cents - coalesce(d.cents, 0))::text as cents
    from commission_settlement_line l
    join commission_settlement s on s.organization_id = l.organization_id and s.id = l.settlement_id and s.voided_at is null
    join patient_payment_application a on a.organization_id = l.organization_id and a.id = l.application_id
    join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
    join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
    left join lateral (
      select sum(l2.commission_cents) as cents from commission_settlement_line l2
      join commission_settlement s2 on s2.organization_id = l2.organization_id and s2.id = l2.settlement_id and s2.voided_at is null
      where l2.organization_id = l.organization_id and l2.kind = 'ajuste' and l2.voided_at is null and l2.application_id = l.application_id
    ) d on true
    where l.organization_id = ${orgId} and l.kind = 'cobro' and l.voided_at is null and l.commission_cents > 0 and s.currency = ${currency}
      and (a.voided_at is not null or p.voided_at is not null or c.voided_at is not null)
      and l.commission_cents > coalesce(d.cents, 0)
      ${branchId ? sql`and p.branch_id = ${branchId}` : sql``}
    group by s.professional_user_id`)
  return new Map(rows.map((row) => [row.userId, safeCents(row.cents)]))
}

/**
 * Lo que falta pagarle a un profesional del tramo: lo nuevo menos lo que hay
 * que descontarle, nunca menos de cero. Se cuenta por profesional: lo que se le
 * descuenta a uno no baja lo que se le debe a otro. La tarjeta y la tabla de
 * Comisiones usan esta misma cuenta.
 */
function pendingOf(row: CommissionTotals, adjustments: Map<string, number>): number {
  return Math.max(0, row.freshCents - (adjustments.get(row.userId) ?? 0))
}

/**
 * Comisiones por pagar en cada momento: lo generado hasta ahí menos lo pagado
 * hasta ahí, por profesional y nunca menos de cero (lo que hay que descontar
 * no se debe). En una sede, lo pagado cuenta en la sede de cada cobro.
 */
export async function commissionsOwedMany(
  tx: Db,
  orgId: string,
  moments: Date[],
  options: { currency: string; branchId?: string },
): Promise<Array<{ cents: number; professionals: number }>> {
  if (moments.length === 0) return []
  const last = new Date(Math.max(...moments.map((moment) => moment.getTime())))
  const rows = await tx.execute<{ idx: number; userId: string; owed: string }>(sql`
    with ${commissionLinesSql(orgId, { start: new Date(Date.UTC(2000, 0, 1)), end: last }, options.currency, options.branchId)},
    m(idx, at_moment) as (values ${sql.join(
      moments.map((moment, index) => sql`(${index}::int, ${at(moment)})`),
      sql`, `,
    )}), generated as (
      select m.idx, ml.user_id, sum(ml.commission) as cents from m join counted_line ml on ml.at < m.at_moment group by m.idx, ml.user_id
    ), paid as (
      ${
        options.branchId
          ? // En una sede, lo pagado es lo de sus cobros menos lo descontado de sus cobros anulados,
            // como lo generado: la sede donde se anotó el gasto del pago no cambia de quién es la deuda.
            sql`select m.idx, s.professional_user_id as user_id,
              sum(case when l.kind = 'cobro' then l.commission_cents else -l.commission_cents end) as cents
            from m join commission_settlement s on s.organization_id = ${orgId} and s.voided_at is null and s.currency = ${options.currency}
              and s.settled_at < m.at_moment
            join commission_settlement_line l on l.organization_id = s.organization_id and l.settlement_id = s.id and l.voided_at is null
            join patient_payment_application a on a.organization_id = l.organization_id and a.id = l.application_id
            join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id and p.branch_id = ${options.branchId}
            group by m.idx, s.professional_user_id`
          : sql`select m.idx, s.professional_user_id as user_id, sum(s.commission_cents) as cents
            from m join commission_settlement s on s.organization_id = ${orgId} and s.voided_at is null and s.currency = ${options.currency}
              and s.settled_at < m.at_moment
            group by m.idx, s.professional_user_id`
      }
    )
    select coalesce(g.idx, p.idx) as idx, coalesce(g.user_id, p.user_id) as "userId",
      round(coalesce(g.cents, 0) - coalesce(p.cents, 0))::text as owed
    from generated g full join paid p on p.idx = g.idx and p.user_id = g.user_id`)
  return moments.map((_, index) => {
    const own = rows.filter((row) => Number(row.idx) === index).map((row) => Math.max(0, safeCents(row.owed)))
    return { cents: own.reduce((total, cents) => total + cents, 0), professionals: own.filter((cents) => cents > 0).length }
  })
}

// --- Gastos -----------------------------------------------------------------------------

/** Lo gastado de un tramo por tipo; el pago de una comisión va aparte de su tipo (Personal). */
export interface ExpenseTotals {
  currency: string
  totalCents: number
  /** Gastos por tipo, sin el pago de comisiones. */
  byCategory: Array<{ category: string; cents: number }>
  /** Pagos de comisiones del tramo. */
  commissionPaidCents: number
  /** Pagos de compras de Inventario (dentro de Materiales). */
  purchasePaidCents: number
  /**
   * Pagos del impuesto de lo cobrado (el IGV, ADR 0083): salen de la caja pero
   * no restan de lo que deja, porque ese impuesto ya salió de lo cobrado. Van
   * aparte de su tipo, como el pago de comisiones.
   */
  salesTaxPaidCents: number
}

/**
 * Lo gastado de varios tramos en una consulta, con la regla de Finanzas: los
 * gastos del tramo que siguen en pie al cerrarlo, menos los de antes que se
 * anularon en el tramo. Con su valor congelado, en moneda del negocio; solo lo viejo
 * en otra moneda, sin valor ni factor, va aparte en su moneda.
 */
export async function expensesMany(tx: Db, orgId: string, spans: Span[], options: { branchId?: string } = {}): Promise<ExpenseTotals[][]> {
  const branch = options.branchId ? sql`and e.branch_id = ${options.branchId}` : sql``
  const kind = sql`case
      when exists (select 1 from commission_settlement s where s.organization_id = e.organization_id and s.expense_id = e.id) then 'comision'
      when e.purchase_order_id is not null then 'compra'
      when e.sales_tax then 'impuesto_de_lo_cobrado'
      else 'gasto' end`
  const rows = await tx.execute<{
    idx: number
    currency: string
    category: string
    kind: string
    cents: string
  }>(sql`
    select b.idx, case when v.value is null then x.currency else op.currency end as currency, x.category, x.kind,
      round(sum(coalesce(v.value, x.cents)))::text as cents
    from ${spansSql(spans)}
    cross join ${orgMoneySql(orgId)}
    join lateral (
      select e.currency::text as currency, e.category, ${kind} as kind, e.amount_cents::bigint as cents, e.amount_cents, e.business_cents from expense e
      where e.organization_id = ${orgId} and e.spent_at >= b.start_at and e.spent_at < b.end_at
        and (e.voided_at is null or e.voided_at >= b.end_at) ${branch}
      union all
      select e.currency::text, e.category, ${kind}, -e.amount_cents::bigint, e.amount_cents, e.business_cents from expense e
      where e.organization_id = ${orgId} and e.spent_at < b.start_at and e.voided_at >= b.start_at and e.voided_at < b.end_at ${branch}
    ) x on true
    cross join lateral (select ${paymentValueSql(sql`x.cents`, "x")} as value) v
    group by b.idx, 2, x.category, x.kind`)
  return bySpan(
    spans,
    [...rows],
    (): ExpenseTotals[] => [],
    (list, row) => {
      let entry = list.find((item) => item.currency === row.currency)
      if (!entry) {
        entry = { currency: row.currency, totalCents: 0, byCategory: [], commissionPaidCents: 0, purchasePaidCents: 0, salesTaxPaidCents: 0 }
        list.push(entry)
      }
      const cents = safeCents(row.cents)
      entry.totalCents += cents
      if (row.kind === "comision") entry.commissionPaidCents += cents
      else if (row.kind === "impuesto_de_lo_cobrado") entry.salesTaxPaidCents += cents
      else {
        if (row.kind === "compra") entry.purchasePaidCents += cents
        const slot = entry.byCategory.find((item) => item.category === row.category)
        if (slot) slot.cents += cents
        else entry.byCategory.push({ category: row.category, cents })
      }
      return list
    },
  )
}

// --- Te deben ---------------------------------------------------------------------------

/** Los tramos de antigüedad de «Te deben»: hasta 30, 60, 90 días y más. */
export const DEBT_AGES = [
  { key: "0_30", upTo: 30 },
  { key: "31_60", upTo: 60 },
  { key: "61_90", upTo: 90 },
  { key: "90_plus", upTo: null },
] as const
export type DebtAge = (typeof DEBT_AGES)[number]["key"]

/**
 * El tramo de lo que se anotó en `since`, visto en `moment`, con la misma
 * cuenta que «Saldo vencido» del Resumen (`overdueDebtSql`) y que Finanzas ›
 * Deudas: días de calendario en la zona de la sede o de la clínica. Así «más
 * de 30 días» suma lo mismo que esa cifra a cualquier hora, y la tarjeta y su
 * lista usan esta sola expresión.
 */
function debtAgeSql(since: SQL, moment: SQL, zone: SQL): SQL {
  const steps = DEBT_AGES.filter((age) => age.upTo !== null).map(
    (age) => sql`when ${debtDaysSql(since, moment, zone)} <= ${age.upTo} then ${age.key}::text`,
  )
  return sql`case ${sql.join(steps, sql` `)} else ${DEBT_AGES[DEBT_AGES.length - 1]!.key}::text end`
}

/**
 * Lo que te deben en cada momento, por antigüedad: cada persona con lo que
 * debe (conceptos menos pagos menos lo que tiene a favor) en el tramo de su
 * concepto sin pagar más antiguo. Lo de «más de 30 días» es exactamente el
 * saldo vencido de Resumen.
 *
 * Con dos monedas, una persona debe por separado en cada una: cada deuda va en el
 * tramo de su moneda, y las personas se cuentan distintas (quien debe en dos cuenta
 * una vez). Las cifras son el total aproximado al cambio de hoy y `byCurrency` dice
 * lo que de verdad se debe; sin nada en otra moneda, `byCurrency` no viene. Lo viejo
 * en otra moneda sin factor no entra.
 */
export async function debtAgingMany(
  tx: Db,
  orgId: string,
  moments: Date[],
  options: { currency: string; branchId?: string },
) {
  const rows = await tx.execute<{
    idx: number
    age: DebtAge | null
    currency: string | null
    owed: string
    cents: string
    people: number
  }>(sql`
    ${valuedDebtSql(orgId, moments, 0, options.branchId)}, aged as (
      select valued.*, ${debtAgeSql(sql`valued.since`, sql`m.at_moment`, debtZoneSql(orgId, options.branchId))} as age from valued join m on m.idx = valued.idx
    )
    select idx, age, currency, sum(owed)::text as owed, round(sum(value))::text as cents, count(distinct patient_id)::int as people
    from aged where value is not null
    group by grouping sets ((idx), (idx, currency), (idx, age), (idx, age, currency))`)
  return moments.map((_, index) => {
    const own = rows.filter((row) => Number(row.idx) === index)
    const slice = (age: DebtAge | null) => {
      const list = own.filter((row) => row.age === age)
      const total = list.find((row) => row.currency === null)
      return {
        cents: safeCents(total?.cents),
        people: total?.people ?? 0,
        parts: list.flatMap((row) =>
          row.currency === null ? [] : [{ currency: row.currency, cents: safeCents(row.owed) }],
        ),
      }
    }
    const all = slice(null)
    // Si algo va en otra moneda, cada tramo dice lo suyo aunque sea solo de la del negocio.
    const foreign = foreignBreakdown(all.parts, options.currency).byCurrency !== undefined
    const inEach = (parts: CurrencyAmount[]) =>
      foreign ? { byCurrency: businessFirst(parts, options.currency) } : {}
    return {
      totalCents: all.cents,
      people: all.people,
      ...inEach(all.parts),
      ages: DEBT_AGES.map((age) => {
        const { cents, people, parts } = slice(age.key)
        return { key: age.key, cents, people, ...inEach(parts) }
      }),
    }
  })
}

/**
 * Lo que se debe a proveedores: el total aproximado al cambio de hoy, con lo que se
 * debe en cada moneda si hay algo en otra. Lo viejo en otra moneda sin factor no entra.
 */
export function purchasesDueOf(
  list:
    | Array<{ currency: string; cents: number; orders: number; oldestReceivedAt: Date | null }>
    | undefined,
  money: OrgMoney,
) {
  const valued = (list ?? []).flatMap((item) => {
    const value = todayValueCents(item.cents, item.currency, money)
    return value === null ? [] : [{ ...item, value }]
  })
  const oldest = valued.flatMap((item) =>
    item.oldestReceivedAt ? [item.oldestReceivedAt.getTime()] : [],
  )
  return {
    cents: valued.reduce((total, item) => total + item.value, 0),
    orders: valued.reduce((total, item) => total + item.orders, 0),
    oldestReceivedAt: oldest.length > 0 ? new Date(Math.min(...oldest)).toISOString() : null,
    ...foreignBreakdown(
      valued.map((item) => ({ currency: item.currency, cents: item.cents })),
      money.currency,
    ),
  }
}

// --- Lo que viene y cuánto vale un paciente ---------------------------------------------

/** «Aceptó y no tiene cita» (`toScheduleSql`) sobre el tratamiento `pi` de una línea, de una persona activa. */
function lineToScheduleSql(now: Date): SQL {
  return sql`(${toScheduleSql(
    { id: sql`pi.id`, organizationId: sql`pi.organization_id`, status: sql`pi.status`, decisionStatus: sql`pi.decision_status` },
    at(now),
  )} and exists (select 1 from patient lp join contact lc on lc.organization_id = lp.organization_id and lc.id = lp.person_id
    where lp.organization_id = pi.organization_id and lp.id = pi.patient_id and lc.is_active and not lc.is_test))`
}

/**
 * Lo que viene, a hoy: lo aceptado en presupuestos que aún no se hizo, a su
 * precio acordado, y de eso lo que no tiene cita: la regla de «Por agendar»
 * (`toScheduleSql`), una cita por venir que lleve ese tratamiento, aunque la
 * persona tenga otra. De la persona, no de una sede. Aún no se cobra: lo de
 * otra moneda va al cambio de hoy y `byCurrency` dice cuánto es en cada una.
 */
export async function upcomingWork(tx: Db, orgId: string, currency: string, now: Date) {
  const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const rows = await tx.execute<{
    currency: string | null
    original: string | null
    cents: string
    patients: number
    unbookedCents: string
    unbookedPatients: number
  }>(sql`
    with pending as (
      select b.patient_id, i.currency::text as currency,
        i.price_cents::bigint * ${budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })} as cents,
        ${lineToScheduleSql(now)} as unbooked
      from treatment_budget b
      join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budget)} and i.decision = 'aceptado' and i.price_cents is not null
      join treatment_plan_item pi on pi.organization_id = i.organization_id and pi.id = i.plan_item_id
      where b.organization_id = ${orgId} and b.status in ('aceptado','parcial')
        and pi.status not in ('realizado','cancelado','reemplazado')
    ), valued as (
      select pending.*, ${todayValueSql(sql`pending.cents`, sql`pending.currency`)} as value from pending cross join ${orgMoneySql(orgId)}
    )
    select currency, sum(cents) filter (where value is not null)::text as original,
      round(coalesce(sum(value), 0))::text as cents, count(distinct patient_id) filter (where value is not null)::int as patients,
      round(coalesce(sum(value) filter (where unbooked), 0))::text as "unbookedCents",
      count(distinct patient_id) filter (where unbooked and value is not null)::int as "unbookedPatients"
    from valued group by grouping sets ((), (currency))`)
  const row = rows.find((item) => item.currency === null)
  const parts = rows.flatMap((item) =>
    item.currency !== null && item.original !== null
      ? [{ currency: item.currency, cents: safeCents(item.original) }]
      : [],
  )
  return {
    cents: safeCents(row?.cents),
    patients: row?.patients ?? 0,
    unbooked: { cents: safeCents(row?.unbookedCents), patients: row?.unbookedPatients ?? 0 },
    ...foreignBreakdown(parts, currency),
  }
}

/** Meses que se miran de cada paciente nuevo: «en sus primeros 6 meses». */
export const PATIENT_VALUE_MONTHS = 6

/**
 * Cuánto vale un paciente nuevo en sus primeros 6 meses: el promedio de lo que
 * pagaron (menos lo devuelto) en sus 6 meses desde su primera cita atendida
 * quienes llegaron hace 6 a 9 meses, para que todos tengan sus 6 meses enteros.
 */
export async function newPatientValue(tx: Db, orgId: string, end: Date, options: { currency: string; branchId?: string }) {
  const [row] = await tx.execute<{ patients: number; cents: string }>(sql`
    with ${firstVisitSql(orgId)}, cohort as (
      select patient_id, starts_at from first_visit
      where starts_at >= ${at(end)} - interval '9 months' and starts_at < ${at(end)} - interval '6 months'
        ${options.branchId ? sql`and branch_id = ${options.branchId}` : sql``}
    ), paid as (
      select c.patient_id,
        coalesce((select sum(${paymentValueSql(sql`p.amount_cents`)}) from patient_payment p where p.organization_id = ${orgId} and p.patient_id = c.patient_id
          and p.voided_at is null and p.paid_at >= c.starts_at and p.paid_at < c.starts_at + interval '6 months'), 0)
        - coalesce((select sum(${paymentValueSql(sql`r.amount_cents`)}) from patient_payment_refund r join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
          where r.organization_id = ${orgId} and r.patient_id = c.patient_id
            and r.refunded_at >= c.starts_at and r.refunded_at < c.starts_at + interval '6 months'), 0) as cents
      from cohort c cross join ${orgMoneySql(orgId)}
    )
    select count(*)::int as patients, round(coalesce(sum(cents), 0))::text as cents from paid`)
  const patients = row?.patients ?? 0
  return { patients, averageCents: patients > 0 ? Math.round(safeCents(row?.cents) / patients) : null }
}

// --- De dónde vino lo cobrado -----------------------------------------------------------

/**
 * Lo cobrado del tramo por medio de pago, con la regla de Finanzas (anulaciones y
 * devoluciones restan): cada medio con su valor en moneda del negocio. Si algo entró
 * en otra moneda, `entered` dice lo que entró en cada una, que es lo que se compara
 * con el arqueo de su caja: lo devuelto, lo que de verdad salió.
 */
export async function collectedByMethod(tx: Db, orgId: string, span: Span, options: { currency: string; branchId?: string }) {
  const rows = await tx.execute<{
    method: string
    cash: boolean
    enteredCurrency: string
    cents: string
    entered: string
  }>(sql`
    select x.method, bool_or(x.cash) as cash, x.entered_currency as "enteredCurrency", round(sum(v.value))::text as cents, round(sum(x.entered))::text as entered from (
      ${paymentFlowSql(orgId, at(span.start), at(span.end), options.branchId)}
    ) x
    cross join ${orgMoneySql(orgId)}
    cross join lateral (select ${paymentValueSql(sql`x.cents`, "x")} as value) v
    where v.value is not null
    group by x.method, x.entered_currency`)
  const closures = await tx.execute<{ currency: string; count: number; cash: string }>(sql`
    select currency::text as currency, count(*)::int as count, coalesce(sum(cash_collected_cents - cash_refunded_cents), 0)::text as cash from cash_closure
    where organization_id = ${orgId} and closed_at >= ${at(span.start)} and closed_at < ${at(span.end)}
      ${options.branchId ? sql`and branch_id = ${options.branchId}` : sql``}
    group by currency`)
  const labels = [...new Set(rows.map((row) => row.method))]
  const business = closures.find((row) => row.currency === options.currency)
  const otherClosures = closures.filter((row) => row.currency !== options.currency)
  return {
    methods: labels
      .map((label) => {
        const own = rows.filter((row) => row.method === label)
        const foreign = own.some((row) => row.enteredCurrency !== options.currency)
        return {
          label,
          cash: own.some((row) => row.cash),
          cents: own.reduce((total, row) => total + safeCents(row.cents), 0),
          ...(foreign
            ? {
                entered: businessFirst(
                  own.map((row) => ({
                    currency: row.enteredCurrency,
                    cents: safeCents(row.entered),
                    valueCents: safeCents(row.cents),
                  })),
                  options.currency,
                ),
              }
            : {}),
        }
      })
      .filter((row) => row.cents !== 0)
      .sort((a, b) => b.cents - a.cents),
    closures: {
      count: business?.count ?? 0,
      cashCents: safeCents(business?.cash),
      ...(otherClosures.length > 0
        ? {
            others: otherClosures.map((row) => ({
              currency: row.currency,
              count: row.count,
              cashCents: safeCents(row.cash),
            })),
          }
        : {}),
    },
  }
}

/** Tratamientos a la vista; el resto va en «Otros». */
const TREATMENTS_SHOWN = 6

/**
 * Lo aplicado en el tramo a cargos de cada servicio (los 6 mayores y «Otros»).
 * Una devolución (ADR 0068) no reescribe el día del cobro: lo pagado cuenta el
 * día que se aplicó, la parte que pasa a un concepto rebajado no vuelve a
 * contar, y lo devuelto se resta el día de la devolución. Con el valor congelado de
 * su pago, en moneda del negocio: se redondea sobre la suma de cada tratamiento.
 */
export async function collectedByTreatment(tx: Db, orgId: string, span: Span, options: { currency: string; branchId?: string }) {
  const branch = options.branchId ? sql`and p.branch_id = ${options.branchId}` : sql``
  const rows = await tx.execute<{ name: string; cents: string }>(sql`
    with x as (
      select coalesce(sc.name, c.description) as name, ${paymentValueSql(sql`a.amount_cents`)} as cents
      from patient_payment_application a
      join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
      left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
      left join treatment_budget_item bi on bi.organization_id = c.organization_id and bi.id = c.budget_item_id
      left join service_catalog sc on sc.organization_id = c.organization_id and sc.id = coalesce(ep.service_id, bi.service_id)
      cross join ${orgMoneySql(orgId)}
      where a.organization_id = ${orgId} and a.replaces_application_id is null
        and a.created_at >= ${at(span.start)} and a.created_at < ${at(span.end)}
        and (a.voided_at is null or a.voided_at >= ${at(span.end)} or a.return_id is not null)
        and (c.voided_at is null or c.voided_at >= ${at(span.end)} or a.return_id is not null)
        and (p.voided_at is null or p.voided_at >= ${at(span.end)}) ${branch}
      union all
      select coalesce(sc.name, c.description),
        -${paymentValueSql(sql`(a.amount_cents - coalesce((select sum(n.amount_cents) from patient_payment_application n
          where n.organization_id = a.organization_id and n.replaces_application_id = a.id), 0))`)}
      from patient_payment_application a
      join patient_payment p on p.organization_id = a.organization_id and p.id = a.payment_id
      join patient_charge c on c.organization_id = a.organization_id and c.id = a.charge_id
      left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
      left join treatment_budget_item bi on bi.organization_id = c.organization_id and bi.id = c.budget_item_id
      left join service_catalog sc on sc.organization_id = c.organization_id and sc.id = coalesce(ep.service_id, bi.service_id)
      cross join ${orgMoneySql(orgId)}
      where a.organization_id = ${orgId} and a.return_id is not null
        and a.voided_at >= ${at(span.start)} and a.voided_at < ${at(span.end)}
        and (p.voided_at is null or p.voided_at >= ${at(span.end)}) ${branch}
    )
    select name, round(sum(cents))::text as cents from x group by 1 order by sum(cents) desc`)
  const all = rows.map((row) => ({ name: row.name, cents: safeCents(row.cents) })).filter((row) => row.cents > 0)
  const rest = all.slice(TREATMENTS_SHOWN)
  return {
    rows: all.slice(0, TREATMENTS_SHOWN),
    others: rest.length > 0 ? { count: rest.length, cents: rest.reduce((total, row) => total + row.cents, 0) } : null,
  }
}

// --- «Puede faltar un gasto» ------------------------------------------------------------

/**
 * Un tipo de gasto que la sede tuvo en cada uno de los dos meses anteriores y
 * en este no (salvo que la clínica haya dicho «No hubo ese gasto»). En el mes
 * en curso solo se avisa pasado el día en que se anotó el mes anterior. Solo
 * con un mes elegido; el pago de comisiones (va en su propia línea) y el de una
 * compra de Inventario no cuentan.
 */
async function missingExpenses(tx: Db, orgId: string, scope: ReportScope) {
  const { window, timezone } = scope
  if (window.kind !== "months" || window.from.year !== window.to.year || window.from.month !== window.to.month) return []
  const month = window.from
  const first = addMonths(month, -2)
  const start = monthStart(timezone, first.year, first.month)
  const end = monthStart(timezone, addMonths(month, 1).year, addMonths(month, 1).month)
  const key = (value: { year: number; month: number }) => `${value.year}-${String(value.month).padStart(2, "0")}`
  const branch = scope.branch ? sql`and e.branch_id = ${scope.branch.id}` : sql``
  const rows = await tx.execute<{
    month: string
    branchId: string
    branchName: string
    category: string
    cents: string
    lastDay: number
    concept: string
    lastCents: string
  }>(sql`
    select to_char(e.spent_at at time zone ${timezone}, 'YYYY-MM') as month, e.branch_id as "branchId", b.name as "branchName", e.category,
      round(sum(v.value))::text as cents,
      max(extract(day from e.spent_at at time zone ${timezone}))::int as "lastDay",
      (array_agg(e.concept order by e.spent_at desc))[1] as concept,
      (array_agg(round(v.value)::text order by e.spent_at desc))[1] as "lastCents"
    from expense e join branch b on b.organization_id = e.organization_id and b.id = e.branch_id
    cross join ${orgMoneySql(orgId)}
    cross join lateral (select ${paymentValueSql(sql`e.amount_cents`, "e")} as value) v
    where e.organization_id = ${orgId} and e.voided_at is null and v.value is not null
      and e.spent_at >= ${at(start)} and e.spent_at < ${at(end)} ${branch}
      and not exists (select 1 from commission_settlement s where s.organization_id = e.organization_id and s.expense_id = e.id)
      -- El pago de una compra tampoco: depende de lo que se compró, y «Copiar el de…» no debe copiarlo.
      and e.purchase_order_id is null
    group by 1, 2, 3, 4`)
  // Lo que ya se repite (sede y tipo con una plantilla en pie) se avisa en Gastos como «por pagar»:
  // aquí solo queda de respaldo para lo que nadie marcó.
  const repeating = await tx.execute<{ category: string; branchId: string }>(sql`
    select distinct category, branch_id as "branchId" from expense_recurring
    where organization_id = ${orgId} and (last_month is null or last_month >= ${key(month)})`)
  const dismissed = await tx.execute<{ category: string; branchId: string | null }>(sql`
    select category, branch_id as "branchId" from expense_gap_dismissal
    where organization_id = ${orgId} and month = ${key(month)}`)
  const before = [addMonths(month, -2), addMonths(month, -1)].map(key)
  const now = currentMonthIn(timezone, scope.now)
  const running = now.year === month.year && now.month === month.month
  const today = Number(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, day: "2-digit" }).format(scope.now))
  const pairs = new Map<string, { branchId: string; branchName: string; category: string }>()
  for (const row of rows) pairs.set(`${row.branchId}|${row.category}`, { branchId: row.branchId, branchName: row.branchName, category: row.category })
  const out: Array<{
    category: string
    branch: { id: string; name: string }
    previous: Array<{ month: string; cents: number }>
    /** Lo que se copia con «Copiar el de…»: el último gasto de ese tipo del mes anterior. */
    copy: { month: string; concept: string; amountCents: number; day: number }
  }> = []
  for (const pair of pairs.values()) {
    const of = (value: string) => rows.find((row) => row.month === value && row.branchId === pair.branchId && row.category === pair.category)
    const previous = before.map(of)
    if (previous.some((row) => !row) || of(key(month))) continue
    if (dismissed.some((row) => row.category === pair.category && (row.branchId === null || row.branchId === pair.branchId))) continue
    if (repeating.some((row) => row.category === pair.category && row.branchId === pair.branchId)) continue
    const last = previous[1] as (typeof rows)[number]
    if (running && today <= last.lastDay) continue
    out.push({
      category: pair.category,
      branch: { id: pair.branchId, name: pair.branchName },
      previous: previous.map((row) => ({
        month: (row as (typeof rows)[number]).month,
        cents: safeCents((row as (typeof rows)[number]).cents),
      })),
      copy: {
        month: last.month,
        concept: last.concept,
        amountCents: safeCents(last.lastCents),
        day: last.lastDay,
      },
    })
  }
  return out.sort((a, b) => EXPENSE_CATEGORIES.indexOf(a.category as (typeof EXPENSE_CATEGORIES)[number]) - EXPENSE_CATEGORIES.indexOf(b.category as (typeof EXPENSE_CATEGORIES)[number]))
}

// --- La pestaña -------------------------------------------------------------------------

function inCurrency<T extends { currency: string }>(list: T[] | undefined, currency: string): T | undefined {
  return list?.find((item) => item.currency === currency)
}

const sumOf = (list: CommissionTotals[] | undefined, pick: (item: CommissionTotals) => number): number =>
  (list ?? []).reduce((total, item) => total + pick(item), 0)

/**
 * Reportes › Finanzas: cobrado, lo que deja el periodo, comisiones y lo que te
 * deben, con el anterior y su línea de 12 meses; la cascada de lo cobrado a lo
 * que deja; cada tramo (cobrado, comisiones, otros gastos); lo que debes; y de
 * dónde vino lo cobrado. Todo en la moneda de la clínica; solo lo viejo en otra
 * moneda, sin valor ni factor, se dice aparte.
 */
export async function getReportFinance(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  const months: ReportBucket[] = lastMonths(scope.timezone, window.to, 12, window.end)
  const buckets = scopeBuckets(scope)
  const spans: Span[] = [window, window.previous, ...months, ...buckets]
  const collected = await collectedNetMany(tx, orgId, spans, { branchId })
  const commissions = await commissionsMany(tx, orgId, spans, { currency, branchId })
  const expenses = await expensesMany(tx, orgId, spans, { branchId })
  const debts = await debtAgingMany(tx, orgId, [window.end, window.previous.end], { currency, branchId })
  // Lo que se debía al cerrar el periodo y lo que se debe hoy: la misma cuenta en dos momentos.
  const [owedCommissions, owedNow] = await commissionsOwedMany(tx, orgId, [window.end, now], { currency, branchId })
  // Lo fijo vencido sin pagar al cierre (gastos que se repiten).
  const fixedOwed = await fixedOwedAt(tx, orgId, window.end < now ? window.end : now, { branchId })
  const [unpaid] = await unpaidPurchasesMany(tx, orgId, [window.end], { branchId })
  const adjustments = await pendingCommissionAdjustments(tx, orgId, currency, branchId)
  const taxName = (await orgTaxes(tx, orgId))?.name ?? null

  const cobrado = (index: number): number => inCurrency(collected[index], currency)?.cents ?? 0
  /** La parte de lo cobrado que es impuesto (ADR 0083): no es de la clínica. */
  const taxOf = (index: number): number => inCurrency(collected[index], currency)?.taxCents ?? 0
  const spent = (index: number): ExpenseTotals =>
    inCurrency(expenses[index], currency) ?? { currency, totalCents: 0, byCategory: [], commissionPaidCents: 0, purchasePaidCents: 0, salesTaxPaidCents: 0 }
  const generated = (index: number): number => sumOf(commissions[index], (item) => item.commissionCents)
  /** Los demás gastos: sin el pago de comisiones ni el del impuesto de lo cobrado. */
  const otherExpenses = (index: number): number => spent(index).totalCents - spent(index).commissionPaidCents - spent(index).salesTaxPaidCents
  /** Lo que deja: lo cobrado menos su impuesto, las comisiones generadas y los demás gastos. */
  const leaves = (index: number): number => cobrado(index) - taxOf(index) - generated(index) - otherExpenses(index)
  const tramo = (index: number) => ({
    cobradoCents: cobrado(index),
    taxCents: taxOf(index),
    commissionCents: generated(index),
    otherExpensesCents: otherExpenses(index),
    leavesCents: leaves(index),
    /**
     * Lo cobrado menos todo lo gastado, también el pago de comisiones. Reportes ya
     * no lo muestra (un solo resultado del periodo, «Lo que deja»); Argos lo usa
     * para explicar por qué no coincide con lo que entró a la caja.
     */
    cashLeftCents: cobrado(index) - spent(index).totalCents,
  })
  const period = spent(0)
  const owedOverdue = (index: number): number =>
    (debts[index]?.ages ?? [])
      .filter((age) => age.key !== "0_30")
      .reduce((total, age) => total + age.cents, 0)
  // Por profesional (`commissionsMany`), también de quien ya dejó la clínica, como la tabla de Comisiones.
  const pending = (commissions[0] ?? []).map((item) => pendingOf(item, adjustments))

  return {
    ...reportHead(scope),
    /** «IGV», «IVA»: el nombre del impuesto de la clínica, o null si su país no tiene uno que separar. */
    taxName: taxName ?? (taxOf(0) > 0 ? "Impuesto" : null),
    months: months.map(serializeBucket),
    /** El periodo y el anterior (`previous` de la cabecera es su tramo). */
    totals: { current: tramo(0), previous: tramo(1) },
    /** Los 12 meses de cada línea pequeña. */
    trend: months.map((_, index) => tramo(index + 2)),
    /** Lo cobrado en otra moneda sin valor ni factor (filas viejas): no se puede sumar. Lo de hoy tiene su valor y ya está en las cifras. */
    otherCurrencies: (collected[0] ?? []).filter((item) => item.currency !== currency).map((item) => ({ currency: item.currency, cobradoCents: item.cents })),
    commissions: {
      generatedCents: generated(0),
      paidCents: sumOf(commissions[0], (item) => item.paidCents),
      /** Lo del periodo que aún no se paga, menos lo que hay que descontarle a cada uno. */
      pendingCents: pending.reduce((total, cents) => total + cents, 0),
      professionals: pending.filter((cents) => cents > 0).length,
      /** Lo nuevo del periodo aún sin registrar, antes de descuentos: si hay, algo queda por hacer en Comisiones. */
      freshCents: sumOf(commissions[0], (item) => item.freshCents),
    },
    /** La cascada: lo cobrado, las comisiones generadas y cada tipo de gasto que tuvo algo (sin el pago de comisiones). */
    cascade: {
      cobradoCents: cobrado(0),
      taxCents: taxOf(0),
      commissionCents: generated(0),
      categories: EXPENSE_CATEGORIES.map((category): { category: string; cents: number } => ({ category, cents: period.byCategory.find((item) => item.category === category)?.cents ?? 0 }))
        .concat(period.byCategory.filter((item) => !(EXPENSE_CATEGORIES as readonly string[]).includes(item.category)))
        .filter((item) => item.cents !== 0),
      purchasePaidCents: period.purchasePaidCents,
      commissionPaidCents: period.commissionPaidCents,
      /** El pago del impuesto de lo cobrado: sale de la caja, no resta de lo que deja. */
      salesTaxPaidCents: period.salesTaxPaidCents,
      leavesCents: leaves(0),
    },
    /** Cobrado, comisiones y otros gastos por tramo del periodo. */
    chart: buckets.map((bucket, index) => ({ ...serializeBucket(bucket), ...tramo(spans.length - buckets.length + index) })),
    debts: {
      current: debts[0],
      previousOverdueCents: owedOverdue(1),
      overdueCents: owedOverdue(0),
    },
    /**
     * Lo que debes al cerrar el periodo: comisiones por pagar, compras recibidas
     * sin pagar y el impuesto de lo cobrado en el periodo, que se paga el mes
     * siguiente (antes de descontarle el de las compras; no se acumula).
     */
    payables: {
      commissions: {
        ...(owedCommissions ?? { cents: 0, professionals: 0 }),
        /** Lo que se debe hoy (igual a `cents` en un periodo en curso). */
        nowCents: owedNow?.cents ?? 0,
      },
      salesTax: { cents: Math.max(0, taxOf(0)) },
      /** Gastos que se repiten, vencidos y sin pagar. */
      fixed: fixedOwed,
      purchases: purchasesDueOf(unpaid, scope.money),
    },
    missing: await missingExpenses(tx, orgId, scope),
    byMethod: await collectedByMethod(tx, orgId, window, { currency, branchId }),
    byTreatment: await collectedByTreatment(tx, orgId, window, { currency, branchId }),
  }
}

/**
 * Reportes › Finanzas › Comisiones: por profesional, lo que atendió, lo que se
 * cobró de eso, su porcentaje, su comisión y lo que falta pagarle; y lo que
 * atendió sin cobrar todavía. Cuadra con Finanzas › Comisiones.
 */
export async function getReportCommissions(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window, currency } = scope
  const branchId = scope.branch?.id
  const [current] = await commissionsMany(tx, orgId, [window], { currency, branchId })
  const adjustments = await pendingCommissionAdjustments(tx, orgId, currency, branchId)
  // Lo que atendió en el periodo (precio × cantidad) y lo que de eso sigue sin cobrar hoy.
  const attended = await tx.execute<{ userId: string; name: string; cents: string; unpaid: string }>(sql`
    select e.professional_user_id as "userId", u.name,
      round(sum(${todayValueSql(sql`ep.price_cents::bigint * ep.quantity`, sql`ep.currency`)}))::text as cents,
      round(sum(${todayValueSql(sql`case when ch.charges > 0 then ch.unpaid else ep.price_cents::bigint * ep.quantity end`, sql`ep.currency`)}))::text as unpaid
    from encounter_procedure ep
    join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
    join "user" u on u.id = e.professional_user_id
    cross join ${orgMoneySql(orgId)}
    left join lateral (
      -- Los cargos vigentes del procedimiento, juntos: con más de uno, lo atendido no se suma dos veces.
      select count(*) as charges, sum(greatest(c.amount_cents - coalesce(ap.applied, 0), 0)) as unpaid
      from patient_charge c
      left join lateral (
        select sum(a.amount_cents) as applied from patient_payment_application a
        where a.organization_id = c.organization_id and a.charge_id = c.id and a.voided_at is null
      ) ap on true
      where c.organization_id = ep.organization_id and c.encounter_procedure_id = ep.id and c.voided_at is null
    ) ch on true
    where ep.organization_id = ${orgId} and ep.voided_at is null and ep.price_cents is not null
      and (ep.currency = op.currency or ep.currency = op.second_currency)
      and e.status = 'finalizada' and e.voided_at is null
      and e.finalized_at >= ${at(window.start)} and e.finalized_at < ${at(window.end)}
      ${branchId ? sql`and e.branch_id = ${branchId}` : sql``}
    group by e.professional_user_id, u.name`)
  const rates = await tx.execute<{ userId: string; name: string; rateBps: number }>(sql`
    select r.professional_user_id as "userId", u.name, r.rate_bps as "rateBps" from commission_rule r
    join "user" u on u.id = r.professional_user_id
    where r.organization_id = ${orgId}`)
  const ids = [...new Set([...(current ?? []).map((row) => row.userId), ...attended.map((row) => row.userId), ...rates.map((row) => row.userId)])]
  const names = new Map<string, string>([...attended, ...rates].map((row) => [row.userId, row.name]))
  const missing = ids.filter((id) => !names.has(id))
  if (missing.length > 0) {
    const rows = await tx.execute<{ id: string; name: string }>(sql`select id, name from "user" where id in (${sql.join(missing.map((id) => sql`${id}`), sql`, `)})`)
    for (const row of rows) names.set(row.id, row.name)
  }
  const rows = ids
    .map((userId) => {
      const own = current?.find((row) => row.userId === userId)
      const work = attended.find((row) => row.userId === userId)
      return {
        userId,
        name: names.get(userId) ?? "",
        attendedCents: safeCents(work?.cents),
        unpaidCents: safeCents(work?.unpaid),
        collectedCents: own?.baseCents ?? 0,
        rateBps: rates.find((row) => row.userId === userId)?.rateBps ?? 0,
        commissionCents: own?.commissionCents ?? 0,
        paidCents: own?.paidCents ?? 0,
        pendingCents: own ? pendingOf(own, adjustments) : 0,
        /** Lo pagado de más que se descontará del próximo pago. */
        discountCents: adjustments.get(userId) ?? 0,
      }
    })
    // También quien solo cobró un pago del periodo (su cobro se anuló después): explica «Ya pagadas».
    .filter((row) => row.attendedCents + row.collectedCents + row.commissionCents + row.paidCents > 0)
    .sort((a, b) => b.attendedCents - a.attendedCents || b.collectedCents - a.collectedCents || a.name.localeCompare(b.name))
  return { ...reportHead(scope), rows }
}

/**
 * Reportes › Finanzas › lo que viene: lo aceptado por hacer (a hoy, de toda la
 * clínica) y cuánto vale un paciente nuevo en sus primeros 6 meses.
 */
export async function getReportOutlook(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  return {
    ...reportHead(scope),
    upcoming: await upcomingWork(tx, orgId, scope.currency, now),
    patientValue: await newPatientValue(tx, orgId, scope.window.end, { currency: scope.currency, branchId: scope.branch?.id }),
    /** Lo aceptado es de la persona, no de una sede. */
    wholeClinic: scope.branch ? (["upcoming"] as const) : ([] as const),
  }
}

// --- Qué dejó cada promoción ------------------------------------------------------------

/** Cómo le fue a una promoción, sin texto: las palabras las pone la pantalla. */
export type PromotionVerdict = "solo_bajo_precio" | "trajo_nuevos" | "volvieron" | "aceptaron"

/**
 * Qué dejó cada promoción en el periodo (2b): quiénes la usaron (un
 * presupuesto presentado o un cobro del periodo la lleva), cuántos eran nuevos
 * (sin una cita atendida antes de usarla), lo que pagaron desde entonces hasta
 * hoy, el descuento frente a la tarifa de lo aceptado o cobrado, cuántos
 * aceptaron, pagaron algo y volvieron por otro tratamiento sin ella. Más los
 * descuentos sueltos (una línea aceptada bajo tarifa sin promoción). De la
 * persona: no se filtra por sede.
 */
export async function getReportPromotions(tx: Db, orgId: string, query: ReportQuery, now: Date = new Date()) {
  const scope = await reportScope(tx, orgId, query, now)
  const { window } = scope
  const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
  const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
  // Cuenta lo que tiene valor: la moneda del negocio y su otra moneda, cada línea en la
  // suya (la cabecera del presupuesto no se lee). Una clínica de una moneda cuenta lo de
  // siempre, y lo descontado en la otra entra al cambio de hoy, como en Argos.
  const countedCurrency = (column: SQL): SQL => sql`(${column} = op.currency or ${column} = op.second_currency)`
  // Lo que se dejó de cobrar sale solo de lo aceptado (y de los cobros): un presupuesto
  // rechazado, pospuesto, reemplazado o cancelado no se cobra, y uno reemplazado no se
  // suma con su reemplazo.
  const acceptedLine = sql`b.status in ('aceptado','parcial') and i.decision = 'aceptado'`
  /** Lo que pagó la persona desde `from` hasta hoy, con el valor de cada pago, menos lo devuelto de esos mismos pagos: la misma cuenta por promoción y en el total. */
  const collectedSince = (patient: SQL, from: SQL): SQL => sql`
    coalesce((select sum(${paymentValueSql(sql`x.amount_cents`, "x")}) from patient_payment x where x.organization_id = ${orgId} and x.patient_id = ${patient}
      and x.voided_at is null and x.paid_at >= ${from} and x.paid_at < ${at(now)}), 0)
    - coalesce((select sum(${paymentValueSql(sql`r.amount_cents`, "x")}) from patient_payment_refund r join patient_payment x on x.organization_id = r.organization_id and x.id = r.payment_id
      where r.organization_id = ${orgId} and r.patient_id = ${patient} and x.voided_at is null
        and x.paid_at >= ${from} and r.refunded_at < ${at(now)}), 0)`
  const rows = await tx.execute<{
    promotionId: string
    name: string
    startsAt: Date | string | null
    endsAt: Date | string | null
    people: number
    fresh: number
    accepted: number
    paidSome: number
    returned: number
    discount: string
    collected: string
  }>(sql`
    with uses as (
      select i.promotion_id, b.patient_id, b.presented_at as at,
        case when ${acceptedLine} then ${todayValueSql(sql`greatest(coalesce(i.tariff_price_cents, i.price_cents) - i.price_cents, 0)::bigint * ${units}`, sql`i.currency::text`)} else 0 end as discount,
        (${acceptedLine}) as accepted
      from treatment_budget b
      join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budget)} and i.promotion_id is not null and i.price_cents is not null
      cross join ${orgMoneySql(orgId)}
      where b.organization_id = ${orgId} and ${countedCurrency(sql`i.currency::text`)} and b.status <> 'borrador'
        and b.presented_at >= ${at(window.start)} and b.presented_at < ${at(window.end)}
      union all
      select c.promotion_id::uuid, c.patient_id, c.created_at,
        ${todayValueSql(sql`greatest(coalesce(sc.price_cents::bigint * coalesce(ep.quantity, 1), c.amount_cents) - c.amount_cents, 0)`, sql`c.currency::text`)},
        true
      from patient_charge c
      left join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
      left join service_catalog sc on sc.organization_id = c.organization_id and sc.id = ep.service_id and sc.currency = c.currency
      cross join ${orgMoneySql(orgId)}
      where c.organization_id = ${orgId} and ${countedCurrency(sql`c.currency::text`)} and c.voided_at is null and c.budget_item_id is null
        and c.promotion_id ~ '^[0-9a-f]{8}-[0-9a-f-]{27}$'
        and c.created_at >= ${at(window.start)} and c.created_at < ${at(window.end)}
    ), person as (
      select promotion_id, patient_id, min(at) as first_at, sum(discount) as discount, bool_or(accepted) as accepted
      from uses group by promotion_id, patient_id
    ), judged as (
      select p.*,
        not exists (select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = p.patient_id
          and a.status = 'atendida' and a.starts_at < p.first_at) as fresh,
        ${collectedSince(sql`p.patient_id`, sql`p.first_at`)} as collected,
        exists (select 1 from patient_charge c where c.organization_id = ${orgId} and c.patient_id = p.patient_id and c.voided_at is null
          and c.created_at > p.first_at + interval '1 day' and c.promotion_id is distinct from p.promotion_id::text) as returned
      from person p cross join ${orgMoneySql(orgId)}
    )
    select j.promotion_id as "promotionId", pr.name, pr.starts_at as "startsAt", pr.ends_at as "endsAt",
      count(*)::int as people, count(*) filter (where j.fresh)::int as fresh,
      count(*) filter (where j.accepted)::int as accepted, count(*) filter (where j.collected > 0)::int as "paidSome",
      count(*) filter (where j.returned)::int as returned,
      round(sum(j.discount))::text as discount, round(sum(j.collected))::text as collected
    from judged j join promotion pr on pr.organization_id = ${orgId} and pr.id = j.promotion_id
    group by j.promotion_id, pr.name, pr.starts_at, pr.ends_at`)
  // Quiénes usaron alguna y lo que pagaron, sin contar dos veces a quien usó dos: lo
  // cobrado de cada persona corre desde la primera que usó.
  const [unique] = await tx.execute<{ people: number; fresh: number; collected: string }>(sql`
    with uses as (
      select b.patient_id, b.presented_at as at from treatment_budget b
      join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
        and i.option_id = ${budgetValueOptionSql(budget)} and i.promotion_id is not null and i.price_cents is not null
      cross join ${orgMoneySql(orgId)}
      where b.organization_id = ${orgId} and ${countedCurrency(sql`i.currency::text`)} and b.status <> 'borrador'
        and b.presented_at >= ${at(window.start)} and b.presented_at < ${at(window.end)}
      union all
      select c.patient_id, c.created_at from patient_charge c
      cross join ${orgMoneySql(orgId)}
      where c.organization_id = ${orgId} and ${countedCurrency(sql`c.currency::text`)} and c.voided_at is null and c.budget_item_id is null
        and c.promotion_id ~ '^[0-9a-f]{8}-[0-9a-f-]{27}$' and c.created_at >= ${at(window.start)} and c.created_at < ${at(window.end)}
    ), person as (select patient_id, min(at) as first_at from uses group by patient_id)
    select count(*)::int as people, count(*) filter (where not exists (
      select 1 from appointment a where a.organization_id = ${orgId} and a.patient_id = person.patient_id and a.status = 'atendida' and a.starts_at < person.first_at))::int as fresh,
      round(coalesce(sum(${collectedSince(sql`person.patient_id`, sql`person.first_at`)}), 0))::text as collected
    from person cross join ${orgMoneySql(orgId)}`)
  const [loose] = await tx.execute<{ count: number; cents: string }>(sql`
    select count(*)::int as count, round(coalesce(sum(${todayValueSql(sql`(i.tariff_price_cents - i.price_cents)::bigint * ${units}`, sql`i.currency::text`)}), 0))::text as cents
    from treatment_budget b
    join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
      and i.option_id = ${budgetValueOptionSql(budget)} and i.promotion_id is null
      and i.tariff_price_cents is not null and i.price_cents is not null and i.tariff_price_cents > i.price_cents
    cross join ${orgMoneySql(orgId)}
    where b.organization_id = ${orgId} and ${countedCurrency(sql`i.currency::text`)} and ${acceptedLine}
      and b.presented_at >= ${at(window.start)} and b.presented_at < ${at(window.end)}`)
  const promotions = rows
    .map((row) => {
      const verdict: PromotionVerdict =
        row.fresh === 0 && row.returned === 0 ? "solo_bajo_precio" : row.fresh > 0 ? "trajo_nuevos" : "volvieron"
      return {
        promotionId: row.promotionId,
        name: row.name,
        startsAt: row.startsAt ? new Date(row.startsAt).toISOString() : null,
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        people: row.people,
        fresh: row.fresh,
        accepted: row.accepted,
        paidSome: row.paidSome,
        returned: row.returned,
        discountCents: safeCents(row.discount),
        collectedCents: safeCents(row.collected),
        verdict,
      }
    })
    .sort((a, b) => b.people - a.people || a.name.localeCompare(b.name))
  return {
    ...reportHead(scope),
    promotions,
    people: unique?.people ?? 0,
    fresh: unique?.fresh ?? 0,
    discountCents: promotions.reduce((total, row) => total + row.discountCents, 0),
    /** Cada persona una vez, aunque haya usado dos promociones. */
    collectedCents: safeCents(unique?.collected),
    loose: { count: loose?.count ?? 0, cents: safeCents(loose?.cents) },
    /** Presupuestos y cobros son de la persona: no se filtra por sede. */
    wholeClinic: scope.branch ? (["promotions"] as const) : ([] as const),
  }
}

// --- Las listas detrás de las cifras ----------------------------------------------------

export const FINANCE_LISTS = ["debts_age_0_30", "debts_age_31_60", "debts_age_61_90", "debts_age_90_plus", "upcoming_unbooked"] as const
export type FinanceListKey = (typeof FINANCE_LISTS)[number]

export function isFinanceList(list: string): list is FinanceListKey {
  return (FINANCE_LISTS as readonly string[]).includes(list)
}

/** El tramo de antigüedad de cada lista: la misma cuenta de la cifra (`debtAgeSql`). */
const AGE_OF_LIST: Record<Exclude<FinanceListKey, "upcoming_unbooked">, DebtAge> = {
  debts_age_0_30: "0_30",
  debts_age_31_60: "31_60",
  debts_age_61_90: "61_90",
  debts_age_90_plus: "90_plus",
}

type FinanceListRow = {
  id: string
  at: string | Date
  patientId: string
  personName: string
  title: string | null
  professionalName: string | null
  branchName: string | null
  hasNextAppointment: boolean
  cents: string | null
  currency: string | null
  total: number
  /** «Aceptaron y no tienen cita»: lo aceptado por hacer, para agendarlo desde la fila. */
  planItemIds?: string[] | null
  /** El servicio de eso, si es uno solo: la reserva lo trae elegido. */
  serviceId?: string | null
}

/**
 * Las personas detrás de una cifra de Finanzas: quién debe en cada tramo de
 * antigüedad al cerrar el periodo (la misma consulta de la cifra) y quién tiene
 * algo aceptado por hacer sin una cita por venir que lo lleve (a hoy).
 */
export async function financeListRows(tx: Db, orgId: string, scope: ReportScope, list: FinanceListKey, limit: number, now: Date): Promise<FinanceListRow[]> {
  const nextAppointment = (patient: SQL): SQL => sql`exists (
    select 1 from appointment n where n.organization_id = ${orgId} and n.patient_id = ${patient}
      and n.starts_at > ${at(now)} and n.status in ('programada','confirmada'))`
  if (list === "upcoming_unbooked") {
    const budget = { id: sql`b.id`, organizationId: sql`b.organization_id` }
    const units = budgetLineUnitsSql({ billingMode: sql`i.billing_mode`, sessionsPlanned: sql`i.sessions_planned` })
    return [
      ...(await tx.execute<FinanceListRow>(sql`
        with pending as (
          select b.patient_id, i.currency::text as currency, max(coalesce(b.decided_at, b.presented_at)) as at, sum(i.price_cents::bigint * ${units}) as cents,
            string_agg(distinct i.title, ' · ') as title,
            array_agg(distinct pi.id::text) filter (where pi.id is not null) as plan_item_ids,
            -- Uno solo y en todos: si alguno no tiene servicio, la reserva no elige por la persona.
            case when count(distinct i.service_id) = 1 and bool_and(i.service_id is not null) then min(i.service_id::text) end as service_id
          from treatment_budget b
          join treatment_budget_item i on i.organization_id = b.organization_id and i.budget_id = b.id
            and i.option_id = ${budgetValueOptionSql(budget)} and i.decision = 'aceptado' and i.price_cents is not null
          join treatment_plan_item pi on pi.organization_id = i.organization_id and pi.id = i.plan_item_id
          where b.organization_id = ${orgId} and b.status in ('aceptado','parcial')
            and i.currency in (${scope.currency}, ${scope.money.secondCurrency ?? scope.currency})
            and ${lineToScheduleSql(now)}
          group by b.patient_id, i.currency
        )
        select case when x.currency = ${scope.currency} then x.patient_id::text else x.patient_id::text || ':' || x.currency end as id, x.at, x.patient_id as "patientId", pp.display_name as "personName", x.title,
          null::text as "professionalName", null::text as "branchName",
          -- Puede tener otra cita que no lo lleva: la fila lo dice.
          ${nextAppointment(sql`x.patient_id`)} as "hasNextAppointment",
          x.cents::text as cents, x.currency, count(*) over()::int as total,
          x.plan_item_ids as "planItemIds", x.service_id as "serviceId"
        from pending x
        join patient p on p.id = x.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
        order by x.cents desc, x.patient_id limit ${limit}`)),
    ]
  }
  const end = scope.window.end
  return [
    ...(await tx.execute<FinanceListRow>(sql`
      ${overdueDebtSql(orgId, [end], 0, scope.branch?.id)}
      select o.patient_id::text || ':' || o.currency as id, o.since as at, o.patient_id as "patientId", pp.display_name as "personName",
        null::text as title, null::text as "professionalName", null::text as "branchName",
        ${nextAppointment(sql`o.patient_id`)} as "hasNextAppointment",
        o.owed::text as cents, o.currency::text as currency, count(*) over()::int as total
      from overdue o
      join patient p on p.id = o.patient_id and p.organization_id = ${orgId} join contact pp on pp.organization_id = p.organization_id and pp.id = p.person_id
      where o.currency in (${scope.currency}, ${scope.money.secondCurrency ?? scope.currency}) and ${debtAgeSql(sql`o.since`, at(end), debtZoneSql(orgId, scope.branch?.id))} = ${AGE_OF_LIST[list]}
      order by o.since, o.patient_id limit ${limit}`)),
  ]
}
