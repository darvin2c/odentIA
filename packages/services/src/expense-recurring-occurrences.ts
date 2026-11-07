/**
 * Las ocurrencias de un gasto que se repite, calculadas al leer: no hay filas por
 * mes ni trabajo de fondo. Lo puro (qué meses tocan, qué día vence) se prueba sin
 * base; la lectura une cada ocurrencia con su pago (el gasto vigente con
 * `recurring_id` y `recurring_month`) y con su «este mes no».
 *
 * Vive aparte de `expense-recurring.ts` porque lo leen también las comisiones
 * (`finance.ts`, el sueldo del mes) y Reportes, y ese archivo escribe con
 * `createExpense`: así ninguno importa al otro en círculo.
 */
import { type MoneyFraction, roundMoneyValue, sumMoneyValues } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { user } from "@odentia/db/schema/auth"
import { expense, expenseRecurring, expenseRecurringSkip } from "@odentia/db/schema/finance"
import { and, desc, eq, gte, inArray, isNull, lte, type SQL } from "drizzle-orm"
import { type OrgMoney, orgPartValue, todayValueCents } from "./report-value.js"

export type RecurringTemplate = typeof expenseRecurring.$inferSelect

/** Mes `YYYY-MM`. */
export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`
}

export function isMonthKey(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

/** Meses desde el año 0: para restar y comparar meses sin fechas. */
export function monthIndex(key: string): number {
  const [year, month] = key.split("-").map(Number)
  return (year ?? 0) * 12 + (month ?? 1) - 1
}

export function keyOfIndex(index: number): string {
  return monthKey(Math.floor(index / 12), (index % 12) + 1)
}

export function addMonthKey(key: string, delta: number): string {
  return keyOfIndex(monthIndex(key) + delta)
}

/** ¿Le toca a la plantilla el mes `key`? Desde su primer mes, cada `every_months`, hasta su fin. */
export function occursIn(
  template: Pick<RecurringTemplate, "firstMonth" | "lastMonth" | "everyMonths">,
  key: string,
): boolean {
  const at = monthIndex(key)
  const first = monthIndex(template.firstMonth)
  if (at < first) return false
  if (template.lastMonth !== null && at > monthIndex(template.lastMonth)) return false
  return (at - first) % template.everyMonths === 0
}

/** El día en que vence en ese mes: el pedido o, si el mes no lo tiene, el último (el 31 de febrero es el 28 o el 29). */
export function dueDayIn(day: number, key: string): number {
  const [year, month] = key.split("-").map(Number)
  const last = new Date(Date.UTC(year ?? 2000, month ?? 1, 0)).getUTCDate()
  return Math.min(day, last)
}

/** Los meses de la plantilla entre `from` y `to` (incluidos). */
export function occurrenceMonths(
  template: Pick<RecurringTemplate, "firstMonth" | "lastMonth" | "everyMonths">,
  from: string,
  to: string,
): string[] {
  const out: string[] = []
  for (let at = monthIndex(from); at <= monthIndex(to); at += 1) {
    const key = keyOfIndex(at)
    if (occursIn(template, key)) out.push(key)
  }
  return out
}

/** El próximo mes que le toca desde `from`, o `null` si ya terminó. */
export function nextOccurrence(
  template: Pick<RecurringTemplate, "firstMonth" | "lastMonth" | "everyMonths">,
  from: string,
): string | null {
  let at = Math.max(monthIndex(from), monthIndex(template.firstMonth))
  const offset = (at - monthIndex(template.firstMonth)) % template.everyMonths
  if (offset !== 0) at += template.everyMonths - offset
  if (template.lastMonth !== null && at > monthIndex(template.lastMonth)) return null
  return keyOfIndex(at)
}

/** El pago de una ocurrencia: el gasto vigente que la enlaza. */
export interface OccurrencePayment {
  expenseId: string
  amountCents: number
  currency: string
  businessCents: number | null
  spentAt: Date
  createdAt: Date
  createdBy: string | null
}

export interface Occurrence {
  template: RecurringTemplate
  month: string
  dueDay: number
  /** `YYYY-MM-DD` del día en que vence. */
  dueOn: string
  paid: OccurrencePayment | null
  skipped: boolean
  /** Lo que se propone pagar si aún no se paga: el último importe que se fijó (al pagar o al cambiar la plantilla). */
  suggestedCents: number
}

export interface OccurrenceFilter {
  from: string
  to: string
  branchId?: string
  memberUserId?: string
  templateIds?: string[]
}

/**
 * Las ocurrencias de `from` a `to` de las plantillas de la clínica (de una sede,
 * de una persona o las pedidas), con su pago y su «este mes no».
 */
export async function loadOccurrences(tx: Db, orgId: string, filter: OccurrenceFilter): Promise<Occurrence[]> {
  const where: SQL[] = [eq(expenseRecurring.organizationId, orgId)]
  if (filter.branchId) where.push(eq(expenseRecurring.branchId, filter.branchId))
  if (filter.memberUserId) where.push(eq(expenseRecurring.memberUserId, filter.memberUserId))
  if (filter.templateIds) {
    if (filter.templateIds.length === 0) return []
    where.push(inArray(expenseRecurring.id, filter.templateIds))
  }
  const templates = await tx.select().from(expenseRecurring).where(and(...where))
  const months = new Map(templates.map((template) => [template.id, occurrenceMonths(template, filter.from, filter.to)]))
  const live = templates.filter((template) => (months.get(template.id)?.length ?? 0) > 0)
  if (live.length === 0) return []
  const ids = live.map((template) => template.id)
  const paid = await tx
    .select({
      expenseId: expense.id,
      recurringId: expense.recurringId,
      month: expense.recurringMonth,
      amountCents: expense.amountCents,
      currency: expense.currency,
      businessCents: expense.businessCents,
      spentAt: expense.spentAt,
      createdAt: expense.createdAt,
      createdBy: expense.createdBy,
    })
    .from(expense)
    .where(
      and(
        eq(expense.organizationId, orgId),
        inArray(expense.recurringId, ids),
        isNull(expense.voidedAt),
        gte(expense.recurringMonth, filter.from),
        lte(expense.recurringMonth, filter.to),
      ),
    )
  const skips = await tx
    .select({ recurringId: expenseRecurringSkip.recurringId, month: expenseRecurringSkip.month })
    .from(expenseRecurringSkip)
    .where(
      and(
        eq(expenseRecurringSkip.organizationId, orgId),
        inArray(expenseRecurringSkip.recurringId, ids),
        isNull(expenseRecurringSkip.voidedAt),
        gte(expenseRecurringSkip.month, filter.from),
        lte(expenseRecurringSkip.month, filter.to),
      ),
    )
  const suggested = await suggestedAmounts(tx, orgId, live)
  const paidOf = new Map(paid.map((row) => [`${row.recurringId}|${row.month}`, row]))
  const skipped = new Set(skips.map((row) => `${row.recurringId}|${row.month}`))
  const out: Occurrence[] = []
  for (const template of live) {
    for (const month of months.get(template.id) ?? []) {
      const payment = paidOf.get(`${template.id}|${month}`)
      const dueDay = dueDayIn(template.day, month)
      out.push({
        template,
        month,
        dueDay,
        dueOn: `${month}-${String(dueDay).padStart(2, "0")}`,
        paid: payment
          ? {
              expenseId: payment.expenseId,
              amountCents: payment.amountCents,
              currency: payment.currency,
              businessCents: payment.businessCents,
              spentAt: payment.spentAt,
              createdAt: payment.createdAt,
              createdBy: payment.createdBy,
            }
          : null,
        skipped: skipped.has(`${template.id}|${month}`),
        suggestedCents: suggested.get(template.id) ?? template.amountCents,
      })
    }
  }
  return out
}

/**
 * Lo que se propone pagar de cada plantilla: el importe del último pago si se hizo
 * después del último cambio de la plantilla, y si no, el de la plantilla. Así la
 * luz de este mes propone la del mes pasado y «Cambiar lo que se repite» manda
 * desde que se guarda.
 */
export async function suggestedAmounts(tx: Db, orgId: string, templates: RecurringTemplate[]): Promise<Map<string, number>> {
  const out = new Map(templates.map((template) => [template.id, template.amountCents]))
  if (templates.length === 0) return out
  const rows = await tx
    .selectDistinctOn([expense.recurringId], {
      recurringId: expense.recurringId,
      amountCents: expense.amountCents,
      currency: expense.currency,
      createdAt: expense.createdAt,
    })
    .from(expense)
    .where(
      and(
        eq(expense.organizationId, orgId),
        inArray(
          expense.recurringId,
          templates.map((template) => template.id),
        ),
        isNull(expense.voidedAt),
      ),
    )
    .orderBy(expense.recurringId, desc(expense.createdAt))
  for (const row of rows) {
    const template = templates.find((item) => item.id === row.recurringId)
    if (template && row.currency === template.currency && row.createdAt > template.updatedAt)
      out.set(template.id, row.amountCents)
  }
  return out
}

/** Lo que vale una ocurrencia en moneda del negocio: lo pagado con su valor congelado; lo que falta, al cambio de hoy. */
export function occurrenceValue(occurrence: Occurrence, money: OrgMoney): MoneyFraction | null {
  if (occurrence.paid) return orgPartValue(occurrence.paid.amountCents, occurrence.paid, money)
  const today = todayValueCents(occurrence.suggestedCents, occurrence.template.currency, money)
  return today === null ? null : { num: BigInt(today), den: 1n }
}

/** Suma redondeada una vez, sobre el total. */
export function occurrencesCents(list: Occurrence[], money: OrgMoney): number {
  return roundMoneyValue(sumMoneyValues(list.map((item) => occurrenceValue(item, money))))
}

export async function userNamesOf(tx: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))]
  if (unique.length === 0) return new Map()
  const rows = await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, unique))
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** El sueldo de una persona en un mes. */
export interface MonthSalary {
  /** Lo del mes, pagado o no, en moneda del negocio. */
  cents: number
  paidCents: number
  dueCents: number
  /** Cuándo se pagó lo último del mes (nulo si falta algo o nada se pagó). */
  paidAt: Date | null
  items: Array<{ recurringId: string; concept: string; cents: number; paidAt: Date | null }>
}

/**
 * El sueldo del mes de una persona (decisión 6): las ocurrencias de ese mes de sus
 * gastos que se repiten, pagadas o no. Cuenta el mes de la ocurrencia, no el día en
 * que se pagó: el sueldo de octubre pagado el 2 de noviembre es de octubre.
 * `null` si no tiene ninguno ese mes.
 */
export async function salaryOfMonth(
  tx: Db,
  orgId: string,
  userId: string,
  period: { year: number; month: number },
  money: OrgMoney,
): Promise<MonthSalary | null> {
  const key = monthKey(period.year, period.month)
  const list = (await loadOccurrences(tx, orgId, { from: key, to: key, memberUserId: userId })).filter(
    (item) => !item.skipped && item.template.category === "Personal",
  )
  if (list.length === 0) return null
  const paid = list.filter((item) => item.paid)
  const due = list.filter((item) => !item.paid)
  return {
    cents: occurrencesCents(list, money),
    paidCents: occurrencesCents(paid, money),
    dueCents: occurrencesCents(due, money),
    paidAt:
      due.length === 0
        ? paid.reduce<Date | null>((latest, item) => {
            const at = item.paid?.spentAt ?? null
            return at && (!latest || at > latest) ? at : latest
          }, null)
        : null,
    items: list.map((item) => ({
      recurringId: item.template.id,
      concept: item.template.concept,
      cents: occurrencesCents([item], money),
      paidAt: item.paid?.spentAt ?? null,
    })),
  }
}
