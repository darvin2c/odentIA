/**
 * Gastos que se repiten (QA de comisiones, entrega 8; ADR 0150): el alquiler,
 * los sueldos y los servicios se anotan una vez y aparecen «por pagar» cada mes.
 *
 * - Una plantilla dice cada cuántos meses (1, 6 o 12), qué día y desde qué mes.
 *   Lo que hay por pagar se calcula al leer (`expense-recurring-occurrences.ts`):
 *   nada se registra solo ni corre de fondo.
 * - Pagar es un toque: bloquea la plantilla, comprueba que el mes le toque y no
 *   esté pagado ni marcado «este mes no», y registra el gasto con
 *   `createExpense` y el enlace. Un índice único parcial impide pagar dos veces
 *   el mismo mes; anular ese gasto lo deja otra vez por pagar.
 * - Registrar un gasto con «Se repite» crea la plantilla y deja ese gasto como
 *   su primera ocurrencia: nunca aparece «vencido» lo que ya se pagó.
 * - Escribir es de `finance.write` y leer de `finance.read` (lo decide la ruta).
 *   Caja ve el sueldo con el nombre de la persona: es quien lo paga.
 */
import { type MoneyFraction, roundMoneyValue, sumMoneyValues } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { expense, expenseRecurring, expenseRecurringSkip, RECURRING_EVERY_MONTHS } from "@odentia/db/schema/finance"
import { auditEvent } from "@odentia/db/schema/org"
import { and, asc, eq, isNull, sql } from "drizzle-orm"
import { invalidField, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import {
  addMonthKey,
  isMonthKey,
  loadOccurrences,
  monthIndex,
  monthKey,
  nextOccurrence,
  type Occurrence,
  occurrencesCents,
  occurrenceValue,
  occursIn,
  type RecurringTemplate,
  suggestedAmounts,
  userNamesOf,
} from "./expense-recurring-occurrences.js"
import { createExpense, type CreateExpenseInput, EXPENSE_CATEGORIES, lockOrgUnit, requireBranch } from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { currentMonthIn, reportDayOf } from "./report-periods.js"
import { orgMoneyOf } from "./report-value.js"

export { RECURRING_EVERY_MONTHS }

/** Hasta cuántos meses atrás se dice lo vencido sin pagar: una plantilla olvidada no acumula para siempre. */
export const RECURRING_OVERDUE_MONTHS = 12

/** El tipo de gasto que puede llevar persona: el sueldo de la decisión 6. */
const SALARY_CATEGORY = "Personal"

function conflict(code: string, message: string): ServiceError {
  return new ServiceError(code, 409, message)
}

async function audit(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  action: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx
    .insert(auditEvent)
    .values({ organizationId: orgId, actorUserId, entity: "expense_recurring", entityId: id, action, metadata: metadata ?? null })
}

function everyOf(value: number, field = "repeat.everyMonths"): number {
  if (!(RECURRING_EVERY_MONTHS as readonly number[]).includes(value))
    throw invalidField(field, "Elige cada mes, cada 6 meses o cada año")
  return value
}

function dayOf(value: number, field = "repeat.day"): number {
  if (!Number.isInteger(value) || value < 1 || value > 31) throw invalidField(field, "Escribe un día del 1 al 31")
  return value
}

function conceptOf(value: string, field = "concept"): string {
  const text = value?.trim()
  if (!text || text.length > 500) throw invalidField(field, "El concepto debe tener 1–500 caracteres")
  return text
}

function centsOf(value: number, field = "amountCents"): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647)
    throw invalidField(field, "El importe debe ser un entero mayor que cero")
  return value
}

/** Quien recibe un sueldo es del equipo hoy (lo ya anotado de alguien que se fue se conserva). */
async function requireTeamMember(tx: Db, orgId: string, userId: string, field: string): Promise<void> {
  const [row] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1)
  if (!row) throw invalidField(field, "Esa persona no es del equipo")
}

async function lockTemplate(tx: Db, orgId: string, id: string): Promise<RecurringTemplate> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Gasto que se repite")
  const [row] = await tx
    .select()
    .from(expenseRecurring)
    .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.id, id)))
    .for("update")
  if (!row) throw notFound("Gasto que se repite")
  return row
}

/** «3 nov»: el día con el mes corto, en el formato de la clínica. */
function shortDay(at: Date, locale: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: timezone })
    .format(at)
    .replace(/\./g, "")
}

// --- Escribir ---------------------------------------------------------------------------------

export interface RepeatInput {
  everyMonths: number
  day: number
  /** De quién es: solo con el tipo «Personal». */
  memberUserId?: string | null
  /**
   * El mes que paga este gasto (`YYYY-MM`): el sueldo de octubre pagado el 2 de
   * noviembre es de octubre. Sin él, el de la fecha del gasto.
   */
  month?: string | null
}

/**
 * Registrar un gasto que se repite: la plantilla y este gasto como su primera
 * ocurrencia, en un solo paso. El mes de la primera ocurrencia es el que paga
 * (cada 6 meses y cada año toman ese mes), y solo puede ser este mes o el
 * anterior: empezar antes dejaría por pagar meses que quizá ya se pagaron como
 * gastos sueltos, y se pagarían dos veces.
 */
export async function registerRecurringExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: CreateExpenseInput & { repeat: RepeatInput },
) {
  const { repeat, ...expenseInput } = input
  const everyMonths = everyOf(repeat.everyMonths)
  const day = dayOf(repeat.day)
  const category = expenseInput.category?.trim() || "Otros"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw invalidField("category", "Tipo de gasto inválido")
  if (expenseInput.salesTax)
    throw invalidField("repeat", "El impuesto de lo cobrado cambia cada mes: regístralo cada vez")
  const memberUserId = repeat.memberUserId?.trim() || null
  if (memberUserId) {
    if (category !== SALARY_CATEGORY) throw invalidField("repeat.memberUserId", "Solo un gasto de Personal es de una persona")
    await requireTeamMember(tx, orgId, memberUserId, "repeat.memberUserId")
  }
  const branchRow = await requireBranch(tx, orgId, expenseInput.branchId)
  const unit = await lockOrgUnit(tx, orgId, expenseInput.currency)
  const { timezone } = await getOrgLocale(tx, orgId)
  const spentAt = expenseInput.spentAt ? new Date(expenseInput.spentAt) : new Date()
  if (!Number.isFinite(spentAt.getTime())) throw invalidField("spentAt", "Fecha ISO inválida")
  const firstMonth = repeat.month?.trim() || reportDayOf(timezone, spentAt).slice(0, 7)
  if (!isMonthKey(firstMonth)) throw invalidField("repeat.month", "El mes debe tener formato AAAA-MM")
  const now = currentMonthIn(timezone)
  const current = monthKey(now.year, now.month)
  if (firstMonth !== current && firstMonth !== addMonthKey(current, -1))
    throw invalidField(
      "repeat.month",
      "Para que se repita, registra el pago de este mes o del anterior. Lo de antes, anótalo como gasto suelto.",
    )
  const [template] = await tx
    .insert(expenseRecurring)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      category,
      concept: conceptOf(expenseInput.concept),
      amountCents: centsOf(expenseInput.amountCents),
      currency: unit,
      everyMonths,
      day,
      firstMonth,
      memberUserId,
      fromCash: expenseInput.fromCash === true,
      createdBy: actorUserId,
    })
    .returning()
  const row = await createExpense(tx, orgId, actorUserId, { ...expenseInput, category }, {
    recurringId: template.id,
    recurringMonth: firstMonth,
  })
  await audit(tx, orgId, actorUserId, template.id, "finance.expense_recurring_created", { firstMonth, everyMonths, day })
  return { ...row, recurring: template }
}

export interface UpdateRecurringInput {
  concept?: string
  amountCents?: number
  day?: number
  /** Solo para confirmar la misma: la persona de un sueldo no se cambia (sería cambiar el pasado). */
  memberUserId?: string | null
  fromCash?: boolean
  /** El último mes con ocurrencia (`YYYY-MM`) o `null` para que vuelva a repetirse («Deshacer»). */
  lastMonth?: string | null
}

/** El último mes ya resuelto (pagado o «este mes no»), o null si ninguno. */
async function lastResolvedMonth(tx: Db, orgId: string, id: string): Promise<string | null> {
  const [settled] = await tx.execute<{ month: string | null }>(sql`
    select max(month) as month from (
      select recurring_month as month from expense
        where organization_id = ${orgId} and recurring_id = ${id} and voided_at is null
      union all
      select month from expense_recurring_skip
        where organization_id = ${orgId} and recurring_id = ${id} and voided_at is null
    ) resolved`)
  return settled?.month ?? null
}

/**
 * «Cambiar lo que se repite»: vale desde el próximo pago; lo ya pagado son gastos
 * y no cambia. Cada cuánto, la moneda, el tipo, la sede y la persona no se
 * cambian: es dejar de repetir esta y crear otra (la persona del sueldo de un mes
 * pagado se lee de la plantilla). El fin no queda antes de un mes ya resuelto.
 * La auditoría guarda antes y después.
 */
export async function updateRecurringExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: UpdateRecurringInput,
) {
  const current = await lockTemplate(tx, orgId, id)
  const next: Partial<typeof expenseRecurring.$inferInsert> = {}
  if (input.concept !== undefined) next.concept = conceptOf(input.concept)
  if (input.amountCents !== undefined) next.amountCents = centsOf(input.amountCents)
  if (input.day !== undefined) next.day = dayOf(input.day, "day")
  if (input.fromCash !== undefined) next.fromCash = input.fromCash
  if (input.memberUserId !== undefined && (input.memberUserId?.trim() || null) !== current.memberUserId)
    throw invalidField(
      "memberUserId",
      "La persona no se cambia: deja de repetir este gasto y anota otro con la persona nueva",
    )
  if (input.lastMonth !== undefined) {
    if (input.lastMonth !== null && !isMonthKey(input.lastMonth)) throw invalidField("lastMonth", "El mes debe tener formato AAAA-MM")
    const resolved = input.lastMonth === null ? null : await lastResolvedMonth(tx, orgId, id)
    if (input.lastMonth !== null && resolved && input.lastMonth < resolved)
      throw invalidField("lastMonth", "Ya hay meses pagados después: el fin no puede quedar antes")
    if (input.lastMonth !== null && input.lastMonth < addMonthKey(current.firstMonth, -1))
      throw invalidField("lastMonth", "El fin no puede quedar antes del primer mes")
    next.lastMonth = input.lastMonth
  }
  const before: Record<string, unknown> = {}
  const after: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next)) {
    const old = current[key as keyof RecurringTemplate]
    if (old !== value) {
      before[key] = old
      after[key] = value
    }
  }
  if (Object.keys(after).length === 0) return current
  // Lo que se propone pagar es el último pago hecho después del último cambio. Un cambio
  // que no toca el importe (el concepto, el día, el fin) deja fijo el que se proponía,
  // para que «Pagar» no vuelva al importe con que se creó.
  if (next.amountCents === undefined) {
    const suggested = (await suggestedAmounts(tx, orgId, [current])).get(current.id) ?? current.amountCents
    if (suggested !== current.amountCents) next.amountCents = suggested
  }
  const [row] = await tx
    .update(expenseRecurring)
    // La hora de la base, como la del gasto con que se compara.
    .set({ ...next, updatedAt: sql`now()` })
    .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.id, id)))
    .returning()
  await audit(tx, orgId, actorUserId, id, "finance.expense_recurring_updated", { before, after })
  return row
}

/**
 * «Dejar de repetir»: ya no aparece por pagar y lo pagado queda en Gastos. Termina
 * en el último mes resuelto (pagado o marcado «este mes no»); sin ninguno, antes
 * del primero. Devuelve el fin que tenía, para «Deshacer».
 */
export async function endRecurringExpense(tx: Db, orgId: string, actorUserId: string, id: string) {
  const current = await lockTemplate(tx, orgId, id)
  const lastMonth = (await lastResolvedMonth(tx, orgId, id)) ?? addMonthKey(current.firstMonth, -1)
  const row = await updateRecurringExpense(tx, orgId, actorUserId, id, { lastMonth })
  // Lo de antes del fin que quedó sin pagar sigue por pagar: se dice, no se borra.
  const { timezone } = await getOrgLocale(tx, orgId)
  const now = currentMonthIn(timezone)
  const stillDue =
    row.lastMonth === null
      ? []
      : (
          await loadOccurrences(tx, orgId, {
            from: addMonthKey(monthKey(now.year, now.month), -RECURRING_OVERDUE_MONTHS),
            to: row.lastMonth,
            templateIds: [id],
          })
        )
          .filter((item) => !item.paid && !item.skipped)
          .map((item) => item.month)
  return { id, lastMonth: row.lastMonth, previousLastMonth: current.lastMonth, stillDue }
}

async function paymentOf(tx: Db, orgId: string, id: string, month: string) {
  const [paid] = await tx
    .select({ id: expense.id, spentAt: expense.spentAt, createdBy: expense.createdBy })
    .from(expense)
    .where(
      and(
        eq(expense.organizationId, orgId),
        eq(expense.recurringId, id),
        eq(expense.recurringMonth, month),
        isNull(expense.voidedAt),
      ),
    )
    .limit(1)
  return paid ?? null
}

async function skipOf(tx: Db, orgId: string, id: string, month: string) {
  const [row] = await tx
    .select({ id: expenseRecurringSkip.id })
    .from(expenseRecurringSkip)
    .where(
      and(
        eq(expenseRecurringSkip.organizationId, orgId),
        eq(expenseRecurringSkip.recurringId, id),
        eq(expenseRecurringSkip.month, month),
        isNull(expenseRecurringSkip.voidedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

/** «Ya se pagó el 3 nov, por Ana»: quién y cuándo, para que nadie pague dos veces. */
async function alreadyPaid(tx: Db, orgId: string, paid: { spentAt: Date; createdBy: string | null }): Promise<ServiceError> {
  const { locale, timezone } = await getOrgLocale(tx, orgId)
  const names = await userNamesOf(tx, [paid.createdBy])
  const who = paid.createdBy ? names.get(paid.createdBy) : undefined
  return conflict(
    "RECURRING_ALREADY_PAID",
    `Ya se pagó el ${shortDay(paid.spentAt, locale, timezone)}${who ? `, por ${who}` : ""}`,
  )
}

/** El mes pedido es de la plantilla y ya llegó. */
async function requireOccurrence(tx: Db, orgId: string, template: RecurringTemplate, month: string): Promise<void> {
  if (!isMonthKey(month)) throw invalidField("month", "El mes debe tener formato AAAA-MM")
  if (!occursIn(template, month)) throw invalidField("month", "Ese mes no le toca a este gasto")
  const { timezone } = await getOrgLocale(tx, orgId)
  const now = currentMonthIn(timezone)
  if (monthIndex(month) > monthIndex(monthKey(now.year, now.month)))
    throw conflict("RECURRING_NOT_YET", "Ese mes aún no llega: se paga cuando llegue")
}

export interface PayRecurringInput {
  month: string
  /** Otro importe («Pagar otro importe»); sin él, el que se propone. */
  amountCents?: number
  fromCash?: boolean
  spentAt?: string | null
  receiptKind?: string
  receiptNumber?: string | null
  notes?: string | null
}

/**
 * Pagar una ocurrencia con un toque. La plantilla queda bloqueada mientras se
 * paga: dos toques o dos personas de caja se esperan en fila y el segundo recibe
 * quién y cuándo la pagó. Si la caja no alcanza, lo dice `createExpense` (en el
 * campo `fromCash`) y no se paga nada.
 */
export async function payRecurringOccurrence(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: PayRecurringInput,
) {
  const template = await lockTemplate(tx, orgId, id)
  await requireOccurrence(tx, orgId, template, input.month)
  const paid = await paymentOf(tx, orgId, id, input.month)
  if (paid) throw await alreadyPaid(tx, orgId, paid)
  if (await skipOf(tx, orgId, id, input.month))
    throw conflict("RECURRING_SKIPPED", "Marcaste que ese mes no hubo: deshazlo para pagarlo")
  const suggested = (await suggestedAmounts(tx, orgId, [template])).get(template.id) ?? template.amountCents
  try {
    const row = await createExpense(
      tx,
      orgId,
      actorUserId,
      {
        branchId: template.branchId,
        category: template.category,
        concept: template.concept,
        amountCents: input.amountCents ?? suggested,
        currency: template.currency,
        fromCash: input.fromCash ?? template.fromCash,
        spentAt: input.spentAt ?? null,
        receiptKind: input.receiptKind,
        receiptNumber: input.receiptNumber,
        notes: input.notes,
      },
      { recurringId: template.id, recurringMonth: input.month },
    )
    await audit(tx, orgId, actorUserId, id, "finance.expense_recurring_paid", { month: input.month, expenseId: row.id })
    return { ...row, fromCash: row.shiftId !== null }
  } catch (error) {
    // El bloqueo de la plantilla ya pone en fila a quien paga: esto es solo el último resguardo.
    if (isUniqueViolation(error)) throw conflict("RECURRING_ALREADY_PAID", "Ese mes ya se pagó")
    throw error
  }
}

/** «No hubo este mes»: la ocurrencia deja de estar por pagar sin un gasto. Repetirlo no hace nada. */
export async function skipRecurringOccurrence(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { month: string },
) {
  const template = await lockTemplate(tx, orgId, id)
  await requireOccurrence(tx, orgId, template, input.month)
  const paid = await paymentOf(tx, orgId, id, input.month)
  if (paid) throw await alreadyPaid(tx, orgId, paid)
  const existing = await skipOf(tx, orgId, id, input.month)
  if (existing) return { recurringId: id, month: input.month, skipped: true }
  await tx
    .insert(expenseRecurringSkip)
    .values({ organizationId: orgId, recurringId: id, month: input.month, createdBy: actorUserId })
  await audit(tx, orgId, actorUserId, id, "finance.expense_recurring_skipped", { month: input.month })
  return { recurringId: id, month: input.month, skipped: true }
}

/** «Deshacer» de «No hubo este mes»: vuelve a estar por pagar. */
export async function unskipRecurringOccurrence(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  input: { month: string },
) {
  await lockTemplate(tx, orgId, id)
  if (!isMonthKey(input.month)) throw invalidField("month", "El mes debe tener formato AAAA-MM")
  const rows = await tx
    .update(expenseRecurringSkip)
    .set({ voidedAt: new Date(), voidedBy: actorUserId })
    .where(
      and(
        eq(expenseRecurringSkip.organizationId, orgId),
        eq(expenseRecurringSkip.recurringId, id),
        eq(expenseRecurringSkip.month, input.month),
        isNull(expenseRecurringSkip.voidedAt),
      ),
    )
    .returning({ id: expenseRecurringSkip.id })
  if (rows.length > 0) await audit(tx, orgId, actorUserId, id, "finance.expense_recurring_unskipped", { month: input.month })
  return { recurringId: id, month: input.month, skipped: false }
}

// --- Leer -------------------------------------------------------------------------------------

export interface RecurringDue {
  recurringId: string
  month: string
  /** El día de la plantilla (puede ser 31); `dueDay` es el de este mes. */
  day: number
  dueDay: number
  dueOn: string
  /** Pasó su día sin pagarse (o es de un mes anterior). */
  overdue: boolean
  concept: string
  category: string
  memberUserId: string | null
  memberName: string | null
  /** Lo que se propone pagar: el último importe que se fijó. */
  amountCents: number
  currency: string
  fromCash: boolean
  everyMonths: number
}

/**
 * Finanzas › Gastos: lo que se repite de un mes.
 *
 * - `due`: lo por pagar de ese mes y, si es el mes en curso, lo vencido sin pagar
 *   de hasta 12 meses atrás («De octubre: Internet»). Lo vencido primero.
 * - `fixed`: «Lo fijo del mes», lo que cae en ese mes (lo de cada 6 meses o cada
 *   año cuenta entero en su mes; no se reparte), sin lo marcado «este mes no». Lo
 *   pagado con el valor de su gasto; lo que falta, al cambio de hoy.
 * - `templates`: todo lo que sigue repitiéndose, también lo que no cae este mes.
 */
export async function getRecurringMonth(
  tx: Db,
  orgId: string,
  query: { year: number; month: number; branchId?: string },
  now: Date = new Date(),
) {
  if (!Number.isInteger(query.year) || query.year < 2000 || query.year > 2100) throw validation("Año inválido")
  if (!Number.isInteger(query.month) || query.month < 1 || query.month > 12) throw validation("Mes inválido")
  const zone = await getOrgLocale(tx, orgId)
  const money = orgMoneyOf(zone)
  const today = reportDayOf(zone.timezone, now)
  const currentKey = today.slice(0, 7)
  const key = monthKey(query.year, query.month)
  const isCurrent = key === currentKey
  const from = isCurrent ? addMonthKey(key, -RECURRING_OVERDUE_MONTHS) : key
  const occurrences = await loadOccurrences(tx, orgId, { from, to: key, branchId: query.branchId })
  const ofMonth = occurrences.filter((item) => item.month === key && !item.skipped)
  const pending = occurrences.filter((item) => !item.paid && !item.skipped)
  const overdue = (item: Occurrence) => item.month < currentKey || (item.month === currentKey && item.dueOn < today)

  // Lo que sigue repitiéndose en la sede, para «Ver todo lo que se repite».
  const active = await tx
    .select()
    .from(expenseRecurring)
    .where(
      and(
        eq(expenseRecurring.organizationId, orgId),
        ...(query.branchId ? [eq(expenseRecurring.branchId, query.branchId)] : []),
        sql`(${expenseRecurring.lastMonth} is null or ${expenseRecurring.lastMonth} >= ${currentKey})`,
      ),
    )
    .orderBy(asc(expenseRecurring.day), asc(expenseRecurring.concept))
  const suggested = await suggestedAmounts(tx, orgId, active)
  // «Toca en…»: si lo de este mes ya se pagó o no hubo, el siguiente.
  const thisMonth = isCurrent
    ? occurrences.filter((item) => item.month === currentKey)
    : await loadOccurrences(tx, orgId, { from: currentKey, to: currentKey, branchId: query.branchId })
  const settledNow = new Set(thisMonth.filter((item) => item.paid || item.skipped).map((item) => item.template.id))
  const nextOf = (template: RecurringTemplate) =>
    nextOccurrence(template, settledNow.has(template.id) ? addMonthKey(currentKey, 1) : currentKey)
  const names = await userNamesOf(tx, [
    ...occurrences.map((item) => item.template.memberUserId),
    ...active.map((template) => template.memberUserId),
  ])

  const due: RecurringDue[] = pending
    .map((item) => ({
      recurringId: item.template.id,
      month: item.month,
      day: item.template.day,
      dueDay: item.dueDay,
      dueOn: item.dueOn,
      overdue: overdue(item),
      concept: item.template.concept,
      category: item.template.category,
      memberUserId: item.template.memberUserId,
      memberName: item.template.memberUserId ? (names.get(item.template.memberUserId) ?? null) : null,
      amountCents: item.suggestedCents,
      currency: item.template.currency,
      fromCash: item.template.fromCash,
      everyMonths: item.template.everyMonths,
    }))
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        a.dueOn.localeCompare(b.dueOn) ||
        a.concept.localeCompare(b.concept),
    )
  const values = (list: Occurrence[]): Array<MoneyFraction | null> => list.map((item) => occurrenceValue(item, money))
  const paidOfMonth = ofMonth.filter((item) => item.paid)
  const dueOfMonth = ofMonth.filter((item) => !item.paid)
  return {
    year: query.year,
    month: query.month,
    currency: zone.currency,
    timezone: zone.timezone,
    today,
    fixed: {
      /** Lo que cae en el mes; la suma redondeada una vez, como el total de Gastos. */
      totalCents: roundMoneyValue(sumMoneyValues(values(ofMonth))),
      paidCents: occurrencesCents(paidOfMonth, money),
      dueCents: occurrencesCents(dueOfMonth, money),
      count: ofMonth.length,
    },
    due,
    templates: active.map((template) => ({
      id: template.id,
      branchId: template.branchId,
      category: template.category,
      concept: template.concept,
      amountCents: suggested.get(template.id) ?? template.amountCents,
      currency: template.currency,
      everyMonths: template.everyMonths,
      day: template.day,
      firstMonth: template.firstMonth,
      lastMonth: template.lastMonth,
      memberUserId: template.memberUserId,
      memberName: template.memberUserId ? (names.get(template.memberUserId) ?? null) : null,
      fromCash: template.fromCash,
      nextMonth: nextOf(template),
    })),
  }
}

export type RecurringMonth = Awaited<ReturnType<typeof getRecurringMonth>>

/** Quiénes pueden tener un sueldo anotado: el equipo de hoy, por nombre. */
export async function listRecurringPeople(tx: Db, orgId: string) {
  const rows = await tx
    .select({ userId: member.userId, name: user.name })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId))
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Lo fijo vencido y sin pagar a un momento (Reportes › Lo que debes): ocurrencias
 * de hasta 12 meses atrás cuyo día ya pasó, sin «este mes no» y sin un gasto
 * vigente pagado antes de ese momento. Al cambio de hoy: aún se debe.
 */
export async function fixedOwedAt(
  tx: Db,
  orgId: string,
  at: Date,
  options: { branchId?: string } = {},
): Promise<{ cents: number; count: number }> {
  const zone = await getOrgLocale(tx, orgId)
  const money = orgMoneyOf(zone)
  const day = reportDayOf(zone.timezone, at)
  const key = day.slice(0, 7)
  const list = (
    await loadOccurrences(tx, orgId, {
      from: addMonthKey(key, -RECURRING_OVERDUE_MONTHS),
      to: key,
      branchId: options.branchId,
    })
  ).filter((item) => !item.skipped && item.dueOn < day && !(item.paid && item.paid.spentAt < at))
  // Lo pagado después de ese momento aún se debía entonces: cuenta con lo que se propone pagar.
  const owed = list.map((item) => ({ ...item, paid: null }))
  return { cents: occurrencesCents(owed, money), count: owed.length }
}
