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
 * - Lo que se le paga al personal (el tipo «Personal», con persona o sin ella: el nombre
 *   también puede ir en el concepto) lo ve, lo anota, lo paga y lo cambia solo quien
 *   administra comisiones (`commissions.write`), como lo que se le paga de comisión
 *   (PR 486). Los demás ven «Sueldos» en una sola fila, sin a quién: los ingresos son
 *   un dato sensible (Ley 29733, art. 2, num. 5; QA de Gastos del 8 nov, S1; ADR 0166,
 *   que cambia lo que decía el ADR 0150). Como con una comisión, el importe de cada pago
 *   sigue en Caja y en Argos, sin a quién.
 */
import { type MoneyFraction, roundMoneyValue, sumMoneyValues } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import { member, user } from "@odentia/db/schema/auth"
import { expense, expenseRecurring, expenseRecurringSkip, RECURRING_EVERY_MONTHS } from "@odentia/db/schema/finance"
import { auditEvent, branch } from "@odentia/db/schema/org"
import { organizationPaymentMethod } from "@odentia/db/schema/org-payments"
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { invalidField, isUniqueViolation, notFound, ServiceError, validation } from "./errors.js"
import {
  addMonthKey,
  dueDayIn,
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
import {
  createExpense,
  type CreateExpenseInput,
  EXPENSE_CATEGORIES,
  lockOrgUnit,
  lockRequest,
  replayedExpense,
  requestKey,
  requestReused,
  requireBranch,
  SALARY_PAYMENT_CONCEPT,
} from "./finance.js"
import { getOrgLocale } from "./locale.js"
import { currentMonthIn, reportDayOf } from "./report-periods.js"
import { orgMoneyOf } from "./report-value.js"

export { RECURRING_EVERY_MONTHS }

/** Hasta cuántos meses atrás se dice lo vencido sin pagar: una plantilla olvidada no acumula para siempre. */
export const RECURRING_OVERDUE_MONTHS = 12

/** El tipo de gasto que puede llevar persona: el sueldo de la decisión 6. */
const SALARY_CATEGORY = "Personal"

/** Cómo ve los sueldos quien no administra comisiones: una fila, sin a quién. */
export const SALARIES_CONCEPT = "Sueldos"

/**
 * Quien mira o actúa: `seesPeople` es quien administra comisiones (`commissions.write`) y por
 * eso ve y paga el sueldo de cada persona. Sin decirlo, no lo ve: es lo más protector.
 */
export interface PayViewer {
  seesPeople: boolean
}
const HIDDEN: PayViewer = { seesPeople: false }

function forbidden(message: string): ServiceError {
  return new ServiceError("FORBIDDEN", 403, message)
}

/** Lo del personal solo lo toca quien administra comisiones; lo demás, cualquiera de caja (ADR 0166). */
function requireSeesPerson(template: { category: string }, viewer: PayViewer): void {
  if (template.category === SALARY_CATEGORY && !viewer.seesPeople)
    throw forbidden("Lo que se le paga al personal lo ven, lo anotan y lo pagan quienes administran las comisiones")
}

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

async function lockTemplate(tx: Db, orgId: string, id: string, viewer: PayViewer = HIDDEN): Promise<RecurringTemplate> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound("Gasto que se repite")
  const [row] = await tx
    .select()
    .from(expenseRecurring)
    .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.id, id)))
    .for("update")
  if (!row) throw notFound("Gasto que se repite")
  requireSeesPerson(row, viewer)
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
   * noviembre es de octubre. Sin él, el de la fecha del gasto (o el de hoy, si aún no se pagó).
   */
  month?: string | null
  /**
   * Ya se pagó el de ese mes (lo de siempre). `false` lo anota sin registrar ningún gasto: queda
   * por pagar desde ese mes. Nunca se registra dinero que nadie pagó (ADR 0150).
   */
  paid?: boolean
  /** Se paga al mes siguiente (el sueldo de noviembre, el 2 de diciembre). */
  dueNextMonth?: boolean
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
  viewer: PayViewer = HIDDEN,
) {
  const { repeat, ...expenseInput } = input
  // El mismo formulario enviado dos veces (un corte) devuelve lo que ya anotó (ADR 0018, G2); el
  // mismo formulario con otra cosa es un error, no lo anotado antes como si fuera esto.
  const requestId = requestKey(expenseInput.requestId)
  if (requestId) {
    await lockRequest(tx, "expense", orgId, requestId)
    const [replay] = await tx
      .select()
      .from(expenseRecurring)
      .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.requestId, requestId)))
    if (replay) {
      requireSeesPerson(replay, viewer)
      const [paidRow] = await tx
        .select()
        .from(expense)
        .where(and(eq(expense.organizationId, orgId), eq(expense.requestId, requestId)))
      const same =
        replay.branchId === expenseInput.branchId &&
        replay.category === (expenseInput.category?.trim() || "Otros") &&
        replay.concept === expenseInput.concept.trim() &&
        replay.amountCents === expenseInput.amountCents &&
        replay.everyMonths === repeat.everyMonths &&
        replay.day === repeat.day &&
        replay.memberUserId === (repeat.memberUserId?.trim() || null) &&
        replay.dueNextMonth === (repeat.dueNextMonth === true) &&
        (repeat.month == null || replay.firstMonth === repeat.month) &&
        (paidRow !== undefined && paidRow.voidedAt === null) === (repeat.paid !== false)
      if (!same) throw requestReused()
      return paidRow ? { ...paidRow, expense: paidRow, recurring: replay } : { expense: null, recurring: replay }
    }
  }
  const everyMonths = everyOf(repeat.everyMonths)
  const day = dayOf(repeat.day)
  const category = expenseInput.category?.trim() || "Otros"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw invalidField("category", "Tipo de gasto inválido")
  if (expenseInput.salesTax)
    throw invalidField("repeat", "El impuesto de lo cobrado cambia cada mes: regístralo cada vez")
  requireSeesPerson({ category }, viewer)
  const memberUserId = repeat.memberUserId?.trim() || null
  if (memberUserId) {
    if (category !== SALARY_CATEGORY) throw invalidField("repeat.memberUserId", "Solo un gasto de Personal es de una persona")
    await requireTeamMember(tx, orgId, memberUserId, "repeat.memberUserId")
  }
  const branchRow = await requireBranch(tx, orgId, expenseInput.branchId)
  const unit = await lockOrgUnit(tx, orgId, expenseInput.currency)
  const { timezone } = await getOrgLocale(tx, orgId)
  const paid = repeat.paid !== false
  const spentAt = paid && expenseInput.spentAt ? new Date(expenseInput.spentAt) : new Date()
  if (!Number.isFinite(spentAt.getTime())) throw invalidField("spentAt", "Fecha ISO inválida")
  // El mes de la fecha del gasto (o de hoy, si aún no se paga): el pago es de ese mes o del anterior.
  const spentMonth = reportDayOf(timezone, spentAt).slice(0, 7)
  const firstMonth = repeat.month?.trim() || spentMonth
  if (!isMonthKey(firstMonth)) throw invalidField("repeat.month", "El mes debe tener formato AAAA-MM")
  const now = currentMonthIn(timezone)
  const current = monthKey(now.year, now.month)
  if (firstMonth !== current && firstMonth !== addMonthKey(current, -1))
    throw invalidField(
      "repeat.month",
      "Para que se repita, registra el pago de este mes o del anterior. Lo de antes, anótalo como gasto suelto.",
    )
  if (paid && firstMonth !== spentMonth && firstMonth !== addMonthKey(spentMonth, -1))
    throw invalidField(
      "repeat.month",
      "Un gasto pagado ese día es el pago de su mes o del anterior: revisa la fecha o el mes.",
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
      // El medio con que se pagó, si se dijo: es el que se propone la próxima vez.
      fromCash: expenseInput.paymentMethodId
        ? (await recurringMethod(tx, orgId, expenseInput.paymentMethodId)).typeCode === "10"
        : expenseInput.fromCash === true,
      paymentMethodId: expenseInput.paymentMethodId ?? null,
      dueNextMonth: repeat.dueNextMonth === true,
      requestId,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, template.id, "finance.expense_recurring_created", {
    firstMonth,
    everyMonths,
    day,
    paid,
    dueNextMonth: template.dueNextMonth,
  })
  // Aún no se paga: queda anotado y por pagar desde ese mes, sin ningún gasto.
  if (!paid) return { expense: null, recurring: template }
  const row = await createExpense(
    tx,
    orgId,
    actorUserId,
    { ...expenseInput, category },
    {
      recurringId: template.id,
      recurringMonth: firstMonth,
      ...(category === SALARY_CATEGORY ? { cashConcept: SALARY_PAYMENT_CONCEPT } : {}),
    },
    viewer,
  )
  return { ...row, expense: row, recurring: template }
}

export interface NoteRecurringInput {
  branchId: string
  category?: string
  concept: string
  /** Lo de siempre: lo que se propone cada vez que toca pagar. */
  amountCents: number
  currency?: string
  everyMonths: number
  day: number
  /**
   * El primer mes que se paga (`YYYY-MM`). Sin él, el primero cuyo día aún no pasó: anotar el
   * alquiler el 9 con el día 1 empieza el mes que viene, y lo de este mes, si se debe, se paga como
   * un gasto. Puede ser el mes pasado (una deuda que se anota) y hasta un año adelante.
   */
  firstMonth?: string | null
  memberUserId?: string | null
  dueNextMonth?: boolean
  /** Con qué se suele pagar: se propone al pagar. Opcional. */
  paymentMethodId?: string | null
  requestId?: string | null
}

/** El medio activo de la clínica que se propone al pagar lo que se repite. */
async function recurringMethod(tx: Db, orgId: string, id: string, field = "paymentMethodId") {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw invalidField(field, "Elige con qué se paga")
  const [method] = await tx
    .select({ id: organizationPaymentMethod.id, typeCode: organizationPaymentMethod.typeCode })
    .from(organizationPaymentMethod)
    .where(
      and(
        eq(organizationPaymentMethod.organizationId, orgId),
        eq(organizationPaymentMethod.id, id),
        eq(organizationPaymentMethod.isActive, true),
      ),
    )
  if (!method) throw invalidField(field, "Ese medio ya no está activo: elige otro")
  return method
}

/**
 * «Anotar lo que se repite» (ADR 0167; QA de Gastos, UX 4): la plantilla sola, desde su sección y no
 * desde «Registrar gasto». Anotar no paga: queda «por pagar» cada vez que toca, y nunca se registra
 * dinero que nadie pagó (ADR 0150).
 */
export async function noteRecurringExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  input: NoteRecurringInput,
  viewer: PayViewer = HIDDEN,
  now: Date = new Date(),
) {
  const category = input.category?.trim() || "Otros"
  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw invalidField("category", "Tipo de gasto inválido")
  requireSeesPerson({ category }, viewer)
  const requestId = requestKey(input.requestId)
  if (requestId) {
    await lockRequest(tx, "expense", orgId, requestId)
    const [replay] = await tx
      .select()
      .from(expenseRecurring)
      .where(and(eq(expenseRecurring.organizationId, orgId), eq(expenseRecurring.requestId, requestId)))
    if (replay) {
      if (
        replay.branchId !== input.branchId ||
        replay.concept !== input.concept.trim() ||
        replay.amountCents !== input.amountCents ||
        replay.day !== input.day ||
        replay.everyMonths !== input.everyMonths ||
        replay.category !== category ||
        (input.firstMonth != null && replay.firstMonth !== input.firstMonth) ||
        replay.paymentMethodId !== (input.paymentMethodId ?? null)
      )
        throw requestReused()
      return replay
    }
  }
  const everyMonths = everyOf(input.everyMonths, "everyMonths")
  const day = dayOf(input.day, "day")
  const memberUserId = input.memberUserId?.trim() || null
  if (memberUserId) {
    if (category !== SALARY_CATEGORY) throw invalidField("memberUserId", "Solo un gasto de Personal es de una persona")
    await requireTeamMember(tx, orgId, memberUserId, "memberUserId")
  }
  const branchRow = await requireBranch(tx, orgId, input.branchId)
  const unit = await lockOrgUnit(tx, orgId, input.currency)
  const { timezone } = await getOrgLocale(tx, orgId)
  const today = reportDayOf(timezone, now)
  const current = today.slice(0, 7)
  const dueNextMonth = input.dueNextMonth === true
  // El primero que aún no vence: este mes si su día no pasó, si no el que sigue.
  const dueOn = (month: string) => {
    const due = dueNextMonth ? addMonthKey(month, 1) : month
    return `${due}-${String(dueDayIn(day, due)).padStart(2, "0")}`
  }
  const firstMonth = input.firstMonth?.trim() || (dueOn(current) >= today ? current : addMonthKey(current, 1))
  if (!isMonthKey(firstMonth)) throw invalidField("firstMonth", "El mes debe tener formato AAAA-MM")
  if (firstMonth < addMonthKey(current, -1) || firstMonth > addMonthKey(current, 12))
    throw invalidField("firstMonth", "Elige un mes desde el pasado hasta dentro de un año")
  const method = input.paymentMethodId ? await recurringMethod(tx, orgId, input.paymentMethodId) : null
  const [template] = await tx
    .insert(expenseRecurring)
    .values({
      organizationId: orgId,
      branchId: branchRow.id,
      category,
      concept: conceptOf(input.concept),
      amountCents: centsOf(input.amountCents),
      currency: unit,
      everyMonths,
      day,
      firstMonth,
      memberUserId,
      fromCash: method?.typeCode === "10",
      paymentMethodId: method?.id ?? null,
      dueNextMonth,
      requestId,
      createdBy: actorUserId,
    })
    .returning()
  await audit(tx, orgId, actorUserId, template.id, "finance.expense_recurring_created", {
    firstMonth,
    everyMonths,
    day,
    paid: false,
    dueNextMonth,
  })
  return template
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
  /** Con qué se suele pagar; `null` lo quita. */
  paymentMethodId?: string | null
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
  viewer: PayViewer = HIDDEN,
) {
  const current = await lockTemplate(tx, orgId, id, viewer)
  const next: Partial<typeof expenseRecurring.$inferInsert> = {}
  if (input.concept !== undefined) next.concept = conceptOf(input.concept)
  if (input.amountCents !== undefined) next.amountCents = centsOf(input.amountCents)
  if (input.day !== undefined) next.day = dayOf(input.day, "day")
  if (input.fromCash !== undefined) next.fromCash = input.fromCash
  if (input.paymentMethodId !== undefined) {
    const method = input.paymentMethodId ? await recurringMethod(tx, orgId, input.paymentMethodId) : null
    next.paymentMethodId = method?.id ?? null
    // Lo de antes que lee `from_cash` sigue de acuerdo con el medio.
    if (method) next.fromCash = method.typeCode === "10"
  }
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
  // El importe se compara con lo que se propone pagar, no con la plantilla: después de «Pagar otro
  // importe» se propone ese, y volver al de siempre (el de la plantilla) sí es un cambio.
  if (next.amountCents !== undefined && after.amountCents === undefined) {
    const suggested = (await suggestedAmounts(tx, orgId, [current])).get(current.id) ?? current.amountCents
    if (suggested !== next.amountCents) {
      before.amountCents = suggested
      after.amountCents = next.amountCents
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
 * «Dejar de repetir»: deja de repetirse desde el mes que viene. Lo vencido sin
 * pagar y lo de este mes siguen por pagar: son deudas, se dicen y no se borran
 * (ADR 0150, «lo vencido sin pagar entra en "Lo que debes"»; QA de Gastos, G3).
 * Si este mes no hubo, se marca «No hubo este mes». Termina en el último mes
 * resuelto (pagado o «este mes no»), en el último por pagar hasta hoy o en este
 * mes, el que sea después; sin ninguno, antes del primero. Lo anotado este mes y
 * nunca resuelto termina antes del primero: era un error o ya no va. Devuelve el
 * fin que tenía, para «Deshacer», y lo que sigue por pagar.
 */
export async function endRecurringExpense(
  tx: Db,
  orgId: string,
  actorUserId: string,
  id: string,
  viewer: PayViewer = HIDDEN,
) {
  const current = await lockTemplate(tx, orgId, id, viewer)
  const zone = await getOrgLocale(tx, orgId)
  const today = reportDayOf(zone.timezone, new Date())
  const currentKey = today.slice(0, 7)
  const pending = (
    await loadOccurrences(tx, orgId, {
      from: addMonthKey(currentKey, -RECURRING_OVERDUE_MONTHS),
      to: addMonthKey(currentKey, 1),
      templateIds: [id],
    })
  ).filter((item) => !item.paid && !item.skipped)
  const resolved = await lastResolvedMonth(tx, orgId, id)
  // Anotado este mes (en la zona de la clínica), nunca resuelto y sin nada vencido: un error o algo
  // que ya no va. Lo vencido, aunque se haya anotado hoy (una deuda), sigue por pagar.
  const justNoted =
    resolved === null &&
    reportDayOf(zone.timezone, current.createdAt).slice(0, 7) === currentKey &&
    pending.every((item) => item.dueOn >= today)
  // Lo por pagar hasta este mes: lo vencido y lo de este mes, aunque aún no venza (el sueldo de
  // quien se va a fin de mes). Lo de meses que no llegan no se debe.
  const owed = justNoted
    ? []
    : pending
        .filter((item) => item.month <= currentKey)
        .map((item) => item.month)
        .sort()
  const ends = [resolved, owed.at(-1) ?? null].filter((month): month is string => month !== null).sort()
  const lastMonth = ends.at(-1) ?? addMonthKey(current.firstMonth, -1)
  const row = await updateRecurringExpense(tx, orgId, actorUserId, id, { lastMonth }, viewer)
  return { id, lastMonth: row.lastMonth, previousLastMonth: current.lastMonth, stillDue: owed }
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
  /** La clave del cajón de pago: el reintento devuelve el mismo pago (ADR 0018). */
  requestId?: string | null
  /** Con qué se pagó (ADR 0167); sin él, el de la plantilla. */
  paymentMethodId?: string | null
  paymentReference?: string | null
  receiptType?: string | null
  supplierId?: string | null
  supplierName?: string | null
  supplierTaxId?: string | null
  /** El cambio de este pago, si es en la otra moneda; sin él, el de hoy. */
  exchangeRate?: string
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
  viewer: PayViewer = HIDDEN,
) {
  const template = await lockTemplate(tx, orgId, id, viewer)
  await requireOccurrence(tx, orgId, template, input.month)
  const suggested = (await suggestedAmounts(tx, orgId, [template])).get(template.id) ?? template.amountCents
  // Con qué se paga: lo que se dijo; si no, el medio de la plantilla mientras siga activo, y si no, la
  // casilla de antes.
  const templateMethod =
    !input.paymentMethodId && input.fromCash === undefined && template.paymentMethodId
      ? await tx
          .select({ id: organizationPaymentMethod.id })
          .from(organizationPaymentMethod)
          .where(
            and(
              eq(organizationPaymentMethod.organizationId, orgId),
              eq(organizationPaymentMethod.id, template.paymentMethodId),
              eq(organizationPaymentMethod.isActive, true),
            ),
          )
          .then((rows) => rows[0]?.id)
      : undefined
  const paymentMethodId = input.paymentMethodId ?? templateMethod
  const replay = await replayedExpense(
    tx,
    orgId,
    {
      requestId: input.requestId,
      branchId: template.branchId,
      amountCents: input.amountCents ?? suggested,
      concept: template.concept,
      ...(paymentMethodId ? { paymentMethodId } : {}),
    },
    { recurringId: template.id, recurringMonth: input.month },
  )
  if (replay) return { ...replay, fromCash: replay.shiftId !== null }
  const paid = await paymentOf(tx, orgId, id, input.month)
  if (paid) throw await alreadyPaid(tx, orgId, paid)
  if (await skipOf(tx, orgId, id, input.month))
    throw conflict("RECURRING_SKIPPED", "Marcaste que ese mes no hubo: deshazlo para pagarlo")
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
        ...(input.exchangeRate !== undefined ? { exchangeRate: input.exchangeRate } : {}),
        ...(paymentMethodId ? { paymentMethodId } : {}),
        paymentReference: input.paymentReference,
        receiptType: input.receiptType,
        supplierId: input.supplierId,
        supplierName: input.supplierName,
        supplierTaxId: input.supplierTaxId,
        spentAt: input.spentAt ?? null,
        receiptKind: input.receiptKind,
        receiptNumber: input.receiptNumber,
        notes: input.notes,
        requestId: input.requestId,
      },
      {
        recurringId: template.id,
        recurringMonth: input.month,
        ...(template.category === SALARY_CATEGORY ? { cashConcept: SALARY_PAYMENT_CONCEPT } : {}),
      },
      viewer,
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
  viewer: PayViewer = HIDDEN,
) {
  const template = await lockTemplate(tx, orgId, id, viewer)
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
  viewer: PayViewer = HIDDEN,
) {
  await lockTemplate(tx, orgId, id, viewer)
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
  /** Con qué se suele pagar: se propone al pagar (ADR 0167). */
  paymentMethodId: string | null
  everyMonths: number
  /**
   * Varios sueldos juntos, para quien no administra comisiones: cuántos son. No se pagan
   * desde esta fila (lo hace quien los ve). Nulo en una fila de un solo gasto.
   */
  group: number | null
}

/**
 * Los sueldos de cada persona en una fila por mes y moneda, sin a quién ni cuánto a cada uno
 * (S1). El id es del grupo: no lleva a ninguna plantilla.
 */
function groupSalaries<
  T extends { category: string; memberUserId: string | null; memberName: string | null; amountCents: number; currency: string },
>(
  rows: T[],
  keyOf: (row: T) => string,
  merge: (first: T, key: string) => T,
): T[] {
  const out: T[] = []
  const groups = new Map<string, T & { group: number }>()
  for (const row of rows) {
    if (row.category !== SALARY_CATEGORY) {
      out.push(row)
      continue
    }
    const key = `${keyOf(row)}|${row.currency}`
    const seen = groups.get(key)
    if (seen) {
      seen.amountCents += row.amountCents
      seen.group += 1
      continue
    }
    const first = { ...merge(row, key), memberUserId: null, memberName: null, group: 1 }
    groups.set(key, first)
    out.push(first)
  }
  return out
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
  viewer: PayViewer = HIDDEN,
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
  // Vencido es lo que ya pasó su día: lo que se paga al mes siguiente no vence en su propio mes.
  const overdue = (item: Occurrence) => item.dueOn < today

  // Lo que sigue repitiéndose en la sede, para «Ver todo lo que se repite».
  const active = await tx
    .select()
    .from(expenseRecurring)
    .where(
      and(
        eq(expenseRecurring.organizationId, orgId),
        ...(query.branchId ? [eq(expenseRecurring.branchId, query.branchId)] : []),
        // Lo que termina este mes ya no se repite: sale de la lista (lo que falte pagar de este mes
        // sigue en «Por pagar»).
        sql`(${expenseRecurring.lastMonth} is null or ${expenseRecurring.lastMonth} > ${currentKey})`,
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
      paymentMethodId: item.template.paymentMethodId,
      everyMonths: item.template.everyMonths,
      group: null as number | null,
    }))
    .sort(
      (a, b) =>
        Number(b.overdue) - Number(a.overdue) ||
        a.dueOn.localeCompare(b.dueOn) ||
        a.concept.localeCompare(b.concept),
    )
  const templates = active.map((template) => ({
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
    paymentMethodId: template.paymentMethodId,
    dueNextMonth: template.dueNextMonth,
    nextMonth: nextOf(template),
    group: null as number | null,
  }))
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
    due: viewer.seesPeople
      ? due
      : groupSalaries(due, (row) => row.month, (row, key) => ({
          ...row,
          recurringId: `sueldos:${key}`,
          concept: SALARIES_CONCEPT,
          fromCash: false,
          paymentMethodId: null,
        })),
    templates: viewer.seesPeople
      ? templates
      : groupSalaries(templates, (row) => `${row.branchId}|${row.everyMonths}`, (row, key) => ({
          ...row,
          id: `sueldos:${key}`,
          concept: SALARIES_CONCEPT,
          fromCash: false,
          paymentMethodId: null,
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
 * vigente pagado antes de ese momento. Al cambio de hoy: aún se debe. También
 * por sede (`byBranch`): Gastos se mira por sede, y el enlace lleva a la suya.
 */
export async function fixedOwedAt(
  tx: Db,
  orgId: string,
  at: Date,
  options: { branchId?: string } = {},
): Promise<{
  cents: number
  count: number
  byBranch: Array<{ branchId: string; branchName: string; cents: number; count: number }>
}> {
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
  const branchIds = [...new Set(owed.map((item) => item.template.branchId))]
  const names = new Map(
    branchIds.length
      ? (
          await tx
            .select({ id: branch.id, name: branch.name })
            .from(branch)
            .where(and(eq(branch.organizationId, orgId), inArray(branch.id, branchIds)))
        ).map((row) => [row.id, row.name])
      : [],
  )
  const byBranch = branchIds
    .map((id) => {
      const own = owed.filter((item) => item.template.branchId === id)
      return { branchId: id, branchName: names.get(id) ?? "", cents: occurrencesCents(own, money), count: own.length }
    })
    .sort((a, b) => b.cents - a.cents || a.branchName.localeCompare(b.branchName))
  return { cents: occurrencesCents(owed, money), count: owed.length, byBranch }
}
