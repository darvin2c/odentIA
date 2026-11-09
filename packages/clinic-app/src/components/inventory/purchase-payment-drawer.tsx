/**
 * «Registrar pago» de una compra de Inventario (tablero 6c): en partes, por
 * adelantado o con lo que se tiene a favor con el proveedor. Es la misma
 * operación que «¿Es el pago de una compra?» de Finanzas › Gastos
 * (`/api/finance/purchases/:id/payments`; ADR 0061): queda como gasto de
 * Materiales de la sede del almacén, enlazado a la orden.
 *
 * Con otra moneda en la clínica se elige con qué se paga: en la moneda de la compra
 * se dice el cambio, y en la otra, lo que salió (el cambio se calcula solo). Lo que
 * cancela es siempre lo de la compra. Sin ella no aparece nada de esto.
 */
import { currencyWord, formatMoney, formatMoneyInput } from "@odentia/clinical"
import { FieldLegend, FieldSet, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { readExpenseMoney } from "../../lib/expense-exchange"
import { currencyChoices } from "../../lib/product-words"
import {
  cashFormMessage,
  errorCode,
  fetchPurchaseLookalikes,
  formatDayKey,
  invalidateFinance,
  noonOf,
  parseAmount,
  payPurchaseApi,
  todayIn,
  useCashState,
} from "../../lib/finance-cash"
import type { PurchaseOrderDetail } from "../../lib/inventory"
import { useOrgProfile, useTodayRate } from "../../lib/org"
import { purchaseOrderLabel } from "../../lib/reports"
import { ChoiceButtons } from "../choice-buttons"
import { ExpenseMoneyFields } from "../finance/expense-money-fields"
import { MoneyInput } from "./fields"

interface PaymentValues {
  amount: string
  /** Lo que salió, si se paga en la otra moneda. */
  tender: string
  rate: string
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
  tenderCents: "tender",
  exchangeRate: "rate",
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
  const profile = useOrgProfile().data
  const { second, todayRate } = useTodayRate(locale)
  const business = profile?.currency ?? order.currency
  const currencies = second ? [business, second.currency] : []
  const uid = useId()
  // Con qué se paga: decide de qué caja se habla. Sin otra moneda es siempre la de siempre.
  const [payIn, setPayIn] = useState(order.currency)
  const balance = order.balance
  const branchId = balance?.branchId ?? ""
  const cash = useCashState(branchId, open && branchId !== "", second ? payIn : undefined)
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
  // Lo que ya se anotó como gasto suelto y puede ser este mismo pago: se avisa, no se frena (G4).
  const lookalikes = useQuery({
    queryKey: ["finance-purchases", "lookalikes", order.id],
    queryFn: () => fetchPurchaseLookalikes(order.id),
    enabled: open,
    staleTime: 30_000,
  })
  const twin = lookalikes.data?.data[0] ?? null

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
  const moneyOf = (value: PaymentValues) =>
    readExpenseMoney({
      second,
      business,
      cents: centsOf(value.amount),
      currency: order.currency,
      payIn,
      tenderText: value.tender,
      rateText: value.rate,
      locale,
    })

  // biome-ignore lint/correctness/useExhaustiveDependencies: `centsOf`, `creditOf`, `moneyOf` y `money` se rehacen en cada render; se lista lo que leen (caja, día, crédito, sugerido, moneda, con qué se paga e idioma).
  const schema = useMemo(
    () =>
      z.custom<PaymentValues>().superRefine((value, ctx) => {
        const cents = centsOf(value.amount)
        const paid = moneyOf(value)
        if (paid.tenderError)
          ctx.addIssue({ code: "custom", path: ["tender"], message: paid.tenderError })
        if (paid.rateError)
          ctx.addIssue({ code: "custom", path: ["rate"], message: paid.rateError })
        if (cents === null)
          ctx.addIssue({ code: "custom", path: ["amount"], message: "Escribe un importe válido." })
        else if (cents + creditOf(value.useCredit) <= 0)
          ctx.addIssue({
            code: "custom",
            path: ["amount"],
            message: "Escribe un importe mayor que cero.",
          })
        else if (
          value.fromCash &&
          state &&
          paid.outCents !== null &&
          paid.outCents > state.cashOnHandCents
        )
          ctx.addIssue({
            code: "custom",
            path: ["fromCash"],
            message: `En la caja solo hay ${second ? formatMoney(state.cashOnHandCents, payIn, locale) : money(state.cashOnHandCents)}: no alcanza para pagar con el efectivo.`,
          })
        if (value.day > today) ctx.addIssue({ code: "custom", path: ["day"], message: "La fecha del pago no puede ser futura." })
        if (value.receiptKind.trim().length > 60) ctx.addIssue({ code: "custom", path: ["receiptKind"], message: "Escribe como mucho 60 caracteres." })
        if (value.receiptNumber.trim().length > 60) ctx.addIssue({ code: "custom", path: ["receiptNumber"], message: "Escribe como mucho 60 caracteres." })
      }),
    [state, today, credit, suggested, order.currency, locale, payIn, business],
  )

  const mutation = useMutation({
    mutationFn: (value: PaymentValues) => {
      const creditCents = creditOf(value.useCredit)
      return payPurchaseApi(order.id, {
        amountCents: centsOf(value.amount) ?? 0,
        ...moneyOf(value).body,
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
    tender: "",
    rate: todayRate,
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
    setPayIn(order.currency)
    form.reset(initialValues())
  }, [open])
  // El cambio de hoy puede llegar después de abrir: llega puesto, sin pisar lo escrito.
  useEffect(() => {
    if (open && todayRate && form.getFieldValue("rate") === "")
      form.setFieldValue("rate", todayRate, { dontUpdateMeta: true })
  }, [open, todayRate, form])

  const values = useStore(form.store, (s) => s.values)
  const total = (centsOf(values.amount) ?? 0) + creditOf(values.useCredit)
  const label = advance ? `Registrar adelanto de ${money(total)}` : `Registrar pago de ${money(total)}`
  const figures = moneyOf(values)

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
        {twin ? (
          <p role="status" className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-sm">
            Ya hay un gasto de Materiales de {formatMoney(twin.amountCents, twin.currency, locale)} del{" "}
            {new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone }).format(new Date(twin.spentAt))} en
            esta sede, sin compra: «{twin.concept}». Si es este mismo pago, anúlalo en{" "}
            <Link
              to="/finance"
              search={{ tab: "gastos", tipo: "Materiales" }}
              className="font-semibold underline underline-offset-2"
            >
              Gastos
            </Link>{" "}
            para que no cuente dos veces.
          </p>
        ) : null}
        <form.AppField name="amount">
          {(field) => {
            const description =
              due > 0
                ? `Por pagar: ${money(due)}. Puedes pagar una parte.`
                : ahead
                  ? `Aún no llega nada: queda como adelanto${rest > 0 ? `. Falta adelantar ${money(rest)} del total` : ""}.`
                  : "Lo recibido ya está pagado: esto queda como adelanto de lo que falta recibir."
            return second ? (
              <field.Control id={`${uid}-monto`} label="Lo que cancelas" description={description}>
                {(control) => (
                  <MoneyInput
                    id={control.id}
                    currency={order.currency}
                    placeholder={formatMoneyInput(0, order.currency, locale)}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            ) : (
              <field.TextField
                id={`${uid}-monto`}
                label="Monto"
                inputMode="decimal"
                autoComplete="off"
                placeholder={formatMoneyInput(0, order.currency, locale)}
                description={description}
              />
            )
          }}
        </form.AppField>
        {figures.asks ? (
          <FieldSet className="gap-3">
            <FieldLegend id={`${uid}-paga`} variant="label">
              Pagas con
            </FieldLegend>
            <ChoiceButtons
              aria-labelledby={`${uid}-paga`}
              tone="primary"
              value={payIn}
              options={currencyChoices(currencies, locale)}
              onChange={(next) => setPayIn(next)}
            />
          </FieldSet>
        ) : null}
        {second ? (
          <ExpenseMoneyFields
            second={second}
            money={figures}
            currency={order.currency}
            business={business}
            locale={locale}
            reportWords={(value) => `En tus reportes cuenta como gasto de Materiales de ${value}.`}
            field={(name, control) => <form.AppField name={name}>{() => control}</form.AppField>}
          />
        ) : null}
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
                id={`${uid}-favor`}
                label={`Usar lo que tienes a favor con ${order.supplierName ?? "el proveedor"} (${money(order.supplierCreditCents)})`}
                description={`Se descuenta ${money(Math.min(credit, suggested))} de lo que hay que pagar. No es un gasto nuevo: ese dinero ya salió.`}
              />
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="day">
          {(field) => (
            <field.Control id={`${uid}-fecha`} label="Fecha del pago">
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
          {(field) => (
            <field.CheckboxField
              id={`${uid}-caja`}
              label="Sale del efectivo de la caja"
              description={
                second && field.state.value
                  ? `Se descuenta de la caja de ${currencyWord(figures.payIn, locale)}.`
                  : "Si no, es transferencia u otro medio."
              }
            />
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <form.AppField name="receiptKind">
            {(field) => <field.TextField id={`${uid}-comprobante`} label="Comprobante" maxLength={60} placeholder="Factura, recibo…" />}
          </form.AppField>
          <form.AppField name="receiptNumber">
            {(field) => <field.TextField id={`${uid}-numero`} label="Número" maxLength={60} autoComplete="off" />}
          </form.AppField>
        </div>
        <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm text-foreground/80">
          Queda como gasto de <strong>Materiales</strong> de {balance?.branchName ?? "la sede del almacén"}, enlazado a esta compra. En Finanzas se ve como cualquier gasto, con el enlace a la compra.
        </p>
      </div>
    </FormDrawer>
  )
}
