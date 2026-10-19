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
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  toast,
} from "@odentia/ui"
import { DatePickerButton, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { usePermission } from "../../lib/crm"
import {
  cashErrorMessage,
  createExpenseApi,
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
import { purchaseOrderLabel } from "../../lib/reports"
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
  const questionId = useId()
  const [concept, setConcept] = useState("")
  const [amount, setAmount] = useState("")
  const [category, setCategory] = useState<ExpenseCategory | "">("")
  const [purchase, setPurchase] = useState<string>(OTHER)
  const [fromCash, setFromCash] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)
  const [receiptKind, setReceiptKind] = useState("")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [spentDay, setSpentDay] = useState(today)
  const [error, setError] = useState<string | null>(null)

  const state = cash.data?.data ?? null
  const unit = state?.currency ?? place.currency
  const money = (cents: number) => formatMoney(cents, unit, locale)

  useEffect(() => {
    if (!open) return
    setConcept(initial?.concept ?? "")
    setAmount(initial ? formatMoneyInput(initial.amountCents, place.currency, locale) : "")
    setCategory(initial?.category ?? "")
    setPurchase(OTHER)
    setFromCash(!initial)
    setMoreOpen(Boolean(initial?.day && initial.day !== todayIn(orgTimeZone)))
    setReceiptKind("")
    setReceiptNumber("")
    setSpentDay(initial?.day && initial.day <= todayIn(orgTimeZone) ? initial.day : todayIn(orgTimeZone))
    setError(null)
  }, [open, orgTimeZone, initial, place.currency, locale])

  // Las compras se preguntan solo con Materiales: las recibidas sin pagar primero, luego lo que aún no llega.
  const purchases = useQuery({
    queryKey: financeKeys.purchases(null),
    queryFn: () => fetchPurchasesToPay(),
    enabled: open && category === "Materiales",
  })
  const orders = (purchases.data?.data.orders ?? []).filter((order) => order.currency === unit)
  const chosen = orders.find((order) => order.orderId === purchase) ?? null
  const asksPurchase = category === "Materiales" && orders.length > 0

  const cents = amount.trim() === "" ? null : parseAmount(amount, unit, locale)
  // Con la caja a la vista se avisa antes de guardar si el efectivo no alcanza.
  const after = fromCash && state && cents !== null && (!chosen || chosen.branchId === branchId) ? state.cashOnHandCents - cents : null

  const done = (message: string) => {
    invalidateFinance(queryClient)
    toast.success(message)
    onClose()
  }
  const createMutation = useMutation({
    mutationFn: createExpenseApi,
    onSuccess: () => done("Gasto registrado"),
    onError: (err) => setError(cashErrorMessage(err)),
  })
  const payMutation = useMutation({
    mutationFn: (input: { orderId: string; body: Parameters<typeof payPurchaseApi>[1] }) => payPurchaseApi(input.orderId, input.body),
    onSuccess: (result, input) => {
      const order = orders.find((item) => item.orderId === input.orderId)
      const left = result.data.balance.dueCents
      if (!order) done("Pago registrado")
      else if (order.receivedCents === 0) done(`Adelanto registrado: ${purchaseOrderLabel(order.orderNumber)} lo descuenta cuando llegue`)
      else if (left > 0) done(`Pago registrado: a ${purchaseOrderLabel(order.orderNumber)} le falta ${money(left)}`)
      else done(`Pago registrado: ${purchaseOrderLabel(order.orderNumber)} queda al día en Inventario`)
    },
    onError: (err) => setError(cashErrorMessage(err)),
  })
  const submitting = createMutation.isPending || payMutation.isPending

  const choosePurchase = (value: string) => {
    setPurchase(value)
    const order = orders.find((item) => item.orderId === value)
    if (order) {
      const suggested = order.dueCents > 0 ? order.dueCents : Math.max(0, order.orderedCents - order.paidCents)
      setAmount(suggested > 0 ? formatMoneyInput(suggested, unit, locale) : "")
      // Un pago a otra sede no sale de esta caja.
      if (order.branchId !== branchId) setFromCash(false)
    }
  }

  return (
    <FormDrawer
      open={open}
      title="Registrar gasto"
      description={chosen ? `Pago de una compra de ${chosen.branchName}.` : place.branchName ? `Gasto de ${place.branchName}.` : undefined}
      error={error}
      isSubmitting={submitting}
      isDirty={concept !== "" || amount !== "" || category !== "" || receiptKind !== "" || receiptNumber !== ""}
      submitLabel={chosen ? (chosen.receivedCents === 0 ? "Registrar adelanto" : "Registrar pago") : "Registrar gasto"}
      submitDisabled={!canWrite}
      onClose={() => {
        if (!submitting) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!chosen && !concept.trim()) {
          setError("Escribe en qué se gastó.")
          return
        }
        if (cents === null || cents <= 0) {
          setError("Escribe un importe mayor que cero.")
          return
        }
        if (category === "") {
          setError("Elige el tipo de gasto.")
          return
        }
        if (after !== null && after < 0 && state) {
          setError(`En la caja solo hay ${money(state.cashOnHandCents)}: no alcanza para pagar este gasto con el efectivo.`)
          return
        }
        if (spentDay > today) {
          setError("La fecha del gasto no puede ser futura.")
          return
        }
        setError(null)
        // Hoy lleva la hora real; otro día, su mediodía en la zona de la clínica.
        const spentAt = spentDay === today ? {} : { spentAt: noonOf(spentDay, orgTimeZone) }
        const receipt = {
          ...(receiptKind.trim() ? { receiptKind: receiptKind.trim() } : {}),
          ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
        }
        if (chosen) {
          // Lo que falta pagar que vio la persona: si alguien pagó mientras tanto, el servidor lo dice en vez de pagar de más.
          payMutation.mutate({ orderId: chosen.orderId, body: { amountCents: cents, fromCash, expectedDueCents: chosen.dueCents, ...receipt, ...spentAt } })
          return
        }
        createMutation.mutate({ branchId, concept: concept.trim(), amountCents: cents, category, fromCash, ...receipt, ...spentAt })
      }}
    >
      <div className="flex flex-col gap-5">
        <ChoiceChips label="Tipo" value={category} options={CATEGORY_OPTIONS} onChange={setCategory} />
        {asksPurchase ? (
          <fieldset className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3.5">
            <legend id={questionId} className="px-1 font-bold">
              ¿Es el pago de una compra de Inventario?
            </legend>
            <RadioGroup aria-labelledby={questionId} value={purchase} onValueChange={(value) => choosePurchase(String(value))} className="flex flex-col gap-1">
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
            <p className="text-sm text-muted-foreground">
              Si eliges una compra, el monto y la sede se llenan solos y la compra queda al día en Inventario. Así no se cuenta dos veces.
            </p>
          </fieldset>
        ) : null}
        {chosen ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
            Queda como gasto de <strong>Materiales</strong> de {chosen.branchName}:{" "}
            {chosen.receivedCents === 0 ? "Adelanto" : "Pago"} de compra {purchaseOrderLabel(chosen.orderNumber)} · {chosen.supplierName}.
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="gasto-concepto">En qué se gastó</FieldLabel>
            <Input id="gasto-concepto" maxLength={500} value={concept} onChange={(event) => setConcept(event.target.value)} />
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="gasto-importe">Importe</FieldLabel>
          <Input
            id="gasto-importe"
            inputMode="decimal"
            autoComplete="off"
            placeholder={formatMoneyInput(0, unit, locale)}
            aria-invalid={amount.trim() !== "" && cents === null}
            aria-describedby={chosen ? "gasto-importe-ayuda" : undefined}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          {chosen ? (
            <FieldDescription id="gasto-importe-ayuda">
              {chosen.dueCents > 0
                ? `Por pagar: ${money(chosen.dueCents)}. Puedes pagar una parte.`
                : "Aún no llega nada: queda como adelanto y se descuenta cuando llegue."}
            </FieldDescription>
          ) : null}
        </Field>
        <Field orientation="horizontal">
          <Checkbox
            id="gasto-caja"
            aria-describedby="gasto-caja-ayuda"
            checked={fromCash}
            disabled={chosen !== null && chosen.branchId !== branchId}
            onCheckedChange={(checked) => setFromCash(checked === true)}
          />
          <FieldContent>
            <FieldLabel htmlFor="gasto-caja">Se pagó con el efectivo de la caja</FieldLabel>
            <FieldDescription id="gasto-caja-ayuda">
              {chosen && chosen.branchId !== branchId ? (
                `Es de otra sede (${chosen.branchName}): no sale de esta caja.`
              ) : after === null ? (
                "Se descuenta del efectivo que debe haber al cerrar."
              ) : after < 0 && state ? (
                <span className="text-destructive">En la caja solo hay {money(state.cashOnHandCents)}: no alcanza para este gasto.</span>
              ) : (
                `Se descuenta del efectivo que debe haber al cerrar: la caja queda en ${money(after)}.`
              )}
            </FieldDescription>
          </FieldContent>
        </Field>
        <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger render={<Button type="button" variant="link" className="h-auto p-0" />}>
            Más detalles: comprobante recibido y fecha
            <ChevronDown aria-hidden className={cn("transition-transform", moreOpen && "rotate-180")} />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="flex flex-col gap-4 pt-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="gasto-comprobante">Comprobante recibido</FieldLabel>
                  <Input id="gasto-comprobante" maxLength={60} placeholder="Factura, recibo…" value={receiptKind} onChange={(event) => setReceiptKind(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="gasto-numero">Número</FieldLabel>
                  <Input id="gasto-numero" maxLength={60} autoComplete="off" value={receiptNumber} onChange={(event) => setReceiptNumber(event.target.value)} />
                </Field>
              </div>
              <Field>
                <FieldLabel htmlFor="gasto-fecha">Fecha del gasto</FieldLabel>
                <DatePickerButton id="gasto-fecha" className="justify-start font-normal" value={spentDay} max={today} onChange={setSpentDay}>
                  {formatDayKey(spentDay, locale, today)}
                </DatePickerButton>
              </Field>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </FormDrawer>
  )
}
