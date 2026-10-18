/**
 * «Registrar pago» de una compra de Inventario (tablero 6c): en partes, por
 * adelantado o con lo que se tiene a favor con el proveedor. Es la misma
 * operación que «¿Es el pago de una compra?» de Finanzas › Gastos
 * (`/api/finance/purchases/:id/payments`; ADR 0061): queda como gasto de
 * Materiales de la sede del almacén, enlazado a la orden.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import { Checkbox, Field, FieldContent, FieldDescription, FieldLabel, Input, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { cashErrorMessage, formatDayKey, invalidateFinance, noonOf, parseAmount, payPurchaseApi, todayIn, useCashState } from "../../lib/finance-cash"
import type { PurchaseOrderDetail } from "../../lib/inventory"
import { purchaseOrderLabel } from "../../lib/reports"

export function PurchasePaymentDrawer({
  order,
  locale,
  timeZone,
  open,
  onClose,
}: {
  order: PurchaseOrderDetail
  locale: string
  /** Zona de la clínica: el día del pago. */
  timeZone: string
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const balance = order.balance
  const branchId = balance?.branchId ?? ""
  const cash = useCashState(branchId, open && branchId !== "")
  const today = todayIn(timeZone)
  const due = balance?.dueCents ?? 0
  const ahead = balance && balance.receivedCents === 0
  // Lo que falta adelantar del total pedido, cuando lo recibido ya está pagado.
  const rest = balance ? Math.max(0, balance.orderedCents - balance.paidCents) : 0
  const suggested = due > 0 ? due : rest
  const credit = Math.min(order.supplierCreditCents, rest)
  const [amount, setAmount] = useState("")
  const [useCredit, setUseCredit] = useState(false)
  const [fromCash, setFromCash] = useState(false)
  const [day, setDay] = useState(today)
  const [receiptKind, setReceiptKind] = useState("")
  const [receiptNumber, setReceiptNumber] = useState("")
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAmount(suggested > 0 ? formatMoneyInput(suggested, order.currency, locale) : "")
    setUseCredit(false)
    setFromCash(false)
    setDay(todayIn(timeZone))
    setReceiptKind("")
    setReceiptNumber("")
    setError(null)
  }, [open, suggested, order.currency, locale, timeZone])

  const money = (cents: number) => formatMoney(cents, order.currency, locale)
  const cents = amount.trim() === "" ? 0 : parseAmount(amount, order.currency, locale)
  const creditCents = useCredit ? Math.min(credit, Math.max(0, suggested)) : 0
  const total = (cents ?? 0) + creditCents
  const state = cash.data?.data ?? null
  const label = ahead || due === 0 ? `Registrar adelanto de ${money(total)}` : `Registrar pago de ${money(total)}`

  const mutation = useMutation({
    mutationFn: () =>
      payPurchaseApi(order.id, {
        amountCents: cents ?? 0,
        ...(creditCents > 0 ? { creditCents } : {}),
        fromCash,
        ...(day === today ? {} : { spentAt: noonOf(day, timeZone) }),
        ...(receiptKind.trim() ? { receiptKind: receiptKind.trim() } : {}),
        ...(receiptNumber.trim() ? { receiptNumber: receiptNumber.trim() } : {}),
        expectedDueCents: due,
      }),
    onSuccess: (result) => {
      invalidateFinance(queryClient)
      const left = result.data.balance.dueCents
      const label = purchaseOrderLabel(order.orderNumber)
      // En Finanzas queda como gasto de Materiales; aquí se dice cómo quedó la compra.
      toast.success(
        ahead
          ? `Adelanto registrado: ${label} lo descuenta cuando llegue`
          : left > 0
            ? `Pago registrado: a ${label} le falta ${money(left)}`
            : `Pago registrado: ${label} queda al día`,
      )
      onClose()
    },
    onError: (err) => setError(cashErrorMessage(err)),
  })

  return (
    <FormDrawer
      open={open}
      title={`Registrar pago · ${purchaseOrderLabel(order.orderNumber)}`}
      description={`${order.supplierName ?? "Proveedor"} · ${balance?.branchName ?? ""}`}
      error={error}
      isSubmitting={mutation.isPending}
      isDirty={receiptKind !== "" || receiptNumber !== "" || useCredit}
      submitLabel={label}
      onClose={() => {
        if (!mutation.isPending) onClose()
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (cents === null) {
          setError("Escribe un importe válido.")
          return
        }
        if (total <= 0) {
          setError("Escribe un importe mayor que cero.")
          return
        }
        if (fromCash && state && (cents ?? 0) > state.cashOnHandCents) {
          setError(`En la caja solo hay ${money(state.cashOnHandCents)}: no alcanza para pagar con el efectivo.`)
          return
        }
        if (day > today) {
          setError("La fecha del pago no puede ser futura.")
          return
        }
        setError(null)
        mutation.mutate()
      }}
    >
      <div className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="pago-monto">Monto</FieldLabel>
          <Input
            id="pago-monto"
            inputMode="decimal"
            autoComplete="off"
            aria-describedby="pago-monto-ayuda"
            placeholder={formatMoneyInput(0, order.currency, locale)}
            aria-invalid={amount.trim() !== "" && cents === null}
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
          <FieldDescription id="pago-monto-ayuda">
            {due > 0
              ? `Por pagar: ${money(due)}. Puedes pagar una parte.`
              : ahead
                ? `Aún no llega nada: queda como adelanto${rest > 0 ? `. Falta adelantar ${money(rest)} del total` : ""}.`
                : "Lo recibido ya está pagado: esto queda como adelanto de lo que falta recibir."}
          </FieldDescription>
        </Field>
        {credit > 0 ? (
          <Field orientation="horizontal">
            <Checkbox
              id="pago-favor"
              checked={useCredit}
              onCheckedChange={(checked) => {
                const on = checked === true
                setUseCredit(on)
                // Lo que se usa a favor se descuenta del monto: así no se paga de más.
                const left = on ? Math.max(0, suggested - Math.min(credit, suggested)) : suggested
                setAmount(left > 0 ? formatMoneyInput(left, order.currency, locale) : "")
              }}
            />
            <FieldContent>
              <FieldLabel htmlFor="pago-favor">
                Usar lo que tienes a favor con {order.supplierName ?? "el proveedor"} ({money(order.supplierCreditCents)})
              </FieldLabel>
              <FieldDescription>Se descuenta {money(Math.min(credit, suggested))} de lo que hay que pagar. No es un gasto nuevo: ese dinero ya salió.</FieldDescription>
            </FieldContent>
          </Field>
        ) : null}
        <Field>
          <FieldLabel htmlFor="pago-fecha">Fecha del pago</FieldLabel>
          <DatePickerButton id="pago-fecha" className="justify-start font-normal" value={day} max={today} onChange={setDay}>
            {formatDayKey(day, locale, today)}
          </DatePickerButton>
        </Field>
        <Field orientation="horizontal">
          <Checkbox id="pago-caja" checked={fromCash} onCheckedChange={(checked) => setFromCash(checked === true)} />
          <FieldContent>
            <FieldLabel htmlFor="pago-caja">Sale del efectivo de la caja</FieldLabel>
            <FieldDescription>Si no, es transferencia u otro medio.</FieldDescription>
          </FieldContent>
        </Field>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <Field>
            <FieldLabel htmlFor="pago-comprobante">Comprobante</FieldLabel>
            <Input id="pago-comprobante" maxLength={60} placeholder="Factura, recibo…" value={receiptKind} onChange={(event) => setReceiptKind(event.target.value)} />
          </Field>
          <Field>
            <FieldLabel htmlFor="pago-numero">Número</FieldLabel>
            <Input id="pago-numero" maxLength={60} autoComplete="off" value={receiptNumber} onChange={(event) => setReceiptNumber(event.target.value)} />
          </Field>
        </div>
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-foreground/80">
          Queda como gasto de <strong>Materiales</strong> de {balance?.branchName ?? "la sede del almacén"}, enlazado a esta compra. En Finanzas se ve como cualquier gasto, con el enlace a la compra.
        </p>
      </div>
    </FormDrawer>
  )
}
