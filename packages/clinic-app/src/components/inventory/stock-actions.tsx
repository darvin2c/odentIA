/**
 * Las acciones sueltas, cada una con su nombre (tablero 12): Ajustar un lote,
 * Registrar uso, Trasladar a otra sede y Agregar sin compra. Se abren desde
 * «⋯» de la cabecera o desde el producto, que llega ya elegido. Usar y
 * trasladar salen del lote que vence primero sin preguntar («Elegir el lote»
 * si hace falta); ajustar sí lo pide. Cada formulario abierto lleva su clave:
 * un reintento no duplica, y la clave cambia al guardar. Cada error va en su
 * campo, también los del servidor («No alcanza…» en la cantidad).
 */
import { unitFor } from "@odentia/clinical"
import { Button, Collapsible, CollapsibleContent, CollapsibleTrigger, FieldDescription, FieldGroup, toast } from "@odentia/ui"
import { DatePickerButton, FormDrawer, type ServerFieldMap, useAppForm, useFormSurface, withFieldGroup } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
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
  inventoryKeys,
  inventoryUnconfirmedMessage,
  newKey,
  type ProductDetail,
  type ProductLot,
  parseWhole,
  registerUse,
  stockText,
  transferStock,
  unitsText,
} from "../../lib/inventory"
import { appWords } from "../../lib/product-words"
import { ChoiceButtons } from "../choice-buttons"
import { PersonPicker, type PickedPerson } from "../person-picker"
import { ChoiceSelect } from "../ui/choice-select"
import { Optional, PickCombobox, QuantityInput } from "./fields"
import { type StockActionKind, useInventory } from "./inventory-scope"

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

/** El mismo tope que la ruta y el servicio (`quantity`, `counted`). */
const MAX_QUANTITY = 1_000_000_000

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

function wholeOf(text: string): number | null {
  const parsed = parseWhole(text)
  return parsed === null || Number.isNaN(parsed) ? null : parsed
}

/** El producto: buscar por nombre entre los activos de la sede, con lo que hay. */
function ProductPicker({
  id,
  value,
  invalid,
  describedBy,
  onChange,
}: {
  id: string
  value: string
  invalid: boolean
  describedBy: string | undefined
  onChange: (id: string) => void
}) {
  const products = useSedeProducts()
  const options = React.useMemo(
    () =>
      (products.data?.items ?? [])
        .filter((item) => item.isActive || item.id === value)
        .map((item) => ({ id: item.id, label: item.name, detail: `hay ${stockText(item.onHand, item)}` })),
    [products.data, value],
  )
  return (
    <PickCombobox
      id={id}
      label="Producto"
      placeholder="Buscar producto…"
      options={options}
      value={value}
      invalid={invalid}
      aria-describedby={describedBy}
      empty={products.isPending ? "Cargando productos…" : "Ningún producto con ese nombre"}
      onPick={onChange}
    />
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

/** Lo de cada cajón con clave: un reintento tal cual no se repite. */
function surfaceOptions(fieldMap?: ServerFieldMap) {
  return { fieldMap, formMessage: (error: unknown) => inventoryUnconfirmedMessage(error) }
}

/* ---------------- ajustar ---------------- */

function AdjustDrawer({ preset, onClose }: { preset: { productId?: string; lotId?: string }; onClose: () => void }) {
  const { branchName } = useInventory()
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const mutation = useMutation({
    mutationFn: (input: { lotId: string; counted: number; reason: AdjustReason; note: string | null }) =>
      adjustLot(input.lotId, { counted: input.counted, reason: input.reason, note: input.note, idempotencyKey: key }),
  })
  const form = useAppForm({
    defaultValues: { productId: preset.productId ?? "", lotId: preset.lotId ?? "", counted: "", reason: "" as AdjustReason | "", note: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.productId) fields.productId = "Elige el producto."
        else if (!lots.some((item) => item.id === value.lotId))
          fields.lotId = `No hay lotes de ${detail?.name ?? "este producto"} en ${branchName}. Para sumar, usa «Agregar sin compra».`
        const counted = wholeOf(value.counted)
        if (counted === null || counted > MAX_QUANTITY) fields.counted = "Escribe cuántos hay, desde 0."
        if (!value.reason) fields.reason = "Elige por qué."
        if (value.reason === "otro" && !value.note.trim()) fields.note = "Escribe el motivo."
        if (value.note.trim().length > 500) fields.note = "El detalle admite hasta 500 caracteres."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const result = await mutation.mutateAsync({
        lotId: value.lotId,
        counted: wholeOf(value.counted) as number,
        reason: value.reason as AdjustReason,
        note: value.note.trim() || null,
      })
      finish(
        result.delta === 0
          ? "No cambió nada: ya había eso."
          : result.delta < 0
            ? `Se ${byCount(-result.delta, "descontó", "descontaron")} ${unitsText(-result.delta, unit)} de ${detail?.name ?? "el producto"}.`
            : `Se ${byCount(result.delta, "sumó", "sumaron")} ${unitsText(result.delta, unit)} a ${detail?.name ?? "el producto"}.`,
      )
    },
  })
  const surface = useFormSurface(form, surfaceOptions())
  const productId = useStore(form.store, (state) => state.values.productId)
  const lotId = useStore(form.store, (state) => state.values.lotId)
  const counted = useStore(form.store, (state) => state.values.counted)
  const reason = useStore(form.store, (state) => state.values.reason)
  const detailQuery = useDetail(productId)
  const detail = detailQuery.data
  const lots = detail?.lots ?? []
  // El primer lote queda elegido cuando llegan; uno elegido a mano no se cambia.
  React.useEffect(() => {
    if (lots.length > 0 && !lots.some((lot) => lot.id === lotId)) form.setFieldValue("lotId", lots[0]?.id ?? "", { dontUpdateMeta: true })
  }, [lots, lotId, form])
  const lot = lots.find((item) => item.id === lotId)
  const parsed = wholeOf(counted)
  const unit = detail?.unit ?? "unidad"
  const help = (() => {
    if (!lot) return undefined
    const has = `${appWords().name} tiene ${formatWhole(lot.quantityOnHand)}.`
    if (parsed === null) return has
    const delta = parsed - lot.quantityOnHand
    if (delta === 0) return `${has} Es lo mismo: no cambia nada.`
    return delta < 0
      ? `${has} Se ${byCount(-delta, "descuenta", "descuentan")} ${unitsText(-delta, unit)}.`
      : `${has} Se ${byCount(delta, "suma", "suman")} ${unitsText(delta, unit)}.`
  })()
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Ajustar un producto"
      description={`${branchName} · para un lote en particular`}
      submitLabel="Ajustar"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="productId" listeners={{ onChange: () => form.setFieldValue("lotId", "") }}>
          {(field) => (
            <field.Control label="Producto">
              {(control) => (
                <ProductPicker id={control.id} value={field.state.value} invalid={control.invalid} describedBy={control.describedBy} onChange={(next) => field.handleChange(next)} />
              )}
            </field.Control>
          )}
        </form.AppField>
        {productId ? (
          detailQuery.isPending ? (
            <p className="text-sm text-muted-foreground">Cargando lotes…</p>
          ) : (
            <form.AppField name="lotId">
              {(field) =>
                lots.length === 0 ? (
                  <field.Group legend="Lote">
                    {() => <FieldDescription>No hay lotes en {branchName}. Para sumar, usa «Agregar sin compra».</FieldDescription>}
                  </field.Group>
                ) : (
                  <field.Control label="Lote">
                    {(control) => (
                      <ChoiceSelect {...control.props} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)}>
                        {lots.map((item) => (
                          <option key={item.id} value={item.id}>
                            {detail ? lotLabel(item, detail) : item.code}
                          </option>
                        ))}
                      </ChoiceSelect>
                    )}
                  </field.Control>
                )
              }
            </form.AppField>
          )
        ) : null}
        <form.AppField name="counted">
          {(field) => (
            <field.Control label="¿Cuántos hay?" description={help}>
              {(control) => (
                <QuantityInput
                  id={control.id}
                  value={field.state.value}
                  suffix={unitFor(parsed ?? 2, unit)}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="reason">
          {(field) => (
            <field.Group legend="Por qué" className="gap-3">
              {(control) => (
                <ChoiceButtons
                  value={field.state.value || null}
                  options={ADJUST_REASON_OPTIONS}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {reason ? (
          <form.AppField name="note">
            {(field) => (
              <field.TextareaField
                label={<>Detalle {reason === "otro" ? null : <Optional />}</>}
                maxLength={500}
              />
            )}
          </form.AppField>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- elegir el lote ---------------- */

/** Abre lo que esconde un campo cuando ese campo tiene algo que corregir. */
function OpenOnError({ invalid, onOpen }: { invalid: boolean; onOpen: () => void }) {
  React.useEffect(() => {
    if (invalid) onOpen()
  }, [invalid, onOpen])
  return null
}

/**
 * El lote de Usar y Trasladar, plegado en «Elegir el lote»; sin elegir, sale del
 * que vence primero. Montado aunque no se vea: lo que diga el servidor del lote
 * llega a su campo y lo abre.
 */
const LotField = withFieldGroup({
  defaultValues: { lotId: "" },
  props: { detail: undefined as ProductDetail | undefined },
  render: function LotFieldRender({ group, detail }) {
    const [open, setOpen] = React.useState(() => group.getFieldValue("lotId") !== "")
    const reveal = React.useCallback(() => setOpen(true), [])
    const lots = detail?.lots ?? []
    if (lots.length < 2) return null
    return (
      <Collapsible className="flex flex-col gap-3" open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          render={
            <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
              Elegir el lote
              <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
            </Button>
          }
        />
        <CollapsibleContent keepMounted>
          <group.AppField name="lotId">
            {(field) => (
              <>
                <OpenOnError invalid={field.state.meta.errors.length > 0} onOpen={reveal} />
                <field.Control label="Lote">
                  {(control) => (
                    <ChoiceSelect {...control.props} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)}>
                      <option value="">El que vence primero</option>
                      {lots.map((lot) => (
                        <option key={lot.id} value={lot.id}>
                          {detail ? lotLabel(lot, detail) : lot.code}
                        </option>
                      ))}
                    </ChoiceSelect>
                  )}
                </field.Control>
              </>
            )}
          </group.AppField>
        </CollapsibleContent>
      </Collapsible>
    )
  },
})

/* ---------------- registrar uso ---------------- */

function UseDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName, can } = useInventory()
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const mutation = useMutation({
    mutationFn: (input: { productId: string; quantity: number; lotId: string | null; patientId: string | null; note: string | null }) =>
      registerUse({ ...input, branchId, idempotencyKey: key }),
  })
  const form = useAppForm({
    defaultValues: { productId: preset.productId ?? "", quantity: "", lotId: "", person: null as PickedPerson | null, note: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.productId) fields.productId = "Elige el producto."
        const quantity = wholeOf(value.quantity)
        if (quantity === null || quantity < 1 || quantity > MAX_QUANTITY) fields.quantity = "Escribe cuánto se usó, desde 1."
        if (value.note.trim().length > 500) fields.note = "El detalle admite hasta 500 caracteres."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const quantity = wholeOf(value.quantity) as number
      const result = await mutation.mutateAsync({
        productId: value.productId,
        quantity,
        lotId: value.lotId || null,
        patientId: value.person?.patientId ?? null,
        note: value.note.trim() || null,
      })
      finish(`Se registró el uso de ${unitsText(quantity, unit)} de ${detail?.name ?? "el producto"}.${result.encounterId ? " Quedó unido a su atención de hoy." : ""}`)
    },
  })
  const surface = useFormSurface(form, surfaceOptions({ patientId: "person" }))
  const productId = useStore(form.store, (state) => state.values.productId)
  const lotId = useStore(form.store, (state) => state.values.lotId)
  const parsed = wholeOf(useStore(form.store, (state) => state.values.quantity))
  const detail = useDetail(productId).data
  const unit = detail?.unit ?? "unidad"
  const short = detail && parsed !== null && parsed > Math.max(0, detail.onHand)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Registrar uso"
      description={`${branchName} · lo que se usó o se regaló fuera de una atención. Lo vendido se descuenta desde Cobrar.`}
      submitLabel="Registrar uso"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="productId" listeners={{ onChange: () => form.setFieldValue("lotId", "") }}>
          {(field) => (
            <field.Control label="Producto">
              {(control) => (
                <ProductPicker id={control.id} value={field.state.value} invalid={control.invalid} describedBy={control.describedBy} onChange={(next) => field.handleChange(next)} />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="quantity">
          {(field) => (
            <field.Control
              label="Cantidad"
              description={`${lotId ? "Sale del lote elegido." : "Sale del lote que vence primero."}${short && detail ? ` En ${branchName} hay ${unitsText(detail.onHand, unit)}: no alcanza.` : ""}`}
            >
              {(control) => (
                <QuantityInput
                  id={control.id}
                  value={field.state.value}
                  suffix={unitFor(parsed ?? 2, unit)}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <LotField form={form} fields={{ lotId: "lotId" }} detail={detail} />
        {can.people ? (
          <form.AppField name="person">
            {(field) => (
              <field.Control
                label="Para quién (opcional)"
                description="Busca por nombre, celular o documento. Si tiene una atención abierta hoy, el uso queda unido a ella."
              >
                {(control) => (
                  <PersonPicker
                    id={control.id}
                    label="Para quién (opcional)"
                    value={field.state.value}
                    onChange={(next) => field.handleChange(next)}
                    patientsOnly
                    invalid={control.invalid}
                    onBlur={control.onBlur}
                    aria-describedby={control.describedBy}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        ) : null}
        <form.AppField name="note">
          {(field) => (
            <field.TextareaField
              label={
                <>
                  Detalle <Optional />
                </>
              }
              maxLength={500}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- trasladar ---------------- */

function TransferDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName, branches } = useInventory()
  const others = branches.filter((branch) => branch.id !== branchId)
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const mutation = useMutation({
    mutationFn: (input: { productId: string; toBranchId: string; quantity: number; lotId: string | null }) =>
      transferStock({ ...input, fromBranchId: branchId, note: null, idempotencyKey: key }),
  })
  const form = useAppForm({
    defaultValues: { productId: preset.productId ?? "", quantity: "", toBranchId: others[0]?.id ?? "", lotId: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.productId) fields.productId = "Elige el producto."
        const quantity = wholeOf(value.quantity)
        if (quantity === null || quantity < 1 || quantity > MAX_QUANTITY) fields.quantity = "Escribe cuánto se traslada, desde 1."
        if (!value.toBranchId) fields.toBranchId = "Elige a qué sede va."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const quantity = wholeOf(value.quantity) as number
      await mutation.mutateAsync({ productId: value.productId, toBranchId: value.toBranchId, quantity, lotId: value.lotId || null })
      const targetName = others.find((branch) => branch.id === value.toBranchId)?.name ?? ""
      finish(`Se ${byCount(quantity, "trasladó", "trasladaron")} ${unitsText(quantity, unit)} de ${detail?.name ?? "el producto"} a ${targetName}.`)
    },
  })
  const surface = useFormSurface(form, surfaceOptions())
  const productId = useStore(form.store, (state) => state.values.productId)
  const lotId = useStore(form.store, (state) => state.values.lotId)
  const toBranchId = useStore(form.store, (state) => state.values.toBranchId)
  const parsed = wholeOf(useStore(form.store, (state) => state.values.quantity))
  const detail = useDetail(productId).data
  const unit = detail?.unit ?? "unidad"
  const target = detail?.branches.find((branch) => branch.branchId === toBranchId)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Trasladar a otra sede"
      description={`Sale de ${branchName}`}
      // Sin otra sede no hay a dónde: el campo «Va a» lo dice.
      submitDisabled={others.length === 0}
      submitLabel="Trasladar"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="productId" listeners={{ onChange: () => form.setFieldValue("lotId", "") }}>
          {(field) => (
            <field.Control label="Producto">
              {(control) => (
                <ProductPicker id={control.id} value={field.state.value} invalid={control.invalid} describedBy={control.describedBy} onChange={(next) => field.handleChange(next)} />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="quantity">
          {(field) => (
            <field.Control
              label="Cantidad"
              description={`${lotId ? "Salen del lote elegido." : "Salen del lote que vence primero."}${detail ? ` En ${branchName} hay ${unitsText(detail.onHand, unit)}.` : ""}`}
            >
              {(control) => (
                <QuantityInput
                  id={control.id}
                  value={field.state.value}
                  suffix={unitFor(parsed ?? 2, unit)}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="toBranchId">
          {(field) =>
            others.length === 0 ? (
              <field.Group legend="Va a">{() => <FieldDescription>No hay otra sede activa a la cual trasladar.</FieldDescription>}</field.Group>
            ) : (
              <field.Control
                label="Va a"
                description={
                  target && detail
                    ? `${target.branchName} tiene ${formatWhole(target.onHand)}${target.minQuantity > 0 ? ` y su mínimo es ${formatWhole(target.minQuantity)}` : ""}.`
                    : undefined
                }
              >
                {(control) => (
                  <ChoiceSelect {...control.props} value={field.state.value} onChange={(event) => field.handleChange(event.target.value)}>
                    {others.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </ChoiceSelect>
                )}
              </field.Control>
            )
          }
        </form.AppField>
        <LotField form={form} fields={{ lotId: "lotId" }} detail={detail} />
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------- agregar sin compra ---------------- */

function AddDrawer({ preset, onClose }: { preset: { productId?: string }; onClose: () => void }) {
  const { branchId, branchName } = useInventory()
  const [key, rotate] = useFormKey()
  const finish = useFinish(onClose, rotate)
  const [showLot, setShowLot] = React.useState(false)
  const mutation = useMutation({
    mutationFn: (input: { productId: string; quantity: number; lotCode: string | null; expiresAt: string | null; reason: AddReason; note: string | null }) =>
      addStock({ ...input, branchId, idempotencyKey: key }),
  })
  const form = useAppForm({
    defaultValues: { productId: preset.productId ?? "", quantity: "", countIn: "compra" as "compra" | "uso", expiresAt: "", lotCode: "", reason: "muestra" as AddReason, note: "" },
    validators: {
      onSubmit: ({ value }) => {
        const fields: Record<string, string> = {}
        if (!value.productId) fields.productId = "Elige el producto."
        const quantity = wholeOf(value.quantity)
        if (quantity === null || quantity < 1 || unitsOf(value) > MAX_QUANTITY) fields.quantity = "Escribe cuánto entra, desde 1."
        if (value.lotCode.trim().length > 120) fields.lotCode = "El lote admite hasta 120 caracteres."
        if (value.reason === "otro" && !value.note.trim()) fields.note = "Escribe el motivo."
        if (value.note.trim().length > 500) fields.note = "El detalle admite hasta 500 caracteres."
        return Object.keys(fields).length > 0 ? { fields } : undefined
      },
    },
    onSubmit: async ({ value }) => {
      const units = unitsOf(value)
      await mutation.mutateAsync({
        productId: value.productId,
        quantity: units,
        lotCode: value.lotCode.trim() || null,
        expiresAt: value.expiresAt || null,
        reason: value.reason,
        note: value.note.trim() || null,
      })
      finish(`Se ${byCount(units, "agregó", "agregaron")} ${unitsText(units, unit)} de ${detail?.name ?? "el producto"} en ${branchName}.`)
    },
  })
  const surface = useFormSurface(form, surfaceOptions())
  const values = useStore(form.store, (state) => state.values)
  const detail = useDetail(values.productId).data
  const unit = detail?.unit ?? "unidad"
  const packed = Boolean(detail?.purchaseUnit && detail.purchaseFactor > 1)
  // Lo que entra, en unidades de uso: con «cajas» se multiplica por lo que trae cada una.
  function unitsOf(value: { quantity: string; countIn: "compra" | "uso" }): number {
    const quantity = wholeOf(value.quantity) ?? 0
    return quantity * (packed && value.countIn === "compra" && detail ? detail.purchaseFactor : 1)
  }
  const parsed = wholeOf(values.quantity)
  const valid = parsed !== null && parsed >= 1
  const inPurchase = packed && values.countIn === "compra"
  const useUnits = valid ? unitsOf(values) : 0
  // El servidor pide el código cuando ya hay un lote con otro vencimiento: el campo se abre con su motivo.
  const revealLot = React.useCallback(() => setShowLot(true), [])
  const suffix = inPurchase && detail?.purchaseUnit ? unitFor(valid ? (parsed as number) : 2, detail.purchaseUnit) : unitFor(valid ? (parsed as number) : 2, unit)
  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title="Agregar sin compra"
      description={`${branchName} · una muestra, un regalo del proveedor o algo que apareció`}
      submitLabel="Agregar"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="productId">
          {(field) => (
            <field.Control label="Producto">
              {(control) => (
                <ProductPicker id={control.id} value={field.state.value} invalid={control.invalid} describedBy={control.describedBy} onChange={(next) => field.handleChange(next)} />
              )}
            </field.Control>
          )}
        </form.AppField>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <form.AppField name="quantity">
              {(field) => (
                <field.Control label="Cantidad" description={inPurchase && valid ? `Son ${unitsText(useUnits, unit)}.` : undefined}>
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
            {packed && detail?.purchaseUnit ? (
              <form.AppField name="countIn">
                {(field) => (
                  <ChoiceButtons
                    aria-label="Se cuenta en"
                    value={field.state.value}
                    options={[
                      { value: "compra", label: unitFor(2, detail.purchaseUnit ?? unit) },
                      { value: "uso", label: unitFor(2, unit) },
                    ]}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </form.AppField>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            <form.AppField name="expiresAt">
              {(field) => (
                <field.Control
                  label={
                    <>
                      Vence <Optional />
                    </>
                  }
                >
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
            {!showLot ? (
              <Button type="button" variant="link" className="h-auto min-h-11 self-start p-0 sm:min-h-8" onClick={() => setShowLot(true)}>
                + Código de lote
              </Button>
            ) : null}
          </div>
        </div>
        {/* Montado aunque esté plegado: lo que diga el servidor del lote llega a su campo y lo abre. */}
        <div hidden={!showLot}>
          <form.AppField name="lotCode">
            {(field) => (
              <>
                <OpenOnError invalid={field.state.meta.errors.length > 0} onOpen={revealLot} />
                <field.TextField
                  label={
                    <>
                      Lote <Optional />
                    </>
                  }
                  maxLength={120}
                />
              </>
            )}
          </form.AppField>
        </div>
        <form.AppField name="reason">
          {(field) => (
            <field.Group legend="Por qué" className="gap-3">
              {(control) => (
                <ChoiceButtons
                  value={field.state.value}
                  options={ADD_REASON_OPTIONS}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onBlur={control.onBlur}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        {values.reason === "otro" ? (
          <form.AppField name="note">{(field) => <field.TextareaField label="Detalle" maxLength={500} />}</form.AppField>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}
