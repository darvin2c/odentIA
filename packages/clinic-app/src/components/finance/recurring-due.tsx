/**
 * Finanzas › Gastos: lo que se repite y toca pagar (el alquiler, los sueldos, la
 * luz). Cada fila se paga con un toque, con el último importe y por el mismo
 * medio, y deja «Deshacer»; lo que cambia cada mes va por «Pagar otro importe».
 * Nada se paga solo. «Lo fijo del mes» va dentro de la tarjeta del total, y
 * «Lo que se repite» lista todo, también lo que no toca este mes, para
 * cambiarlo o dejar de repetirlo.
 *
 * El servidor decide qué toca, qué venció y si ya se pagó (también si dos
 * personas tocan a la vez): aquí solo se presenta.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, cn, toast } from "@odentia/ui"
import { FormDrawer, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useState } from "react"
import { plainAmount } from "../../lib/commissions"
import {
  endRecurringApi,
  fetchRecurringMonth,
  invalidateFinance,
  parseAmount,
  payRecurringApi,
  type RecurringDue,
  type RecurringMonth,
  type RecurringTemplate,
  skipRecurringApi,
  updateRecurringApi,
  voidExpenseApi,
} from "../../lib/finance-cash"

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

const EVERY_WORDS: Record<number, string> = { 1: "Cada mes", 6: "Cada 6 meses", 12: "Cada año" }

function monthWord(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1] ?? key
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

/** «Lo fijo del mes: S/ 21,350.00 · pagado 14,850.00 · falta 6,500.00», dentro de la tarjeta del total. */
export function FixedOfMonth({ data, locale }: { data: RecurringMonth | undefined; locale: string }) {
  if (!data || data.fixed.count === 0) return null
  const { totalCents, paidCents, dueCents } = data.fixed
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      Lo fijo del mes:{" "}
      <span className="font-semibold text-foreground tabular-nums">{formatMoney(totalCents, data.currency, locale)}</span>
      {" · "}pagado {plainAmount(paidCents, data.currency, locale)}
      {dueCents > 0 ? ` · falta ${plainAmount(dueCents, data.currency, locale)}` : ""}
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
  fromCash: boolean
}

const editableOfDue = (row: RecurringDue): Editable => ({
  recurringId: row.recurringId,
  concept: row.concept,
  amountCents: row.amountCents,
  currency: row.currency,
  day: row.day,
  fromCash: row.fromCash,
})

const editableOfTemplate = (row: RecurringTemplate): Editable => ({
  recurringId: row.id,
  concept: row.concept,
  amountCents: row.amountCents,
  currency: row.currency,
  day: row.day,
  fromCash: row.fromCash,
})

export function RecurringDueSection({
  data,
  locale,
  canWrite,
}: {
  data: RecurringMonth | undefined
  locale: string
  canWrite: boolean
}) {
  const queryClient = useQueryClient()
  const [other, setOther] = useState<RecurringDue | null>(null)
  const [change, setChange] = useState<Editable | null>(null)
  const refresh = () => invalidateFinance(queryClient)
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)

  // «Deshacer» puede fallar (por ejemplo, con la caja ya cerrada): se dice, para que nadie crea que se deshizo.
  const undo = (run: () => Promise<unknown>, done: string) => {
    run()
      .then(() => toast.success(done))
      .catch((error: unknown) => toast.error(`No se pudo deshacer: ${errorText(error, "inténtalo otra vez")}`))
      .finally(refresh)
  }

  const pay = useMutation({
    mutationFn: (row: RecurringDue) => payRecurringApi(row.recurringId, { month: row.month }),
    onSuccess: (result, row) => {
      refresh()
      toast.success(
        `${row.concept} registrado · ${money(result.data.amountCents, result.data.currency)} · ${result.data.fromCash ? "Efectivo de la caja" : "Fuera de la caja"}`,
        {
          // Deshacer anula ese gasto: vuelve a quedar por pagar.
          action: {
            label: "Deshacer",
            onClick: () =>
              undo(() => voidExpenseApi(result.data.id, "Se deshizo el pago recién registrado"), `${row.concept}: vuelve a estar por pagar`),
          },
        },
      )
    },
    onError: (error, row) => {
      refresh()
      // Si la caja no alcanza, se paga de otra forma con todo escrito.
      if (error instanceof Error && /caja/i.test(error.message)) setOther(row)
      toast.error(errorText(error, "No se pudo registrar"))
    },
  })
  const skip = useMutation({
    mutationFn: (input: { row: RecurringDue; undo?: boolean }) => skipRecurringApi(input.row.recurringId, input.row.month, input.undo),
    onSuccess: (_result, input) => {
      refresh()
      if (!input.undo)
        toast.success(`${input.row.concept}: este mes no hubo`, {
          action: { label: "Deshacer", onClick: () => skip.mutate({ row: input.row, undo: true }) },
        })
    },
    onError: (error) => toast.error(errorText(error, "No se pudo marcar")),
  })
  const end = useMutation({
    mutationFn: (row: Editable) => endRecurringApi(row.recurringId),
    onSuccess: (result, row) => {
      refresh()
      const { stillDue, previousLastMonth } = result.data
      toast.success(
        stillDue.length > 0
          ? `${row.concept} ya no se repite. Lo de ${joinMonths(stillDue)} sigue por pagar.`
          : `${row.concept} ya no se repite. Lo pagado queda en Gastos.`,
        {
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

  if (!data) return null
  const current = `${data.year}-${String(data.month).padStart(2, "0")}`
  const inMain = data.due.filter((row) => row.currency === data.currency)
  const total = inMain.reduce((sum, row) => sum + row.amountCents, 0)
  const otherCurrency = inMain.length < data.due.length
  const earlier = data.due.some((row) => row.month !== current)

  return (
    <>
      {data.due.length > 0 ? (
        <section aria-labelledby="gastos-por-pagar" className="elevated rounded-xl border bg-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
            <h2 id="gastos-por-pagar" className="text-sm font-semibold">
              {/* Con meses anteriores, el total no es solo de este mes: se dice. */}
              {earlier ? "Por pagar" : `Por pagar en ${MONTHS[data.month - 1]}`} ·{" "}
              <span className="tabular-nums">{formatMoney(total, data.currency, locale)}</span>
              {otherCurrency ? <span className="font-normal text-muted-foreground"> y lo de otra moneda</span> : null}
            </h2>
          </div>
          <ul className="flex min-w-0 flex-col divide-y">
            {data.due.map((row) => {
              const when = row.overdue ? `venció el ${row.dueDay}` : `el ${row.dueDay}`
              const before = row.month !== current ? `De ${monthWord(row.month)}: ` : ""
              const paying = pay.isPending && pay.variables?.recurringId === row.recurringId && pay.variables.month === row.month
              const named = `${row.concept} de ${monthWord(row.month)}`
              return (
                <li key={`${row.recurringId}:${row.month}`} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium break-words">
                      {before}
                      {row.concept}
                    </span>
                    <span className={row.overdue ? "text-sm font-medium text-warning" : "text-sm text-muted-foreground"}>
                      {[row.category, row.memberName, when].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <span className="shrink-0 font-semibold tabular-nums">{money(row.amountCents, row.currency)}</span>
                  {canWrite ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        size="sm"
                        disabled={paying}
                        aria-label={`Pagar ${named}, ${money(row.amountCents, row.currency)}`}
                        onClick={() => pay.mutate(row)}
                      >
                        {paying ? "Pagando…" : "Pagar"}
                      </Button>
                      <RowActions
                        label={`Más acciones de ${named}`}
                        items={[
                          { key: "otro", label: "Pagar otro importe", onSelect: () => setOther(row) },
                          { key: "no", label: "No hubo este mes", onSelect: () => skip.mutate({ row }) },
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
        </section>
      ) : null}
      <RepeatingList
        templates={data.templates}
        locale={locale}
        canWrite={canWrite}
        onChange={(row) => setChange(editableOfTemplate(row))}
        onEnd={(row) => end.mutate(editableOfTemplate(row))}
      />
      <PayOtherDrawer row={other} locale={locale} onClose={() => setOther(null)} onDone={refresh} />
      <ChangeRecurringDrawer row={change} locale={locale} onClose={() => setChange(null)} onDone={refresh} />
    </>
  )
}

/**
 * «Lo que se repite»: todo lo que sigue en pie, también lo que no toca este mes
 * (lo de cada 6 meses o cada año), para cambiarlo o dejar de repetirlo sin
 * esperar a que vuelva a tocar. Plegado: lo diario es lo por pagar.
 */
function RepeatingList({
  templates,
  locale,
  canWrite,
  onChange,
  onEnd,
}: {
  templates: RecurringTemplate[]
  locale: string
  canWrite: boolean
  onChange: (row: RecurringTemplate) => void
  onEnd: (row: RecurringTemplate) => void
}) {
  const [open, setOpen] = useState(false)
  if (templates.length === 0) return null
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger
        render={<Button type="button" variant="ghost" className="h-auto w-full justify-between px-4 py-3 text-sm font-semibold" />}
      >
        Lo que se repite ({templates.length})
        <ChevronDown aria-hidden className={cn("transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex min-w-0 flex-col divide-y border-t">
          {templates.map((row) => (
            <li key={row.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">{row.concept}</span>
                <span className="text-sm text-muted-foreground">
                  {[
                    row.category,
                    row.memberName,
                    `${EVERY_WORDS[row.everyMonths] ?? ""}, el ${row.day}`,
                    row.fromCash ? "de la caja" : "fuera de la caja",
                    row.nextMonth ? `toca en ${monthWord(row.nextMonth)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{formatMoney(row.amountCents, row.currency, locale)}</span>
              {canWrite ? (
                <RowActions
                  label={`Más acciones de ${row.concept}`}
                  items={[
                    { key: "cambiar", label: "Cambiar lo que se repite", onSelect: () => onChange(row) },
                    { key: "fin", label: "Dejar de repetir", onSelect: () => onEnd(row) },
                  ]}
                />
              ) : null}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** «Pagar otro importe»: la luz de este mes, o pagar fuera de la caja cuando no alcanza. */
function PayOtherDrawer({
  row,
  locale,
  onClose,
  onDone,
}: {
  row: RecurringDue | null
  locale: string
  onClose: () => void
  onDone: () => void
}) {
  const currency = row?.currency ?? ""
  const cents = (text: string) => {
    const value = parseAmount(text, currency, locale)
    return value !== null && value > 0 ? value : null
  }
  const form = useAppForm({
    defaultValues: { amount: "", fromCash: false },
    validators: {
      onSubmit: ({ value }) => (cents(value.amount) === null ? { fields: { amount: "Escribe un importe mayor que cero." } } : undefined),
    },
    onSubmit: async ({ value }) => {
      if (!row) return
      const amountCents = cents(value.amount)
      if (amountCents === null) return
      await payRecurringApi(row.recurringId, { month: row.month, amountCents, fromCash: value.fromCash })
      onDone()
      toast.success(`${row.concept} registrado · ${formatMoney(amountCents, row.currency, locale)}`)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount" } })
  useEffect(() => {
    // Parte de lo que se propone y por el medio de siempre.
    if (row) form.reset({ amount: formatMoneyInput(row.amountCents, row.currency, locale), fromCash: row.fromCash })
  }, [row, form, locale])
  return (
    <FormDrawer
      {...surface}
      dock={false}
      open={row !== null}
      onClose={onClose}
      title="Pagar otro importe"
      description={row ? `${row.concept} de ${monthWord(row.month)}.` : undefined}
      submitLabel="Registrar"
    >
      <div className="flex flex-col gap-4">
        <form.AppField name="amount">
          {(field) => <field.TextField label={`Importe (${currency})`} inputMode="decimal" inputClassName="w-40" />}
        </form.AppField>
        <form.AppField name="fromCash">
          {(field) => (
            <field.CheckboxField
              label="Se pagó con el efectivo de la caja"
              description="Si no, no toca ninguna caja: salió de una cuenta o de otro lado."
            />
          )}
        </form.AppField>
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
  const currency = row?.currency ?? ""
  const form = useAppForm({
    defaultValues: { concept: "", amount: "", day: "", fromCash: false },
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
        ...(value.fromCash !== row.fromCash ? { fromCash: value.fromCash } : {}),
      }
      if (Object.keys(body).length > 0) {
        await updateRecurringApi(row.recurringId, body)
        onDone()
        toast.success("Guardado: vale desde el próximo pago")
      }
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount" } })
  useEffect(() => {
    if (row)
      form.reset({
        concept: row.concept,
        amount: formatMoneyInput(row.amountCents, row.currency, locale),
        day: String(row.day),
        fromCash: row.fromCash,
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
              label={`Importe (${currency})`}
              description={row ? `Se propone este importe cada vez. Hoy: ${formatMoney(row.amountCents, row.currency, locale)}.` : undefined}
              inputMode="decimal"
              inputClassName="w-40"
            />
          )}
        </form.AppField>
        <form.AppField name="day">
          {(field) => (
            <field.TextField label="El día" description="Si el mes no tiene ese día, el último del mes." inputMode="numeric" inputClassName="w-24" />
          )}
        </form.AppField>
        <form.AppField name="fromCash">
          {(field) => (
            <field.CheckboxField
              label="Se paga con el efectivo de la caja"
              description="Es lo que se propone al pagar con un toque."
            />
          )}
        </form.AppField>
      </div>
    </FormDrawer>
  )
}
