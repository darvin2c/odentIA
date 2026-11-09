/**
 * Finanzas › Gastos: lo que se repite y toca pagar (el alquiler, los sueldos, la
 * luz). «Pagar» abre el cajón del gasto ya lleno, con el importe y el medio de
 * siempre, y nada se paga sin verlo (ADR 0167, que cambia el «pagar es un toque»
 * del ADR 0150). «Lo fijo del mes» va dentro de la tarjeta del total, y «Lo que se
 * repite» lista todo, también lo que no toca este mes, para anotarlo, cambiarlo o
 * dejar de repetirlo.
 *
 * El servidor decide qué toca, qué venció y si ya se pagó (también si dos
 * personas tocan a la vez): aquí solo se presenta.
 */
import { currencyWord, formatMoney, formatMoneyInput } from "@odentia/clinical"
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, toast } from "@odentia/ui"
import { FormDrawer, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import {
  endRecurringApi,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_HINTS,
  expenseCategoryLabel,
  fetchRecurringMonth,
  fetchRecurringPeople,
  invalidateFinance,
  noteRecurringApi,
  parseAmount,
  type RecurringDue,
  type RecurringMonth,
  type RecurringTemplate,
  skipRecurringApi,
  todayIn,
  updateRecurringApi,
} from "../../lib/finance-cash"
import { fetchPaymentMethods } from "../../lib/finance-collect"
import { useTodayRate } from "../../lib/org"
import { currencyChoices } from "../../lib/product-words"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceChips } from "./cash-close-drawer"
import { PaymentMethodButtons } from "./collect-drawer"

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

const EVERY_WORDS: Record<number, string> = { 1: "Cada mes", 6: "Cada 6 meses", 12: "Cada año" }

const EVERY_CHOICES = [
  { value: "1", label: "Cada mes" },
  { value: "6", label: "Cada 6 meses" },
  { value: "12", label: "Cada año" },
]

function monthWord(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1] ?? key
}

function addMonth(key: string, delta: number): string {
  const index = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + delta
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

function joinMonths(keys: string[]): string {
  const words = keys.map(monthWord)
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} y ${words.at(-1)}`
}

const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback)

export function recurringKey(branchId: string, month: { year: number; month: number }) {
  return ["finance-expenses", "recurring", branchId, month.year, month.month] as const
}

export function useRecurringMonth(branchId: string, month: { year: number; month: number }, enabled: boolean) {
  return useQuery({
    queryKey: recurringKey(branchId, month),
    queryFn: () => fetchRecurringMonth({ ...month, branchId }),
    enabled,
  })
}

/**
 * «Lo fijo del mes: S/ 21,350.00 · pagado 14,850.00 · falta 6,500.00», en una línea bajo el total.
 * Con varias sedes dice también lo de toda la clínica, en la misma línea (QA de Gastos, G31).
 */
export function FixedOfMonth({
  data,
  wholeClinic,
  locale,
}: {
  data: RecurringMonth | undefined
  /** Lo de todas las sedes, solo si la clínica tiene más de una. */
  wholeClinic?: RecurringMonth | undefined
  locale: string
}) {
  if (!data || (data.fixed.count === 0 && !wholeClinic?.fixed.count)) return null
  const { totalCents, paidCents, dueCents } = data.fixed
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      Lo fijo del mes{wholeClinic ? " en esta sede" : ""}:{" "}
      <span className="font-semibold text-foreground tabular-nums">{formatMoney(totalCents, data.currency, locale)}</span>
      {" · "}pagado {plainAmount(paidCents, data.currency, locale)}
      {dueCents > 0 ? ` · falta ${plainAmount(dueCents, data.currency, locale)}` : ""}
      {wholeClinic && wholeClinic.fixed.count > 0 ? (
        <>
          {" · "}en toda la clínica{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {formatMoney(wholeClinic.fixed.totalCents, wholeClinic.currency, locale)}
          </span>
        </>
      ) : null}
    </p>
  )
}

/** Lo que se puede cambiar de una plantilla, venga de lo por pagar o de la lista completa. */
interface Editable {
  recurringId: string
  concept: string
  amountCents: number
  currency: string
  /** El día de la plantilla (puede ser 31). */
  day: number
  paymentMethodId: string | null
}

const editableOfDue = (row: RecurringDue): Editable => ({
  recurringId: row.recurringId,
  concept: row.concept,
  amountCents: row.amountCents,
  currency: row.currency,
  day: row.day,
  paymentMethodId: row.paymentMethodId,
})

const editableOfTemplate = (row: RecurringTemplate): Editable => ({
  recurringId: row.id,
  concept: row.concept,
  amountCents: row.amountCents,
  currency: row.currency,
  day: row.day,
  paymentMethodId: row.paymentMethodId,
})

/** Dónde se anota lo que se repite: la sede y el formato de la clínica. */
export interface RecurringPlace {
  branchId: string
  currency: string
  locale: string
  orgTimeZone: string
}

/** «Dejar de repetir»: deja de repetirse desde el mes que viene y dice lo que sigue por pagar (G3). */
function useEndRecurring(today: string | undefined) {
  const queryClient = useQueryClient()
  const refresh = () => invalidateFinance(queryClient)
  // «Deshacer» puede fallar (por ejemplo, con la caja ya cerrada): se dice, para que nadie crea que se deshizo.
  const undo = (run: () => Promise<unknown>, done: string) => {
    run()
      .then(() => toast.success(done))
      .catch((error: unknown) => toast.error(`No se pudo deshacer: ${errorText(error, "inténtalo otra vez")}`))
      .finally(refresh)
  }
  return useMutation({
    mutationFn: (row: Editable) => endRecurringApi(row.recurringId),
    onSuccess: (result, row) => {
      refresh()
      const { stillDue, previousLastMonth } = result.data
      const thisMonth = stillDue.includes(today?.slice(0, 7) ?? "")
      toast.success(
        stillDue.length > 0
          ? `${row.concept} ya no se repite. Sigue por pagar lo de ${joinMonths(stillDue)}${thisMonth ? "; si este mes no hubo, márcalo «No hubo este mes»" : ""}.`
          : `${row.concept} ya no se repite.`,
        {
          duration: 10_000,
          action: {
            label: "Deshacer",
            onClick: () =>
              undo(() => updateRecurringApi(row.recurringId, { lastMonth: previousLastMonth ?? null }), `${row.concept}: se repite otra vez`),
          },
        },
      )
    },
    onError: (error) => toast.error(errorText(error, "No se pudo dejar de repetir")),
  })
}

export function RecurringDueSection({
  data,
  locale,
  canWrite,
  onPay,
}: {
  data: RecurringMonth | undefined
  locale: string
  canWrite: boolean
  /** «Pagar»: abre el cajón del gasto lleno con lo de siempre. */
  onPay: (row: RecurringDue) => void
}) {
  const queryClient = useQueryClient()
  const [change, setChange] = useState<Editable | null>(null)
  const refresh = () => invalidateFinance(queryClient)
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)
  // En el celular se ven los primeros tres; el resto, a pedido (QA de Gastos, UX 5).
  const [all, setAll] = useState(false)
  const end = useEndRecurring(data?.today)

  const skip = useMutation({
    mutationFn: (input: { row: RecurringDue; undo?: boolean }) => skipRecurringApi(input.row.recurringId, input.row.month, input.undo),
    onSuccess: (_result, input) => {
      refresh()
      if (!input.undo)
        toast.success(`${input.row.concept}: en ${monthWord(input.row.month)} no hubo`, {
          duration: 10_000,
          action: { label: "Deshacer", onClick: () => skip.mutate({ row: input.row, undo: true }) },
        })
    },
    onError: (error) => toast.error(errorText(error, "No se pudo marcar")),
  })

  if (!data || data.due.length === 0) return null
  const current = `${data.year}-${String(data.month).padStart(2, "0")}`
  const inMain = data.due.filter((row) => row.currency === data.currency)
  // Los sueldos juntos (de quien no los paga) van aparte del total: no son lo que le toca pagar.
  const total = inMain.filter((row) => row.group === null).reduce((sum, row) => sum + row.amountCents, 0)
  const salaries = inMain.filter((row) => row.group !== null).reduce((sum, row) => sum + row.amountCents, 0)
  const otherCurrency = inMain.length < data.due.length
  const earlier = data.due.some((row) => row.month !== current)
  const FEW = 3
  const shown = all ? data.due : data.due.slice(0, FEW)

  return (
    <section aria-labelledby="gastos-por-pagar" className="elevated rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 id="gastos-por-pagar" className="text-sm font-semibold">
          {/* Con meses anteriores, el total no es solo de este mes: se dice. */}
          {earlier ? "Por pagar" : `Por pagar en ${MONTHS[data.month - 1]}`} ·{" "}
          <span className="tabular-nums">{formatMoney(total, data.currency, locale)}</span>
          {otherCurrency ? <span className="font-normal text-muted-foreground"> y lo de otra moneda</span> : null}
          {salaries > 0 ? (
            <span className="font-normal text-muted-foreground">
              {" "}
              · y {formatMoney(salaries, data.currency, locale)} de sueldos, que paga administración
            </span>
          ) : null}
        </h2>
      </div>
      <ul className="flex min-w-0 flex-col divide-y">
        {shown.map((row) => {
          // Lo que se paga al mes siguiente dice su mes: el sueldo de noviembre, «el 2 de diciembre».
          const dueMonth = row.dueOn.slice(0, 7)
          const dueWords = dueMonth !== row.month ? `${row.dueDay} de ${monthWord(dueMonth)}` : `${row.dueDay}`
          const when = row.overdue ? `venció el ${dueWords}` : `el ${dueWords}`
          const before = row.month !== current ? `De ${monthWord(row.month)}: ` : ""
          const named = `${row.concept} de ${monthWord(row.month)}`
          return (
            <li key={`${row.recurringId}:${row.month}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium [overflow-wrap:anywhere]">
                  {before}
                  {row.concept}
                </span>
                <span className={row.overdue ? "text-sm font-medium text-warning" : "text-sm text-muted-foreground"}>
                  {[expenseCategoryLabel(row.category), row.memberName, when, row.group !== null ? "los paga administración" : null]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{money(row.amountCents, row.currency)}</span>
              {/* Los sueldos juntos no se pagan desde aquí: el de cada persona lo paga quien lo ve (S1). */}
              {canWrite && row.group === null ? (
                <span className="flex shrink-0 items-center gap-1">
                  <Button type="button" size="sm" aria-label={`Pagar ${named}, ${money(row.amountCents, row.currency)}`} onClick={() => onPay(row)}>
                    Pagar
                  </Button>
                  <RowActions
                    label={`Más acciones de ${named}`}
                    items={[
                      {
                        key: "no",
                        // Una fila de otro mes dice su mes, no «este mes».
                        label: row.month === current ? "No hubo este mes" : `No hubo en ${monthWord(row.month)}`,
                        onSelect: () => skip.mutate({ row }),
                      },
                      { key: "cambiar", label: "Cambiar lo que se repite", onSelect: () => setChange(editableOfDue(row)) },
                      { key: "fin", label: "Dejar de repetir", onSelect: () => end.mutate(editableOfDue(row)) },
                    ]}
                  />
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      {!all && data.due.length > FEW ? (
        <div className="border-t px-4 py-2">
          <Button type="button" variant="link" className="h-auto p-0" onClick={() => setAll(true)}>
            Ver todo lo por pagar ({data.due.length})
          </Button>
        </div>
      ) : null}
      <ChangeRecurringDrawer row={change} locale={locale} onClose={() => setChange(null)} onDone={refresh} />
    </section>
  )
}

/**
 * «Lo que se repite»: todo lo que sigue en pie, también lo que no toca este mes
 * (lo de cada 6 meses o cada año), para anotarlo, cambiarlo o dejar de repetirlo
 * sin esperar a que vuelva a tocar. Plegado: lo diario es lo por pagar. Anotar
 * vive aquí y no en «Registrar gasto» (ADR 0167): anotar no paga.
 */
export function RepeatingList({
  data,
  place,
  canWrite,
}: {
  data: RecurringMonth | undefined
  place: RecurringPlace
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [noting, setNoting] = useState(false)
  const [change, setChange] = useState<Editable | null>(null)
  const { locale } = place
  const end = useEndRecurring(data?.today)
  if (!data) return null
  const templates = data.templates
  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
        <div className="flex items-center gap-2 pr-3">
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-between px-4 py-3 text-sm font-semibold" />}
          >
            Lo que se repite ({templates.length})
            <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
          </CollapsibleTrigger>
          {canWrite ? (
            <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setNoting(true)}>
              Anotar lo que se repite
            </Button>
          ) : null}
        </div>
        <CollapsibleContent>
          {templates.length === 0 ? (
            <p className="border-t px-4 py-3 text-sm text-muted-foreground">
              El alquiler, la luz o un sueldo: anótalos una vez y aparecen «por pagar» cada vez que tocan. Nunca se pagan solos.
            </p>
          ) : (
            <ul className="flex min-w-0 flex-col divide-y border-t">
              {templates.map((row) => (
                <li key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium [overflow-wrap:anywhere]">{row.concept}</span>
                    <span className="text-sm text-muted-foreground">
                      {[
                        expenseCategoryLabel(row.category),
                        row.memberName,
                        `${EVERY_WORDS[row.everyMonths] ?? ""}${row.group === null ? `, el ${row.day}` : ""}`,
                        row.group !== null ? "los anota administración" : null,
                        row.nextMonth && row.group === null ? `toca en ${monthWord(row.nextMonth)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{formatMoney(row.amountCents, row.currency, locale)}</span>
                  {canWrite && row.group === null ? (
                    <RowActions
                      label={`Más acciones de ${row.concept}`}
                      items={[
                        { key: "cambiar", label: "Cambiar lo que se repite", onSelect: () => setChange(editableOfTemplate(row)) },
                        { key: "fin", label: "Dejar de repetir", onSelect: () => end.mutate(editableOfTemplate(row)) },
                      ]}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CollapsibleContent>
      </Collapsible>
      <NoteRecurringDrawer place={place} open={noting} onClose={() => setNoting(false)} onDone={() => setOpen(true)} />
      <ChangeRecurringDrawer row={change} locale={locale} onClose={() => setChange(null)} onDone={() => invalidateFinance(queryClient)} />
    </>
  )
}

interface NoteValues {
  concept: string
  category: string
  /** Con otra moneda en la clínica, en cuál se paga (el alquiler en dólares). */
  currency: string
  amount: string
  every: "1" | "6" | "12"
  day: string
  firstMonth: string
  method: string
  member: string
  dueNext: boolean
}

/**
 * «Anotar lo que se repite» (ADR 0167; QA de Gastos, UX 4): en qué, tipo, lo de siempre, cada cuánto
 * y el día. Anotar no paga: queda «por pagar» cada vez que toca, desde el primer mes que aún no
 * vence. Con qué se suele pagar es opcional y se propone al pagar.
 */
function NoteRecurringDrawer({
  place,
  open,
  onClose,
  onDone,
}: {
  place: RecurringPlace
  open: boolean
  onClose: () => void
  onDone: () => void
}) {
  const { branchId, locale, orgTimeZone } = place
  const queryClient = useQueryClient()
  const canStaffPay = usePermission("commissions.write")
  const { second } = useTodayRate(locale)
  const today = todayIn(orgTimeZone)
  const requestId = useRef<string>(crypto.randomUUID())
  const methods = useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods, enabled: open })
  const options = EXPENSE_CATEGORIES.filter((value) => canStaffPay || value !== "Personal").map((value) => ({
    value,
    label: expenseCategoryLabel(value),
  }))
  /** El primer mes que aún no vence, como el servidor: este si su día no pasó, si no el que sigue. */
  const firstOf = (day: number, dueNext: boolean) => {
    const current = today.slice(0, 7)
    const dueMonth = dueNext ? addMonth(current, 1) : current
    const last = new Date(Date.UTC(Number(dueMonth.slice(0, 4)), Number(dueMonth.slice(5, 7)), 0)).getUTCDate()
    const dueOn = `${dueMonth}-${String(Math.min(day, last)).padStart(2, "0")}`
    return dueOn >= today ? current : addMonth(current, 1)
  }
  const form = useAppForm({
    defaultValues: {
      concept: "",
      category: "",
      currency: place.currency,
      amount: "",
      every: "1",
      day: "",
      firstMonth: "",
      method: "",
      member: "",
      dueNext: false,
    } as NoteValues,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.concept.trim()) fields.concept = "Escribe en qué se gasta."
        if (!value.category) fields.category = "Elige el tipo."
        const amount = parseAmount(value.amount, value.currency, locale)
        if (amount === null || amount <= 0) fields.amount = "Escribe lo de siempre, mayor que cero."
        const day = Number(value.day)
        if (!Number.isInteger(day) || day < 1 || day > 31) fields.day = "Escribe un día del 1 al 31."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const amountCents = parseAmount(value.amount, value.currency, locale)
      if (amountCents === null) return
      const day = Number(value.day)
      const created = await noteRecurringApi({
        requestId: requestId.current,
        branchId,
        ...(value.currency !== place.currency ? { currency: value.currency } : {}),
        category: value.category,
        concept: value.concept.trim(),
        amountCents,
        everyMonths: Number(value.every) as 1 | 6 | 12,
        day,
        firstMonth: value.firstMonth || firstOf(day, value.dueNext),
        ...(value.method ? { paymentMethodId: value.method } : {}),
        ...(value.category === "Personal" && value.member ? { memberUserId: value.member } : {}),
        ...(value.category === "Personal" ? { dueNextMonth: value.dueNext } : {}),
      })
      invalidateFinance(queryClient)
      toast.success(`Anotado: ${value.concept.trim()} queda por pagar desde ${monthWord(created.data.firstMonth)}, cada vez que toca`)
      onDone()
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { amountCents: "amount", everyMonths: "every", paymentMethodId: "method", memberUserId: "member" },
  })
  const values = useStore(form.store, (s) => s.values)
  const people = useQuery({
    queryKey: ["finance", "recurring-people"],
    queryFn: fetchRecurringPeople,
    enabled: open && values.category === "Personal" && canStaffPay,
    staleTime: 60_000,
  })
  const [pickMonth, setPickMonth] = useState(false)
  useEffect(() => {
    if (!open) return
    requestId.current = crypto.randomUUID()
    setPickMonth(false)
    form.reset()
  }, [open, form])
  const day = Number(values.day)
  const validDay = Number.isInteger(day) && day >= 1 && day <= 31
  const proposed = validDay ? firstOf(day, values.dueNext) : today.slice(0, 7)
  // Desde el mes pasado (una deuda que se anota) hasta un año: si no se elige, el primero que no vence.
  const months = Array.from({ length: 14 }, (_, index) => addMonth(today.slice(0, 7), index - 1)).map((key) => ({
    value: key,
    label: `${monthWord(key)}${key.slice(0, 4) !== today.slice(0, 4) ? ` de ${key.slice(0, 4)}` : ""}`,
  }))
  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title="Anotar lo que se repite"
      description="Queda «por pagar» cada vez que toca. Nunca se paga solo."
      submitLabel="Anotar"
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="concept">
          {(field) => <field.TextField label="En qué se gasta" maxLength={500} placeholder="Alquiler del local, luz, sueldo de la asistente" />}
        </form.AppField>
        <form.AppField name="category">
          {(field) => (
            <field.Group legend="Tipo" description={field.state.value ? EXPENSE_CATEGORY_HINTS[field.state.value] : undefined}>
              {(control) => (
                <ChoiceChips
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={options}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {second ? (
          <form.AppField name="currency">
            {(field) => (
              <field.Group legend="Moneda" className="gap-3">
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    tone="primary"
                    value={field.state.value}
                    options={currencyChoices([place.currency, second.currency], locale)}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="amount">
          {(field) => (
            <field.TextField
              label={`Lo de siempre, en ${currencyWord(values.currency, locale)}`}
              inputMode="decimal"
              inputClassName="w-40"
            />
          )}
        </form.AppField>
        <form.AppField name="day">
          {(field) => <field.TextField label="Se paga el día" description="Si el mes no lo tiene, el último." inputMode="numeric" inputClassName="w-24" />}
        </form.AppField>
        <form.AppField name="every">
          {(field) => (
            <field.Group legend="Cada cuánto" className="gap-3">
              {(control) => (
                <ChoiceButtons
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  tone="primary"
                  value={field.state.value}
                  options={EVERY_CHOICES}
                  onChange={(next) => field.handleChange(next as NoteValues["every"])}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {/* El primer mes casi nunca se elige: se dice cuál será, y se cambia solo si hace falta (UX 4). */}
        {pickMonth ? (
          <form.AppField name="firstMonth">
            {(field) => (
              <field.SelectField label="Desde qué mes" placeholder={monthWord(proposed)} options={months} />
            )}
          </form.AppField>
        ) : validDay ? (
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            Queda por pagar desde {monthWord(proposed)}.
            <Button type="button" variant="link" className="h-auto p-0" onClick={() => setPickMonth(true)}>
              Otro mes
            </Button>
          </p>
        ) : null}
        <form.AppField name="method">
          {(field) => (
            <field.Group legend="Con qué se suele pagar (opcional)">
              {(control) => (
                <PaymentMethodButtons
                  id={control.id}
                  methods={methods.data?.data ?? []}
                  value={field.state.value}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  onChange={(next) => field.handleChange(field.state.value === next ? "" : next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {values.category === "Personal" ? (
          <>
            <form.AppField name="member">
              {(field) => (
                <field.SelectField
                  label="De quién es el sueldo (opcional)"
                  placeholder="De nadie en particular"
                  options={[
                    { value: "", label: "De nadie en particular" },
                    ...(people.data?.data ?? []).map((person) => ({ value: person.userId, label: person.name })),
                  ]}
                />
              )}
            </form.AppField>
            <form.AppField name="dueNext">
              {(field) => (
                <field.CheckboxField
                  label="Se paga al mes siguiente"
                  description="El sueldo de noviembre que se paga el 2 de diciembre: así no sale vencido antes de tiempo."
                />
              )}
            </form.AppField>
          </>
        ) : null}
      </div>
    </FormDrawer>
  )
}

/** «Cambiar lo que se repite»: vale desde el próximo pago; lo ya pagado no cambia. Solo se manda lo que cambió. */
function ChangeRecurringDrawer({
  row,
  locale,
  onClose,
  onDone,
}: {
  row: Editable | null
  locale: string
  onClose: () => void
  onDone: () => void
}) {
  // La última fila abierta se conserva mientras el cajón se cierra: sin ella no hay moneda (QA de Gastos, G1).
  const last = useRef<Editable | null>(row)
  if (row) last.current = row
  const shown = row ?? last.current
  const currency = shown?.currency ?? ""
  const methods = useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods, enabled: row !== null })
  const form = useAppForm({
    defaultValues: { concept: "", amount: "", day: "", method: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.concept.trim()) fields.concept = "Escribe en qué se gasta."
        const amount = parseAmount(value.amount, currency, locale)
        if (amount === null || amount <= 0) fields.amount = "Escribe un importe mayor que cero."
        const day = Number(value.day)
        if (!Number.isInteger(day) || day < 1 || day > 31) fields.day = "Escribe un día del 1 al 31."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!row) return
      const concept = value.concept.trim()
      const amountCents = parseAmount(value.amount, currency, locale)
      const day = Number(value.day)
      const body = {
        ...(concept !== row.concept ? { concept } : {}),
        ...(amountCents !== null && amountCents !== row.amountCents ? { amountCents } : {}),
        ...(day !== row.day ? { day } : {}),
        ...(value.method !== (row.paymentMethodId ?? "") ? { paymentMethodId: value.method || null } : {}),
      }
      if (Object.keys(body).length > 0) {
        await updateRecurringApi(row.recurringId, body)
        onDone()
        toast.success("Guardado: vale desde el próximo pago")
      }
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount", paymentMethodId: "method" } })
  useEffect(() => {
    if (row)
      form.reset({
        concept: row.concept,
        amount: formatMoneyInput(row.amountCents, row.currency, locale),
        day: String(row.day),
        method: row.paymentMethodId ?? "",
      })
  }, [row, form, locale])
  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={row !== null}
      onClose={onClose}
      title="Cambiar lo que se repite"
      description="Vale desde el próximo pago. Lo ya pagado no cambia."
      submitLabel="Guardar"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="concept">
          {(field) => <field.TextField label="En qué se gasta" maxLength={500} />}
        </form.AppField>
        <form.AppField name="amount">
          {(field) => (
            <field.TextField
              label={currency ? `Lo de siempre, en ${currencyWord(currency, locale)}` : "Lo de siempre"}
              description={shown ? `Se propone este importe cada vez. Hoy: ${formatMoney(shown.amountCents, shown.currency, locale)}.` : undefined}
              inputMode="decimal"
              inputClassName="w-40"
            />
          )}
        </form.AppField>
        <form.AppField name="day">
          {(field) => <field.TextField label="El día" description="Si el mes no tiene ese día, el último del mes." inputMode="numeric" inputClassName="w-24" />}
        </form.AppField>
        <form.AppField name="method">
          {(field) => (
            <field.Group legend="Con qué se suele pagar (opcional)" description="Se propone al pagar.">
              {(control) => (
                <PaymentMethodButtons
                  id={control.id}
                  methods={methods.data?.data ?? []}
                  value={field.state.value}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  onChange={(next) => field.handleChange(field.state.value === next ? "" : next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
