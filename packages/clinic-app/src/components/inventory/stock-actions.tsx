/**
 * Las acciones sueltas, cada una con su nombre (tablero 12): Ajustar un lote,
 * Registrar uso, Trasladar a otra sede y Agregar sin compra. Se abren desde
 * «⋯» de la cabecera o desde el producto, que llega ya elegido. Usar y
 * trasladar salen del lote que vence primero sin preguntar («Elegir el lote»
 * si hace falta); ajustar sí lo pide. Cada formulario abierto lleva su clave:
 * un reintento no duplica, y la clave cambia al guardar.
 */
import { unitFor } from "@odentia/clinical"
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import {
  ADD_REASON_OPTIONS,
  ADJUST_REASON_OPTIONS,
  type AddReason,
  type AdjustReason,
  addStock,
  adjustLot,
  byCount,
  expiryText,
  fetchProduct,
  fetchProducts,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  newKey,
  type ProductDetail,
  type ProductLot,
  parseWhole,
  registerUse,
  stockText,
  transferStock,
  unitsText,
} from "../../lib/inventory"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { ChoiceButtons } from "../choice-buttons"
import { type PickedPerson, PersonPicker } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"
import { Optional, PickCombobox, QuantityInput } from "./fields"
import { type StockActionKind, useInventory } from "./inventory-scope"
import { appWords } from "../../lib/product-words"

export function StockActionDrawer({
  kind,
  preset,
  onClose,
}: {
  kind: StockActionKind
  preset: { productId?: string; lotId?: string }
  onClose: () => void
}) {
  if (kind === "ajustar") return <AdjustDrawer preset={preset} onClose={onClose} />
  if (kind === "uso") return <UseDrawer preset={preset} onClose={onClose} />
  if (kind === "trasladar") return <TransferDrawer preset={preset} onClose={onClose} />
  return <AddDrawer preset={preset} onClose={onClose} />
}

/* ---------------- piezas comunes ---------------- */

function useSedeProducts() {
  const { branchId } = useInventory()
  return useQuery({ queryKey: inventoryKeys.products(branchId, "", ""), queryFn: () => fetchProducts(branchId) })
}

function useDetail(productId: string) {
  const { branchId } = useInventory()
  return useQuery({
    queryKey: inventoryKeys.product(productId, branchId),
    queryFn: () => fetchProduct(productId, branchId),
    enabled: productId !== "",
  })
}

/** El producto: buscar por nombre entre los activos de la sede, con lo que hay. */
function ProductField({ id, value, onChange, error }: { id: string; value: string; onChange: (id: string) => void; error?: string }) {
  const products = useSedeProducts()
  const options = React.useMemo(
    () =>
      (products.data?.items ?? [])
        .filter((item) => item.isActive || item.id === value)
        .map((item) => ({ id: item.id, label: item.name, detail: `hay ${stockText(item.onHand, item)}` })),
    [products.data, value],
  )
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>Producto</FieldLabel>
      <PickCombobox
        id={id}
        label="Producto"
        placeholder="Buscar producto…"
        options={options}
        value={value}
        invalid={Boolean(error)}
        empty={products.isPending ? "Cargando productos…" : "Ningún producto con ese nombre"}
        onPick={onChange}
      />
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  )
}

/** Un lote, dicho como se reconoce en el almacén: «L-2298 · vence 12 nov · hay 7». */
function lotLabel(lot: ProductLot, detail: ProductDetail): string {
  const code = lot.code && lot.code !== lot.purchaseOrderLabel ? lot.code : "Sin código"
  return [
    code,
    lot.expiresAt ? `vence ${expiryText(lot.expiresAt, detail.today)}` : null,
    !lot.warehouseIsDefault ? lot.warehouseName : null,
    `hay ${formatWhole(lot.quantityOnHand)}`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** «Elegir el lote»: plegado; sin elegir, sale del que vence primero. */
function LotChooser({ id, detail, value, onChange }: { id: string; detail: ProductDetail | undefined; value: string; onChange: (id: string) => void }) {
  const lots = detail?.lots ?? []
  if (lots.length < 2) return null
  return (
    <Collapsible className="flex flex-col gap-3" defaultOpen={value !== ""}>
      <CollapsibleTrigger
        render={
          <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
            Elegir el lote
            <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
          </Button>
        }
      />
      <CollapsibleContent>
        <Field>
          <FieldLabel htmlFor={id}>Lote</FieldLabel>
          <ChoiceSelect id={id} value={value} onChange={(event) => onChange(event.target.value)}>
            <option value="">El que vence primero</option>
            {lots.map((lot) => (
              <option key={lot.id} value={lot.id}>
                {detail ? lotLabel(lot, detail) : lot.code}
              </option>
            ))}
          </ChoiceSelect>
        </Field>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** La clave del formulario abierto: sigue igual en los reintentos y cambia al guardar. */
function useFormKey(): [string, () => void] {
  const [key, setKey] = React.useState(newKey)
  return [key, () => setKey(newKey())]
}

function useFinish(onClose: () => void, rotate: () => void) {
  const queryClient = useQueryClient()
  return (message: string) => {
    rotate()
    toast.success(message)
    void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    onClose()
  }
}

/* ---------------- ajustar ---------------- */

function AdjustDrawer({ preset, onClose }: { preset: { productId?: string; lotId?: string }; onClose: () => void }) {
  const { branchName } = useInventory()
  const ids = React.useId()
  const [productId, setProductId] = React.useState(preset.productId ?? "")
  const [lotId, setLotId] = React.useState(preset.lotId ?? "")
  const [counted, setCounted] = React.useState("")
  const [reason, setReason] = React.useState<AdjustReason | null>(null)
  const [note, setNote] = React.useState("")
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const detailQuery = useDetail(productId)
  const detail = detailQuery.data
  const lots = detail?.lots ?? []
  // El primer lote queda elegido cuando llegan; uno elegido a mano no se cambia.
  React.useEffect(() => {
    if (lots.length > 0 && !lots.some((lot) => lot.id === lotId)) setLotId(lots[0]?.id ?? "")
  }, [lots, lotId])
  const lot = lots.find((item) => item.id === lotId)
  const parsed = parseWhole(counted)
  const unit = detail?.unit ?? "unidad"
  const help = (() => {
    if (!lot) return null
    const has = `${appWords().name} tiene ${formatWhole(lot.quantityOnHand)}.`
    if (parsed === null || Number.isNaN(parsed)) return has
    const delta = parsed - lot.quantityOnHand
    if (delta === 0) return `${has} Es lo mismo: no cambia nada.`
    return delta < 0
      ? `${has} Se ${byCount(-delta, "descuenta", "descuentan")} ${unitsText(-delta, unit)}.`
      : `${has} Se ${byCount(delta, "suma", "suman")} ${unitsText(delta, unit)}.`
  })()
  const mutation = useMutation({
    mutationFn: () =>
      adjustLot(lotId, { counted: parsed as number, reason: reason as AdjustReason, note: note.trim() || null, idempotencyKey: key }),
    onSuccess: (result) =>
      finish(
        result.delta === 0
          ? "No cambió nada: ya había eso."
          : result.delta < 0
            ? `Se ${byCount(-result.delta, "descontó", "descontaron")} ${unitsText(-result.delta, unit)} de ${detail?.name ?? "el producto"}.`
            : `Se ${byCount(result.delta, "sumó", "sumaron")} ${unitsText(result.delta, unit)} a ${detail?.name ?? "el producto"}.`,
      ),
  })
  const dirty = counted !== "" || reason !== null || note !== "" || (productId !== (preset.productId ?? ""))
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Ajustar un producto"
      description={`${branchName} · para un lote en particular`}
      error={mutation.error ? inventoryErrorMessage(mutation.error) : null}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitLabel="Ajustar"
      cancelLabel="Cancelar"
      onSubmit={(event) => {
        event.preventDefault()
        if (mutation.isPending) return
        const found: Record<string, string> = {}
        if (!productId) found.product = "Elige el producto."
        else if (!lot) found.lot = `No hay lotes de ${detail?.name ?? "este producto"} en ${branchName}. Para sumar, usa «Agregar sin compra».`
        if (parsed === null || Number.isNaN(parsed)) found.counted = "Escribe cuántos hay, desde 0."
        if (!reason) found.reason = "Elige por qué."
        if (reason === "otro" && !note.trim()) found.note = "Escribe el motivo."
        setErrors(found)
        if (Object.keys(found).length === 0) mutation.mutate()
      }}
    >
      <FieldGroup>
        <ProductField
          id={`${ids}-producto`}
          value={productId}
          error={errors.product}
          onChange={(next) => {
            setProductId(next)
            setLotId("")
          }}
        />
        {productId ? (
          <Field data-invalid={errors.lot ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-lote`}>Lote</FieldLabel>
            {detailQuery.isPending ? (
              <p className="text-sm text-muted-foreground">Cargando lotes…</p>
            ) : lots.length === 0 ? (
              <FieldDescription>No hay lotes en {branchName}. Para sumar, usa «Agregar sin compra».</FieldDescription>
            ) : (
              <ChoiceSelect id={`${ids}-lote`} value={lotId} onChange={(event) => setLotId(event.target.value)} aria-invalid={Boolean(errors.lot)}>
                {lots.map((item) => (
                  <option key={item.id} value={item.id}>
                    {detail ? lotLabel(item, detail) : item.code}
                  </option>
                ))}
              </ChoiceSelect>
            )}
            {errors.lot ? <FieldError>{errors.lot}</FieldError> : null}
          </Field>
        ) : null}
        <Field data-invalid={errors.counted ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-hay`}>¿Cuántos hay?</FieldLabel>
          <QuantityInput
            id={`${ids}-hay`}
            value={counted}
            suffix={unitFor(parsed !== null && !Number.isNaN(parsed) ? parsed : 2, unit)}
            invalid={Boolean(errors.counted)}
            aria-describedby={`${ids}-hay-ayuda`}
            onChange={setCounted}
          />
          {help ? <FieldDescription id={`${ids}-hay-ayuda`}>{help}</FieldDescription> : null}
          {errors.counted ? <FieldError>{errors.counted}</FieldError> : null}
        </Field>
        <FieldSet data-invalid={errors.reason ? true : undefined} className="gap-3">
          <FieldLegend variant="label" className="mb-0">Por qué</FieldLegend>
          <ChoiceButtons label="Por qué" value={reason} options={ADJUST_REASON_OPTIONS} onChange={setReason} />
          {errors.reason ? <FieldError>{errors.reason}</FieldError> : null}
        </FieldSet>
        {reason ? (
          <Field data-invalid={errors.note ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-detalle`}>
              Detalle {reason === "otro" ? null : <Optional />}
            </FieldLabel>
            <Textarea id={`${ids}-detalle`} maxLength={500} value={note} aria-invalid={errors.note ? true : undefined} onChange={(event) => setNote(event.target.value)} />
            {errors.note ? <FieldError>{errors.note}</FieldError> : null}
          </Field>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- registrar uso ---------------- */

function UseDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName, can } = useInventory()
  const ids = React.useId()
  const [productId, setProductId] = React.useState(preset.productId ?? "")
  const [quantity, setQuantity] = React.useState("")
  const [lotId, setLotId] = React.useState("")
  const [person, setPerson] = React.useState<PickedPerson | null>(null)
  const [note, setNote] = React.useState("")
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const detail = useDetail(productId).data
  const unit = detail?.unit ?? "unidad"
  const parsed = parseWhole(quantity)
  const short = detail && parsed !== null && !Number.isNaN(parsed) && parsed > Math.max(0, detail.onHand)
  const mutation = useMutation({
    mutationFn: () =>
      registerUse({
        productId,
        branchId,
        quantity: parsed as number,
        lotId: lotId || null,
        patientId: person?.patientId ?? null,
        note: note.trim() || null,
        idempotencyKey: key,
      }),
    onSuccess: (result) =>
      finish(
        `Se registró el uso de ${unitsText(parsed ?? 0, unit)} de ${detail?.name ?? "el producto"}.${result.encounterId ? " Quedó unido a su atención de hoy." : ""}`,
      ),
  })
  const dirty = quantity !== "" || person !== null || note !== "" || productId !== (preset.productId ?? "")
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Registrar uso"
      description={`${branchName} · lo que se usó o se regaló fuera de una atención. Lo vendido se descuenta desde Cobrar.`}
      error={mutation.error ? inventoryErrorMessage(mutation.error) : null}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitLabel="Registrar uso"
      cancelLabel="Cancelar"
      onSubmit={(event) => {
        event.preventDefault()
        if (mutation.isPending) return
        const found: Record<string, string> = {}
        if (!productId) found.product = "Elige el producto."
        if (parsed === null || Number.isNaN(parsed) || parsed < 1) found.quantity = "Escribe cuánto se usó, desde 1."
        setErrors(found)
        if (Object.keys(found).length === 0) mutation.mutate()
      }}
    >
      <FieldGroup>
        <ProductField
          id={`${ids}-producto`}
          value={productId}
          error={errors.product}
          onChange={(next) => {
            setProductId(next)
            setLotId("")
          }}
        />
        <Field data-invalid={errors.quantity ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-cantidad`}>Cantidad</FieldLabel>
          <QuantityInput
            id={`${ids}-cantidad`}
            value={quantity}
            suffix={unitFor(parsed !== null && !Number.isNaN(parsed) ? parsed : 2, unit)}
            invalid={Boolean(errors.quantity)}
            aria-describedby={`${ids}-cantidad-ayuda`}
            onChange={setQuantity}
          />
          <FieldDescription id={`${ids}-cantidad-ayuda`}>
            {lotId ? "Sale del lote elegido." : "Sale del lote que vence primero."}
            {short && detail ? ` En ${branchName} hay ${unitsText(detail.onHand, unit)}: no alcanza.` : ""}
          </FieldDescription>
          {errors.quantity ? <FieldError>{errors.quantity}</FieldError> : null}
        </Field>
        <LotChooser id={`${ids}-lote`} detail={detail} value={lotId} onChange={setLotId} />
        {can.people ? (
          <PersonPicker
            label="Para quién (opcional)"
            value={person}
            onChange={setPerson}
            patientsOnly
            description="Busca por nombre, celular o documento. Si tiene una atención abierta hoy, el uso queda unido a ella."
          />
        ) : null}
        <Field>
          <FieldLabel htmlFor={`${ids}-detalle`}>
            Detalle <Optional />
          </FieldLabel>
          <Textarea id={`${ids}-detalle`} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- trasladar ---------------- */

function TransferDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName, branches } = useInventory()
  const ids = React.useId()
  const others = branches.filter((branch) => branch.id !== branchId)
  const [productId, setProductId] = React.useState(preset.productId ?? "")
  const [quantity, setQuantity] = React.useState("")
  const [toBranchId, setToBranchId] = React.useState(others[0]?.id ?? "")
  const [lotId, setLotId] = React.useState("")
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const detail = useDetail(productId).data
  const unit = detail?.unit ?? "unidad"
  const parsed = parseWhole(quantity)
  const target = detail?.branches.find((branch) => branch.branchId === toBranchId)
  const targetName = others.find((branch) => branch.id === toBranchId)?.name ?? ""
  const mutation = useMutation({
    mutationFn: () =>
      transferStock({
        productId,
        fromBranchId: branchId,
        toBranchId,
        quantity: parsed as number,
        lotId: lotId || null,
        note: null,
        idempotencyKey: key,
      }),
    onSuccess: () => finish(`Se ${byCount(parsed ?? 0, "trasladó", "trasladaron")} ${unitsText(parsed ?? 0, unit)} de ${detail?.name ?? "el producto"} a ${targetName}.`),
  })
  const dirty = quantity !== "" || productId !== (preset.productId ?? "")
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Trasladar a otra sede"
      description={`Sale de ${branchName}`}
      error={mutation.error ? inventoryErrorMessage(mutation.error) : null}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitDisabled={others.length === 0}
      submitLabel="Trasladar"
      cancelLabel="Cancelar"
      onSubmit={(event) => {
        event.preventDefault()
        if (mutation.isPending) return
        const found: Record<string, string> = {}
        if (!productId) found.product = "Elige el producto."
        if (parsed === null || Number.isNaN(parsed) || parsed < 1) found.quantity = "Escribe cuánto se traslada, desde 1."
        if (!toBranchId) found.to = "Elige a qué sede va."
        setErrors(found)
        if (Object.keys(found).length === 0) mutation.mutate()
      }}
    >
      <FieldGroup>
        <ProductField
          id={`${ids}-producto`}
          value={productId}
          error={errors.product}
          onChange={(next) => {
            setProductId(next)
            setLotId("")
          }}
        />
        <Field data-invalid={errors.quantity ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-cantidad`}>Cantidad</FieldLabel>
          <QuantityInput
            id={`${ids}-cantidad`}
            value={quantity}
            suffix={unitFor(parsed !== null && !Number.isNaN(parsed) ? parsed : 2, unit)}
            invalid={Boolean(errors.quantity)}
            aria-describedby={`${ids}-cantidad-ayuda`}
            onChange={setQuantity}
          />
          <FieldDescription id={`${ids}-cantidad-ayuda`}>
            {lotId ? "Salen del lote elegido." : "Salen del lote que vence primero."}
            {detail ? ` En ${branchName} hay ${unitsText(detail.onHand, unit)}.` : ""}
          </FieldDescription>
          {errors.quantity ? <FieldError>{errors.quantity}</FieldError> : null}
        </Field>
        <Field data-invalid={errors.to ? true : undefined}>
          <FieldLabel htmlFor={`${ids}-destino`}>Va a</FieldLabel>
          {others.length === 0 ? (
            <FieldDescription>No hay otra sede activa a la cual trasladar.</FieldDescription>
          ) : (
            <ChoiceSelect id={`${ids}-destino`} value={toBranchId} onChange={(event) => setToBranchId(event.target.value)} aria-describedby={`${ids}-destino-ayuda`}>
              {others.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </ChoiceSelect>
          )}
          {target && detail ? (
            <FieldDescription id={`${ids}-destino-ayuda`}>
              {target.branchName} tiene {formatWhole(target.onHand)}
              {target.minQuantity > 0 ? ` y su mínimo es ${formatWhole(target.minQuantity)}` : ""}.
            </FieldDescription>
          ) : null}
          {errors.to ? <FieldError>{errors.to}</FieldError> : null}
        </Field>
        <LotChooser id={`${ids}-lote`} detail={detail} value={lotId} onChange={setLotId} />
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- agregar sin compra ---------------- */

function AddDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName } = useInventory()
  const ids = React.useId()
  const [productId, setProductId] = React.useState(preset.productId ?? "")
  const [quantity, setQuantity] = React.useState("")
  const [countIn, setCountIn] = React.useState<"compra" | "uso">("compra")
  const [expiresAt, setExpiresAt] = React.useState("")
  const [lotCode, setLotCode] = React.useState("")
  const [showLot, setShowLot] = React.useState(false)
  const [reason, setReason] = React.useState<AddReason>("muestra")
  const [note, setNote] = React.useState("")
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const detail = useDetail(productId).data
  const unit = detail?.unit ?? "unidad"
  const packed = Boolean(detail?.purchaseUnit && detail.purchaseFactor > 1)
  const inPurchase = packed && countIn === "compra"
  const parsed = parseWhole(quantity)
  const valid = parsed !== null && !Number.isNaN(parsed) && parsed >= 1
  const useUnits = valid ? (parsed as number) * (inPurchase && detail ? detail.purchaseFactor : 1) : 0
  const mutation = useMutation({
    mutationFn: () =>
      addStock({
        productId,
        branchId,
        quantity: useUnits,
        lotCode: lotCode.trim() || null,
        expiresAt: expiresAt || null,
        reason,
        note: note.trim() || null,
        idempotencyKey: key,
      }),
    onSuccess: () => finish(`Se ${byCount(useUnits, "agregó", "agregaron")} ${unitsText(useUnits, unit)} de ${detail?.name ?? "el producto"} en ${branchName}.`),
    onError: (error) => {
      // El servidor pide el código cuando ya hay un lote sin código con otro vencimiento.
      if (!isAmbiguousMutationError(error) && /lote/i.test(inventoryErrorMessage(error))) setShowLot(true)
    },
  })
  const errorText = mutation.error ? inventoryErrorMessage(mutation.error) : null
  const lotError = errorText && /lote/i.test(errorText) ? errorText : null
  const dirty = quantity !== "" || expiresAt !== "" || lotCode !== "" || note !== "" || productId !== (preset.productId ?? "")
  const suffix = inPurchase && detail?.purchaseUnit ? unitFor(valid ? (parsed as number) : 2, detail.purchaseUnit) : unitFor(valid ? (parsed as number) : 2, unit)
  return (
    <FormDrawer
      open
      onClose={onClose}
      title="Agregar sin compra"
      description={`${branchName} · una muestra, un regalo del proveedor o algo que apareció`}
      error={errorText && !lotError ? errorText : null}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitLabel="Agregar"
      cancelLabel="Cancelar"
      onSubmit={(event) => {
        event.preventDefault()
        if (mutation.isPending) return
        const found: Record<string, string> = {}
        if (!productId) found.product = "Elige el producto."
        if (!valid) found.quantity = "Escribe cuánto entra, desde 1."
        if (reason === "otro" && !note.trim()) found.note = "Escribe el motivo."
        setErrors(found)
        if (Object.keys(found).length === 0) mutation.mutate()
      }}
    >
      <FieldGroup>
        <ProductField id={`${ids}-producto`} value={productId} error={errors.product} onChange={setProductId} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={errors.quantity ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-cantidad`}>Cantidad</FieldLabel>
            <QuantityInput
              id={`${ids}-cantidad`}
              value={quantity}
              suffix={suffix}
              invalid={Boolean(errors.quantity)}
              aria-describedby={`${ids}-cantidad-ayuda`}
              onChange={setQuantity}
            />
            {packed && detail?.purchaseUnit ? (
              <ChoiceButtons
                label="Se cuenta en"
                value={countIn}
                options={[
                  { value: "compra", label: unitFor(2, detail.purchaseUnit) },
                  { value: "uso", label: unitFor(2, unit) },
                ]}
                onChange={setCountIn}
              />
            ) : null}
            {inPurchase && valid ? <FieldDescription id={`${ids}-cantidad-ayuda`}>Son {unitsText(useUnits, unit)}.</FieldDescription> : null}
            {errors.quantity ? <FieldError>{errors.quantity}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel htmlFor={`${ids}-vence`}>
              Vence <Optional />
            </FieldLabel>
            <DatePickerButton id={`${ids}-vence`} className="w-full" value={expiresAt} emptyLabel="Sin vencimiento" onChange={setExpiresAt} />
            {!showLot ? (
              <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setShowLot(true)}>
                + Código de lote
              </Button>
            ) : null}
          </Field>
        </div>
        {showLot ? (
          <Field data-invalid={lotError ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-lote`}>
              Lote <Optional />
            </FieldLabel>
            <Input id={`${ids}-lote`} maxLength={120} value={lotCode} aria-invalid={lotError ? true : undefined} onChange={(event) => setLotCode(event.target.value)} />
            {lotError ? <FieldError>{lotError}</FieldError> : null}
          </Field>
        ) : null}
        <FieldSet className="gap-3">
          <FieldLegend variant="label" className="mb-0">Por qué</FieldLegend>
          <ChoiceButtons label="Por qué" value={reason} options={ADD_REASON_OPTIONS} onChange={setReason} />
        </FieldSet>
        {reason === "otro" ? (
          <Field data-invalid={errors.note ? true : undefined}>
            <FieldLabel htmlFor={`${ids}-detalle`}>Detalle</FieldLabel>
            <Textarea id={`${ids}-detalle`} maxLength={500} value={note} aria-invalid={errors.note ? true : undefined} onChange={(event) => setNote(event.target.value)} />
            {errors.note ? <FieldError>{errors.note}</FieldError> : null}
          </Field>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}
