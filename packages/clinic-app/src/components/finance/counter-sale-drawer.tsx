/**
 * «Venta de mostrador» (ADR 0170): cobrar productos sin ficha —unos lentes de
 * sol, unas gotas, un cepillo— a una persona, a un nombre escrito o a nadie.
 * Lo que se vende sale de la búsqueda de «Agregar producto» (también con el
 * lector de códigos de barras), con su cantidad; se paga entero, con uno o
 * varios medios y, en efectivo, con lo recibido y el vuelto. El servidor crea
 * los conceptos, el ticket y la caja en una sola transacción; la clave de la
 * venta (`requestId`) es la misma mientras el cajón sigue abierto, así un
 * reintento tras un corte no vende dos veces, y cambia al vender.
 */
import { formatMoney, parseMoney } from "@odentia/clinical"
import { Button } from "@odentia/ui"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@odentia/ui/components/input-group"
import { FormDrawer, LoadingState, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"
import * as React from "react"
import { ApiError } from "../../lib/api"
import { usePermission } from "../../lib/crm"
import {
  CASH_TYPE_CODE,
  type CollectTicketRow,
  COUNTER_SALE_LABEL,
  counterSaleApi,
  fetchSaleProducts,
  type PaymentMethodOption,
  usePaymentMethodsOptions,
} from "../../lib/finance-collect"
import { inventoryKeys } from "../../lib/inventory"
import { parseWholeQuantity, saleStockNote } from "../../lib/materials"
import { ChoiceButtons } from "../choice-buttons"
import { MoneyInput } from "../inventory/fields"
import { itemDetail, ProductSearch, type SaleItem } from "../orders/sale-drawer"
import { PersonPicker, type PickedPerson } from "../person-picker"

/** Medios en una misma venta que se ofrecen a la vista (la API admite hasta 10). */
const MAX_PAYMENTS = 3
const MAX_QUANTITY = 9999
const NO_SALE_PRICE = "Ponle precio de venta en Inventario: sin precio no se puede vender."

/** Para quién: nadie («Venta de mostrador»), una persona que ya está o solo un nombre. */
type BuyerMode = "nadie" | "persona" | "nombre"

interface CounterLine {
  key: string
  product: SaleItem | null
  quantity: string
}

interface CounterPayment {
  key: string
  methodId: string
  /** Con un solo medio no se escribe: paga el total. */
  amount: string
}

interface CounterValues {
  lines: CounterLine[]
  buyerMode: BuyerMode
  person: PickedPerson | null
  buyerName: string
  payments: CounterPayment[]
  cashReceived: string
}

const newLine = (): CounterLine => ({ key: crypto.randomUUID(), product: null, quantity: "1" })

const EMPTY = (): CounterValues => ({
  lines: [newLine()],
  buyerMode: "nadie",
  person: null,
  buyerName: "",
  payments: [],
  cashReceived: "",
})

/** El nombre del dato en el cuerpo de la venta → su campo en pantalla. */
function serverField(field: string): string | undefined {
  if (field === "contactId") return "person"
  if (field === "buyerName") return "buyerName"
  if (field === "cashReceivedCents") return "cashReceived"
  if (field === "payments") return "payments"
  const payment = /^(payments\[\d+\])\.(paymentMethodId|amountCents|reference)$/.exec(field)
  if (payment) return payment[2] === "paymentMethodId" ? `${payment[1]}.methodId` : "payments"
  const line = /^(lines\[\d+\])\.(productId|quantity)$/.exec(field)
  if (line) return line[2] === "productId" ? `${line[1]}.product` : `${line[1]}.quantity`
  if (field === "lines" || /^lines\[\d+\]$/.test(field)) return "lines"
  return undefined
}

export function CounterSaleDrawer({
  open,
  branchId,
  branchName,
  currency,
  locale,
  onClose,
  onSold,
}: {
  open: boolean
  /** La sede de Finanzas: de su almacén sale lo vendido y a su caja entra el dinero. */
  branchId: string
  branchName: string
  /** La moneda de la clínica: la venta cobra en ella. */
  currency: string
  locale: string
  onClose: () => void
  /** Vendido: el ticket, para abrirlo al lado; `already`, si ya estaba registrada (un reintento). */
  onSold: (ticket: CollectTicketRow, already: boolean) => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  // La misma clave mientras sea la misma venta: si no llegó la respuesta, cobrar otra vez
  // devuelve el ticket que ya se registró. Al vender, o si el servidor dice que con esta
  // clave se cobró otra cosa, otra: es otra venta.
  const [requestId, setRequestId] = React.useState(() => crypto.randomUUID())
  // Caja solo ve a los pacientes: elige entre ellos o escribe el nombre.
  const seesEveryone = usePermission("crm.read")
  const money = (cents: number) => formatMoney(cents, currency, locale)
  const centsOf = (raw: string): number | null => {
    if (!raw.trim()) return null
    try {
      return parseMoney(raw, currency, locale)
    } catch {
      return null
    }
  }
  const quantityOf = (raw: string): number | null => {
    const value = parseWholeQuantity(raw, locale)
    return value !== null && value >= 1 && value <= MAX_QUANTITY ? value : null
  }
  // Una sola vez: la fila vacía lleva una clave al azar, y otros valores en cada pintado
  // harían que el formulario volviera a empezar sin fin.
  const [initial] = React.useState(EMPTY)
  const methods = usePaymentMethodsOptions()
  const methodList = methods.data?.data ?? []
  const methodOf = (id: string): PaymentMethodOption | undefined => methodList.find((item) => item.id === id)
  const lineCents = (line: CounterLine): number | null =>
    line.product?.salePriceCents != null && quantityOf(line.quantity) !== null
      ? line.product.salePriceCents * (quantityOf(line.quantity) as number)
      : null
  const totalOf = (all: CounterLine[]) => all.reduce((sum, line) => sum + (lineCents(line) ?? 0), 0)
  /** Lo que paga cada medio: con uno solo, el total. */
  const paidOf = (all: CounterPayment[], total: number) =>
    all.map((row) => (all.length === 1 ? total : (centsOf(row.amount) ?? 0)))
  const cashPartOf = (all: CounterPayment[], total: number) => {
    const paid = paidOf(all, total)
    return all.reduce((sum, row, index) => sum + (methodOf(row.methodId)?.typeCode === CASH_TYPE_CODE ? (paid[index] ?? 0) : 0), 0)
  }

  const form = useAppForm({
    defaultValues: initial,
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        const chosen = value.lines.filter((line) => line.product)
        if (chosen.length === 0) fields.lines = "Busca o escanea lo que se vende."
        value.lines.forEach((line, index) => {
          const at = `lines[${index}]`
          if (!line.product) {
            // Una fila vacía al final no estorba: se deja fuera.
            if (chosen.length > 0 && index < value.lines.length - 1) fields[`${at}.product`] = "Busca y elige el producto, o quita la fila."
            return
          }
          if (line.product.salePriceCents === null) fields[`${at}.product`] = NO_SALE_PRICE
          else if (line.product.currency && line.product.currency !== currency)
            fields[`${at}.product`] = `Su precio está en ${line.product.currency}: aquí se vende en ${currency}.`
          if (quantityOf(line.quantity) === null) fields[`${at}.quantity`] = `La cantidad va de 1 a ${MAX_QUANTITY}, sin decimales.`
        })
        if (value.buyerMode === "persona" && !value.person) fields.person = "Busca y elige a la persona, o elige «Sin nombre»."
        if (value.buyerMode === "nombre" && !value.buyerName.trim()) fields.buyerName = "Escribe su nombre, o elige «Sin nombre»."
        const total = totalOf(value.lines)
        if (value.payments.length === 0) fields.payments = "Elige con qué paga."
        const seen = new Set<string>()
        value.payments.forEach((row, index) => {
          const at = `payments[${index}]`
          if (!row.methodId) fields[`${at}.methodId`] = "Elige el medio."
          else if (seen.has(row.methodId)) fields[`${at}.methodId`] = "Ese medio ya está arriba: súmalo en su importe."
          seen.add(row.methodId)
          if (value.payments.length > 1) {
            const cents = centsOf(row.amount)
            if (cents === null || cents <= 0) fields[`${at}.amount`] = "Escribe cuánto paga con este medio."
          }
        })
        const paid = paidOf(value.payments, total).reduce((sum, cents) => sum + cents, 0)
        if (value.payments.length > 1 && !fields.payments && paid !== total && total > 0)
          fields.payments =
            paid < total
              ? `Entre los medios faltan ${money(total - paid)}: se paga entera.`
              : `Entre los medios pasan del total por ${money(paid - total)}.`
        const cashPart = cashPartOf(value.payments, total)
        const received = centsOf(value.cashReceived)
        if (value.cashReceived.trim() && cashPart > 0 && (received === null || received < cashPart))
          fields.cashReceived = "Lo que recibes en efectivo no cubre la parte en efectivo."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const total = totalOf(value.lines)
      const paid = paidOf(value.payments, total)
      const cashPart = cashPartOf(value.payments, total)
      const received = cashPart > 0 ? centsOf(value.cashReceived) : null
      const lines = value.lines.flatMap((line) =>
        line.product ? [{ productId: line.product.productId, quantity: quantityOf(line.quantity) as number }] : [],
      )
      let data: Awaited<ReturnType<typeof counterSaleApi>>["data"]
      try {
        ;({ data } = await counterSaleApi({
          branchId,
          requestId,
          lines,
          ...(value.buyerMode === "persona" && value.person ? { contactId: value.person.id } : {}),
          ...(value.buyerMode === "nombre" && value.buyerName.trim() ? { buyerName: value.buyerName.trim() } : {}),
          payments: value.payments.map((row, index) => ({ paymentMethodId: row.methodId, amountCents: paid[index] ?? 0 })),
          ...(received !== null ? { cashReceivedCents: received } : {}),
        }))
      } catch (error) {
        const code = error instanceof ApiError ? error.shape.code : undefined
        // Con esta clave ya se cobró otra cosa: el mensaje dice cuál, y cobrar de nuevo es otra venta.
        if (code === "REQUEST_ID_CONFLICT") setRequestId(crypto.randomUUID())
        if (code === "COUNTER_SALE_SHORT" || code === "COUNTER_SALE_OVER") {
          const changed = await refreshPrices().catch(() => [])
          if (changed.length > 0)
            throw new ApiError(409, {
              code: "COUNTER_SALE_PRICE_CHANGED",
              message: `Cambió el precio de ${changed.join(", ")}: revisa el total y vuelve a cobrar.`,
            })
        }
        throw error
      }
      // Lo vendido salió de la sede: la búsqueda y el inventario dicen lo que queda.
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      void queryClient.invalidateQueries({ queryKey: ["sale-products"] })
      form.reset()
      setRequestId(crypto.randomUUID())
      onSold(data.ticket, data.duplicate)
    },
  })
  const surface = useFormSurface(form, { fieldMap: serverField })

  /**
   * Si el precio de un producto cambió mientras se vendía, el total de la pantalla
   * ya no es el del servidor: se traen los de ahora a cada fila y se dice cuáles.
   */
  async function refreshPrices(): Promise<string[]> {
    const current = form.getFieldValue("lines")
    const changed: string[] = []
    await Promise.all(
      current.map(async (line, index) => {
        const chosen = line.product
        if (!chosen) return
        const list = await fetchSaleProducts({ branchId, q: chosen.barcode ?? chosen.name, limit: 20 })
        const fresh = list.data.items.find((item) => item.productId === chosen.productId)
        if (!fresh || (fresh.salePriceCents === chosen.salePriceCents && fresh.currency === chosen.currency)) return
        form.setFieldValue(`lines[${index}].product`, { ...chosen, salePriceCents: fresh.salePriceCents, currency: fresh.currency })
        changed.push(chosen.name)
      }),
    )
    return changed
  }

  const lines = useStore(form.store, (state) => state.values.lines)
  const buyerMode = useStore(form.store, (state) => state.values.buyerMode)
  const person = useStore(form.store, (state) => state.values.person)
  const payments = useStore(form.store, (state) => state.values.payments)
  const receivedText = useStore(form.store, (state) => state.values.cashReceived)
  const total = totalOf(lines)
  const cashPart = cashPartOf(payments, total)
  const hasCash = payments.some((row) => methodOf(row.methodId)?.typeCode === CASH_TYPE_CODE)
  const received = hasCash ? centsOf(receivedText) : null
  const change = received !== null ? received - cashPart : null
  const methodOptions = methodList.map((item) => ({ value: item.id, label: item.name }))
  const paidNow = paidOf(payments, total).reduce((sum, cents) => sum + cents, 0)

  // Al campo, o a la primera opción de un grupo de botones.
  const focusLater = (id: string) =>
    requestAnimationFrame(() => {
      const found = document.getElementById(id)
      ;(found?.matches("input, button") ? found : found?.querySelector<HTMLElement>("input, button"))?.focus()
    })
  const addLine = () => {
    const line = newLine()
    form.pushFieldValue("lines", line)
    // El foco va a la fila nueva: con el teclado (o el lector) no hay que buscarla.
    focusLater(`mostrador-producto-${line.key}`)
  }
  /** Lo mismo otra vez (el lector pasó dos veces): suma uno a su fila, no repite el producto. */
  const pickProduct = (index: number, next: SaleItem | null) => {
    const current = form.getFieldValue("lines")
    const twin = next ? current.findIndex((line, at) => at !== index && line.product?.productId === next.productId) : -1
    if (twin >= 0) {
      const quantity = quantityOf(current[twin]?.quantity ?? "1") ?? 1
      form.setFieldValue(`lines[${twin}].quantity`, String(Math.min(MAX_QUANTITY, quantity + 1)))
      form.setFieldValue(`lines[${index}].product`, null)
      return
    }
    form.setFieldValue(`lines[${index}].product`, next)
    // Con el lector, la fila siguiente queda lista para el próximo código.
    if (next && index === current.length - 1) addLine()
  }
  const addPayment = (methodId = "") => {
    const key = crypto.randomUUID()
    form.pushFieldValue("payments", { key, methodId, amount: "" })
    focusLater(methodId ? `mostrador-importe-${key}` : `mostrador-medio-${key}`)
  }

  return (
    <FormDrawer
      {...surface}
      open={open}
      onClose={onClose}
      title="Venta de mostrador"
      description={`Productos sin ficha. Sale de ${branchName || "la sede"} y entra en su caja.`}
      isLoading={methods.isPending}
      submitLabel={total > 0 ? `Cobrar ${money(total)}` : "Cobrar"}
    >
      <div className="flex flex-col gap-5">
        <form.AppField name="lines" mode="array">
          {(linesField) => (
            <linesField.Group legend="Lo que se vende" className="gap-3">
              {() => (
                <div className="flex flex-col gap-3">
                  <ul className="flex flex-col gap-3">
                    {linesField.state.value.map((line, index) => {
                      const which = <span className="sr-only">, fila {index + 1}</span>
                      const cents = lineCents(line)
                      const quantity = quantityOf(line.quantity)
                      const stock = line.product && line.product.salePriceCents !== null
                        ? saleStockNote(line.product, quantity ?? 1, branchName || "esta sede")
                        : null
                      return (
                        <li key={line.key} className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
                          <form.AppField name={`lines[${index}].product`}>
                            {(field) => (
                              <field.Control
                                label={<>Producto{which}</>}
                                id={`mostrador-producto-${line.key}`}
                                description={
                                  stock ? (
                                    <span role="status" className="font-medium text-warning">
                                      {stock}
                                    </span>
                                  ) : field.state.value ? (
                                    itemDetail(field.state.value, money, branchName)
                                  ) : (
                                    "Escribe su nombre, marca o modelo, o pasa el lector por el código de barras."
                                  )
                                }
                              >
                                {(control) => (
                                  <ProductSearch
                                    id={control.id}
                                    invalid={control.invalid}
                                    describedBy={control.describedBy}
                                    onBlur={control.onBlur}
                                    branchId={branchId}
                                    branchName={branchName}
                                    money={money}
                                    value={field.state.value}
                                    onChange={(next) => {
                                      pickProduct(index, next)
                                      field.handleBlur()
                                    }}
                                  />
                                )}
                              </field.Control>
                            )}
                          </form.AppField>
                          <div className="flex flex-wrap items-end gap-3">
                            <form.AppField name={`lines[${index}].quantity`}>
                              {(field) => (
                                <field.Control label={<>Cantidad{which}</>} id={`mostrador-cantidad-${line.key}`} className="w-32">
                                  {(control) => (
                                    <InputGroup className="h-11 sm:h-9">
                                      <InputGroupInput
                                        {...control.props}
                                        inputMode="numeric"
                                        autoComplete="off"
                                        className="tabular-nums"
                                        value={field.state.value}
                                        onChange={(event: React.ChangeEvent<HTMLInputElement>) => field.handleChange(event.target.value)}
                                      />
                                      {line.product ? <InputGroupAddon align="inline-end">{line.product.unit}</InputGroupAddon> : null}
                                    </InputGroup>
                                  )}
                                </field.Control>
                              )}
                            </form.AppField>
                            <p className="flex min-h-11 flex-1 items-center text-base font-semibold tabular-nums sm:min-h-9">
                              {cents !== null ? money(cents) : "—"}
                            </p>
                            {linesField.state.value.length > 1 ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="min-h-11 sm:min-h-8"
                                aria-label={`Quitar ${line.product?.name ?? `la fila ${index + 1}`}`}
                                onClick={() => linesField.removeValue(index)}
                              >
                                <X aria-hidden />
                                Quitar
                              </Button>
                            ) : null}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                  <Button type="button" variant="outline" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={addLine}>
                    <Plus aria-hidden />
                    Agregar producto
                  </Button>
                  <p className="text-base font-semibold tabular-nums" aria-live="polite">
                    Total {money(total)}
                  </p>
                </div>
              )}
            </linesField.Group>
          )}
        </form.AppField>

        <form.AppField name="buyerMode">
          {(field) => (
            <field.Group legend="Para quién (opcional)" className="gap-3">
              {(control) => (
                <div className="flex flex-col gap-3">
                  <ChoiceButtons
                    id={control.id}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    value={field.state.value}
                    options={[
                      { value: "nadie", label: "Sin nombre" },
                      { value: "persona", label: "Buscar a la persona" },
                      { value: "nombre", label: "Solo su nombre" },
                    ]}
                    onChange={(next) => field.handleChange(next)}
                  />
                  {field.state.value === "nadie" ? (
                    <p className="text-sm text-muted-foreground">El ticket dirá «{COUNTER_SALE_LABEL}».</p>
                  ) : null}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        {buyerMode === "persona" ? (
          <form.AppField name="person">
            {(field) => (
              <field.Control
                label="Persona"
                id="mostrador-persona"
                description={
                  person?.patientId
                    ? "Es paciente: esta venta no entra en su cuenta ni en su historia. Si debe ir a su cuenta, cóbrala con «Cobrar»."
                    : seesEveryone
                      ? "Cualquier persona que ya está, sea o no paciente."
                      : "Uno de los pacientes. Si no es paciente, elige «Solo su nombre»."
                }
              >
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="Personas"
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(next) => {
                      field.handleChange(next)
                      field.handleBlur()
                    }}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : buyerMode === "nombre" ? (
          <form.AppField name="buyerName">
            {(field) => (
              <field.TextField label="Nombre" description="Va en el ticket; no crea a la persona." autoComplete="off" maxLength={200} />
            )}
          </form.AppField>
        ) : null}

        {methods.isError ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            No pudimos cargar los medios de pago.
            <Button type="button" size="sm" variant="outline" onClick={() => void methods.refetch()}>
              Reintentar
            </Button>
          </p>
        ) : methods.isPending ? (
          <LoadingState message="Cargando los medios de pago…" />
        ) : null}
        <form.AppField name="payments" mode="array">
          {(paymentsField) => (
            <paymentsField.Group legend="Cómo paga" className="gap-3">
              {(control) => (
                <div className="flex flex-col gap-3">
                  {/* El primer medio: con uno solo, paga el total. */}
                  <ChoiceButtons
                    id={control.id}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    tone="primary"
                    value={payments[0]?.methodId || null}
                    options={methodOptions}
                    onChange={(next) => {
                      if (payments.length === 0) addPayment(next)
                      else form.setFieldValue("payments[0].methodId", next)
                    }}
                  />
                  {paymentsField.state.value.length > 1 ? (
                    <ul className="flex flex-col gap-3">
                      {paymentsField.state.value.map((row, index) => {
                        const which = <span className="sr-only">, medio {index + 1}</span>
                        return (
                          <li key={row.key} className={index > 0 ? "flex flex-col gap-3 rounded-xl border bg-muted/40 p-3" : "flex flex-col gap-3"}>
                            {index > 0 ? (
                              <form.AppField name={`payments[${index}].methodId`}>
                                {(field) => (
                                  <field.Group legend={`Medio ${index + 1}`} className="gap-2">
                                    {(rowControl) => (
                                      <div className="flex items-start justify-between gap-2">
                                        <ChoiceButtons
                                          id={`mostrador-medio-${row.key}`}
                                          invalid={rowControl.invalid}
                                          aria-describedby={rowControl.describedBy}
                                          onBlur={rowControl.onBlur}
                                          tone="primary"
                                          value={field.state.value || null}
                                          options={methodOptions}
                                          onChange={(next) => field.handleChange(next)}
                                        />
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="sm"
                                          aria-label={`Quitar el medio ${index + 1}`}
                                          onClick={() => paymentsField.removeValue(index)}
                                        >
                                          <X aria-hidden />
                                          Quitar
                                        </Button>
                                      </div>
                                    )}
                                  </field.Group>
                                )}
                              </form.AppField>
                            ) : null}
                            <form.AppField name={`payments[${index}].amount`}>
                              {(field) => (
                                <field.Control
                                  label={<>Importe{which}</>}
                                  id={`mostrador-importe-${row.key}`}
                                  className="sm:max-w-56"
                                >
                                  {(amountControl) => (
                                    <MoneyInput
                                      id={amountControl.id}
                                      currency={currency}
                                      invalid={amountControl.invalid}
                                      aria-describedby={amountControl.describedBy}
                                      value={field.state.value}
                                      onChange={(next) => field.handleChange(next)}
                                    />
                                  )}
                                </field.Control>
                              )}
                            </form.AppField>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                  {payments.length > 0 && payments.length < Math.min(MAX_PAYMENTS, methodList.length) ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-h-11 self-start sm:min-h-8"
                      onClick={() => addPayment()}
                    >
                      <Plus aria-hidden />
                      Pagar con otro medio
                    </Button>
                  ) : null}
                  {payments.length > 1 && total > 0 ? (
                    <p className="text-sm tabular-nums" aria-live="polite">
                      {paidNow === total
                        ? `Entre los medios: ${money(paidNow)}, el total.`
                        : paidNow < total
                          ? `Entre los medios: ${money(paidNow)}. Faltan ${money(total - paidNow)}.`
                          : `Entre los medios: ${money(paidNow)}. Pasan del total por ${money(paidNow - total)}.`}
                    </p>
                  ) : null}
                </div>
              )}
            </paymentsField.Group>
          )}
        </form.AppField>
        {hasCash ? (
          <div className="grid grid-cols-2 items-start gap-3">
            <form.AppField name="cashReceived">
              {(field) => (
                <field.Control label="Recibes en efectivo" id="mostrador-recibes">
                  {(control) => (
                    <MoneyInput
                      id={control.id}
                      currency={currency}
                      invalid={control.invalid || (change !== null && change < 0)}
                      aria-describedby={control.describedBy}
                      value={field.state.value}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
            <div className="flex min-h-9 flex-col justify-center" aria-live="polite">
              <span className="text-sm text-muted-foreground">{change !== null && change < 0 ? "Falta" : "Vuelto"}</span>
              <span className="text-base font-semibold tabular-nums">{change === null ? "—" : money(Math.abs(change))}</span>
            </div>
          </div>
        ) : null}
      </div>
    </FormDrawer>
  )
}
