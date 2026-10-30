/**
 * «Registrar gasto»: el formulario corto de Finanzas › Gastos, también desde
 * Reportes («Copiar el de agosto» llega con lo del mes anterior ya escrito).
 *
 * Con el tipo Materiales pregunta «¿Es el pago de una compra de Inventario?»
 * si hay compras por pagar o sin llegar: elegir una registra el pago de esa
 * compra (`/api/finance/purchases/:id/payments`, la misma operación que desde
 * Inventario; ADR 0061) y así no se cuenta dos veces.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  cn,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import {
  DatePickerButton,
  FormChoiceField,
  FormDrawer,
  useAppForm,
  useFieldContext,
  useFieldControl,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import { usePermission } from "../../lib/crm"
import { orgTaxesOf, useOrgProfile } from "../../lib/org"
import { ChoiceButtons } from "../choice-buttons"
import {
  cashFormMessage,
  createExpenseApi,
  errorCode,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  fetchPurchasesToPay,
  financeKeys,
  formatDayKey,
  invalidateFinance,
  noonOf,
  parseAmount,
  payPurchaseApi,
  todayIn,
  useCashState,
} from "../../lib/finance-cash"
import { type PurchaseBalance, purchaseOrderLabel } from "../../lib/reports"
import { ChoiceChips } from "./cash-close-drawer"

/** Dónde se registra el gasto: la sede y el formato de la clínica. */
export interface ExpensePlace {
  branchId: string
  branchName: string
  currency: string
  locale: string
  /** Zona de la clínica: el día del gasto. */
  orgTimeZone: string
}

/** Lo que llega escrito: «Copiar el de agosto». */
export interface ExpenseDraft {
  category: ExpenseCategory
  concept: string
  amountCents: number
  /** Día del gasto, `YYYY-MM-DD`. */
  day?: string
}

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((value) => ({ value, label: value }))
/** «No, es otro gasto de materiales». */
const OTHER = "otro"

interface ExpenseValues {
  category: ExpenseCategory | ""
  /** El pago del impuesto de lo cobrado (ADR 0083): se pregunta solo en «Impuestos» y en un país que lo separa. */
  salesTax: "cobros" | "otro" | null
  purchase: string
  concept: string
  amount: string
  fromCash: boolean
  receiptKind: string
  receiptNumber: string
  spentDay: string
}

/** «¿Es el pago de una compra de Inventario?»: el grupo con su error debajo. */
function PurchaseChoice({
  orders,
  branchId,
  money,
  onChoose,
}: {
  orders: PurchaseBalance[]
  branchId: string
  money: (cents: number) => string
  onChoose: (orderId: string) => void
}) {
  const field = useFieldContext<string>()
  const { control, errors, descriptionId, errorId } = useFieldControl({ hasDescription: true })
  const legendId = `${control.id}-leyenda`
  return (
    <fieldset data-invalid={control.invalid || undefined} className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3.5">
      <legend id={legendId} className={cn("px-1 font-bold", control.invalid && "text-destructive")}>
        ¿Es el pago de una compra de Inventario?
      </legend>
      <RadioGroup
        id={control.id}
        aria-labelledby={legendId}
        aria-describedby={control.describedBy}
        aria-invalid={control.invalid || undefined}
        value={field.state.value}
        onValueChange={(value) => onChoose(String(value))}
        onBlur={(event: React.FocusEvent<HTMLDivElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget)) control.onBlur()
        }}
        className="flex flex-col gap-1"
      >
        {orders.map((order) => (
          <FieldLabel key={order.orderId} className="flex min-h-11 cursor-pointer items-center gap-2.5 font-normal">
            <RadioGroupItem value={order.orderId} />
            <span className="min-w-0 flex-1">
              {purchaseOrderLabel(order.orderNumber)} · {order.supplierName}
              {order.branchId !== branchId ? <span className="text-muted-foreground"> · {order.branchName}</span> : null}
            </span>
            <span className={cn("shrink-0 text-sm font-semibold", order.dueCents > 0 ? "text-warning" : "text-muted-foreground")}>
              {order.dueCents > 0 ? `por pagar ${money(order.dueCents)}` : order.receivedCents === 0 ? "aún no llega" : "al día, falta que llegue"}
            </span>
          </FieldLabel>
        ))}
        <FieldLabel className="flex min-h-11 cursor-pointer items-center gap-2.5 font-semibold">
          <RadioGroupItem value={OTHER} />
          No, es otro gasto de materiales
        </FieldLabel>
      </RadioGroup>
      <p id={descriptionId} className="text-sm text-muted-foreground">
        Si eliges una compra, el monto y la sede se llenan solos y la compra queda al día en Inventario. Así no se cuenta dos veces.
      </p>
      {control.invalid ? <FieldError id={errorId} errors={errors.map((message) => ({ message }))} /> : null}
    </fieldset>
  )
}

export function ExpenseFormDrawer({
  place,
  open,
  onClose,
  initial,
}: {
  place: ExpensePlace
  open: boolean
  onClose: () => void
  initial?: ExpenseDraft | null
}) {
  const { branchId, locale, orgTimeZone } = place
  const queryClient = useQueryClient()
  const canWrite = usePermission("finance.write")
  const cash = useCashState(branchId, open)
  const today = todayIn(orgTimeZone)
  const salesTaxHelpId = useId()
  const salesTaxName = orgTaxesOf(useOrgProfile().data)?.name ?? null
  // Lo que se vio de la compra al elegirla: si cambia mientras tanto, el servidor lo dice.
  const [seen, setSeen] = useState<{ due: number; paid: number } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)

  const state = cash.data?.data ?? null
  const unit = state?.currency ?? place.currency
  const money = (cents: number) => formatMoney(cents, unit, locale)

  const form = useAppForm({
    defaultValues: {
      category: "",
      salesTax: null,
      purchase: OTHER,
      concept: "",
      amount: "",
      fromCash: true,
      receiptKind: "",
      receiptNumber: "",
      spentDay: today,
    } as ExpenseValues,
    validators: {
      onSubmit: ({ value }) => {
        const { chosen, asksSalesTax, cents, after } = derive(value)
        const fields: Record<string, string> = {}
        if (value.category === "") fields.category = "Elige el tipo de gasto."
        if (asksSalesTax && value.salesTax === null) fields.salesTax = "Elige qué impuesto pagas."
        if (!chosen && !value.concept.trim()) fields.concept = "Escribe en qué se gastó."
        if (value.amount.trim() !== "" && cents === null) fields.amount = "Ese importe no se entiende. Revísalo."
        else if (cents === null || cents <= 0) fields.amount = "Escribe un importe mayor que cero."
        else if (after !== null && after < 0 && state)
          fields.fromCash = `En la caja solo hay ${money(state.cashOnHandCents)}: no alcanza para pagar este gasto con el efectivo.`
        if (value.spentDay > today) fields.spentDay = "La fecha del gasto no puede ser futura."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const { chosen, asksSalesTax, cents } = derive(value)
      if (cents === null || value.category === "") return
      // Hoy lleva la hora real; otro día, su mediodía en la zona de la clínica.
      const spentAt = value.spentDay === today ? {} : { spentAt: noonOf(value.spentDay, orgTimeZone) }
      const receipt = {
        ...(value.receiptKind.trim() ? { receiptKind: value.receiptKind.trim() } : {}),
        ...(value.receiptNumber.trim() ? { receiptNumber: value.receiptNumber.trim() } : {}),
      }
      if (chosen) {
        // Lo que vio la persona al elegirla: si alguien pagó mientras tanto, o este envío ya entró, el servidor lo dice en vez de pagar de más.
        await payMutation.mutateAsync({
          orderId: chosen.orderId,
          body: {
            amountCents: cents,
            fromCash: value.fromCash,
            expectedDueCents: seen?.due ?? chosen.dueCents,
            expectedPaidCents: seen?.paid ?? chosen.paidCents,
            ...receipt,
            ...spentAt,
          },
        })
        return
      }
      await createMutation.mutateAsync({
        branchId,
        concept: value.concept.trim(),
        amountCents: cents,
        category: value.category,
        fromCash: value.fromCash,
        ...(asksSalesTax ? { salesTax: value.salesTax === "cobros" } : {}),
        ...receipt,
        ...spentAt,
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { amountCents: "amount", spentAt: "spentDay", orderId: "purchase" },
    formMessage: cashFormMessage,
  })
  const values = useStore(form.store, (s) => s.values)

  // Se llena al abrir y solo entonces: si quien lo abre vuelve a pintar (otro `initial`
  // tras una consulta), lo que ya se escribió se queda.
  const filled = useRef(false)
  useEffect(() => {
    if (!open) {
      filled.current = false
      return
    }
    if (filled.current) return
    filled.current = true
    const day = todayIn(orgTimeZone)
    form.reset({
      category: initial?.category ?? "",
      salesTax: null,
      purchase: OTHER,
      concept: initial?.concept ?? "",
      amount: initial ? formatMoneyInput(initial.amountCents, place.currency, locale) : "",
      fromCash: !initial,
      receiptKind: "",
      receiptNumber: "",
      spentDay: initial?.day && initial.day <= day ? initial.day : day,
    })
    setSeen(null)
    setMoreOpen(Boolean(initial?.day && initial.day !== day))
  }, [open, orgTimeZone, initial, place.currency, locale, form])

  // Una fecha que no pasa abre «Más detalles» para que se vea su error.
  const spentDayInvalid = useStore(form.store, (s) => (s.fieldMeta.spentDay?.errors.length ?? 0) > 0)
  useEffect(() => {
    if (spentDayInvalid) setMoreOpen(true)
  }, [spentDayInvalid])

  // Las compras se preguntan solo con Materiales: las recibidas sin pagar primero, luego lo que aún no llega.
  const purchases = useQuery({
    queryKey: financeKeys.purchases(null),
    queryFn: () => fetchPurchasesToPay(),
    enabled: open && values.category === "Materiales",
  })
  const orders = (purchases.data?.data.orders ?? []).filter((order) => order.currency === unit)

  /** Lo que se deduce de lo elegido: la compra que se paga, si se pregunta el impuesto y cómo queda la caja. */
  function derive(value: ExpenseValues) {
    // Solo un gasto de Materiales paga una compra: si se cambia el tipo, ya no es ese pago.
    const chosen = value.category === "Materiales" ? (orders.find((order) => order.orderId === value.purchase) ?? null) : null
    const asksSalesTax = value.category === "Impuestos" && salesTaxName !== null
    const cents = value.amount.trim() === "" ? null : parseAmount(value.amount, unit, locale)
    // Con la caja a la vista se avisa antes de guardar si el efectivo no alcanza.
    const after =
      value.fromCash && state && cents !== null && (!chosen || chosen.branchId === branchId) ? state.cashOnHandCents - cents : null
    return { chosen, asksSalesTax, cents, after }
  }
  const { chosen, asksSalesTax, after } = derive(values)
  // Sin nada recibido por pagar, lo que se paga es un adelanto de lo que falta que llegue.
  const advance = chosen !== null && chosen.dueCents === 0
  const asksPurchase = values.category === "Materiales" && orders.length > 0
  const otherBranch = chosen !== null && chosen.branchId !== branchId

  const done = (message: string) => {
    invalidateFinance(queryClient)
    toast.success(message)
    onClose()
  }
  const createMutation = useMutation({
    mutationFn: createExpenseApi,
    onSuccess: () => done("Gasto registrado"),
  })
  const payMutation = useMutation({
    mutationFn: (input: { orderId: string; body: Parameters<typeof payPurchaseApi>[1] }) => payPurchaseApi(input.orderId, input.body),
    onSuccess: (result, input) => {
      const order = orders.find((item) => item.orderId === input.orderId)
      const left = result.data.balance.dueCents
      if (!order) done("Pago registrado")
      else if (order.dueCents === 0)
        done(`Adelanto registrado: ${purchaseOrderLabel(order.orderNumber)} lo descuenta cuando llegue${order.receivedCents > 0 ? " lo que falta" : ""}`)
      else if (left > 0) done(`Pago registrado: a ${purchaseOrderLabel(order.orderNumber)} le falta ${money(left)}`)
      else done(`Pago registrado: ${purchaseOrderLabel(order.orderNumber)} queda al día en Inventario`)
    },
    onError: (err) => {
      // La compra cambió: se relee y el próximo envío compara con lo que se ve ahora, no con lo de antes.
      const code = errorCode(err)
      if (code === "PURCHASE_PAID_CHANGED" || code === "PURCHASE_DUE_CHANGED") {
        setSeen(null)
        void queryClient.invalidateQueries({ queryKey: financeKeys.purchases(null) })
      }
    },
  })

  const choosePurchase = (value: string) => {
    form.setFieldValue("purchase", value)
    const order = orders.find((item) => item.orderId === value)
    setSeen(order ? { due: order.dueCents, paid: order.paidCents } : null)
    if (order) {
      const suggested = order.dueCents > 0 ? order.dueCents : Math.max(0, order.orderedCents - order.paidCents)
      form.setFieldValue("amount", suggested > 0 ? formatMoneyInput(suggested, unit, locale) : "")
      // Un pago a otra sede no sale de esta caja.
      if (order.branchId !== branchId) form.setFieldValue("fromCash", false)
    }
  }

  return (
    <FormDrawer
      {...surface}
      open={open}
      title="Registrar gasto"
      description={chosen ? `Pago de una compra de ${chosen.branchName}.` : place.branchName ? `Gasto de ${place.branchName}.` : undefined}
      submitLabel={chosen ? (advance ? "Registrar adelanto" : "Registrar pago") : "Registrar gasto"}
      submitDisabled={!canWrite}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="category">
          {(field) => (
            <field.Group legend="Tipo">
              {(control) => (
                <ChoiceChips
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={CATEGORY_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {asksSalesTax ? (
          <form.AppField name="salesTax">
            {(field) => (
              <field.Group legend="¿Qué impuesto pagas?">
                {(control) => (
                  <>
                    <ChoiceButtons
                      id={control.id}
                      invalid={control.invalid}
                      onBlur={control.onBlur}
                      aria-label="¿Qué impuesto pagas?"
                      aria-describedby={[salesTaxHelpId, control.describedBy].filter(Boolean).join(" ")}
                      tone="primary"
                      columns={2}
                      value={field.state.value}
                      options={[
                        { value: "cobros", label: `${salesTaxName} de tus cobros` },
                        { value: "otro", label: "Otro (renta, municipal…)" },
                      ]}
                      onChange={(next) => field.handleChange(next)}
                    />
                    <FieldDescription id={salesTaxHelpId}>
                      {field.state.value === "otro"
                        ? "Resta de lo que deja, como cualquier gasto."
                        : `El ${salesTaxName} ya se restó de lo cobrado, así que no vuelve a restar de lo que deja. Si pagas ${salesTaxName} y renta juntos, regístralos por separado.`}
                    </FieldDescription>
                  </>
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {asksPurchase ? (
          <form.AppField name="purchase">
            {() => <PurchaseChoice orders={orders} branchId={branchId} money={money} onChoose={choosePurchase} />}
          </form.AppField>
        ) : null}
        {chosen ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            Queda como gasto de <strong>Materiales</strong> de {chosen.branchName}:{" "}
            {advance ? "Adelanto" : "Pago"} de compra {purchaseOrderLabel(chosen.orderNumber)} · {chosen.supplierName}.
          </p>
        ) : (
          <form.AppField name="concept">
            {(field) => <field.TextField label="En qué se gastó" maxLength={500} />}
          </form.AppField>
        )}
        <form.AppField name="amount">
          {(field) => (
            <field.Control
              label="Importe"
              description={
                chosen
                  ? chosen.dueCents > 0
                    ? `Por pagar: ${money(chosen.dueCents)}. Puedes pagar una parte.`
                    : chosen.receivedCents === 0
                      ? "Aún no llega nada: queda como adelanto y se descuenta cuando llegue."
                      : "Lo que llegó ya está pagado: queda como adelanto de lo que falta y se descuenta cuando llegue."
                  : undefined
              }
            >
              {(control) => (
                <Input
                  {...control.props}
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
        <form.AppField name="fromCash">
          {(field) => (
            <FormChoiceField
              label="Se pagó con el efectivo de la caja"
              description={
                otherBranch && chosen
                  ? `Es de otra sede (${chosen.branchName}): no sale de esta caja.`
                  : after === null || (after < 0 && state)
                    ? "Se descuenta del efectivo que debe haber al cerrar."
                    : `Se descuenta del efectivo que debe haber al cerrar: la caja queda en ${money(after)}.`
              }
            >
              {(control) => (
                <Checkbox
                  id={control.id}
                  aria-invalid={control.invalid || undefined}
                  aria-describedby={control.describedBy}
                  checked={field.state.value}
                  disabled={otherBranch}
                  onCheckedChange={(checked) => {
                    field.handleChange(checked === true)
                    control.onBlur()
                  }}
                />
              )}
            </FormChoiceField>
          )}
        </form.AppField>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="link" className="h-auto p-0" />}>
            Más detalles: comprobante recibido y fecha
            <ChevronDown aria-hidden className={cn("transition-transform", moreOpen && "rotate-180")} />
          </CollapsibleTrigger>
          {/* Montado aunque esté cerrado: el error de la fecha (también del servidor) tiene dónde ir. */}
          <CollapsibleContent keepMounted>
            <div className="flex flex-col gap-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <form.AppField name="receiptKind">
                  {(field) => <field.TextField label="Comprobante recibido" maxLength={60} placeholder="Factura, recibo…" />}
                </form.AppField>
                <form.AppField name="receiptNumber">
                  {(field) => <field.TextField label="Número" maxLength={60} autoComplete="off" />}
                </form.AppField>
              </div>
              <form.AppField name="spentDay">
                {(field) => (
                  <field.Control label="Fecha del gasto">
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        className="justify-start font-normal"
                        value={field.state.value}
                        max={today}
                        onChange={(day) => field.handleChange(day)}
                      >
                        {formatDayKey(field.state.value, locale, today)}
                      </DatePickerButton>
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>
          </CollapsibleContent>
        </Collapsible>
        {!canWrite ? (
          <p className="text-sm font-medium">
            Tu rol no puede registrar gastos. Pídeselo a quien cobra o a administración.
          </p>
        ) : null}
      </div>
    </FormDrawer>
  )
}
