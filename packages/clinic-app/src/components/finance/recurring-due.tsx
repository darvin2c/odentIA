/**
 * Finanzas › Gastos: lo que se repite y toca pagar (el alquiler, los sueldos, la
 * luz). Cada fila se paga con un toque, con el último importe y por el mismo
 * medio, y deja «Deshacer»; lo que cambia cada mes va por «Pagar otro importe».
 * Nada se paga solo. «Lo fijo del mes» va dentro de la tarjeta del total.
 *
 * El servidor decide qué toca, qué venció y si ya se pagó (también si dos
 * personas tocan a la vez): aquí solo se presenta.
 */
import { formatMoney } from "@odentia/clinical"
import { Button, toast } from "@odentia/ui"
import { FormDrawer, RowActions, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { plainAmount } from "../../lib/commissions"
import {
  endRecurringApi,
  fetchRecurringMonth,
  invalidateFinance,
  payRecurringApi,
  type RecurringDue,
  type RecurringMonth,
  skipRecurringApi,
  updateRecurringApi,
} from "../../lib/finance-cash"

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

function monthWord(key: string): string {
  return MONTHS[Number(key.slice(5, 7)) - 1] ?? key
}

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
  const [change, setChange] = useState<RecurringDue | null>(null)
  const refresh = () => invalidateFinance(queryClient)
  const money = (cents: number, currency: string) => formatMoney(cents, currency, locale)

  const pay = useMutation({
    mutationFn: (row: RecurringDue) => payRecurringApi(row.recurringId, { month: row.month }),
    onSuccess: (result, row) => {
      refresh()
      toast.success(
        `${row.concept} registrado · ${money(result.data.amountCents, result.data.currency)} · ${result.data.fromCash ? "Efectivo de la caja" : "Fuera de la caja"}`,
      )
    },
    onError: (error, row) => {
      refresh()
      // Si la caja no alcanza, se paga de otra forma con todo escrito.
      if (error instanceof Error && /caja/i.test(error.message)) setOther(row)
      toast.error(error instanceof Error ? error.message : "No se pudo registrar")
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
    onError: (error) => toast.error(error instanceof Error ? error.message : "No se pudo marcar"),
  })
  const end = useMutation({
    mutationFn: (row: RecurringDue) => endRecurringApi(row.recurringId) as Promise<{ data: { previousLastMonth: string | null } }>,
    onSuccess: (result, row) => {
      refresh()
      toast.success("Ya no aparece por pagar. Lo pagado queda en Gastos.", {
        action: {
          label: "Deshacer",
          onClick: () =>
            void updateRecurringApi(row.recurringId, { lastMonth: result.data.previousLastMonth ?? null }).then(refresh),
        },
      })
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "No se pudo dejar de repetir"),
  })

  if (!data || data.due.length === 0) return null
  const total = data.due.reduce((sum, row) => sum + (row.currency === data.currency ? row.amountCents : 0), 0)
  const current = `${data.year}-${String(data.month).padStart(2, "0")}`

  return (
    <section aria-labelledby="gastos-por-pagar" className="elevated rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
        <h2 id="gastos-por-pagar" className="text-sm font-semibold">
          Por pagar en {MONTHS[data.month - 1]} ·{" "}
          <span className="tabular-nums">{formatMoney(total, data.currency, locale)}</span>
        </h2>
      </div>
      <ul className="flex min-w-0 flex-col divide-y">
        {data.due.map((row) => {
          const when = row.overdue ? `venció el ${row.dueDay}` : `el ${row.dueDay}`
          const before = row.month !== current ? `De ${monthWord(row.month)}: ` : ""
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
                    disabled={pay.isPending && pay.variables?.recurringId === row.recurringId}
                    aria-label={`Pagar ${row.concept}, ${money(row.amountCents, row.currency)}`}
                    onClick={() => pay.mutate(row)}
                  >
                    {pay.isPending && pay.variables?.recurringId === row.recurringId ? "Pagando…" : "Pagar"}
                  </Button>
                  <RowActions
                    label={`Más acciones de ${row.concept}`}
                    items={[
                      { key: "otro", label: "Pagar otro importe", onSelect: () => setOther(row) },
                      { key: "no", label: "No hubo este mes", onSelect: () => skip.mutate({ row }) },
                      { key: "cambiar", label: "Cambiar lo que se repite", onSelect: () => setChange(row) },
                      { key: "fin", label: "Dejar de repetir", onSelect: () => end.mutate(row) },
                    ]}
                  />
                </span>
              ) : null}
            </li>
          )
        })}
      </ul>
      <PayOtherDrawer row={other} locale={locale} onClose={() => setOther(null)} onDone={refresh} />
      <ChangeRecurringDrawer row={change} locale={locale} onClose={() => setChange(null)} onDone={refresh} />
    </section>
  )
}

function toCents(text: string): number | null {
  const clean = text.replace(/[^\d.,]/g, "").replace(/,(?=\d{3}\b)/g, "").replace(",", ".")
  if (!clean) return null
  const value = Math.round(Number(clean) * 100)
  return Number.isFinite(value) && value > 0 ? value : null
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
  const form = useAppForm({
    defaultValues: { amount: "", fromCash: false },
    validators: {
      onSubmit: ({ value }) => (toCents(value.amount) === null ? { fields: { amount: "Escribe un importe mayor que cero." } } : undefined),
    },
    onSubmit: async ({ value }) => {
      if (!row) return
      const cents = toCents(value.amount)
      if (cents === null) return
      await payRecurringApi(row.recurringId, { month: row.month, amountCents: cents, fromCash: value.fromCash })
      onDone()
      toast.success(`${row.concept} registrado · ${formatMoney(cents, row.currency, locale)}`)
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount" } })
  useEffect(() => {
    if (row) form.reset({ amount: (row.amountCents / 100).toFixed(2), fromCash: false })
  }, [row, form])
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
          {(field) => <field.TextField label={`Importe (${row?.currency ?? ""})`} inputMode="decimal" inputClassName="w-40" />}
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

/** «Cambiar lo que se repite»: vale desde el próximo pago; lo ya pagado no cambia. */
function ChangeRecurringDrawer({
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
  const form = useAppForm({
    defaultValues: { concept: "", amount: "", day: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.concept.trim()) fields.concept = "Escribe en qué se gasta."
        if (toCents(value.amount) === null) fields.amount = "Escribe un importe mayor que cero."
        const day = Number(value.day)
        if (!Number.isInteger(day) || day < 1 || day > 31) fields.day = "Escribe un día del 1 al 31."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!row) return
      await updateRecurringApi(row.recurringId, {
        concept: value.concept.trim(),
        amountCents: toCents(value.amount) ?? row.amountCents,
        day: Number(value.day),
      })
      onDone()
      toast.success("Guardado: vale desde el próximo pago")
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { amountCents: "amount" } })
  useEffect(() => {
    if (row) form.reset({ concept: row.concept, amount: (row.amountCents / 100).toFixed(2), day: String(row.dueDay) })
  }, [row, form])
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
              label={`Importe (${row?.currency ?? ""})`}
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
      </div>
    </FormDrawer>
  )
}
