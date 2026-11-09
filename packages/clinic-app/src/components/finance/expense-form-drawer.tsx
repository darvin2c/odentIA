/**
 * «Registrar gasto» (ADR 0167; QA de Gastos del 8 nov, UX 1 a 3): un gasto ya pagado, y nada más.
 * Pregunta en qué, cuánto, de qué tipo, con qué se pagó y su comprobante; la caja va en una línea.
 * Lo que se repite se anota en su sección, no aquí.
 *
 * El mismo cajón sirve para tres cosas (`mode`): registrar uno nuevo, corregir uno (anula el
 * original con lo que cambió y registra este, en una operación) y pagar lo que toca de lo que se
 * repite (el importe de siempre, editable, y el medio de siempre).
 *
 * Con el tipo Materiales pregunta si es el pago de una compra de Inventario: elegirla registra el
 * pago de esa compra (`/api/finance/purchases/:id/payments`, la misma operación que desde
 * Inventario; ADR 0061) y así no se cuenta dos veces. Con otra moneda en la clínica, un gasto suelto
 * lleva su moneda y su cambio, y pagar una compra deja elegir con qué se paga.
 */
import {
  currencyWord,
  expenseReceiptTypes,
  formatExchangeRateInput,
  formatMoney,
  formatMoneyInput,
  isTaxDocument,
  NO_RECEIPT_TYPE,
  rucLooksValid,
  suggestedReceiptType,
} from "@odentia/clinical"
import { Button, FieldDescription, Input, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useId, useRef, useState } from "react"
import { usePermission } from "../../lib/crm"
import { readExpenseMoney } from "../../lib/expense-exchange"
import {
  cashFormMessage,
  correctExpenseApi,
  createExpenseApi,
  dayKeyOf,
  EXPENSE_CATEGORIES,
  type ExpenseCategory,
  type ExpenseRow,
  errorCode,
  expenseCategoryHint,
  expenseCategoryLabel,
  fetchExpenseSuppliers,
  fetchPurchasesToPay,
  financeKeys,
  formatDayKey,
  invalidateFinance,
  NO_RECEIPT,
  noonOf,
  parseAmount,
  payPurchaseApi,
  payRecurringApi,
  type RecurringDue,
  todayIn,
  useCashState,
  voidExpenseApi,
} from "../../lib/finance-cash"
import { CASH_TYPE_CODE, fetchPaymentMethods } from "../../lib/finance-collect"
import { orgTaxesOf, useOrgProfile, useTodayRate } from "../../lib/org"
import { currencyChoices } from "../../lib/product-words"
import { type PurchaseBalance, purchaseOrderLabel } from "../../lib/reports"
import { ChoiceButtons } from "../choice-buttons"
import { MoneyInput } from "../inventory/fields"
import { CashMoveDrawer, ChoiceChips } from "./cash-close-drawer"
import { PaymentMethodButtons } from "./collect-drawer"
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

/** Qué hace el cajón: registrar uno nuevo, corregir uno o pagar lo que toca de lo que se repite. */
export type ExpenseDrawerMode =
  | { kind: "nuevo" }
  | { kind: "corregir"; expense: ExpenseRow }
  | { kind: "pagar"; due: RecurringDue }

const NEW: ExpenseDrawerMode = { kind: "nuevo" }

const CATEGORY_OPTIONS = EXPENSE_CATEGORIES.map((value) => ({ value, label: expenseCategoryLabel(value) }))
/** «No, es otro gasto de materiales». */
const OTHER = "otro"

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "setiembre", "octubre", "noviembre", "diciembre"]

const monthWord = (key: string) => MONTH_NAMES[Number(key.slice(5, 7)) - 1] ?? key

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
  /** Con qué se pagó: un medio de la clínica (el mismo de Cobrar). */
  method: string
  /** El n.º de operación de lo que no es efectivo. */
  reference: string
  /** El tipo de comprobante del país, o «sin». */
  receiptType: string
  receiptNumber: string
  /** A quién se pagó: un proveedor de la lista o uno escrito. */
  supplier: string
  supplierTaxId: string
  spentDay: string
}

/**
 * Las opciones de «¿Es el pago de una compra?» (QA de Gastos, G4 y G24): «No» primero, después lo
 * que se debe en esta sede y al final lo demás. En un desplegable, como prometía el lienzo: la lista
 * entera empujaba el medio de pago fuera de la vista. Sin «Inventario» ni «OC» delante: el número va
 * al final, para distinguir dos compras al mismo proveedor.
 */
function purchaseOptions(
  orders: PurchaseBalance[],
  branchId: string,
  money: (cents: number, currency: string) => string,
): Array<{ value: string; label: string }> {
  const here = orders.filter((order) => order.branchId === branchId && order.dueCents > 0)
  const rest = orders.filter((order) => !here.includes(order))
  const label = (order: PurchaseBalance) =>
    [
      `Compra a ${order.supplierName}`,
      order.dueCents > 0
        ? `por pagar ${money(order.dueCents, order.currency)}`
        : order.receivedCents === 0
          ? "aún no llega"
          : "al día, falta que llegue",
      order.branchId !== branchId ? order.branchName : null,
    ]
      .filter(Boolean)
      .join(" · ") + ` (${purchaseOrderLabel(order.orderNumber)})`
  return [{ value: OTHER, label: "No, es otro gasto" }, ...[...here, ...rest].map((order) => ({ value: order.orderId, label: label(order) }))]
}

export function ExpenseFormDrawer({
  place,
  open,
  onClose,
  initial,
  mode = NEW,
}: {
  place: ExpensePlace
  open: boolean
  onClose: () => void
  initial?: ExpenseDraft | null
  mode?: ExpenseDrawerMode
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
  const profile = useOrgProfile().data
  const salesTaxName = orgTaxesOf(profile)?.name ?? null
  const country = profile?.countryCode ?? "PE"
  const receiptTypes = expenseReceiptTypes(country)
  // Lo que se vio de la compra al elegirla: si cambia mientras tanto, el servidor lo dice.
  const [seen, setSeen] = useState<{ due: number; paid: number } | null>(null)
  // «Ingresar lo que falta»: el cajón del efectivo se apila encima, sin tocar el gasto.
  const [cashOpen, setCashOpen] = useState(false)
  const currencies = second ? [place.currency, second.currency] : []
  // Una clave por cajón abierto (ADR 0018): si se corta la red y se vuelve a guardar, el servidor
  // devuelve el mismo gasto en vez de registrar otro y sacar el efectivo dos veces.
  const requestId = useRef<string>(crypto.randomUUID())
  // El comprobante se propone por el tipo hasta que la persona lo elige.
  const receiptTouched = useRef(false)
  // Lo último que propuso el tipo: elegir otro valor es lo que cuenta como elección de la persona.
  const lastSuggested = useRef("")
  const paying = mode.kind === "pagar" ? mode.due : null
  const correcting = mode.kind === "corregir" ? mode.expense : null

  const methods = useQuery({ queryKey: ["org-payment-methods"], queryFn: fetchPaymentMethods, enabled: open })
  const allMethods = methods.data?.data ?? []
  const cashMethod = allMethods.find((method) => method.typeCode === CASH_TYPE_CODE) ?? null

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
      method: "",
      reference: "",
      receiptType: "",
      receiptNumber: "",
      supplier: "",
      supplierTaxId: "",
      spentDay: today,
    } as ExpenseValues,
    validators: {
      onSubmit: ({ value }) => {
        const { chosen, asksSalesTax, cents, after, paid } = derive(value)
        const fields: Record<string, string> = {}
        if (!paying && value.category === "") fields.category = "Elige el tipo de gasto."
        if (asksSalesTax && value.salesTax === null) fields.salesTax = "Elige qué impuesto pagas."
        // Con compras por pagar en esta sede, que sea o no una de ellas lo dice la persona (G4).
        if (
          !paying &&
          !correcting &&
          value.category === "Materiales" &&
          value.purchase === "" &&
          orders.some((order) => order.branchId === branchId && order.dueCents > 0)
        )
          fields.purchase = "Elige si es el pago de una de estas compras o de otro gasto."
        if (!paying && !chosen && !value.concept.trim()) fields.concept = "Escribe en qué se gastó."
        if (value.amount.trim() !== "" && cents === null) fields.amount = "Ese importe no se entiende. Revísalo."
        else if (cents === null || cents <= 0) fields.amount = "Escribe un importe mayor que cero."
        if (!value.method) fields.method = "Elige con qué se pagó."
        else if (!derive(value).method) fields.method = "Ese medio ya no está activo: elige otro."
        else if (after !== null && after < 0)
          // Una sola salida por cada camino: ingresar lo que falta o decir que se pagó de otra forma.
          fields.method = "No alcanza el efectivo de la caja: ingresa lo que falta o elige con qué se pagó."
        if (paid.tenderError) fields.tender = paid.tenderError
        if (paid.rateError) fields.rate = paid.rateError
        if (value.spentDay > today) fields.spentDay = "La fecha del gasto no puede ser futura."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const { chosen, asksSalesTax, cents, currency, paid, method } = derive(value)
      if (cents === null || !method) return
      // Hoy lleva la hora real; otro día, su mediodía en la zona de la clínica. Al corregir va siempre:
      // lo que no se manda se queda como estaba (la fecha de antes, aunque se haya elegido hoy).
      const spentAt =
        value.spentDay !== today
          ? { spentAt: noonOf(value.spentDay, orgTimeZone) }
          : correcting
            ? { spentAt: new Date().toISOString() }
            : {}
      const type = value.receiptType ? receiptTypes.find((item) => item.code === value.receiptType) : null
      const supplier = (suppliers.data?.data ?? []).find(
        (item) => item.name.toLocaleLowerCase(locale) === value.supplier.trim().toLocaleLowerCase(locale),
      )
      const asksSupplier = showsSupplier(value)
      const paper = {
        paymentMethodId: method.id,
        ...(method.typeCode !== CASH_TYPE_CODE && value.reference.trim() ? { paymentReference: value.reference.trim() } : {}),
        ...(value.receiptType ? { receiptType: value.receiptType } : {}),
        ...(value.receiptType && value.receiptType !== NO_RECEIPT_TYPE && value.receiptNumber.trim()
          ? { receiptNumber: value.receiptNumber.trim() }
          : {}),
        ...(asksSupplier && supplier ? { supplierId: supplier.id } : {}),
        ...(asksSupplier && !supplier && value.supplier.trim() ? { supplierName: value.supplier.trim() } : {}),
        ...(asksSupplier && type?.asksTaxId && value.supplierTaxId.trim() ? { supplierTaxId: value.supplierTaxId.trim() } : {}),
      }
      if (paying) {
        await payRecurringMutation.mutateAsync({
          due: paying,
          // Con otra moneda, el cambio que se escribió (o el de hoy) va con el pago.
          body: { month: paying.month, amountCents: cents, requestId: requestId.current, ...paid.body, ...paper, ...spentAt },
        })
        return
      }
      if (chosen) {
        // Lo que vio la persona al elegirla: si alguien pagó mientras tanto, o este envío ya entró, el servidor lo dice en vez de pagar de más.
        await payMutation.mutateAsync({
          orderId: chosen.orderId,
          body: {
            amountCents: cents,
            ...paid.body,
            fromCash: method.typeCode === CASH_TYPE_CODE,
            paymentMethodId: method.id,
            ...(paper.paymentReference ? { paymentReference: paper.paymentReference } : {}),
            expectedDueCents: seen?.due ?? chosen.dueCents,
            expectedPaidCents: seen?.paid ?? chosen.paidCents,
            requestId: requestId.current,
            ...(value.receiptType ? { receiptType: value.receiptType } : {}),
            ...(paper.receiptNumber ? { receiptNumber: paper.receiptNumber } : {}),
            ...spentAt,
          },
        })
        return
      }
      const body = {
        requestId: requestId.current,
        branchId,
        concept: value.concept.trim(),
        amountCents: cents,
        // Al corregir, la moneda va siempre: de dólares a soles es un cambio.
        ...((second && currency !== place.currency) || correcting ? { currency } : {}),
        ...paid.body,
        category: value.category as ExpenseCategory,
        fromCash: method.typeCode === CASH_TYPE_CODE,
        ...(asksSalesTax ? { salesTax: value.salesTax === "cobros" } : {}),
        // Lo de antes, con su comprobante escrito a mano y su número, lo conserva si no se elige un tipo.
        ...(correcting && !value.receiptType && correcting.receiptKind !== NO_RECEIPT ? { receiptKind: correcting.receiptKind } : {}),
        ...(correcting && !value.receiptType && correcting.receiptNumber ? { receiptNumber: correcting.receiptNumber } : {}),
        ...paper,
        ...spentAt,
      }
      if (correcting) await correctMutation.mutateAsync({ id: correcting.id, body })
      else await createMutation.mutateAsync(body)
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
      paymentMethodId: "method",
      fromCash: "method",
      paymentReference: "reference",
      supplierId: "supplier",
      supplierName: "supplier",
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
    receiptTouched.current = Boolean(correcting)
    const day = todayIn(orgTimeZone)
    const category: ExpenseCategory | "" = paying
      ? (paying.category as ExpenseCategory)
      : correcting
        ? (correcting.category as ExpenseCategory)
        : (initial?.category ?? "")
    const unit = correcting?.currency ?? paying?.currency ?? place.currency
    const cents = correcting?.amountCents ?? paying?.amountCents ?? initial?.amountCents ?? null
    form.reset({
      category,
      salesTax: correcting?.salesTax ? "cobros" : null,
      purchase: "",
      concept: correcting?.concept ?? paying?.concept ?? initial?.concept ?? "",
      currency: unit,
      amount: cents !== null ? formatMoneyInput(cents, unit, locale) : "",
      payIn: unit,
      tender: "",
      rate: correcting?.exchangeRate ? formatExchangeRateInput(correcting.exchangeRate, locale) : todayRate,
      // El medio de siempre: el que se dijo, o el efectivo si salía de la caja.
      method: correcting?.paymentMethodId ?? paying?.paymentMethodId ?? "",
      reference: correcting?.paymentReference ?? "",
      receiptType: correcting ? (correcting.receiptType ?? "") : (lastSuggested.current = category ? suggestedReceiptType(country, category) : ""),
      receiptNumber: correcting?.receiptNumber ?? "",
      supplier: correcting?.supplierName ?? "",
      supplierTaxId: correcting?.supplierTaxId ?? "",
      spentDay: correcting
        ? dayKeyOf(correcting.spentAt, orgTimeZone)
        : initial?.day && initial.day <= day
          ? initial.day
          : day,
    })
    setSeen(null)
  }, [open, orgTimeZone, initial, place.currency, locale, form, todayRate, correcting, paying, country])
  // Cuando llega la lista: el medio de siempre se propone solo si sigue activo; lo de antes que
  // salía de la caja, sin medio, propone el efectivo.
  useEffect(() => {
    if (!open || !methods.data) return
    const current = form.getFieldValue("method")
    if (current && !allMethods.some((method) => method.id === current)) form.setFieldValue("method", "", { dontUpdateMeta: true })
    if (form.getFieldValue("method") !== "" || !cashMethod) return
    if (correcting?.fromCash || (paying && paying.fromCash && !paying.paymentMethodId))
      form.setFieldValue("method", cashMethod.id, { dontUpdateMeta: true })
  }, [open, methods.data, allMethods, cashMethod, form, correcting, paying])
  // Después de «Ingresar», si ya alcanza, el rojo de la caja se va solo (QA de Gastos, G7).
  const methodErrors = useStore(form.store, (s) => (s.fieldMeta.method?.errors.length ?? 0) > 0)
  useEffect(() => {
    if (!methodErrors) return
    const { after: nowAfter, method: nowMethod } = derive(form.state.values)
    if (nowMethod && (nowAfter === null || nowAfter >= 0))
      form.setFieldMeta("method", (meta) => ({ ...meta, errorMap: {}, errorSourceMap: {} }))
  })
  // El cambio de hoy puede llegar después de abrir: llega puesto, sin pisar lo escrito.
  useEffect(() => {
    if (open && todayRate && form.getFieldValue("rate") === "")
      form.setFieldValue("rate", todayRate, { dontUpdateMeta: true })
  }, [open, todayRate, form])

  // Las compras se preguntan solo con Materiales: las recibidas sin pagar primero, luego lo que aún no llega.
  const purchases = useQuery({
    queryKey: financeKeys.purchases(null),
    queryFn: () => fetchPurchasesToPay(),
    enabled: open && !paying && !correcting && values.category === "Materiales",
  })
  // Con otra moneda se ven las compras de las dos; sin ella, las de la moneda de la clínica.
  const allOrders = purchases.data?.data.orders ?? []
  const listed = second ? allOrders.filter((order) => currencies.includes(order.currency)) : allOrders
  const picked = values.category === "Materiales" ? (listed.find((order) => order.orderId === values.purchase) ?? null) : null
  // El impuesto de lo cobrado y lo que no es una compra: de qué moneda sale el dinero, y de esa caja.
  const paysSalesTax = values.category === "Impuestos" && salesTaxName !== null && values.salesTax === "cobros"
  const outCurrency = second ? (picked ? values.payIn : paysSalesTax ? place.currency : values.currency) : undefined
  const cash = useCashState(branchId, open, outCurrency)
  const state = cash.data?.data ?? null
  const unit = second
    ? (picked?.currency ?? (paysSalesTax ? place.currency : values.currency))
    : (state?.currency ?? correcting?.currency ?? paying?.currency ?? place.currency)
  const orders = second ? listed : listed.filter((order) => order.currency === unit)

  /** El proveedor se pregunta donde hay a quién pagar con papel: compras, laboratorio o un comprobante con RUC. */
  function showsSupplier(value: Pick<ExpenseValues, "category" | "receiptType" | "purchase">): boolean {
    if (value.category === "Materiales" && value.purchase !== "" && value.purchase !== OTHER) return false
    const type = receiptTypes.find((item) => item.code === value.receiptType)
    return value.category === "Materiales" || value.category === "Laboratorio" || type?.asksTaxId === true
  }

  /** Lo que se deduce de lo elegido: la compra que se paga, si se pregunta el impuesto, la moneda, el medio y cómo queda la caja. */
  function derive(value: ExpenseValues) {
    // Solo un gasto de Materiales paga una compra: si se cambia el tipo, ya no es ese pago.
    const chosen = !paying && !correcting && value.category === "Materiales" ? (orders.find((order) => order.orderId === value.purchase) ?? null) : null
    const asksSalesTax = !paying && value.category === "Impuestos" && salesTaxName !== null
    // El impuesto de lo cobrado solo se paga en moneda del negocio.
    const onlyBusiness = asksSalesTax && value.salesTax === "cobros"
    const currency = second ? (chosen?.currency ?? (onlyBusiness ? place.currency : value.currency)) : unit
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
    const method = allMethods.find((item) => item.id === value.method) ?? null
    const fromCash = method?.typeCode === CASH_TYPE_CODE
    // Al corregir un gasto que salió de la caja, lo que salió vuelve antes de sacar lo nuevo.
    const back =
      correcting?.fromCash && state && (correcting.tenderCurrency ?? correcting.currency) === paid.payIn
        ? (correcting.tenderCents ?? correcting.amountCents)
        : 0
    // Con la caja a la vista se dice cómo queda; si no alcanza, se dice antes de guardar.
    const after =
      fromCash && state && state.currency === paid.payIn && paid.outCents !== null && (!chosen || chosen.branchId === branchId)
        ? state.cashOnHandCents + back - paid.outCents
        : null
    return { chosen, asksSalesTax, onlyBusiness, currency, cents, after, paid, method, fromCash, back }
  }
  const { chosen, asksSalesTax, onlyBusiness, cents, after, paid, method, fromCash, back } = derive(values)
  // Sin nada recibido por pagar, lo que se paga es un adelanto de lo que falta que llegue.
  const advance = chosen !== null && chosen.dueCents === 0
  const asksPurchase = !paying && !correcting && values.category === "Materiales" && orders.length > 0
  const otherBranch = chosen !== null && chosen.branchId !== branchId
  // Un pago a otra sede no sale de esta caja: el efectivo no se ofrece.
  const methodOptions = otherBranch ? allMethods.filter((item) => item.typeCode !== CASH_TYPE_CODE) : allMethods
  const asksSupplier = showsSupplier(values)
  const pickedType = receiptTypes.find((item) => item.code === values.receiptType) ?? null
  const suppliers = useQuery({
    queryKey: ["finance", "suppliers"],
    queryFn: fetchExpenseSuppliers,
    enabled: open && asksSupplier,
    staleTime: 60_000,
  })
  const supplierListId = useId()
  const money = (amount: number) => formatMoney(amount, unit, locale)

  const done = (message: string, options?: Parameters<typeof toast.success>[1]) => {
    invalidateFinance(queryClient)
    toast.success(message, options)
    onClose()
  }
  /** Quedó en otro mes que el de hoy: se dice dónde verlo (QA de Gastos, G30). */
  const inMonth = (day: string) => (day.slice(0, 7) !== today.slice(0, 7) ? `: quedó en ${monthWord(day)}` : "")
  const createMutation = useMutation({
    mutationFn: createExpenseApi,
    onSuccess: () => done(`Gasto registrado${inMonth(form.getFieldValue("spentDay"))}`),
  })
  const correctMutation = useMutation({
    mutationFn: (input: { id: string; body: Parameters<typeof createExpenseApi>[0] }) => correctExpenseApi(input.id, input.body),
    onSuccess: () => done(`Gasto corregido${inMonth(form.getFieldValue("spentDay"))}: el de antes queda anulado, con lo que cambió`),
  })
  const payRecurringMutation = useMutation({
    mutationFn: (input: { due: RecurringDue; body: Parameters<typeof payRecurringApi>[1] }) =>
      payRecurringApi(input.due.recurringId, input.body),
    onSuccess: (result, input) =>
      done(`${input.due.concept} de ${monthWord(input.due.month)} registrado · ${formatMoney(result.data.amountCents, result.data.currency, locale)}`, {
        duration: 10_000,
        // «Deshacer» es anular este pago: vuelve a quedar por pagar.
        action: {
          label: "Anular este pago",
          onClick: () => {
            voidExpenseApi(result.data.id, "Se deshizo el pago recién registrado")
              .then(() => toast.success(`${input.due.concept}: vuelve a estar por pagar`))
              .catch((error: unknown) =>
                toast.error(`No se pudo anular: ${error instanceof Error ? error.message : "inténtalo otra vez"}`),
              )
              .finally(() => invalidateFinance(queryClient))
          },
        },
      }),
  })
  const payMutation = useMutation({
    mutationFn: (input: { orderId: string; body: Parameters<typeof payPurchaseApi>[1] }) => payPurchaseApi(input.orderId, input.body),
    onSuccess: (result, input) => {
      const order = orders.find((item) => item.orderId === input.orderId)
      const left = result.data.balance.dueCents
      if (!order) done("Pago registrado")
      else if (order.dueCents === 0)
        done(`Adelanto registrado: ${purchaseOrderLabel(order.orderNumber)} lo descuenta cuando llegue${order.receivedCents > 0 ? " lo que falta" : ""}`)
      else if (left > 0) done(`Pago registrado: a ${purchaseOrderLabel(order.orderNumber)} le falta ${formatMoney(left, order.currency, locale)}`)
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
    const order = orders.find((item) => item.orderId === value)
    setSeen(order ? { due: order.dueCents, paid: order.paidCents } : null)
    if (order) {
      const suggested = order.dueCents > 0 ? order.dueCents : Math.max(0, order.orderedCents - order.paidCents)
      form.setFieldValue("amount", suggested > 0 ? formatMoneyInput(suggested, order.currency, locale) : "")
      form.setFieldValue("payIn", order.currency)
      form.setFieldValue("tender", "")
      // Un pago a otra sede no sale de esta caja.
      if (order.branchId !== branchId && form.getFieldValue("method") === cashMethod?.id) form.setFieldValue("method", "")
    }
  }

  const title = paying ? `Pagar ${paying.concept} · ${monthWord(paying.month)}` : correcting ? "Corregir gasto" : "Registrar gasto"
  const amountWords = cents !== null && cents > 0 ? ` ${formatMoney(cents, paid.payIn === unit ? unit : unit, locale)}` : ""
  const submitLabel = paying
    ? `Registrar pago${amountWords}`
    : correcting
      ? "Guardar corrección"
      : chosen
        ? advance
          ? "Registrar adelanto"
          : "Registrar pago"
        : `Registrar${amountWords || " gasto"}`

  return (
    <FormDrawer
      {...surface}
      open={open}
      title={title}
      description={
        paying
          ? paying.memberName
            ? `Sueldo de ${paying.memberName}, de ${place.branchName}.`
            : `${expenseCategoryLabel(paying.category)} de ${place.branchName}.`
          : chosen
            ? `Pago de una compra de ${chosen.branchName}.`
            : place.branchName
              ? `Gasto de ${place.branchName}.`
              : undefined
      }
      submitLabel={submitLabel}
      submitDisabled={!canWrite}
      onClose={() => {
        if (!surface.isSubmitting) onClose()
      }}
    >
      <div className="flex flex-col gap-5">
        {correcting ? (
          <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-sm">
            Antes: <strong>{formatMoney(correcting.amountCents, correcting.currency, locale)}</strong> ·{" "}
            {expenseCategoryLabel(correcting.category)} ·{" "}
            {correcting.methodName ?? (correcting.fromCash ? "Efectivo de la caja" : "Otro medio")}. Al guardar, ese queda anulado
            con lo que cambió y se registra este. Si salió de la caja, vuelve y sale lo nuevo.
          </p>
        ) : null}
        {paying ? null : (
          <form.AppField name="concept">
            {(field) =>
              chosen ? (
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
                  Queda como gasto de <strong>Materiales</strong> de {chosen.branchName}: {advance ? "Adelanto" : "Pago"} de compra{" "}
                  {purchaseOrderLabel(chosen.orderNumber)} · {chosen.supplierName}.
                </p>
              ) : (
                <field.TextField label="En qué se gastó" maxLength={500} />
              )
            }
          </form.AppField>
        )}
        {second && !chosen && !onlyBusiness && !paying ? (
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
                paying
                  ? `Lo de siempre: ${formatMoney(paying.amountCents, paying.currency, locale)}. Si llegó otro, cámbialo.`
                  : chosen
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
        {paying ? null : (
          <form.AppField
            name="category"
            listeners={{
              // El comprobante que suele traer ese tipo, hasta que la persona elige otro.
              onChange: ({ value }) => {
                // Solo mientras la persona no eligió uno: lo que cambia el código no cuenta como elegido.
                if (!receiptTouched.current && value) {
                  lastSuggested.current = suggestedReceiptType(country, value)
                  form.setFieldValue("receiptType", lastSuggested.current, { dontUpdateMeta: true })
                }
              },
            }}
          >
            {(field) => (
              <field.Group
                legend="Tipo"
                description={
                  field.state.value
                    ? expenseCategoryHint(field.state.value)
                    : canStaffPay
                      ? undefined
                      : "Los sueldos y lo que se le paga al personal los anota administración."
                }
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
        )}
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
                        : `El ${salesTaxName} ya se restó de lo cobrado: no suma en «Gastado» ni resta de lo que deja.`}
                    </FieldDescription>
                  </>
                )}
              </field.Group>
            )}
          </form.AppField>
        ) : null}
        {asksPurchase ? (
          <form.AppField name="purchase" listeners={{ onChange: ({ value }) => choosePurchase(value) }}>
            {(field) => (
              <field.SelectField
                label="¿Es el pago de una compra?"
                description="Si es una compra, el monto se llena solo y la compra queda al día: así no se cuenta dos veces."
                placeholder="Elige si es una compra"
                options={purchaseOptions(orders, branchId, (amount, currency) => formatMoney(amount, currency, locale))}
              />
            )}
          </form.AppField>
        ) : null}
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
            reportWords={(value) => `En tus reportes cuenta como ${value}${paid.crossed ? "" : ", con este cambio"}.`}
            field={(name, control) => <form.AppField name={name}>{() => control}</form.AppField>}
          />
        ) : null}
        <form.AppField name="method">
          {(field) => (
            <field.Group legend="¿Con qué se pagó?">
              {(control) => (
                <div className="flex flex-col gap-2.5">
                  {methods.isPending ? (
                    <p className="text-sm text-muted-foreground">Consultando los medios de la clínica…</p>
                  ) : methods.isError ? (
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      No se pudieron consultar los medios de pago.
                      <Button type="button" variant="outline" size="sm" onClick={() => void methods.refetch()}>
                        Reintentar
                      </Button>
                    </p>
                  ) : methodOptions.length === 0 ? (
                    <p className="text-sm">La clínica aún no tiene medios de pago: se agregan en Configuración › Medios de pago.</p>
                  ) : (
                    <PaymentMethodButtons
                      id={control.id}
                      methods={methodOptions}
                      value={field.state.value}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                  {/* La caja en una sola línea (QA de Gastos, G7): cómo queda o cuánto falta, con su salida. */}
                  {fromCash && after !== null ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm">
                      <span>
                        {after >= 0
                          ? `En la caja${second ? ` de ${currencyWord(paid.payIn, locale)}` : ""} hay ${formatMoney(after + (paid.outCents ?? 0) - back, paid.payIn, locale)}${back > 0 ? ` y vuelven ${formatMoney(back, paid.payIn, locale)} de lo anotado antes` : ""}: queda ${formatMoney(after, paid.payIn, locale)}.`
                          : `En la caja${second ? ` de ${currencyWord(paid.payIn, locale)}` : ""} hay ${formatMoney(after + (paid.outCents ?? 0) - back, paid.payIn, locale)}${back > 0 ? ` y vuelven ${formatMoney(back, paid.payIn, locale)} de lo anotado antes` : ""}: faltan ${formatMoney(-after, paid.payIn, locale)}.`}
                      </span>
                      {after < 0 && canWrite ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => setCashOpen(true)}>
                          Ingresar {formatMoney(-after, paid.payIn, locale)}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {fromCash && values.spentDay !== today ? (
                    <p className="text-sm text-muted-foreground">El efectivo sale de la caja de hoy, aunque la fecha sea otra.</p>
                  ) : null}
                  {otherBranch ? (
                    <p className="text-sm text-muted-foreground">Es de otra sede ({chosen?.branchName}): no sale de esta caja.</p>
                  ) : null}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        {method && method.typeCode !== CASH_TYPE_CODE ? (
          <form.AppField name="reference">
            {(field) => <field.TextField label="N.º de operación (opcional)" maxLength={60} autoComplete="off" inputClassName="sm:w-56" />}
          </form.AppField>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
          <form.AppField
            name="receiptType"
            listeners={{
              // Solo lo que elige la persona: un valor distinto del que propuso el tipo (abrir y cerrar la
              // lista sin elegir no cuenta).
              onChange: ({ value }) => {
                if (value !== lastSuggested.current) receiptTouched.current = true
              },
            }}
          >
            {(field) => (
              <field.SelectField
                label="Comprobante"
                placeholder="Elige el comprobante"
                options={[
                  ...receiptTypes.map((type) => ({ value: type.code, label: type.label })),
                  { value: NO_RECEIPT_TYPE, label: "Sin comprobante" },
                ]}
              />
            )}
          </form.AppField>
          {(values.receiptType && values.receiptType !== NO_RECEIPT_TYPE) ? (
            <form.AppField name="receiptNumber">
              {(field) => (
                <field.TextField
                  label="Número"
                  maxLength={60}
                  autoComplete="off"
                  placeholder={values.receiptType === "01" ? "F001-2345" : values.receiptType === "03" ? "B001-2345" : undefined}
                />
              )}
            </form.AppField>
          ) : null}
        </div>
        {asksSupplier ? (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,10rem)]">
            <form.AppField
              name="supplier"
              listeners={{
                // El RUC del proveedor de la lista, si se tiene y aún no se escribió otro.
                onChange: ({ value }) => {
                  const found = (suppliers.data?.data ?? []).find(
                    (item) => item.name.toLocaleLowerCase(locale) === value.trim().toLocaleLowerCase(locale),
                  )
                  // Solo un documento tributario (RUC), no el DNI de un proveedor persona.
                  if (found?.docNumber && isTaxDocument(found.docType) && !form.getFieldValue("supplierTaxId"))
                    form.setFieldValue("supplierTaxId", found.docNumber)
                },
              }}
            >
              {(field) => (
                <field.Control label="A quién se pagó (opcional)" description="El de tu lista de proveedores, o escríbelo.">
                  {(control) => (
                    <>
                      <Input
                        {...control.props}
                        list={supplierListId}
                        autoComplete="off"
                        maxLength={200}
                        value={field.state.value}
                        onChange={(event) => field.handleChange(event.target.value)}
                      />
                      <datalist id={supplierListId}>
                        {(suppliers.data?.data ?? []).map((item) => (
                          <option key={item.id} value={item.name} />
                        ))}
                      </datalist>
                    </>
                  )}
                </field.Control>
              )}
            </form.AppField>
            {pickedType?.asksTaxId ? (
              <form.AppField name="supplierTaxId">
                {(field) => (
                  <field.TextField
                    label="RUC (opcional)"
                    inputMode="numeric"
                    maxLength={20}
                    autoComplete="off"
                    // Se avisa, no se frena: el contador lo revisa con la factura en la mano.
                    description={
                      country === "PE" && field.state.value.trim() && !rucLooksValid(field.state.value)
                        ? "Ese RUC no cuadra: tiene 11 números y el último lo comprueba. Revísalo con la factura."
                        : undefined
                    }
                  />
                )}
              </form.AppField>
            ) : null}
          </div>
        ) : null}
        <form.AppField name="spentDay">
          {(field) => (
            <field.Control label="Fecha">
              {(control) => (
                <DatePickerButton
                  {...control.props}
                  className="justify-start font-normal sm:w-64"
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
        {!canWrite ? (
          <p className="text-sm font-medium">Tu rol no puede registrar gastos. Pídeselo a quien cobra o a administración.</p>
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
