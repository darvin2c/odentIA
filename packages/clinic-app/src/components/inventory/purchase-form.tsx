/**
 * Nueva compra, o un borrador (tablero 9): «¿Ya la tienes?» elige entre lo que
 * se va a pedir y lo que ya se trajo de la tienda. Proveedor con su buscador y
 * «+ Nuevo proveedor» (queda elegido), una fila por producto en unidades de
 * compra con su precio y su ayuda (último precio, uso al mes, lo que falta),
 * el total y las notas. «Ya la tengo» pide lote y vencimiento por fila y
 * «La pagué ahora» abre «Registrar pago» al guardar.
 */
import { formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  Textarea,
  toast,
} from "@odentia/ui"
import { DatePickerButton, FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import * as React from "react"
import {
  confirmOrder,
  createOrder,
  dayText,
  fetchOrder,
  fetchProduct,
  fetchProducts,
  fetchSuppliers,
  fetchWarehouses,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  type ProductDetail,
  type ProductListItem,
  parseWhole,
  type PurchaseLineBody,
  type PurchaseOrderView,
  stockText,
  supplierDocText,
  supplierShortName,
  unitsText,
  updateOrder,
  clinicDayOf,
} from "../../lib/inventory"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceSelect } from "../ui/choice-select"
import { MoneyInput, Optional, PickCombobox, QuantityInput } from "./fields"
import { type PurchasePreset, useInventory } from "./inventory-scope"

type Mode = "pedir" | "ya_la_tengo"

interface LineDraft {
  productId: string
  /** En unidades de compra. */
  quantity: string
  price: string
  /** Escrito a mano: el último precio ya no lo reemplaza. */
  priceTouched: boolean
  lotOpen: boolean
  lotCode: string
  expiresAt: string
}

const MODE_OPTIONS = [
  { value: "pedir" as const, label: "La voy a pedir" },
  { value: "ya_la_tengo" as const, label: "Ya la tengo" },
]

/** El último precio por la unidad de compra de hoy (la línea vieja pudo traer otro factor). */
function lastPriceFor(detail: ProductDetail | undefined): number | null {
  const last = detail?.lastPurchase
  if (!detail || !last || last.unitCostCents === undefined) return null
  if (last.unitFactor === detail.purchaseFactor) return last.unitCostCents
  return Math.round((last.unitCostCents / last.unitFactor) * detail.purchaseFactor)
}

export function PurchaseFormDrawer({
  preset,
  order,
  onClose,
  onSaved,
}: {
  preset?: PurchasePreset
  /** Un borrador para editar. */
  order?: PurchaseOrderView
  onClose: () => void
  /** La compra guardada; `pay`: abrir «Registrar pago». */
  onSaved: (order: PurchaseOrderView, pay: boolean) => void
}) {
  const scope = useInventory()
  const { branchId, branchName, currency, locale, can, open } = scope
  const queryClient = useQueryClient()
  const ids = React.useId()
  const editing = Boolean(order)
  const money = (cents: number) => (currency ? moneyText(cents, currency, locale) : formatWhole(cents))
  const moneyInput = (cents: number) => (currency ? formatMoneyInput(cents, currency, locale) : "")

  // Se arma una vez al abrir: lo que llega después no pisa lo escrito.
  const [initial] = React.useState(() => {
    const lines: LineDraft[] = order
      ? order.lines.map((line) => ({
          productId: line.productId,
          quantity: formatWhole(line.quantity, locale),
          // Un borrador sin precio se guardó en 0: vuelve vacío para pedirlo antes de confirmar.
          price: line.unitCostCents ? moneyInput(line.unitCostCents) : "",
          priceTouched: Boolean(line.unitCostCents),
          lotOpen: false,
          lotCode: "",
          expiresAt: "",
        }))
      : (preset?.lines ?? []).map((line) => ({
          productId: line.productId,
          quantity: line.quantity > 0 ? formatWhole(line.quantity, locale) : "",
          price: line.unitCostCents !== undefined ? moneyInput(line.unitCostCents) : "",
          priceTouched: line.unitCostCents !== undefined,
          lotOpen: false,
          lotCode: "",
          expiresAt: "",
        }))
    return {
      mode: "pedir" as Mode,
      supplierId: order?.supplierId ?? preset?.supplierId ?? "",
      warehouseId: order?.warehouseId ?? "",
      lines,
      notes: order?.notes ?? "",
      paidNow: false,
    }
  })
  const [values, setValues] = React.useState(initial)
  const [errors, setErrors] = React.useState<{ supplier?: string; lines?: string; line: Record<string, { quantity?: string; price?: string }> }>({ line: {} })
  const [formError, setFormError] = React.useState<string | null>(null)
  const set = <K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) => setValues((current) => ({ ...current, [key]: value }))
  const setLine = (productId: string, patch: Partial<LineDraft>) =>
    setValues((current) => ({ ...current, lines: current.lines.map((line) => (line.productId === productId ? { ...line, ...patch } : line)) }))
  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  const products = useQuery({ queryKey: inventoryKeys.products(branchId, "", ""), queryFn: () => fetchProducts(branchId) })
  const byId = React.useMemo(() => new Map((products.data?.items ?? []).map((item) => [item.id, item])), [products.data])
  const suppliers = useQuery({ queryKey: inventoryKeys.suppliers(), queryFn: () => fetchSuppliers() })
  const warehouses = useQuery({ queryKey: inventoryKeys.warehouses(branchId), queryFn: () => fetchWarehouses(branchId) })
  const sedeWarehouses = (warehouses.data ?? []).filter((item) => item.branchId === branchId)
  const details = useQueries({
    queries: values.lines.map((line) => ({
      queryKey: inventoryKeys.product(line.productId, branchId),
      queryFn: () => fetchProduct(line.productId, branchId),
      staleTime: 30_000,
    })),
  })
  const detailOf = (productId: string): ProductDetail | undefined =>
    details[values.lines.findIndex((line) => line.productId === productId)]?.data

  // El último precio llega puesto, salvo que ya se haya escrito otro.
  const lastPrices = values.lines.map((line) => lastPriceFor(detailOf(line.productId)))
  const lastPricesKey = lastPrices.join("|")
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con la firma de los precios que llegaron.
  React.useEffect(() => {
    setValues((current) => {
      let changed = false
      const lines = current.lines.map((line, index) => {
        const price = lastPrices[index]
        if (line.priceTouched || line.price !== "" || price == null) return line
        changed = true
        return { ...line, price: moneyInput(price) }
      })
      return changed ? { ...current, lines } : current
    })
  }, [lastPricesKey])
  // Lote y vencimiento se abren solos en lo que suele tenerlos (anestesia, resinas).
  const tracksKey = values.lines.map((line) => (detailOf(line.productId)?.lots.some((lot) => lot.expiresAt) ? 1 : 0)).join("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con saber qué productos suelen tener lote.
  React.useEffect(() => {
    setValues((current) => {
      let changed = false
      const lines = current.lines.map((line) => {
        if (line.lotOpen || !detailOf(line.productId)?.lots.some((lot) => lot.expiresAt)) return line
        changed = true
        return { ...line, lotOpen: true }
      })
      return changed ? { ...current, lines } : current
    })
  }, [tracksKey])

  const centsOf = (text: string): number | null => {
    if (!currency || !text.trim()) return null
    try {
      return parseMoney(text, currency, locale)
    } catch {
      return null
    }
  }
  const subtotal = (line: LineDraft) => {
    const quantity = parseWhole(line.quantity)
    const price = centsOf(line.price)
    return quantity !== null && !Number.isNaN(quantity) && price !== null ? quantity * price : null
  }
  const total = values.lines.reduce((sum, line) => sum + (subtotal(line) ?? 0), 0)
  const supplier = (suppliers.data ?? []).find((item) => item.id === values.supplierId)
  const supplierOptions = (suppliers.data ?? [])
    .filter((item) => item.isActive || item.id === values.supplierId)
    .map((item) => ({ id: item.id, label: item.name, detail: supplierDocText(item) ?? undefined }))
  const productOptions = (products.data?.items ?? [])
    .filter((item) => item.isActive)
    .map((item) => ({ id: item.id, label: item.name, detail: `hay ${stockText(item.onHand, item)}` }))

  const addProduct = (productId: string) => {
    setValues((current) => {
      const existing = current.lines.find((line) => line.productId === productId)
      // Una fila por producto: si ya está, se suma a su fila.
      if (existing) {
        const quantity = parseWhole(existing.quantity)
        const next = quantity !== null && !Number.isNaN(quantity) ? quantity + 1 : 1
        return {
          ...current,
          lines: current.lines.map((line) => (line.productId === productId ? { ...line, quantity: formatWhole(next, locale) } : line)),
        }
      }
      return {
        ...current,
        lines: [...current.lines, { productId, quantity: "", price: "", priceTouched: false, lotOpen: false, lotCode: "", expiresAt: "" }],
      }
    })
  }

  const mutation = useMutation({
    mutationFn: async (input: { intent: "borrador" | "pedir" | "ya_la_tengo"; lines: PurchaseLineBody[] }) => {
      const notes = values.notes.trim() || null
      const warehouseId = sedeWarehouses.length > 1 && values.warehouseId ? values.warehouseId : null
      if (order) {
        await updateOrder(order.id, { supplierId: values.supplierId, branchId, warehouseId, notes, lines: input.lines })
        if (input.intent === "pedir") await confirmOrder(order.id)
        return fetchOrder(order.id)
      }
      return createOrder({ supplierId: values.supplierId, branchId, warehouseId, mode: input.intent, notes, lines: input.lines })
    },
    onSuccess: (saved, input) => {
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      toast.success(
        input.intent === "borrador"
          ? `${saved.label} quedó como borrador.`
          : input.intent === "pedir"
            ? `${saved.label} quedó pedida. «Copiar el pedido» deja el texto listo para el proveedor.`
            : `${saved.label} quedó registrada con lo que llegó.`,
      )
      onSaved(saved, input.intent === "ya_la_tengo" && values.paidNow && can.pay)
    },
    onError: (error) => setFormError(inventoryErrorMessage(error, { repeatable: editing })),
  })
  const blocked = !editing && isAmbiguousMutationError(mutation.error)

  /**
   * Enter y el botón principal del pie piden o registran la compra; la acción
   * secundaria del pie («Guardar borrador», o «Guardar cambios» al editar) pasa
   * `asDraft`. Con «Ya la tengo» no hay borrador.
   */
  function submit(event: React.SyntheticEvent, asDraft = false) {
    event.preventDefault()
    if (mutation.isPending || blocked) return
    const intent = asDraft ? "borrador" : values.mode === "ya_la_tengo" && !editing ? "ya_la_tengo" : "pedir"
    const found: typeof errors = { line: {} }
    if (!values.supplierId) found.supplier = "Elige el proveedor."
    if (values.lines.length === 0) found.lines = "Agrega al menos un producto."
    if (!currency) found.lines = "Configura la moneda de la clínica antes de registrar compras."
    const lines: PurchaseLineBody[] = []
    for (const line of values.lines) {
      const product = byId.get(line.productId)
      const unit = product?.purchaseUnit ?? product?.unit ?? "unidad"
      const quantity = parseWhole(line.quantity)
      const lineErrors: { quantity?: string; price?: string } = {}
      if (quantity === null || Number.isNaN(quantity) || quantity < 1) lineErrors.quantity = `Escribe la cantidad de ${unitFor(2, unit)}, desde 1.`
      let price = 0
      if (line.price.trim()) {
        try {
          price = currency ? parseMoney(line.price, currency, locale) : 0
        } catch (error) {
          lineErrors.price = error instanceof Error ? `${error.message}.` : "El precio no es un importe válido."
        }
      } else if (intent !== "borrador") lineErrors.price = "Escribe el precio (puede ser 0)."
      if (lineErrors.quantity || lineErrors.price) {
        found.line[line.productId] = lineErrors
        continue
      }
      const lot = intent === "ya_la_tengo" && (line.lotCode.trim() || line.expiresAt) ? { lotCode: line.lotCode.trim() || null, expiresAt: line.expiresAt || null } : null
      lines.push({
        productId: line.productId,
        quantity: quantity as number,
        unitCostCents: price,
        ...(lot ? { lots: [{ quantity: quantity as number, ...lot }] } : {}),
      })
    }
    setErrors(found)
    if (found.supplier || found.lines || Object.keys(found.line).length > 0) {
      setFormError(null)
      return
    }
    setFormError(null)
    mutation.mutate({ intent, lines })
  }

  const already = values.mode === "ya_la_tengo" && !editing
  const submitLabel = already ? "Guardar compra" : "Confirmar pedido"
  const supplierHelp = (() => {
    if (!supplier?.currency) return null
    if ((supplier.dueCents ?? 0) > 0) return `Le debes ${moneyText(supplier.dueCents ?? 0, supplier.currency)}.`
    if ((supplier.creditCents ?? 0) > 0) return `Tienes ${moneyText(supplier.creditCents ?? 0, supplier.currency)} a favor.`
    return null
  })()

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={editing ? `Editar ${order?.label}` : "Nueva compra"}
      description={branchName}
      error={formError}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitDisabled={blocked}
      submitLabel={submitLabel}
      cancelLabel="Cancelar"
      secondaryAction={
        already
          ? undefined
          : { label: editing ? "Guardar cambios" : "Guardar borrador", onClick: (event) => submit(event, true), disabled: mutation.isPending || blocked }
      }
      onSubmit={submit}
    >
      <FieldGroup>
        {preset?.notice ? <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground">{preset.notice}</p> : null}
        {editing ? null : (
          <FieldSet className="gap-3">
            <FieldLegend variant="label" className="mb-0">
              ¿Ya la tienes?
            </FieldLegend>
            <ChoiceButtons label="¿Ya la tienes?" tone="primary" value={values.mode} options={MODE_OPTIONS} onChange={(next) => set("mode", next)} />
            {already ? (
              <FieldDescription>Queda registrada como llegada, con sus lotes, de una vez.</FieldDescription>
            ) : null}
          </FieldSet>
        )}

        <Field data-invalid={errors.supplier ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-proveedor`}>Proveedor</FieldLabel>
          <PickCombobox
            id={`${ids}-proveedor`}
            label="Proveedor"
            placeholder="Buscar proveedor…"
            options={supplierOptions}
            value={values.supplierId}
            invalid={Boolean(errors.supplier)}
            aria-describedby={`${ids}-proveedor-ayuda`}
            empty={
              <Button type="button" variant="link" className="h-auto p-0" onClick={() => open.supplier(undefined, (saved) => set("supplierId", saved.id))}>
                + Nuevo proveedor
              </Button>
            }
            onPick={(id) => set("supplierId", id)}
          />
          <FieldDescription id={`${ids}-proveedor-ayuda`} className="flex flex-wrap items-center gap-x-1">
            <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-0" onClick={() => open.supplier(undefined, (saved) => set("supplierId", saved.id))}>
              + Nuevo proveedor
            </Button>
            {supplierHelp ? <span>· {supplierHelp}</span> : null}
          </FieldDescription>
          {errors.supplier ? <FieldError>{errors.supplier}</FieldError> : null}
        </Field>

        {sedeWarehouses.length > 1 ? (
          <Field>
            <FieldLabel htmlFor={`${ids}-almacen`}>Llega a</FieldLabel>
            <ChoiceSelect
              id={`${ids}-almacen`}
              value={values.warehouseId || (sedeWarehouses.find((item) => item.isDefault)?.id ?? "")}
              onChange={(event) => set("warehouseId", event.target.value)}
            >
              {sedeWarehouses.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </ChoiceSelect>
            <FieldDescription>Un almacén de {branchName}.</FieldDescription>
          </Field>
        ) : null}

        <FieldSet data-invalid={errors.lines ? true : undefined} className="gap-3">
          <FieldLegend variant="label" className="mb-0">
            Productos
          </FieldLegend>
          <div className="@container flex flex-col gap-3">
            {values.lines.length > 0 ? (
              <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_6rem_2.75rem] gap-2 px-1 text-xs font-medium text-muted-foreground @lg:grid">
                <span>Producto</span>
                <span>Cantidad</span>
                <span>Precio</span>
                <span className="text-right">Subtotal</span>
                <span />
              </div>
            ) : null}
            {values.lines.map((line) => (
              <LineRow
                key={line.productId}
                ids={ids}
                line={line}
                product={byId.get(line.productId)}
                detail={detailOf(line.productId)}
                supplierId={values.supplierId}
                already={already}
                subtotal={subtotal(line)}
                money={money}
                currency={currency}
                errors={errors.line[line.productId]}
                onChange={(patch) => setLine(line.productId, patch)}
                onRemove={() => set("lines", values.lines.filter((item) => item.productId !== line.productId))}
              />
            ))}
            <Field>
              <FieldLabel htmlFor={`${ids}-agregar`} className="sr-only">
                Agregar un producto
              </FieldLabel>
              <PickCombobox
                id={`${ids}-agregar`}
                label="Agregar un producto"
                placeholder="Buscar producto…"
                options={productOptions}
                value=""
                resetOnPick
                empty={products.isPending ? "Cargando productos…" : "Ningún producto con ese nombre"}
                onPick={addProduct}
              />
            </Field>
            {values.lines.length > 0 ? (
              <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                <span>Total</span>
                <span className="tabular-nums">{money(total)}</span>
              </div>
            ) : null}
          </div>
          <FieldDescription>
            {already
              ? "El precio de la factura: es lo que se le debe al proveedor."
              : "El precio es el que te dio el proveedor. Si la factura dice otro, se corrige al registrar lo que llegó."}
          </FieldDescription>
          {errors.lines ? <FieldError>{errors.lines}</FieldError> : null}
        </FieldSet>

        <Field>
          <FieldLabel htmlFor={`${ids}-notas`}>
            Notas <Optional />
          </FieldLabel>
          <Textarea id={`${ids}-notas`} maxLength={2000} value={values.notes} onChange={(event) => set("notes", event.target.value)} />
        </Field>

        {already && can.pay ? (
          <Field orientation="horizontal">
            <Checkbox id={`${ids}-pagada`} checked={values.paidNow} onCheckedChange={(checked) => set("paidNow", checked === true)} />
            <FieldContent>
              <FieldLabel htmlFor={`${ids}-pagada`}>La pagué ahora</FieldLabel>
              <FieldDescription>Al guardar se abre «Registrar pago» con {money(total)} puesto.</FieldDescription>
            </FieldContent>
          </Field>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

function LineRow({
  ids,
  line,
  product,
  detail,
  supplierId,
  already,
  subtotal,
  money,
  currency,
  errors,
  onChange,
  onRemove,
}: {
  ids: string
  line: LineDraft
  product: ProductListItem | undefined
  detail: ProductDetail | undefined
  supplierId: string
  already: boolean
  subtotal: number | null
  money: (cents: number) => string
  currency: string | null
  errors?: { quantity?: string; price?: string }
  onChange: (patch: Partial<LineDraft>) => void
  onRemove: () => void
}) {
  const { locale } = useInventory()
  const name = product?.name ?? detail?.name ?? "Producto"
  const unit = product?.unit ?? detail?.unit ?? "unidad"
  const purchaseUnit = product?.purchaseUnit ?? detail?.purchaseUnit ?? null
  const factor = product?.purchaseFactor ?? detail?.purchaseFactor ?? 1
  const quantity = parseWhole(line.quantity)
  const buyUnit = purchaseUnit && factor > 1 ? purchaseUnit : unit
  const suffix = unitFor(quantity !== null && !Number.isNaN(quantity) ? quantity : 2, buyUnit)
  const key = `${ids}-${line.productId}`
  const hints: string[] = []
  if (purchaseUnit && factor > 1) hints.push(`${purchaseUnit} de ${unitsText(factor, unit)}`)
  const missing = detail?.missing ?? product?.missing ?? 0
  if (missing > 0) hints.push(`${missing === 1 ? "Hace" : "Hacen"} falta ${unitsText(missing, unit)} para el mínimo`)
  const last = detail?.lastPurchase
  if (last?.unitCostCents !== undefined && last.currency) {
    const other = last.supplierId !== supplierId && supplierId ? ` (${supplierShortName(last.supplierName)})` : ""
    hints.push(`Último precio: ${moneyText(lastPriceFor(detail) ?? last.unitCostCents, last.currency)} el ${dayText(clinicDayOf(last.at))}${other}`)
  }
  if (detail && detail.usedLast30Days > 0) {
    const perMonth = detail.usedLast30Days / (factor > 1 ? factor : 1)
    const said = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(perMonth)
    hints.push(`usas cerca de ${said} ${unitFor(perMonth === 1 ? 1 : 2, buyUnit)} al mes`)
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border p-3 @lg:border-0 @lg:p-1">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2 @lg:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_6rem_2.75rem] @lg:items-center">
        <span className="min-w-0 truncate pt-2 text-sm font-medium @lg:pt-0">{name}</span>
        <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 @lg:order-last" aria-label={`Quitar ${name}`} onClick={onRemove}>
          <X aria-hidden />
        </Button>
        <Field data-invalid={errors?.quantity ? true : undefined} className="col-span-2 gap-1 @lg:col-span-1">
          <FieldLabel htmlFor={`${key}-cantidad`} className="@lg:sr-only">
            Cantidad
          </FieldLabel>
          <QuantityInput
            id={`${key}-cantidad`}
            value={line.quantity}
            suffix={suffix}
            invalid={Boolean(errors?.quantity)}
            aria-label={`Cantidad de ${name}`}
            onChange={(next) => onChange({ quantity: next })}
          />
        </Field>
        <Field data-invalid={errors?.price ? true : undefined} className="col-span-2 gap-1 @lg:col-span-1">
          <FieldLabel htmlFor={`${key}-precio`} className="@lg:sr-only">
            Precio
          </FieldLabel>
          {currency ? (
            <MoneyInput
              id={`${key}-precio`}
              currency={currency}
              value={line.price}
              invalid={Boolean(errors?.price)}
              aria-label={`Precio de ${name}, por ${buyUnit}`}
              onChange={(next) => onChange({ price: next, priceTouched: true })}
            />
          ) : (
            <Input id={`${key}-precio`} disabled value="" aria-label={`Precio de ${name}`} />
          )}
        </Field>
        <span className="col-span-2 text-right text-sm tabular-nums @lg:col-span-1">
          <span className="text-muted-foreground @lg:sr-only">Subtotal </span>
          {subtotal !== null ? money(subtotal) : "—"}
        </span>
      </div>
      {errors?.quantity || errors?.price ? (
        <FieldError>{[errors.quantity, errors.price].filter(Boolean).join(" ")}</FieldError>
      ) : null}
      {hints.length > 0 ? <p className="text-xs text-muted-foreground">{hints.join(" · ")}</p> : null}
      {already ? (
        line.lotOpen ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Field className="gap-1">
              <FieldLabel htmlFor={`${key}-lote`}>
                Lote <Optional />
              </FieldLabel>
              <Input id={`${key}-lote`} maxLength={120} value={line.lotCode} onChange={(event) => onChange({ lotCode: event.target.value })} />
            </Field>
            <Field className="gap-1">
              <FieldLabel htmlFor={`${key}-vence`}>Vence</FieldLabel>
              <DatePickerButton id={`${key}-vence`} className="w-full" value={line.expiresAt} emptyLabel="Sin vencimiento" onChange={(next) => onChange({ expiresAt: next })} />
            </Field>
          </div>
        ) : (
          <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0" onClick={() => onChange({ lotOpen: true })}>
            + Lote y vencimiento
          </Button>
        )
      ) : null}
    </div>
  )
}
