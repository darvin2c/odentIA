/**
 * Nueva compra, o un borrador (tablero 9): «¿Ya la tienes?» elige entre lo que
 * se va a pedir y lo que ya se trajo de la tienda. Proveedor con su buscador y
 * «+ Nuevo proveedor» (queda elegido), una fila por producto en unidades de
 * compra con su precio y su ayuda (último precio, uso al mes, lo que falta),
 * el total y las notas. «Ya la tengo» pide lote y vencimiento por fila y
 * «La pagué ahora» abre «Registrar pago» al guardar. Cada error va en su
 * campo, también el de una fila que rechaza el servidor (`lines[i].quantity`).
 */
import { formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import { Button, FieldError, FieldGroup, Input, toast } from "@odentia/ui"
import {
  DatePickerButton,
  FormDrawer,
  fieldErrorMessages,
  type SubmitOptions,
  setSubmitErrors,
  submitForm,
  useAppForm,
  useFormSurface,
  withForm,
} from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  clinicDayOf,
  confirmOrder,
  createOrder,
  dayText,
  fetchOrder,
  fetchProduct,
  fetchProducts,
  fetchSuppliers,
  fetchWarehouses,
  formatWhole,
  inventoryKeys,
  inventoryUnconfirmedMessage,
  moneyText,
  type ProductDetail,
  type ProductListItem,
  type PurchaseLineBody,
  type PurchaseOrderView,
  parseWhole,
  stockText,
  supplierDocText,
  supplierShortName,
  unitsText,
  updateOrder,
} from "../../lib/inventory"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { ChoiceButtons } from "../choice-buttons"
import { ChoiceSelect } from "../ui/choice-select"
import { MoneyInput, Optional, PickCombobox, QuantityInput } from "./fields"
import { type PurchasePreset, useInventory } from "./inventory-scope"

type Mode = "pedir" | "ya_la_tengo"
type Intent = "borrador" | "pedir" | "ya_la_tengo"

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

interface PurchaseValues {
  mode: Mode
  supplierId: string
  warehouseId: string
  lines: LineDraft[]
  notes: string
  paidNow: boolean
}

const MODE_OPTIONS = [
  { value: "pedir" as const, label: "La voy a pedir" },
  { value: "ya_la_tengo" as const, label: "Ya la tengo" },
]

/** Los mismos topes que la ruta y el servicio (`quantity`, `cents`). */
const MAX_QUANTITY = 1_000_000_000
const MAX_CENTS = 2_147_483_647

/** El último precio por la unidad de compra de hoy (la línea vieja pudo traer otro factor). */
function lastPriceFor(detail: ProductDetail | undefined): number | null {
  const last = detail?.lastPurchase
  if (!detail || !last || last.unitCostCents === undefined) return null
  if (last.unitFactor === detail.purchaseFactor) return last.unitCostCents
  return Math.round((last.unitCostCents / last.unitFactor) * detail.purchaseFactor)
}

/** El precio escrito en la unidad menor de la moneda, o el motivo por el que no se entiende. */
function readPrice(text: string, currency: string, locale: string): { cents: number } | { error: string } {
  try {
    return { cents: parseMoney(text, currency, locale) }
  } catch (error) {
    return { error: error instanceof Error ? `${error.message}.` : "El precio no es un importe válido." }
  }
}

/**
 * El dato de una fila como lo nombra el servidor (`lines[2].unitCostCents`,
 * `lines[2].lots[0].lotCode` al registrar lo que ya llegó) → su campo.
 */
function lineField(serverField: string): string | undefined {
  const lots = /^lines\[(\d+)\]\.lots$/.exec(serverField)
  if (lots) return `lines[${lots[1]}].quantity`
  const part = /^lines\[(\d+)\]\.(?:lots\[\d+\]\.)?(\w+)$/.exec(serverField)
  if (!part) return undefined
  return `lines[${part[1]}].${part[2] === "unitCostCents" ? "price" : part[2]}`
}

export function PurchaseFormDrawer({
  preset,
  order,
  missingPrices = false,
  onClose,
  onSaved,
}: {
  preset?: PurchasePreset
  /** Un borrador para editar. */
  order?: PurchaseOrderView
  /** Se abrió para confirmar el borrador y le falta el precio a alguna fila: esas filas llegan marcadas. */
  missingPrices?: boolean
  onClose: () => void
  /** La compra guardada; `pay`: abrir «Registrar pago». */
  onSaved: (order: PurchaseOrderView, pay: boolean) => void
}) {
  const scope = useInventory()
  const { branchId, branchName, currency, locale, can, open } = scope
  const queryClient = useQueryClient()
  const editing = Boolean(order)
  const money = (cents: number) => (currency ? moneyText(cents, currency, locale) : formatWhole(cents))
  const moneyInput = (cents: number) => (currency ? formatMoneyInput(cents, currency, locale) : "")

  // Se arma una vez al abrir: lo que llega después no pisa lo escrito.
  const [initial] = React.useState<PurchaseValues>(() => {
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
      mode: "pedir",
      supplierId: order?.supplierId ?? preset?.supplierId ?? "",
      warehouseId: order?.warehouseId ?? "",
      lines,
      notes: order?.notes ?? "",
      paidNow: false,
    }
  })

  const products = useQuery({ queryKey: inventoryKeys.products(branchId, "", ""), queryFn: () => fetchProducts(branchId) })
  const byId = React.useMemo(() => new Map((products.data?.items ?? []).map((item) => [item.id, item])), [products.data])
  const suppliers = useQuery({ queryKey: inventoryKeys.suppliers(), queryFn: () => fetchSuppliers() })
  const warehouses = useQuery({ queryKey: inventoryKeys.warehouses(branchId), queryFn: () => fetchWarehouses(branchId) })
  const sedeWarehouses = (warehouses.data ?? []).filter((item) => item.branchId === branchId)

  // El botón que envió: «Guardar borrador» no pide precio; pedir o registrar, sí.
  const intent = React.useRef<Intent>("pedir")

  const schema = React.useMemo(
    () =>
      z.custom<PurchaseValues>().superRefine((value, ctx) => {
        if (!value.supplierId) ctx.addIssue({ code: "custom", path: ["supplierId"], message: "Elige el proveedor." })
        if (value.lines.length === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "Agrega al menos un producto." })
        if (!currency) ctx.addIssue({ code: "custom", path: ["lines"], message: "Configura la moneda de la clínica antes de registrar compras." })
        if (value.notes.trim().length > 2000) ctx.addIssue({ code: "custom", path: ["notes"], message: "Las notas admiten hasta 2000 caracteres." })
        value.lines.forEach((line, index) => {
          const product = byId.get(line.productId)
          const unit = product?.purchaseUnit && product.purchaseFactor > 1 ? product.purchaseUnit : (product?.unit ?? "unidad")
          const quantity = parseWhole(line.quantity)
          if (quantity === null || Number.isNaN(quantity) || quantity < 1 || quantity > MAX_QUANTITY)
            ctx.addIssue({
              code: "custom",
              path: ["lines", index, "quantity"],
              message: `Escribe la cantidad de ${unitFor(2, unit)}, de 1 a ${formatWhole(MAX_QUANTITY, locale)}.`,
            })
          if (currency && line.price.trim()) {
            const price = readPrice(line.price, currency, locale)
            if ("error" in price) ctx.addIssue({ code: "custom", path: ["lines", index, "price"], message: price.error })
            else if (price.cents > MAX_CENTS) ctx.addIssue({ code: "custom", path: ["lines", index, "price"], message: "El precio es demasiado alto." })
          } else if (currency && intent.current !== "borrador")
            ctx.addIssue({ code: "custom", path: ["lines", index, "price"], message: "Escribe el precio (puede ser 0)." })
          if (line.lotCode.trim().length > 120)
            ctx.addIssue({ code: "custom", path: ["lines", index, "lotCode"], message: "El lote admite hasta 120 caracteres." })
        })
      }),
    [byId, currency, locale],
  )

  const mutation = useMutation({
    mutationFn: async (input: { intent: Intent; supplierId: string; warehouseId: string | null; notes: string | null; lines: PurchaseLineBody[] }) => {
      if (order) {
        await updateOrder(order.id, { supplierId: input.supplierId, branchId, warehouseId: input.warehouseId, notes: input.notes, lines: input.lines })
        if (input.intent === "pedir") await confirmOrder(order.id)
        return fetchOrder(order.id)
      }
      return createOrder({ supplierId: input.supplierId, branchId, warehouseId: input.warehouseId, mode: input.intent, notes: input.notes, lines: input.lines })
    },
  })
  // Crear sin respuesta del servidor puede haber guardado: no se repite a ciegas.
  const blocked = !editing && isAmbiguousMutationError(mutation.error)

  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const sent = intent.current === "borrador" ? "borrador" : value.mode === "ya_la_tengo" && !editing ? "ya_la_tengo" : "pedir"
      // En el mismo orden que las filas: `lines[i]` del servidor es la fila i.
      const lines: PurchaseLineBody[] = value.lines.map((line) => {
        const quantity = parseWhole(line.quantity) as number
        const price = currency && line.price.trim() ? readPrice(line.price, currency, locale) : null
        const lot = sent === "ya_la_tengo" && (line.lotCode.trim() || line.expiresAt) ? { lotCode: line.lotCode.trim() || null, expiresAt: line.expiresAt || null } : null
        return {
          productId: line.productId,
          quantity,
          unitCostCents: price && "cents" in price ? price.cents : 0,
          ...(lot ? { lots: [{ quantity, ...lot }] } : {}),
        }
      })
      const saved = await mutation.mutateAsync({
        intent: sent,
        supplierId: value.supplierId,
        warehouseId: sedeWarehouses.length > 1 && value.warehouseId ? value.warehouseId : null,
        notes: value.notes.trim() || null,
        lines,
      })
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      toast.success(
        sent === "borrador"
          ? `${saved.label} quedó como borrador.`
          : sent === "pedir"
            ? `${saved.label} quedó pedida. «Copiar el pedido» deja el texto listo para el proveedor.`
            : `${saved.label} quedó registrada con lo que llegó.`,
      )
      onSaved(saved, sent === "ya_la_tengo" && value.paidNow && can.pay)
    },
  })
  const submitOptions: SubmitOptions = {
    fieldMap: lineField,
    formMessage: (error) => inventoryUnconfirmedMessage(error, { repeatable: editing }),
  }
  const surface = useFormSurface(form, submitOptions)

  // Al abrir para confirmar, cada fila sin precio ya dice que falta: no hace falta pulsar para enterarse.
  // Se va sola al escribirlo o cuando llega el último precio.
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al abrir.
  React.useEffect(() => {
    if (!missingPrices) return
    const fields: Record<string, string> = {}
    form.state.values.lines.forEach((line, index) => {
      if (!line.price.trim()) fields[`lines[${index}].price`] = "Escribe el precio para confirmar el pedido (puede ser 0)."
    })
    setSubmitErrors(form, { fields })
  }, [])

  const values = useStore(form.store, (state) => state.values)
  const details = useQueries({
    queries: values.lines.map((line) => ({
      queryKey: inventoryKeys.product(line.productId, branchId),
      queryFn: () => fetchProduct(line.productId, branchId),
      staleTime: 30_000,
    })),
  })
  const detailOf = (productId: string): ProductDetail | undefined =>
    details[values.lines.findIndex((line) => line.productId === productId)]?.data

  // El último precio llega puesto, salvo que ya se haya escrito otro. No cuenta como cambio de quien compra.
  const lastPrices = values.lines.map((line) => lastPriceFor(detailOf(line.productId)))
  const lastPricesKey = lastPrices.join("|")
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con la firma de los precios que llegaron.
  React.useEffect(() => {
    form.state.values.lines.forEach((line, index) => {
      const price = lastPrices[index]
      if (line.priceTouched || line.price !== "" || price == null) return
      form.setFieldValue(`lines[${index}].price`, moneyInput(price), { dontUpdateMeta: true })
    })
  }, [lastPricesKey])
  // Lote y vencimiento se abren solos en lo que suele tenerlos (anestesia, resinas).
  const tracksKey = values.lines.map((line) => (detailOf(line.productId)?.lots.some((lot) => lot.expiresAt) ? 1 : 0)).join("")
  // biome-ignore lint/correctness/useExhaustiveDependencies: basta con saber qué productos suelen tener lote.
  React.useEffect(() => {
    form.state.values.lines.forEach((line, index) => {
      if (line.lotOpen || !detailOf(line.productId)?.lots.some((lot) => lot.expiresAt)) return
      form.setFieldValue(`lines[${index}].lotOpen`, true, { dontUpdateMeta: true })
    })
  }, [tracksKey])

  const centsOf = (text: string): number | null => {
    if (!currency || !text.trim()) return null
    const price = readPrice(text, currency, locale)
    return "cents" in price ? price.cents : null
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
    const current = form.getFieldValue("lines")
    const at = current.findIndex((line) => line.productId === productId)
    // Una fila por producto: si ya está, se suma a su fila.
    if (at >= 0) {
      const quantity = parseWhole(current[at]?.quantity ?? "")
      const next = quantity !== null && !Number.isNaN(quantity) ? quantity + 1 : 1
      form.setFieldValue(`lines[${at}].quantity`, formatWhole(next, locale))
      return
    }
    form.pushFieldValue("lines", { productId, quantity: "", price: "", priceTouched: false, lotOpen: false, lotCode: "", expiresAt: "" })
  }

  const already = values.mode === "ya_la_tengo" && !editing
  const submitLabel = already ? "Guardar compra" : "Confirmar pedido"
  const supplierHelp = (() => {
    if (!supplier?.currency) return null
    if ((supplier.dueCents ?? 0) > 0) return `Le debes ${moneyText(supplier.dueCents ?? 0, supplier.currency)}.`
    if ((supplier.creditCents ?? 0) > 0) return `Tienes ${moneyText(supplier.creditCents ?? 0, supplier.currency)} a favor.`
    return null
  })()
  const chooseSupplier = () => open.supplier(undefined, (saved) => form.setFieldValue("supplierId", saved.id))

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={editing ? `Editar ${order?.label}` : "Nueva compra"}
      description={branchName}
      submitDisabled={blocked}
      // Mientras no se pueda volver a guardar, el porqué sigue a la vista aunque se escriba.
      error={blocked ? inventoryUnconfirmedMessage(mutation.error, { repeatable: false }) : surface.error}
      submitLabel={submitLabel}
      cancelLabel="Cancelar"
      secondaryAction={
        already
          ? undefined
          : {
              label: editing ? "Guardar cambios" : "Guardar borrador",
              onClick: () => {
                intent.current = "borrador"
                void submitForm(form, submitOptions)
              },
              disabled: surface.isSubmitting || blocked,
            }
      }
      onSubmit={(event) => {
        // Enter tampoco reenvía: el aviso de que no se pudo confirmar sigue a la vista.
        if (blocked) {
          event.preventDefault()
          return
        }
        intent.current = "pedir"
        surface.onSubmit(event)
      }}
    >
      <FieldGroup>
        {preset?.notice ? <p className="rounded-md bg-primary-soft px-3 py-2 text-sm text-primary-soft-foreground">{preset.notice}</p> : null}
        {editing ? null : (
          <form.AppField name="mode">
            {(field) => (
              <field.Group
                legend="¿Ya la tienes?"
                className="gap-3"
                description={already ? "Queda registrada como llegada, con sus lotes, de una vez." : undefined}
              >
                {(control) => (
                  <ChoiceButtons
                    tone="primary"
                    value={field.state.value}
                    options={MODE_OPTIONS}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onBlur={control.onBlur}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
        )}

        <form.AppField name="supplierId">
          {(field) => (
            <field.Control
              label="Proveedor"
              description={
                <span className="flex flex-wrap items-center gap-x-1">
                  <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-0" onClick={chooseSupplier}>
                    + Nuevo proveedor
                  </Button>
                  {supplierHelp ? <span>· {supplierHelp}</span> : null}
                </span>
              }
            >
              {(control) => (
                <PickCombobox
                  id={control.id}
                  label="Proveedor"
                  placeholder="Buscar proveedor…"
                  options={supplierOptions}
                  value={field.state.value}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  empty={
                    <Button type="button" variant="link" className="h-auto p-0" onClick={chooseSupplier}>
                      + Nuevo proveedor
                    </Button>
                  }
                  onPick={(id) => field.handleChange(id)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>

        {sedeWarehouses.length > 1 ? (
          <form.AppField name="warehouseId">
            {(field) => (
              <field.Control label="Llega a" description={`Un almacén de ${branchName}.`}>
                {(control) => (
                  <ChoiceSelect
                    {...control.props}
                    value={field.state.value || (sedeWarehouses.find((item) => item.isDefault)?.id ?? "")}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {sedeWarehouses.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}

        <form.AppField name="lines" mode="array">
          {(list) => (
            <list.Group
              legend="Productos"
              className="gap-3"
              description={
                already
                  ? "El precio de la factura: es lo que se le debe al proveedor."
                  : "El precio es el que te dio el proveedor. Si la factura dice otro, se corrige al registrar lo que llegó."
              }
            >
              {(group) => (
                <div className="@container flex flex-col gap-3">
                  {list.state.value.length > 0 ? (
                    <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_6rem_2.75rem] gap-2 px-1 text-xs font-medium text-muted-foreground @lg:grid">
                      <span>Producto</span>
                      <span>Cantidad</span>
                      <span>Precio</span>
                      <span className="text-right">Subtotal</span>
                      <span />
                    </div>
                  ) : null}
                  {list.state.value.map((line, index) => (
                    <LineRow
                      key={line.productId}
                      form={form}
                      index={index}
                      product={byId.get(line.productId)}
                      detail={detailOf(line.productId)}
                      supplierId={values.supplierId}
                      already={already}
                      subtotal={subtotal(line)}
                      money={money}
                      currency={currency}
                      onRemove={() => list.removeValue(index)}
                    />
                  ))}
                  <PickCombobox
                    id={`${group.id}-agregar`}
                    label="Agregar un producto"
                    placeholder="Buscar producto…"
                    options={productOptions}
                    value=""
                    resetOnPick
                    invalid={group.invalid}
                    aria-describedby={group.describedBy}
                    empty={products.isPending ? "Cargando productos…" : "Ningún producto con ese nombre"}
                    onPick={addProduct}
                  />
                  {list.state.value.length > 0 ? (
                    <div className="flex items-center justify-between border-t pt-2 text-sm font-semibold">
                      <span>Total</span>
                      <span className="tabular-nums">{money(total)}</span>
                    </div>
                  ) : null}
                </div>
              )}
            </list.Group>
          )}
        </form.AppField>

        <form.AppField name="notes">
          {(field) => (
            <field.TextareaField
              label={
                <>
                  Notas <Optional />
                </>
              }
              maxLength={2000}
            />
          )}
        </form.AppField>

        {already && can.pay ? (
          <form.AppField name="paidNow">
            {(field) => <field.CheckboxField label="La pagué ahora" description={`Al guardar se abre «Registrar pago» con ${money(total)} puesto.`} />}
          </form.AppField>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/** Lo que el servidor dice del producto de una fila (repetido, desactivado): debajo de su nombre. */
function RowProblem({ id, errors }: { id: string; errors: unknown[] }) {
  const messages = fieldErrorMessages(errors)
  return messages.length > 0 ? <FieldError id={id} errors={messages.map((message) => ({ message }))} /> : null
}

const LineRow = withForm({
  defaultValues: {} as PurchaseValues,
  props: {} as {
    index: number
    product: ProductListItem | undefined
    detail: ProductDetail | undefined
    supplierId: string
    already: boolean
    subtotal: number | null
    money: (cents: number) => string
    currency: string | null
    onRemove: () => void
  },
  render: function LineRowRender({ form, index, product, detail, supplierId, already, subtotal, money, currency, onRemove }) {
    const { locale } = useInventory()
    const line = useStore(form.store, (state) => state.values.lines[index])
    const ids = React.useId()
    if (!line) return null
    const name = product?.name ?? detail?.name ?? "Producto"
    const unit = product?.unit ?? detail?.unit ?? "unidad"
    const purchaseUnit = product?.purchaseUnit ?? detail?.purchaseUnit ?? null
    const factor = product?.purchaseFactor ?? detail?.purchaseFactor ?? 1
    const quantity = parseWhole(line.quantity)
    const buyUnit = purchaseUnit && factor > 1 ? purchaseUnit : unit
    const suffix = unitFor(quantity !== null && !Number.isNaN(quantity) ? quantity : 2, buyUnit)
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
          <form.AppField name={`lines[${index}].quantity`}>
            {(field) => (
              <field.Control
                className="col-span-2 gap-1 @lg:col-span-1"
                label={
                  <>
                    <span className="@lg:sr-only">Cantidad</span>
                    <span className="sr-only"> de {name}</span>
                  </>
                }
              >
                {(control) => (
                  <QuantityInput
                    id={control.id}
                    value={field.state.value}
                    suffix={suffix}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          <form.AppField name={`lines[${index}].price`}>
            {(field) => (
              <field.Control
                className="col-span-2 gap-1 @lg:col-span-1"
                label={
                  <>
                    <span className="@lg:sr-only">Precio</span>
                    <span className="sr-only">
                      {" "}
                      de {name}, por {buyUnit}
                    </span>
                  </>
                }
              >
                {(control) =>
                  currency ? (
                    <MoneyInput
                      id={control.id}
                      currency={currency}
                      value={field.state.value}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onChange={(next) => {
                        form.setFieldValue(`lines[${index}].priceTouched`, true)
                        field.handleChange(next)
                      }}
                    />
                  ) : (
                    <Input id={control.id} disabled value="" />
                  )
                }
              </field.Control>
            )}
          </form.AppField>
          <span className="col-span-2 text-right text-sm tabular-nums @lg:col-span-1">
            <span className="text-muted-foreground @lg:sr-only">Subtotal </span>
            {subtotal !== null ? money(subtotal) : "—"}
          </span>
        </div>
        <form.Field name={`lines[${index}].productId`}>{(field) => <RowProblem id={`${ids}-producto-error`} errors={field.state.meta.errors} />}</form.Field>
        {hints.length > 0 ? <p className="text-xs text-muted-foreground">{hints.join(" · ")}</p> : null}
        {already ? (
          line.lotOpen ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <form.AppField name={`lines[${index}].lotCode`}>
                {(field) => (
                  <field.TextField
                    className="gap-1"
                    label={
                      <>
                        Lote <Optional />
                      </>
                    }
                    maxLength={120}
                  />
                )}
              </form.AppField>
              <form.AppField name={`lines[${index}].expiresAt`}>
                {(field) => (
                  <field.Control className="gap-1" label="Vence">
                    {(control) => (
                      <DatePickerButton
                        {...control.props}
                        className="w-full"
                        value={field.state.value}
                        emptyLabel="Sin vencimiento"
                        onChange={(next) => field.handleChange(next)}
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            </div>
          ) : (
            <Button
              type="button"
              variant="link"
              className="h-auto min-h-11 self-start p-0 text-xs sm:min-h-0"
              onClick={() => form.setFieldValue(`lines[${index}].lotOpen`, true)}
            >
              + Lote y vencimiento
            </Button>
          )
        ) : null}
      </div>
    )
  },
})
