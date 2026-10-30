/**
 * Paneles de la caja: cerrar (se cuenta solo el efectivo, se dice cuánto queda
 * y cuánto se entrega), ingresar o retirar efectivo a mano, y la hoja de
 * cierre imprimible y firmable. Un cierre no se edita: lo que se corrija
 * después queda como movimiento del día en que se corrige.
 *
 * Los tres leen el mismo estado de caja que la pantalla (`useCashState`), así
 * que lo que refresca Caja los refresca a ellos. Dinero con `@odentia/clinical`;
 * moneda, formato y zona siempre de la clínica o la sede.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import {
  Button,
  cn,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import { DetailDrawer, ErrorState, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useState } from "react"
import { ticketDisplayNumber } from "./ticket-view"
import { plainAmount } from "../../lib/commissions"
import { usePermission } from "../../lib/crm"
import {
  addCashMovementApi,
  CASH_TERMS,
  CASH_TERMS_ALWAYS,
  cashErrorMessage,
  cashFormMessage,
  closeCashApi,
  type ClosureSheet,
  dayKeyOf,
  differenceLabel,
  errorCode,
  fetchClosureSheet,
  financeKeys,
  formatClock,
  formatDateTimeSheet,
  formatDayMonth,
  invalidateFinance,
  type MethodTotal,
  momentOf,
  otherMethods,
  parseAmount,
  spokenMoment,
  useCashState,
} from "../../lib/finance-cash"

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "cobro" : "cobros"}`
}

/**
 * Elección única entre pocas opciones, todas a la vista (tipo de movimiento,
 * motivo, tipo de gasto). Es un grupo de radio: se recorre con las flechas.
 * Con `label` es un `FieldSet` con su leyenda; sin él, solo las opciones, para
 * ir dentro de `field.Group` (que pone la leyenda y el error).
 */
export function ChoiceChips<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  id,
  invalid = false,
  onBlur,
  "aria-describedby": describedBy,
}: {
  label?: string
  value: T | ""
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  disabled?: boolean
  id?: string
  invalid?: boolean
  /** Al salir del grupo (no al pasar de una opción a otra). */
  onBlur?: () => void
  "aria-describedby"?: string
}): React.JSX.Element {
  const group = (
    <RadioGroup
      id={id}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      className="flex flex-wrap gap-2"
      value={value}
      disabled={disabled}
      onValueChange={(next) => onChange(next as T)}
      onBlur={
        onBlur
          ? (event: React.FocusEvent<HTMLDivElement>) => {
              if (!event.currentTarget.contains(event.relatedTarget)) onBlur()
            }
          : undefined
      }
    >
      {options.map((option) => (
        <FieldLabel
          key={option.value}
          className={cn(
            "flex min-h-10 w-auto cursor-pointer items-center gap-2 rounded-xl border px-3 text-sm font-normal",
            value === option.value && "border-primary bg-primary-soft",
            invalid && "border-destructive",
          )}
        >
          <RadioGroupItem value={option.value} />
          {option.label}
        </FieldLabel>
      ))}
    </RadioGroup>
  )
  if (label === undefined) return group
  return (
    <FieldSet data-invalid={invalid || undefined} className="gap-2">
      <FieldLegend variant="label" className="mb-0">
        {label}
      </FieldLegend>
      {group}
    </FieldSet>
  )
}

/** Medios que no se cuentan, agrupados, con su número de cobros. */
function OtherMethodsList({
  rows,
  currency,
  locale,
}: {
  rows: MethodTotal[]
  currency: string
  locale: string
}): React.JSX.Element {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No hubo cobros con otros medios.</p>
  }
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((row) => (
        <li key={row.name} className="flex flex-wrap justify-between gap-x-3">
          <span>
            {row.name} · {countLabel(row.count)}
            {row.refundedCents > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · devuelto {plainAmount(row.refundedCents, currency, locale)}
              </span>
            ) : null}
          </span>
          <span className="tabular-nums">{plainAmount(row.amountCents, currency, locale)}</span>
        </li>
      ))}
    </ul>
  )
}

// --- Cerrar caja ---------------------------------------------------------------------

type SplitField = "retained" | "delivered"

interface CloseValues {
  counted: string
  retained: string
  delivered: string
  /** Lo último que la persona escribió manda; el otro importe se calcula de él. */
  splitField: SplitField | null
  notes: string
}

const CLOSE_DEFAULTS: CloseValues = { counted: "", retained: "", delivered: "", splitField: null, notes: "" }

/** Contado, lo que queda y lo que se entrega según lo escrito (null: vacío o no se entiende). */
function closeAmounts(
  values: CloseValues,
  unit: string,
  locale: string,
  opening: number,
): { countedCents: number | null; retainedCents: number | null; deliveredCents: number | null } {
  const countedCents = values.counted.trim() === "" ? null : parseAmount(values.counted, unit, locale)
  if (countedCents === null) return { countedCents, retainedCents: null, deliveredCents: null }
  if (!values.splitField) {
    // Por defecto se deja lo mismo que quedó la vez anterior, si alcanza.
    const retainedCents = Math.min(opening, countedCents)
    return { countedCents, retainedCents, deliveredCents: countedCents - retainedCents }
  }
  const text = values.splitField === "retained" ? values.retained : values.delivered
  const typed = text.trim() === "" ? null : parseAmount(text, unit, locale)
  if (typed === null) return { countedCents, retainedCents: null, deliveredCents: null }
  return values.splitField === "retained"
    ? { countedCents, retainedCents: typed, deliveredCents: countedCents - typed }
    : { countedCents, retainedCents: countedCents - typed, deliveredCents: typed }
}

export function CashCloseDrawer({
  branchId,
  branchName,
  currency,
  locale,
  timeZone,
  open,
  onClose,
  onClosed,
}: {
  branchId: string
  branchName: string
  /** Moneda de la clínica, mientras llega la de la caja. */
  currency: string
  locale: string
  /** Zona de la sede. */
  timeZone: string
  open: boolean
  onClose: () => void
  /**
   * Recibe la ventana cerrada (su id abre la hoja) y si ya la había cerrado
   * otra persona: en ese caso el servidor devuelve aquel cierre, no este.
   */
  onClosed: (windowId: string, alreadyClosed: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canClose = usePermission("finance.close")
  const cash = useCashState(branchId, open)
  const [notesOpen, setNotesOpen] = useState(false)
  const differenceId = useId()
  const splitHelpId = useId()

  const state = cash.data?.data ?? null
  const unit = state?.currency ?? currency
  const money = (cents: number) => formatMoney(cents, unit, locale)
  const expected = state?.cashOnHandCents ?? 0
  const opening = state?.breakdown.openingCents ?? 0
  const zero = formatMoneyInput(0, unit, locale)

  const closeMutation = useMutation({
    mutationFn: closeCashApi,
    onSuccess: (result, sent) => {
      invalidateFinance(queryClient)
      const alreadyClosed =
        result.data.countedCents !== sent.countedCents ||
        result.data.retainedCents !== sent.retainedCents
      if (!alreadyClosed) toast.success("Caja cerrada")
      onClosed(result.data.id, alreadyClosed)
      onClose()
    },
    onError: (err) => {
      // Hubo movimientos mientras se contaba: se releen los importes.
      if (errorCode(err) === "CASH_WINDOW_CHANGED") {
        void queryClient.invalidateQueries({ queryKey: financeKeys.cash(branchId) })
      }
    },
  })

  const form = useAppForm({
    defaultValues: CLOSE_DEFAULTS,
    validators: {
      onSubmit: ({ value }) => {
        const { countedCents, retainedCents, deliveredCents } = closeAmounts(value, unit, locale, opening)
        const fields: Record<string, string> = {}
        if (value.counted.trim() === "") {
          fields.counted = `Escribe el efectivo que contaste (${zero} si la caja está vacía).`
        } else if (countedCents === null) {
          fields.counted = "Ese importe no se entiende. Revísalo."
        } else if (retainedCents === null || deliveredCents === null) {
          fields[value.splitField ?? "retained"] = "Revisa cuánto dejas en caja y cuánto entregas."
        } else if (retainedCents < 0 || deliveredCents < 0) {
          if (value.splitField === "delivered") fields.delivered = "Lo que entregas no puede superar lo que contaste."
          else fields.retained = "Lo que dejas en caja no puede superar lo que contaste."
        }
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      if (!state) return
      const { countedCents, retainedCents, deliveredCents } = closeAmounts(value, unit, locale, opening)
      if (countedCents === null || retainedCents === null || deliveredCents === null) return
      const notes = value.notes.trim()
      await closeMutation.mutateAsync({
        branchId,
        shiftId: state.shiftId,
        countedCents,
        retainedCents,
        deliveredCents,
        ...(notes ? { notes } : {}),
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { countedCents: "counted", retainedCents: "retained", deliveredCents: "delivered" },
    formMessage: cashFormMessage,
  })

  useEffect(() => {
    if (!open) return
    form.reset(CLOSE_DEFAULTS)
    setNotesOpen(false)
  }, [open, branchId, form])

  const values = useStore(form.store, (s) => s.values)
  const { countedCents, retainedCents, deliveredCents } = closeAmounts(values, unit, locale, opening)
  const shown = (cents: number | null) =>
    cents !== null && cents >= 0 ? formatMoneyInput(cents, unit, locale) : ""
  const difference = countedCents === null ? null : countedCents - expected
  const others = otherMethods(state?.byMethod ?? [])

  const last = state?.lastClosure ?? null
  const description = last
    ? `Todo lo cobrado desde el cierre ${momentOf(spokenMoment(last.closedAt, locale, timeZone))}.`
    : "Todo lo cobrado hasta ahora: esta caja aún no tiene cierres."

  const splitInput = (name: SplitField, label: string, computed: number | null) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label}>
          {(control) => (
            <Input
              {...control.props}
              aria-describedby={[splitHelpId, control.describedBy].filter(Boolean).join(" ")}
              inputMode="decimal"
              autoComplete="off"
              placeholder={zero}
              value={values.splitField === name ? field.state.value : shown(computed)}
              onChange={(event) => {
                form.setFieldValue("splitField", name)
                field.handleChange(event.target.value)
              }}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )

  return (
    <FormDrawer
      {...surface}
      open={open}
      title={branchName ? `Cerrar caja · ${branchName}` : "Cerrar caja"}
      description={description}
      isLoading={open && cash.isPending}
      submitLabel="Cerrar caja"
      submitDisabled={!canClose || !state}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      {cash.isError ? (
        <ErrorState
          title="No se pudo consultar la caja"
          message={cashErrorMessage(cash.error)}
          onRetry={() => void cash.refetch()}
        />
      ) : state ? (
        <div className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Efectivo</h3>
            <dl className="flex flex-col gap-1 rounded-lg bg-muted p-3 text-sm">
              {CASH_TERMS.filter(
                (term) => CASH_TERMS_ALWAYS.has(term.key) || state.breakdown[term.key] !== 0,
              ).map((term) => (
                <div key={term.key} className="flex justify-between gap-3">
                  <dt>{term.label}</dt>
                  <dd className="tabular-nums">
                    {term.sign < 0 ? "− " : ""}
                    {plainAmount(state.breakdown[term.key], unit, locale)}
                  </dd>
                </div>
              ))}
              <div className="mt-1 flex justify-between gap-3 border-t pt-2 text-base font-semibold">
                <dt>Debe haber</dt>
                <dd className="tabular-nums">{money(expected)}</dd>
              </div>
            </dl>
          </section>

          <form.AppField name="counted">
            {(field) => (
              <field.Control label="1. Efectivo que contaste">
                {(control) => (
                  <>
                    <Input
                      {...control.props}
                      aria-describedby={[differenceId, control.describedBy].filter(Boolean).join(" ")}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={zero}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <p id={differenceId} role="status" className="text-sm">
                      {difference === null ? null : difference === 0 ? (
                        <span className="text-success">Cuadra con lo que debe haber.</span>
                      ) : (
                        <span className="text-destructive">
                          {difference < 0
                            ? `Faltan ${money(-difference)}.`
                            : `Sobran ${money(difference)}.`}{" "}
                          Puedes cerrar igual; administración recibirá un aviso.
                        </span>
                      )}
                    </p>
                  </>
                )}
              </field.Control>
            )}
          </form.AppField>

          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-0">
              2. Qué haces con el efectivo
            </FieldLegend>
            <div className="grid grid-cols-2 gap-3">
              {splitInput("retained", "Dejas en caja para mañana", retainedCents)}
              {splitInput("delivered", "Entregas", deliveredCents)}
            </div>
            <FieldDescription id={splitHelpId}>
              Escribe uno y el otro se calcula solo: juntos suman lo que contaste.
            </FieldDescription>
          </FieldSet>

          {notesOpen ? (
            <form.AppField name="notes">
              {(field) => <field.TextareaField label="Nota (opcional)" maxLength={2000} />}
            </form.AppField>
          ) : (
            <div>
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => setNotesOpen(true)}>
                Añadir una nota
              </Button>
            </div>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Otros medios, no se cuentan aquí</h3>
            <OtherMethodsList rows={others} currency={unit} locale={locale} />
            {others.length > 0 ? (
              <p className="text-sm text-muted-foreground">Compáralos con el reporte de cada medio.</p>
            ) : null}
          </section>

          <p className="text-sm text-muted-foreground">
            Queda guardado y se puede imprimir la hoja de cierre.
          </p>
          {!canClose ? (
            <p className="text-sm font-medium">
              Tu rol no puede cerrar la caja. Pídeselo a quien cobra o a administración.
            </p>
          ) : null}
        </div>
      ) : null}
    </FormDrawer>
  )
}

// --- Ingresar o retirar efectivo ------------------------------------------------------

type MoveKind = "aporte" | "retiro"

const MOVE_KINDS: ReadonlyArray<{ value: MoveKind; label: string }> = [
  { value: "aporte", label: "Ingresar" },
  { value: "retiro", label: "Retirar" },
]

const OTHER_PURPOSE = "otro"

const MOVE_PURPOSES: Record<MoveKind, ReadonlyArray<{ value: string; label: string }>> = {
  aporte: [
    { value: "cambio", label: "Fondo para cambio" },
    { value: OTHER_PURPOSE, label: "Otro" },
  ],
  retiro: [
    { value: "banco", label: "Depósito al banco" },
    { value: "administracion", label: "Entrega a administración" },
    { value: OTHER_PURPOSE, label: "Otro" },
  ],
}

interface MoveValues {
  kind: MoveKind
  amount: string
  purpose: string
  detail: string
}

const MOVE_DEFAULTS: MoveValues = { kind: "aporte", amount: "", purpose: MOVE_PURPOSES.aporte[0].value, detail: "" }

export function CashMoveDrawer({
  branchId,
  currency,
  locale,
  open,
  onClose,
}: {
  branchId: string
  /** Moneda de la clínica, mientras llega la de la caja. */
  currency: string
  locale: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const cash = useCashState(branchId, open)
  const resultId = useId()

  // Una sede sin caja todavía parte de cero: el ingreso la crea.
  const state = cash.data?.data ?? null
  const unit = state?.currency ?? currency
  const money = (cents: number) => formatMoney(cents, unit, locale)
  const onHand = state?.cashOnHandCents ?? 0
  const centsOf = (text: string) => (text.trim() === "" ? null : parseAmount(text, unit, locale))

  const moveMutation = useMutation({
    mutationFn: addCashMovementApi,
    onSuccess: (_result, sent) => {
      invalidateFinance(queryClient)
      toast.success(sent.kind === "aporte" ? "Efectivo ingresado" : "Efectivo retirado")
      onClose()
    },
    onError: (err) => {
      if (errorCode(err) === "INSUFFICIENT_CASH") {
        void queryClient.invalidateQueries({ queryKey: financeKeys.cash(branchId) })
      }
    },
  })

  const form = useAppForm({
    defaultValues: MOVE_DEFAULTS,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        const cents = centsOf(value.amount)
        if (value.amount.trim() !== "" && cents === null) fields.amount = "Ese importe no se entiende. Revísalo."
        else if (cents === null || cents <= 0) fields.amount = "Escribe un importe mayor que cero."
        else if (value.kind === "retiro" && cents > onHand)
          fields.amount = `No puedes retirar más de lo que hay en la caja: ${money(onHand)}.`
        if (value.purpose === OTHER_PURPOSE && !value.detail.trim()) fields.detail = "Cuenta para qué es el movimiento."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const cents = centsOf(value.amount)
      if (cents === null) return
      const extra = value.detail.trim()
      const label = MOVE_PURPOSES[value.kind].find((item) => item.value === value.purpose)?.label ?? ""
      await moveMutation.mutateAsync({
        branchId,
        kind: value.kind,
        amountCents: cents,
        concept: (value.purpose === OTHER_PURPOSE ? extra : extra ? `${label}: ${extra}` : label).slice(0, 500),
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { amountCents: "amount", concept: "detail" },
    formMessage: cashFormMessage,
  })

  useEffect(() => {
    if (open) form.reset(MOVE_DEFAULTS)
  }, [open, branchId, form])

  const values = useStore(form.store, (s) => s.values)
  const cents = centsOf(values.amount)
  const after = cents === null ? null : values.kind === "aporte" ? onHand + cents : onHand - cents
  const verb = values.kind === "aporte" ? "Ingresar" : "Retirar"
  const needsDetail = values.purpose === OTHER_PURPOSE

  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Efectivo de la caja"
      description="Para el efectivo que entra o sale sin ser un cobro ni un gasto."
      isLoading={open && cash.isPending}
      submitLabel={cents !== null && cents > 0 ? `${verb} ${money(cents)}` : verb}
      submitDisabled={!canWrite || cash.isError}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      {cash.isError ? (
        <ErrorState
          title="No se pudo consultar la caja"
          message={cashErrorMessage(cash.error)}
          onRetry={() => void cash.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-5">
          <form.AppField name="kind">
            {(field) => (
              <field.Group legend="Qué haces">
                {(control) => (
                  <ChoiceChips
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    options={MOVE_KINDS}
                    onChange={(next) => {
                      field.handleChange(next)
                      form.setFieldValue("purpose", MOVE_PURPOSES[next][0].value)
                    }}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
          <form.AppField name="amount">
            {(field) => (
              <field.Control label="Importe">
                {(control) => (
                  <Input
                    {...control.props}
                    aria-describedby={[resultId, control.describedBy].filter(Boolean).join(" ")}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={formatMoneyInput(0, unit, locale)}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name="purpose">
            {(field) => (
              <field.Group legend="Para qué">
                {(control) => (
                  <ChoiceChips
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    options={MOVE_PURPOSES[values.kind]}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
          <form.AppField name="detail">
            {(field) => <field.TextField label={needsDetail ? "Detalle" : "Detalle (opcional)"} maxLength={300} />}
          </form.AppField>
          <div
            id={resultId}
            role="status"
            className="flex flex-wrap items-baseline justify-between gap-x-3 rounded-lg bg-muted p-3 text-sm"
          >
            {after === null || after < 0 ? (
              <>
                <span>En la caja hay</span>
                <span className="text-base font-semibold tabular-nums">{money(onHand)}</span>
              </>
            ) : (
              <>
                <span>El efectivo de la caja queda en</span>
                <span className="text-base font-semibold tabular-nums">{money(after)}</span>
              </>
            )}
          </div>
          {!canWrite ? (
            <p className="text-sm font-medium">
              Tu rol no puede ingresar ni retirar efectivo. Pídeselo a quien cobra o a administración.
            </p>
          ) : null}
        </div>
      )}
    </FormDrawer>
  )
}

// --- Hoja de cierre --------------------------------------------------------------------

const PRINT_HOLDER_ID = "hoja-cierre-impresion"

function sheetNodeId(sheet: ClosureSheet): string {
  return `cierre-${sheet.closure.id}`
}

/**
 * Imprime solo la hoja: una copia pasa a ser hija directa de la página
 * mientras dura la impresión, así no depende de dónde esté abierto el panel.
 * Tinta negra sobre blanco, también con el tema oscuro, y al ancho de la
 * térmica de la clínica.
 */
function printClosureSheet(sheet: ClosureSheet): void {
  const node = document.getElementById(sheetNodeId(sheet))
  if (!node) return
  document.getElementById(PRINT_HOLDER_ID)?.remove()
  document.getElementById(`${PRINT_HOLDER_ID}-estilo`)?.remove()
  const width = sheet.orgProfile?.receiptWidth === "58" ? "58mm" : "80mm"
  const copy = node.cloneNode(true) as HTMLElement
  copy.removeAttribute("id")
  const holder = document.createElement("div")
  holder.id = PRINT_HOLDER_ID
  holder.append(copy)
  const style = document.createElement("style")
  style.id = `${PRINT_HOLDER_ID}-estilo`
  style.textContent = `
    #${PRINT_HOLDER_ID} { display: none; }
    @media print {
      body > *:not(#${PRINT_HOLDER_ID}) { display: none !important; }
      #${PRINT_HOLDER_ID} { display: block; width: ${width}; }
      #${PRINT_HOLDER_ID}, #${PRINT_HOLDER_ID} * {
        color: #000 !important;
        background: transparent !important;
        border-color: #000 !important;
        box-shadow: none !important;
      }
    }`
  const cleanup = () => {
    holder.remove()
    style.remove()
    window.removeEventListener("afterprint", cleanup)
  }
  window.addEventListener("afterprint", cleanup)
  document.head.append(style)
  document.body.append(holder)
  window.print()
}

/** Hoja de cierre tal como se imprime y se firma. */
export function CashClosureSheet({
  sheet,
  locale,
  orgTimeZone,
}: {
  sheet: ClosureSheet
  locale: string
  /** Zona de la clínica, para una sede que no tiene la suya. */
  orgTimeZone: string
}): React.JSX.Element {
  const closure = sheet.closure
  const timeZone = sheet.branch?.timezone || sheet.orgProfile?.timezone || orgTimeZone
  const money = (cents: number | null | undefined) =>
    cents === null || cents === undefined ? "—" : plainAmount(cents, closure.currency, locale)
  const orgName = sheet.orgProfile?.tradeName || sheet.orgProfile?.legalName || ""
  // Mismo orden que el panel de cierre; los cierres antiguos no guardan todo.
  const terms: Array<{ key: string; label: string; sign: 1 | -1; cents: number | null | undefined; always: boolean }> = [
    { key: "quedo", label: "Quedó del cierre anterior", sign: 1, cents: closure.openingRetainedCents, always: true },
    { key: "cobros", label: "Cobros en efectivo", sign: 1, cents: closure.cashCollectedCents, always: true },
    { key: "ingresado", label: "Efectivo ingresado", sign: 1, cents: closure.cashAddedCents, always: false },
    { key: "gastos", label: "Gastos", sign: -1, cents: closure.expenseCashCents, always: true },
    { key: "retirado", label: "Efectivo retirado", sign: -1, cents: closure.cashWithdrawnCents, always: false },
    { key: "devuelto", label: "Devuelto en efectivo", sign: -1, cents: closure.cashRefundedCents, always: false },
  ]
  const others = otherMethods(sheet.totalsByMethod ?? [])

  return (
    <div
      id={sheetNodeId(sheet)}
      className="flex flex-col gap-1 rounded-lg border bg-card p-4 text-sm"
    >
      {orgName ? <p className="text-center font-semibold">{orgName}</p> : null}
      {sheet.branch ? <p className="text-center">{sheet.branch.name}</p> : null}
      <p className="mt-1 text-center font-heading text-base font-semibold">CIERRE DE CAJA</p>
      <p className="text-center">{formatDateTimeSheet(closure.closedAt, locale, timeZone)}</p>
      {sheet.legacy ? (
        <p className="text-center text-xs text-muted-foreground">
          Cierre anterior a la hoja completa: no guarda el detalle por medio ni lo entregado.
        </p>
      ) : null}
      <dl className="mt-2 flex flex-col gap-1">
        <div className="flex justify-between gap-3">
          <dt>Cerró</dt>
          <dd className="text-right">{sheet.closedByName ?? "—"}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Desde</dt>
          <dd className="text-right">{formatDateTimeSheet(closure.windowFrom, locale, timeZone)}</dd>
        </div>
      </dl>
      <dl className="mt-2 flex flex-col gap-1 border-t pt-2">
        {terms
          .filter((term) => term.always || (term.cents ?? 0) !== 0)
          .map((term) => (
            <div key={term.key} className="flex justify-between gap-3">
              <dt>{term.label}</dt>
              <dd className="tabular-nums">
                {term.sign < 0 && term.cents ? "− " : ""}
                {money(term.cents)}
              </dd>
            </div>
          ))}
        <div className="flex justify-between gap-3 font-semibold">
          <dt>Debe haber</dt>
          <dd className="tabular-nums">{money(closure.expectedCents)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Contado</dt>
          <dd className="tabular-nums">{money(closure.countedCents)}</dd>
        </div>
        <div className="flex justify-between gap-3 font-semibold">
          <dt>Diferencia</dt>
          <dd className="tabular-nums">
            {closure.differenceCents === null
              ? "—"
              : differenceLabel(closure.differenceCents, (cents) => money(cents))}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>Queda en caja</dt>
          <dd className="tabular-nums">{money(closure.retainedCents)}</dd>
        </div>
        <div className="mt-1 flex justify-between gap-3 border-t pt-2 text-base font-semibold">
          <dt>ENTREGA</dt>
          <dd className="tabular-nums">
            {closure.deliveredCents === null
              ? "—"
              : formatMoney(closure.deliveredCents, closure.currency, locale)}
          </dd>
        </div>
      </dl>
      {sheet.totalsByMethod ? (
        <div className="mt-2 flex flex-col gap-1 border-t pt-2">
          <p className="text-xs text-muted-foreground">Otros medios (no se cuentan)</p>
          {others.length === 0 ? (
            <p className="text-muted-foreground">Sin cobros con otros medios.</p>
          ) : (
            <dl className="flex flex-col gap-1">
              {others.map((row) => (
                <div key={row.name} className="flex justify-between gap-3">
                  <dt>
                    {row.name} ({row.count})
                    {row.refundedCents > 0 ? ` · devuelto ${money(row.refundedCents)}` : ""}
                  </dt>
                  <dd className="tabular-nums">{money(row.amountCents)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ) : null}
      {closure.notes ? (
        <p className="mt-2 border-t pt-2">
          <span className="text-muted-foreground">Nota: </span>
          {closure.notes}
        </p>
      ) : null}
      <div className="mt-8 grid grid-cols-2 gap-4 text-xs">
        <p className="border-t pt-1">Entrega</p>
        <p className="border-t pt-1">Recibe</p>
      </div>
    </div>
  )
}

/** Hoja de un cierre por su id (o el de su ventana), con su botón de imprimir. */
export function ClosureSheetDrawer({
  closureId,
  locale,
  orgTimeZone,
  notice,
  onShowTickets,
  onClose,
}: {
  closureId: string | null
  locale: string
  orgTimeZone: string
  /** Aviso sobre la hoja abierta (p. ej. que la caja ya estaba cerrada). */
  notice?: string | null
  /** Abre Cobros con los días de la ventana del cierre (días de la sede). */
  onShowTickets?: (range: { from: string; to: string }) => void
  onClose: () => void
}): React.JSX.Element {
  const query = useQuery({
    queryKey: financeKeys.closure(closureId ?? ""),
    queryFn: () => fetchClosureSheet(closureId as string),
    enabled: closureId !== null,
    // Un cierre no cambia: no hace falta releerlo.
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const sheet = closureId !== null ? (query.data?.data ?? null) : null
  const missing = query.isError && errorCode(query.error) === "NOT_FOUND"

  return (
    <DetailDrawer
      open={closureId !== null}
      onClose={onClose}
      title="Hoja de cierre"
      size="lg"
      isLoading={closureId !== null && query.isPending}
      actions={
        sheet ? (
          <Button type="button" onClick={() => printClosureSheet(sheet)}>
            Imprimir
          </Button>
        ) : undefined
      }
    >
      {query.isError ? (
        <ErrorState
          title={missing ? "No encontramos ese cierre" : "No se pudo abrir la hoja"}
          message={
            missing
              ? "Puede que el enlace sea de otra clínica o que el cierre ya no exista."
              : cashErrorMessage(query.error)
          }
          onRetry={missing ? undefined : () => void query.refetch()}
        />
      ) : sheet ? (
        <div className="flex flex-col gap-3">
          {notice ? (
            <p role="status" className="rounded-lg bg-muted p-3 text-sm">
              {notice}
            </p>
          ) : null}
          <CashClosureSheet sheet={sheet} locale={locale} orgTimeZone={orgTimeZone} />
          <CountedMovements sheet={sheet} locale={locale} orgTimeZone={orgTimeZone} onShowTickets={onShowTickets} />
          <p className="text-sm text-muted-foreground">
            Un cierre no se edita. Lo que se corrija después queda como movimiento del día en que
            se corrige.
          </p>
        </div>
      ) : null}
    </DetailDrawer>
  )
}

/**
 * Lo que contó el cierre, movimiento por movimiento (cobros con su ticket,
 * gastos, ingresos, retiros y devoluciones en efectivo): para entender una
 * diferencia sin rehacer el día. No se imprime; la hoja ya lleva los totales.
 */
function CountedMovements({
  sheet,
  locale,
  orgTimeZone,
  onShowTickets,
}: {
  sheet: ClosureSheet
  locale: string
  orgTimeZone: string
  onShowTickets?: (range: { from: string; to: string }) => void
}): React.JSX.Element | null {
  const headingId = useId()
  const timeZone = sheet.branch?.timezone || sheet.orgProfile?.timezone || orgTimeZone
  const from = dayKeyOf(sheet.closure.windowFrom, timeZone)
  const to = dayKeyOf(sheet.closure.closedAt ?? sheet.closure.windowTo ?? sheet.closure.windowFrom, timeZone)
  const rows = (sheet.counted ?? []).filter((row) => row.kind !== "apertura")
  const money = (cents: number) => plainAmount(cents, sheet.closure.currency, locale)
  const when = (iso: string) =>
    from === to ? formatClock(iso, locale, timeZone) : `${formatDayMonth(iso, locale, timeZone)} ${formatClock(iso, locale, timeZone)}`
  const what = (row: ClosureSheet["counted"][number]): string => {
    if (row.kind === "cobro")
      return row.ticketNumber !== null
        ? `Ticket ${ticketDisplayNumber(row.ticketNumber)}${row.patientName ? ` · ${row.patientName}` : ""}`
        : row.concept
    if (row.kind === "gasto") return `Gasto: ${row.concept}`
    if (row.kind === "aporte") return `Ingreso de efectivo: ${row.concept}`
    if (row.kind === "retiro") return `Retiro de efectivo: ${row.concept}`
    return `Devolución: ${row.concept}`
  }
  if (rows.length === 0 && !onShowTickets) return null
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-sm font-semibold">
        Lo que contó · {rows.length === 1 ? "1 movimiento" : `${rows.length} movimientos`} en efectivo
      </h3>
      {rows.length > 0 ? (
        <ul className="divide-y rounded-lg border bg-card text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-baseline gap-3 px-3 py-2">
              <span className="w-24 shrink-0 text-muted-foreground tabular-nums">{when(row.createdAt)}</span>
              <span className="min-w-0 flex-1 break-words">{what(row)}</span>
              <span className={`shrink-0 tabular-nums ${row.direction === "egreso" ? "text-destructive" : ""}`}>
                {row.direction === "egreso" ? "− " : ""}
                {money(row.amountCents)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No hubo movimientos en efectivo en esta ventana.</p>
      )}
      {onShowTickets ? (
        <Button type="button" variant="link" className="h-auto self-start p-0" onClick={() => onShowTickets({ from, to })}>
          {from === to ? "Ver todos los cobros de ese día" : "Ver todos los cobros de esos días"}
        </Button>
      ) : null}
    </section>
  )
}
