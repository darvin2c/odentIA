/**
 * «Registrar gasto»: el formulario corto de Finanzas › Gastos, también desde
 * Reportes («Copiar el de agosto» llega con lo del mes anterior ya escrito).
 *
 * Con el tipo Materiales pregunta «¿Es el pago de una compra de Inventario?»
 * si hay compras por pagar o sin llegar: elegir una registra el pago de esa
 * compra (`/api/finance/purchases/:id/payments`, la misma operación que desde
 * Inventario; ADR 0061) y así no se cuenta dos veces.
 *
 * Con otra moneda en la clínica, un gasto suelto lleva su moneda y su cambio, y
 * pagar una compra deja elegir con qué se paga. Sin ella no aparece nada de esto.
 */
import { currencyWord, formatMoney, formatMoneyInput } from "@odentia/clinical"
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
import { readExpenseMoney } from "../../lib/expense-exchange"
import { currencyChoices } from "../../lib/product-words"
import { orgTaxesOf, useOrgProfile, useTodayRate } from "../../lib/org"
import { ChoiceButtons } from "../choice-buttons"
import {
  cashFormMessage,
  createExpenseApi,
  errorCode,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  fetchPurchasesToPay,
  fetchRecurringPeople,
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
import { MoneyInput } from "../inventory/fields"
import { CashMoveDrawer, ChoiceChips } from "./cash-close-drawer"
import { ExpenseMoneyFields } from "./expense-money-fields"

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
  /** En qué moneda es un gasto suelto, con otra moneda en la clínica. */
  currency: string
  amount: string
  /** Con qué se paga una compra: su moneda o la otra. */
  payIn: string
  /** Lo que salió, si se paga en la otra. */
  tender: string
  rate: string
  fromCash: boolean
  receiptKind: string
  receiptNumber: string
  spentDay: string
  /** «Se repite»: queda anotado y aparece «por pagar» cada vez que toca. */
  repeats: boolean
  every: "1" | "6" | "12"
  /** Día del mes en que se paga (1–31). */
  repeatDay: string
  /** El mes que paga (`YYYY-MM`): este o el anterior (el sueldo de octubre pagado en noviembre). */
  repeatMonth: string
  /** «¿Ya se pagó?»: con «no» se anota sin registrar ningún gasto y queda por pagar. */
  paidNow: "si" | "no"
  /** Se paga en ese mes o al mes siguiente (el sueldo de noviembre, el 2 de diciembre). */
  dueNext: "mismo" | "siguiente"
  /** De quién es un sueldo (solo con el tipo «Personal»). */
  member: string
}

const EVERY_CHOICES = [
  { value: "1", label: "Cada mes" },
  { value: "6", label: "Cada 6 meses" },
  { value: "12", label: "Cada año" },
]

const PAID_CHOICES = [
  { value: "si", label: "Sí, ahora" },
  { value: "no", label: "Todavía no" },
]

const DUE_CHOICES = [
  { value: "mismo", label: "En ese mes" },
  { value: "siguiente", label: "Al mes siguiente" },
]

/** Se anota sin pagar: no hay gasto, ni caja, ni fecha. */
function annotatesOnly(value: Pick<ExpenseValues, "repeats" | "paidNow">): boolean {
  return value.repeats && value.paidNow === "no"
}

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

/** Este mes y el anterior (`YYYY-MM`), los dos que puede pagar un gasto que empieza a repetirse. */
function payableMonths(today: string): Array<{ value: string; label: string }> {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const prev = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
  const key = (value: { year: number; month: number }) => `${value.year}-${String(value.month).padStart(2, "0")}`
  return [
    { value: key({ year, month }), label: MONTH_NAMES[month - 1] ?? "" },
    { value: key(prev), label: MONTH_NAMES[prev.month - 1] ?? "" },
  ]
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
  money: (cents: number, currency: string) => string
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
            <span
              className={cn(
                "shrink-0 text-sm font-semibold",
                order.dueCents > 0 ? "text-warning" : "text-muted-foreground",
              )}
            >
              {order.dueCents > 0
                ? `por pagar ${money(order.dueCents, order.currency)}`
                : order.receivedCents === 0
                  ? "aún no llega"
                  : "al día, falta que llegue"}
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
  // Lo que se le paga al personal lo anota quien lo ve, como en el servidor (ADR 0166).
  const canStaffPay = usePermission("commissions.write")
  const categoryOptions = canStaffPay ? CATEGORY_OPTIONS : CATEGORY_OPTIONS.filter((option) => option.value !== "Personal")
  const { second, todayRate } = useTodayRate(locale)
  const today = todayIn(orgTimeZone)
  const salesTaxHelpId = useId()
  const salesTaxName = orgTaxesOf(useOrgProfile().data)?.name ?? null
  // Lo que se vio de la compra al elegirla: si cambia mientras tanto, el servidor lo dice.
  const [seen, setSeen] = useState<{ due: number; paid: number } | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  // «Ingresar lo que falta»: el cajón del efectivo se apila encima, sin tocar el gasto.
  const [cashOpen, setCashOpen] = useState(false)
  const canMoveCash = canWrite
  const currencies = second ? [place.currency, second.currency] : []
  // Una clave por cajón abierto (ADR 0018): si se corta la red y se vuelve a guardar, el servidor
  // devuelve el mismo gasto en vez de registrar otro y sacar el efectivo dos veces (G2).
  const requestId = useRef<string>(crypto.randomUUID())

  const form = useAppForm({
    defaultValues: {
      category: "",
      salesTax: null,
      // Sin respuesta: con compras por pagar en la sede, la persona elige (QA de Gastos, G4).
      purchase: "",
      concept: "",
      currency: place.currency,
      amount: "",
      payIn: place.currency,
      tender: "",
      rate: todayRate,
      fromCash: true,
      receiptKind: "",
      receiptNumber: "",
      spentDay: today,
      repeats: false,
      every: "1",
      repeatDay: String(Number(today.slice(8, 10))),
      repeatMonth: today.slice(0, 7),
      paidNow: "si",
      dueNext: "mismo",
      member: "",
    } as ExpenseValues,
    validators: {
      onSubmit: ({ value }) => {
        const { chosen, asksSalesTax, cents, after, paid } = derive(value)
        const fields: Record<string, string> = {}
        if (value.category === "") fields.category = "Elige el tipo de gasto."
        // Con compras por pagar en esta sede, que sea o no una de ellas lo dice la persona: si ya
        // venía respondido «No», la misma compra se pagaba otra vez en Inventario (G4).
        if (value.category === "Materiales" && value.purchase === "" && orders.some((order) => order.branchId === branchId && order.dueCents > 0))
          fields.purchase = "Elige si es el pago de una de estas compras o de otro gasto."
        if (asksSalesTax && value.salesTax === null) fields.salesTax = "Elige qué impuesto pagas."
        if (!chosen && !value.concept.trim()) fields.concept = "Escribe en qué se gastó."
        if (value.amount.trim() !== "" && cents === null) fields.amount = "Ese importe no se entiende. Revísalo."
        else if (cents === null || cents <= 0) fields.amount = "Escribe un importe mayor que cero."
        else if (after !== null && after < 0 && state && !annotatesOnly(value))
          // El freno se queda (el efectivo nunca queda negativo), pero dice qué
          // hacer: quitar la casilla dejaría «fuera de la caja» lo que salió de ella.
          fields.fromCash = `En la caja solo hay ${formatMoney(state.cashOnHandCents, paid.payIn, locale)}: no alcanza para pagarlo todo con el efectivo. Si el dinero está en el cajón, ingrésalo a la caja con el botón de abajo. Si una parte se pagó por otro medio, anótala como otro gasto.`
        if (paid.tenderError) fields.tender = paid.tenderError
        if (paid.rateError) fields.rate = paid.rateError
        if (value.spentDay > today && !annotatesOnly(value)) fields.spentDay = "La fecha del gasto no puede ser futura."
        if (value.repeats && !chosen) {
          const day = Number(value.repeatDay)
          if (!Number.isInteger(day) || day < 1 || day > 31) fields.repeatDay = "Escribe un día del 1 al 31."
        }
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const { chosen, asksSalesTax, cents, currency, paid } = derive(value)
      if (cents === null || value.category === "") return
      // Hoy lleva la hora real; otro día, su mediodía en la zona de la clínica.
      const unpaid = annotatesOnly(value)
      const spentAt = value.spentDay === today || unpaid ? {} : { spentAt: noonOf(value.spentDay, orgTimeZone) }
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
            ...paid.body,
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
        requestId: requestId.current,
        branchId,
        concept: value.concept.trim(),
        amountCents: cents,
        ...(second && currency !== place.currency ? { currency } : {}),
        ...paid.body,
        category: value.category,
        fromCash: value.fromCash && !unpaid,
        ...(asksSalesTax ? { salesTax: value.salesTax === "cobros" } : {}),
        ...receipt,
        ...spentAt,
        ...(value.repeats && !(asksSalesTax && value.salesTax === "cobros")
          ? {
              repeat: {
                everyMonths: Number(value.every) as 1 | 6 | 12,
                day: Number(value.repeatDay),
                month: value.repeatMonth,
                memberUserId: value.category === "Personal" && value.member ? value.member : null,
                ...(unpaid ? { paid: false } : {}),
                dueNextMonth: value.dueNext === "siguiente",
              },
            }
          : {}),
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: {
      amountCents: "amount",
      spentAt: "spentDay",
      orderId: "purchase",
      tenderCents: "tender",
      tenderCurrency: "payIn",
      exchangeRate: "rate",
      "repeat.month": "repeatMonth",
      "repeat.day": "repeatDay",
      "repeat.everyMonths": "every",
      "repeat.memberUserId": "member",
    },
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
    requestId.current = crypto.randomUUID()
    const day = todayIn(orgTimeZone)
    form.reset({
      category: initial?.category ?? "",
      salesTax: null,
      purchase: "",
      concept: initial?.concept ?? "",
      currency: place.currency,
      amount: initial ? formatMoneyInput(initial.amountCents, place.currency, locale) : "",
      payIn: place.currency,
      tender: "",
      rate: todayRate,
      fromCash: !initial,
      receiptKind: "",
      receiptNumber: "",
      spentDay: initial?.day && initial.day <= day ? initial.day : day,
      repeats: false,
      every: "1",
      repeatDay: String(Number((initial?.day && initial.day <= day ? initial.day : day).slice(8, 10))),
      repeatMonth: day.slice(0, 7),
      paidNow: "si",
      dueNext: "mismo",
      member: "",
    })
    setSeen(null)
    setMoreOpen(Boolean(initial?.day && initial.day !== day))
  }, [open, orgTimeZone, initial, place.currency, locale, form, todayRate])
  // El cambio de hoy puede llegar después de abrir: llega puesto, sin pisar lo escrito.
  useEffect(() => {
    if (open && todayRate && form.getFieldValue("rate") === "")
      form.setFieldValue("rate", todayRate, { dontUpdateMeta: true })
  }, [open, todayRate, form])

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
  // Con otra moneda se ven las compras de las dos; sin ella, las de la moneda de la clínica.
  const allOrders = purchases.data?.data.orders ?? []
  const listed = second
    ? allOrders.filter((order) => currencies.includes(order.currency))
    : allOrders
  const picked =
    values.category === "Materiales"
      ? (listed.find((order) => order.orderId === values.purchase) ?? null)
      : null
  // El impuesto de lo cobrado y lo que no es una compra: de qué moneda sale el dinero, y de esa caja.
  const paysSalesTax =
    values.category === "Impuestos" && salesTaxName !== null && values.salesTax === "cobros"
  const outCurrency = second
    ? picked
      ? values.payIn
      : paysSalesTax
        ? place.currency
        : values.currency
    : undefined
  const cash = useCashState(branchId, open, outCurrency)
  const state = cash.data?.data ?? null
  const unit = second
    ? (picked?.currency ?? (paysSalesTax ? place.currency : values.currency))
    : (state?.currency ?? place.currency)
  const orders = second ? listed : listed.filter((order) => order.currency === unit)
  const money = (cents: number) => formatMoney(cents, unit, locale)

  /** Lo que se deduce de lo elegido: la compra que se paga, si se pregunta el impuesto, la moneda y cómo queda la caja. */
  function derive(value: ExpenseValues) {
    // Solo un gasto de Materiales paga una compra: si se cambia el tipo, ya no es ese pago.
    const chosen = value.category === "Materiales" ? (orders.find((order) => order.orderId === value.purchase) ?? null) : null
    const asksSalesTax = value.category === "Impuestos" && salesTaxName !== null
    // El impuesto de lo cobrado solo se paga en moneda del negocio.
    const onlyBusiness = asksSalesTax && value.salesTax === "cobros"
    const currency = second
      ? (chosen?.currency ?? (onlyBusiness ? place.currency : value.currency))
      : unit
    const cents = value.amount.trim() === "" ? null : parseAmount(value.amount, currency, locale)
    const paid = readExpenseMoney({
      second,
      business: place.currency,
      cents,
      currency,
      payIn: chosen ? value.payIn : currency,
      tenderText: value.tender,
      rateText: value.rate,
      locale,
    })
    // Con la caja a la vista se avisa antes de guardar si el efectivo no alcanza.
    const after =
      value.fromCash &&
      !annotatesOnly(value) &&
      state &&
      state.currency === paid.payIn &&
      paid.outCents !== null &&
      (!chosen || chosen.branchId === branchId)
        ? state.cashOnHandCents - paid.outCents
        : null
    return { chosen, asksSalesTax, onlyBusiness, currency, cents, after, paid }
  }
  const { chosen, asksSalesTax, onlyBusiness, after, paid } = derive(values)
  const asksSalesTaxNow = asksSalesTax
  // De quién puede ser un sueldo: el equipo de hoy (solo se pide con «Se repite» y el tipo Personal).
  const people = useQuery({
    queryKey: ["finance", "recurring-people"],
    queryFn: fetchRecurringPeople,
    enabled: open && values.repeats && values.category === "Personal",
    staleTime: 60_000,
  })
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
    onSuccess: (_result, input) =>
      done(
        input.repeat?.paid === false
          ? `Anotado: queda por pagar el de ${MONTH_NAMES[Number(input.repeat.month?.slice(5, 7)) - 1] ?? "ese mes"}, sin registrar ningún pago`
          : input.repeat
            ? "Gasto registrado: aparecerá «por pagar» cada vez que toque"
            : "Gasto registrado",
      ),
  })
  const payMutation = useMutation({
    mutationFn: (input: { orderId: string; body: Parameters<typeof payPurchaseApi>[1] }) => payPurchaseApi(input.orderId, input.body),
    onSuccess: (result, input) => {
      const order = orders.find((item) => item.orderId === input.orderId)
      const left = result.data.balance.dueCents
      if (!order) done("Pago registrado")
      else if (order.dueCents === 0)
        done(
          `Adelanto registrado: ${purchaseOrderLabel(order.orderNumber)} lo descuenta cuando llegue${order.receivedCents > 0 ? " lo que falta" : ""}`,
        )
      else if (left > 0)
        done(
          `Pago registrado: a ${purchaseOrderLabel(order.orderNumber)} le falta ${formatMoney(left, order.currency, locale)}`,
        )
      else
        done(`Pago registrado: ${purchaseOrderLabel(order.orderNumber)} queda al día en Inventario`)
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
      const suggested =
        order.dueCents > 0 ? order.dueCents : Math.max(0, order.orderedCents - order.paidCents)
      form.setFieldValue(
        "amount",
        suggested > 0 ? formatMoneyInput(suggested, order.currency, locale) : "",
      )
      form.setFieldValue("payIn", order.currency)
      form.setFieldValue("tender", "")
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
      submitLabel={chosen ? (advance ? "Registrar adelanto" : "Registrar pago") : annotatesOnly(values) ? "Anotar" : "Registrar gasto"}
      submitDisabled={!canWrite}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="category">
          {(field) => (
            <field.Group
              legend="Tipo"
              description={canStaffPay ? undefined : "Los sueldos y lo que se le paga al personal los anota administración."}
            >
              {(control) => (
                <ChoiceChips
                  id={control.id}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={categoryOptions}
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
            {() => (
              <PurchaseChoice
                orders={orders}
                branchId={branchId}
                money={(cents, currency) => formatMoney(cents, currency, locale)}
                onChoose={choosePurchase}
              />
            )}
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
        {second && !chosen && !onlyBusiness ? (
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
                    options={currencyChoices(currencies, locale)}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="amount">
          {(field) => (
            <field.Control
              label={second && chosen ? "Lo que cancelas" : "Importe"}
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
              {(control) =>
                second ? (
                  <MoneyInput
                    id={control.id}
                    currency={unit}
                    placeholder={formatMoneyInput(0, unit, locale)}
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                ) : (
                  <Input
                    {...control.props}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={formatMoneyInput(0, unit, locale)}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )
              }
            </field.Control>
          )}
        </form.AppField>
        {second && chosen && paid.asks ? (
          <form.AppField name="payIn">
            {(field) => (
              <field.Group legend="Pagas con" className="gap-3">
                {(control) => (
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    tone="primary"
                    value={field.state.value}
                    options={currencyChoices(currencies, locale)}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {second ? (
          <ExpenseMoneyFields
            second={second}
            money={paid}
            currency={unit}
            business={place.currency}
            locale={locale}
            crosses={Boolean(chosen)}
            reportWords={(value) =>
              `En tus reportes cuenta como ${value}${paid.crossed ? "" : ", con este cambio"}.`
            }
            field={(name, control) => <form.AppField name={name}>{() => control}</form.AppField>}
          />
        ) : null}
        {annotatesOnly(values) ? null : (
          <>
        <form.AppField name="fromCash">
          {(field) => (
            <FormChoiceField
              label="Se pagó con el efectivo de la caja"
              description={
                otherBranch && chosen
                  ? `Es de otra sede (${chosen.branchName}): no sale de esta caja.`
                  : second && !values.fromCash
                    ? "No toca ninguna caja: salió de una cuenta o de otro lado."
                    : after === null || (after < 0 && state)
                      ? second
                        ? `Se descuenta de la caja de ${currencyWord(paid.payIn, locale)}.`
                        : "Se descuenta del efectivo que debe haber al cerrar."
                      : second
                        ? `Se descuenta de la caja de ${currencyWord(paid.payIn, locale)}: queda en ${formatMoney(after, paid.payIn, locale)}.`
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
        {after !== null && after < 0 && !otherBranch && canMoveCash ? (
          // Lo que falta se ingresa encima, sin salir: al guardarlo, el gasto sigue como estaba.
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-muted-foreground">
              En la caja hay {formatMoney(after + (paid.outCents ?? 0), paid.payIn, locale)}: faltan{" "}
              {formatMoney(-after, paid.payIn, locale)} para pagarlo con el efectivo. Si está en el cajón, ingrésalo; si se
              pagó por otro medio, quita la casilla.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setCashOpen(true)}>
              Ingresar {formatMoney(-after, paid.payIn, locale)} a la caja
            </Button>
          </div>
        ) : null}
          </>
        )}
        {!chosen && !(asksSalesTaxNow && values.salesTax === "cobros") ? (
          <>
            <form.AppField name="repeats">
              {(field) => (
                <FormChoiceField
                  label="Se repite"
                  description="El alquiler, un sueldo, la luz: queda anotado y aparece «por pagar» en Gastos cada vez que toca. Nunca se paga solo."
                >
                  {(control) => (
                    <Checkbox
                      id={control.id}
                      aria-describedby={control.describedBy}
                      checked={field.state.value}
                      onCheckedChange={(checked) => {
                        field.handleChange(checked === true)
                        control.onBlur()
                      }}
                    />
                  )}
                </FormChoiceField>
              )}
            </form.AppField>
            {values.repeats ? (
              <div className="flex flex-col gap-4 rounded-lg border bg-muted/30 p-3">
                <form.AppField name="paidNow">
                  {(field) => (
                    <field.Group
                      legend={`¿Ya se pagó el de ${MONTH_NAMES[Number(values.repeatMonth.slice(5, 7)) - 1] ?? "este mes"}?`}
                      description={
                        field.state.value === "no"
                          ? "Se anota sin registrar ningún pago: queda «por pagar» y lo pagas desde Gastos cuando toque."
                          : "Se registra este pago y desde ahí aparece por pagar cada vez que toca."
                      }
                      className="gap-3"
                    >
                      {(control) => (
                        <ChoiceButtons
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          tone="primary"
                          value={field.state.value}
                          options={PAID_CHOICES}
                          onChange={(next) => {
                            field.handleChange(next as ExpenseValues["paidNow"])
                            // Lo que se anota sin pagar parte de hoy, no de la fecha de un pago.
                            if (next === "no" && !payableMonths(today).some((item) => item.value === values.repeatMonth))
                              form.setFieldValue("repeatMonth", today.slice(0, 7))
                          }}
                        />
                      )}
                    </field.Group>
                  )}
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
                          onChange={(next) => field.handleChange(next as ExpenseValues["every"])}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
                <form.AppField name="repeatMonth">
                  {(field) => (
                    <field.Group
                      legend="Este gasto es el pago de"
                      description="El sueldo de octubre pagado en noviembre es de octubre. Desde ahí aparece por pagar cada vez que toca."
                      className="gap-3"
                    >
                      {(control) => (
                        <ChoiceButtons
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          tone="primary"
                          value={field.state.value}
                          options={payableMonths(annotatesOnly(values) ? today : values.spentDay)}
                          onChange={(next) => field.handleChange(next)}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
                <form.AppField name="repeatDay">
                  {(field) => (
                    <field.TextField
                      label="El día"
                      description="Si el mes no tiene ese día, el último del mes."
                      inputMode="numeric"
                      inputClassName="w-24"
                    />
                  )}
                </form.AppField>
                <form.AppField name="dueNext">
                  {(field) => (
                    <field.Group
                      legend="Se paga"
                      description="El sueldo de noviembre que se paga el 2 de diciembre: «Al mes siguiente». Así no sale vencido antes de tiempo."
                      className="gap-3"
                    >
                      {(control) => (
                        <ChoiceButtons
                          id={control.id}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onBlur={control.onBlur}
                          tone="primary"
                          value={field.state.value}
                          options={DUE_CHOICES}
                          onChange={(next) => field.handleChange(next as ExpenseValues["dueNext"])}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
                {values.category === "Personal" ? (
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
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}
        {annotatesOnly(values) ? null : (
          <>
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
                        onChange={(day) => {
                          // El día propuesto con la fecha anterior: si sigue igual, nadie lo cambió.
                          const proposed = String(Number(field.state.value.slice(8, 10)))
                          field.handleChange(day)
                          // El mes que paga sigue a la fecha: su mes o el anterior. El día, si no se escribió otro.
                          if (!payableMonths(day).some((item) => item.value === form.getFieldValue("repeatMonth")))
                            form.setFieldValue("repeatMonth", day.slice(0, 7))
                          if (form.getFieldValue("repeatDay") === proposed)
                            form.setFieldValue("repeatDay", String(Number(day.slice(8, 10))))
                        }}
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
          </>
        )}
        {!canWrite ? (
          <p className="text-sm font-medium">
            Tu rol no puede registrar gastos. Pídeselo a quien cobra o a administración.
          </p>
        ) : null}
      </div>
      <CashMoveDrawer
        branchId={branchId}
        currency={paid.payIn}
        locale={locale}
        open={cashOpen}
        onClose={() => setCashOpen(false)}
        initialAmountCents={after !== null && after < 0 ? -after : undefined}
      />
    </FormDrawer>
  )
}
