/**
 * «Registrar pago» de una compra de Inventario (tablero 6c): en partes, por
 * adelantado o con lo que se tiene a favor con el proveedor. Es la misma
 * operación que «¿Es el pago de una compra?» de Finanzas › Gastos
 * (`/api/finance/purchases/:id/payments`; ADR 0061): queda como gasto de
 * Materiales de la sede del almacén, enlazado a la orden.
 */
import { formatMoney, formatMoneyInput } from "@odentia/clinical"
import { toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef } from "react"
import { z } from "zod"
import { cashFormMessage, errorCode, formatDayKey, invalidateFinance, noonOf, parseAmount, payPurchaseApi, todayIn, useCashState } from "../../lib/finance-cash"
import type { PurchaseOrderDetail } from "../../lib/inventory"
import { purchaseOrderLabel } from "../../lib/reports"

interface PaymentValues {
  amount: string
  useCredit: boolean
  fromCash: boolean
  day: string
  receiptKind: string
  receiptNumber: string
}

/** El servidor nombra los datos como el cuerpo; el formulario, como la pantalla. */
const SERVER_FIELDS: Record<string, string> = {
  amountCents: "amount",
  creditCents: "useCredit",
  spentAt: "day",
}

/** La compra cambió mientras se escribía (otro pago): se vuelve a leer antes de reintentar. */
const CHANGED: Record<string, true> = { PURCHASE_PAID_CHANGED: true, PURCHASE_DUE_CHANGED: true }

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
  // Sin nada recibido por pagar y con algo aún por llegar, lo que se paga es un adelanto
  // (la misma regla del servidor); en una compra ya recibida y al día queda a favor.
  const advance = due === 0 && balance?.status !== "recibida"
  // Lo que falta adelantar del total pedido, cuando lo recibido ya está pagado.
  const rest = balance ? Math.max(0, balance.orderedCents - balance.paidCents) : 0
  const suggested = due > 0 ? due : rest
  const credit = Math.min(order.supplierCreditCents, rest)
  const money = (cents: number) => formatMoney(cents, order.currency, locale)
  const state = cash.data?.data ?? null

  // Lo que se vio al abrir: si la compra cambia mientras tanto (otro pago, o este mismo
  // enviado dos veces), el servidor lo dice en vez de pagar sobre otra cifra.
  const paid = balance?.paidCents ?? 0
  const seen = useRef({ due, paid })
  // Tras «la compra cambió», lo nuevo que llega es lo que se ve: el reintento paga sobre eso.
  const stale = useRef(false)
  useEffect(() => {
    if (!stale.current) return
    stale.current = false
    seen.current = { due, paid }
  }, [due, paid])

  const creditOf = (useCredit: boolean) => (useCredit ? Math.min(credit, Math.max(0, suggested)) : 0)
  const centsOf = (amount: string) => (amount.trim() === "" ? 0 : parseAmount(amount, order.currency, locale))

  // biome-ignore lint/correctness/useExhaustiveDependencies: `centsOf`, `creditOf` y `money` se rehacen en cada render; se lista lo que leen (caja, día, crédito, sugerido, moneda e idioma).
  const schema = useMemo(
    () =>
      z.custom<PaymentValues>().superRefine((value, ctx) => {
        const cents = centsOf(value.amount)
        if (cents === null) ctx.addIssue({ code: "custom", path: ["amount"], message: "Escribe un importe válido." })
        else if (cents + creditOf(value.useCredit) <= 0) ctx.addIssue({ code: "custom", path: ["amount"], message: "Escribe un importe mayor que cero." })
        else if (value.fromCash && state && cents > state.cashOnHandCents)
          ctx.addIssue({ code: "custom", path: ["fromCash"], message: `En la caja solo hay ${money(state.cashOnHandCents)}: no alcanza para pagar con el efectivo.` })
        if (value.day > today) ctx.addIssue({ code: "custom", path: ["day"], message: "La fecha del pago no puede ser futura." })
        if (value.receiptKind.trim().length > 60) ctx.addIssue({ code: "custom", path: ["receiptKind"], message: "Escribe como mucho 60 caracteres." })
        if (value.receiptNumber.trim().length > 60) ctx.addIssue({ code: "custom", path: ["receiptNumber"], message: "Escribe como mucho 60 caracteres." })
      }),
    [state, today, credit, suggested, order.currency, locale],
  )

  const mutation = useMutation({
    mutationFn: (value: PaymentValues) => {
      const creditCents = creditOf(value.useCredit)
      return payPurchaseApi(order.id, {
        amountCents: centsOf(value.amount) ?? 0,
        ...(creditCents > 0 ? { creditCents } : {}),
        fromCash: value.fromCash,
        ...(value.day === today ? {} : { spentAt: noonOf(value.day, timeZone) }),
        ...(value.receiptKind.trim() ? { receiptKind: value.receiptKind.trim() } : {}),
        ...(value.receiptNumber.trim() ? { receiptNumber: value.receiptNumber.trim() } : {}),
        expectedDueCents: seen.current.due,
        expectedPaidCents: seen.current.paid,
      })
    },
  })

  const initialValues = (): PaymentValues => ({
    amount: suggested > 0 ? formatMoneyInput(suggested, order.currency, locale) : "",
    useCredit: false,
    fromCash: false,
    day: todayIn(timeZone),
    receiptKind: "",
    receiptNumber: "",
  })
  const form = useAppForm({
    defaultValues: initialValues(),
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const result = await mutation.mutateAsync(value).catch((error: unknown) => {
        if (CHANGED[errorCode(error) ?? ""]) {
          stale.current = true
          invalidateFinance(queryClient)
        }
        throw error
      })
      invalidateFinance(queryClient)
      const left = result.data.balance.dueCents
      const label = purchaseOrderLabel(order.orderNumber)
      // En Finanzas queda como gasto de Materiales; aquí se dice cómo quedó la compra.
      toast.success(
        advance
          ? `Adelanto registrado: ${label} lo descuenta cuando llegue${ahead ? "" : " lo que falta"}`
          : left > 0
            ? `Pago registrado: a ${label} le falta ${money(left)}`
            : result.data.balance.paidCents > result.data.balance.orderedCents
              ? `Pago registrado: lo que pasa de ${label} queda a favor con ${order.supplierName ?? "el proveedor"}`
              : `Pago registrado: ${label} queda al día`,
      )
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: SERVER_FIELDS, formMessage: cashFormMessage })

  // Se llena al abrir y solo entonces: si la compra se vuelve a consultar (otro `suggested`),
  // lo que ya se escribió se queda.
  const filled = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir.
  useEffect(() => {
    if (!open) {
      filled.current = false
      return
    }
    if (filled.current) return
    filled.current = true
    seen.current = { due, paid }
    form.reset(initialValues())
  }, [open])

  const values = useStore(form.store, (s) => s.values)
  const total = (centsOf(values.amount) ?? 0) + creditOf(values.useCredit)
  const label = advance ? `Registrar adelanto de ${money(total)}` : `Registrar pago de ${money(total)}`

  return (
    <FormDrawer
      {...surface}
      open={open}
      title={`Registrar pago · ${purchaseOrderLabel(order.orderNumber)}`}
      description={`${order.supplierName ?? "Proveedor"} · ${balance?.branchName ?? ""}`}
      submitLabel={label}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="amount">
          {(field) => (
            <field.TextField
              id="pago-monto"
              label="Monto"
              inputMode="decimal"
              autoComplete="off"
              placeholder={formatMoneyInput(0, order.currency, locale)}
              description={
                due > 0
                  ? `Por pagar: ${money(due)}. Puedes pagar una parte.`
                  : ahead
                    ? `Aún no llega nada: queda como adelanto${rest > 0 ? `. Falta adelantar ${money(rest)} del total` : ""}.`
                    : "Lo recibido ya está pagado: esto queda como adelanto de lo que falta recibir."
              }
            />
          )}
        </form.AppField>
        {credit > 0 ? (
          <form.AppField
            name="useCredit"
            listeners={{
              // Lo que se usa a favor se descuenta del monto: así no se paga de más.
              onChange: ({ value }) => {
                const left = value ? Math.max(0, suggested - Math.min(credit, suggested)) : suggested
                form.setFieldValue("amount", left > 0 ? formatMoneyInput(left, order.currency, locale) : "")
              },
            }}
          >
            {(field) => (
              <field.CheckboxField
                id="pago-favor"
                label={`Usar lo que tienes a favor con ${order.supplierName ?? "el proveedor"} (${money(order.supplierCreditCents)})`}
                description={`Se descuenta ${money(Math.min(credit, suggested))} de lo que hay que pagar. No es un gasto nuevo: ese dinero ya salió.`}
              />
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="day">
          {(field) => (
            <field.Control id="pago-fecha" label="Fecha del pago">
              {(control) => (
                <DatePickerButton
                  {...control.props}
                  className="justify-start font-normal"
                  value={field.state.value}
                  max={today}
                  onChange={(next) => field.handleChange(next)}
                >
                  {formatDayKey(field.state.value, locale, today)}
                </DatePickerButton>
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="fromCash">
          {(field) => <field.CheckboxField id="pago-caja" label="Sale del efectivo de la caja" description="Si no, es transferencia u otro medio." />}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <form.AppField name="receiptKind">
            {(field) => <field.TextField id="pago-comprobante" label="Comprobante" maxLength={60} placeholder="Factura, recibo…" />}
          </form.AppField>
          <form.AppField name="receiptNumber">
            {(field) => <field.TextField id="pago-numero" label="Número" maxLength={60} autoComplete="off" />}
          </form.AppField>
        </div>
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-foreground/80">
          Queda como gasto de <strong>Materiales</strong> de {balance?.branchName ?? "la sede del almacén"}, enlazado a esta compra. En Finanzas se ve como cualquier gasto, con el enlace a la compra.
        </p>
      </div>
    </FormDrawer>
  )
}
