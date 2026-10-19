/**
 * «Te deben hace más de 30 días» a una fecha: la misma regla que el saldo
 * vencido del Administrador (`overdueCollections`), contada como estaba en
 * cada momento. Una persona debe lo que suman sus conceptos vigentes menos lo
 * aplicado, menos lo que tenía a favor; entra si su concepto más antiguo sin
 * pagar se anotó hace más de `days` días. Sin cuotas con fecha: la deuda es el
 * saldo de la cuenta, como en Caja (decisión 22).
 *
 * Dos pasos, para que dos años de una clínica mediana sigan siendo rápidos:
 * primero el saldo de cada persona en cada momento (conceptos menos pagos más
 * devoluciones, sumas simples), que dice quién podría deber; después la regla
 * exacta, concepto por concepto, solo para esas personas. Cada paso va
 * materializado: la base estima mal cuántas personas deben y, sin eso, repite
 * el saldo a favor una vez por persona (minutos en vez de milisegundos). Con los datos en
 * regla (lo aplicado sale de pagos y conceptos vigentes) nadie que deba queda
 * fuera del primer paso: lo que debe menos lo que tiene a favor es su saldo.
 */
import { sql, type SQL } from "drizzle-orm"
import { at } from "./report-spans.js"

/** Plazo de «Te deben hace más de…», el mismo de la línea «Saldo vencido» por defecto. */
export const OVERDUE_DAYS = 30

/** Existía en ese momento y todavía no estaba anulado. */
function liveAt(alias: "a" | "c" | "p", column: "created_at" | "paid_at"): SQL {
  return sql.raw(`${alias}.${column} < m.at_moment and (${alias}.voided_at is null or ${alias}.voided_at >= m.at_moment)`)
}

/**
 * CTE `overdue(idx, patient_id, currency, owed, since)`: por cada momento
 * (`idx`), quién debía hace más de `days` días, cuánto y desde cuándo. La
 * sede filtra por la sede del concepto; lo que tiene a favor es de la persona.
 */
export function overdueDebtSql(orgId: string, moments: Date[], days: number, branchId?: string): SQL {
  const branch = branchId ? sql`and c.branch_id = ${branchId}` : sql``
  return sql`with m(idx, at_moment) as (
      values ${sql.join(
        moments.map((moment, index) => sql`(${index}::int, ${at(moment)})`),
        sql`, `,
      )}
    ), balance as materialized (
      -- Quién tenía saldo en contra en cada momento: los únicos que pueden deber.
      select m.idx, x.patient_id, x.currency
      from m join lateral (
        select c.patient_id, c.currency, c.amount_cents::bigint as cents from patient_charge c
        where c.organization_id = ${orgId} and ${liveAt("c", "created_at")}
        union all
        select p.patient_id, p.currency, -p.amount_cents::bigint from patient_payment p
        where p.organization_id = ${orgId} and ${liveAt("p", "paid_at")}
        union all
        select p.patient_id, p.currency, r.amount_cents::bigint from patient_payment_refund r
        join patient_payment p on p.organization_id = r.organization_id and p.id = r.payment_id
        where r.organization_id = ${orgId} and r.refunded_at < m.at_moment and ${liveAt("p", "paid_at")}
      ) x on true
      group by m.idx, x.patient_id, x.currency
      having sum(x.cents) > 0
    ), owed as materialized (
      select b.idx, c.patient_id, c.currency, sum(c.amount_cents - coalesce(ap.applied, 0)) as owed, min(c.created_at) as since
      from balance b join m on m.idx = b.idx
      join patient_charge c on c.organization_id = ${orgId} and c.patient_id = b.patient_id and c.currency = b.currency
        and ${liveAt("c", "created_at")} ${branch}
      left join lateral (
        select sum(a.amount_cents) as applied from patient_payment_application a
        where a.organization_id = c.organization_id and a.charge_id = c.id and ${liveAt("a", "created_at")}
      ) ap on true
      where c.amount_cents > coalesce(ap.applied, 0)
      group by b.idx, c.patient_id, c.currency
    ), owed_payment as materialized (
      -- Los pagos que existían de quienes deben: de ahí sale lo que tenían a favor.
      select o.idx, p.patient_id, p.currency, p.id, p.amount_cents
      from owed o join m on m.idx = o.idx
      join patient_payment p on p.organization_id = ${orgId} and p.patient_id = o.patient_id and p.currency = o.currency and ${liveAt("p", "paid_at")}
    ), payment_used as materialized (
      select op.idx, op.id, sum(a.amount_cents) as amount
      from owed_payment op join m on m.idx = op.idx
      join patient_payment_application a on a.organization_id = ${orgId} and a.payment_id = op.id and ${liveAt("a", "created_at")}
      group by op.idx, op.id
    ), payment_refunded as materialized (
      select op.idx, op.id, sum(r.amount_cents) as amount
      from owed_payment op join m on m.idx = op.idx
      join patient_payment_refund r on r.organization_id = ${orgId} and r.payment_id = op.id and r.refunded_at < m.at_moment
      group by op.idx, op.id
    ), credit as materialized (
      select op.idx, op.patient_id, op.currency, sum(op.amount_cents - coalesce(u.amount, 0) - coalesce(rf.amount, 0)) as credit
      from owed_payment op
      left join payment_used u on u.idx = op.idx and u.id = op.id
      left join payment_refunded rf on rf.idx = op.idx and rf.id = op.id
      group by op.idx, op.patient_id, op.currency
    ), overdue as materialized (
      -- Deuda y saldo a favor se juntan sumando, no cruzando: la base estima mal
      -- cuántas filas son y un cruce compararía a cada deudor con todos.
      select z.idx, z.patient_id, z.currency, (sum(z.owed) - greatest(sum(z.credit), 0))::bigint as owed, min(z.since) as since
      from (
        select idx, patient_id, currency, owed, since, 0::bigint as credit from owed
        union all
        select idx, patient_id, currency, 0, null::timestamptz, credit from credit
      ) z
      join m on m.idx = z.idx
      group by z.idx, z.patient_id, z.currency, m.at_moment
      having sum(z.owed) > 0 and min(z.since) < m.at_moment - make_interval(days => ${days})
        and sum(z.owed) > greatest(sum(z.credit), 0)
    )`
}
