/**
 * Formulario de producto (tableros 7, 16 y 19): nombre, cómo se usa (en las
 * atenciones, se vende o las dos), en qué se usa y en qué se compra, el mínimo
 * de cada sede y, si se vende, su precio con lo que deja. El código va plegado
 * en «Más datos»: vacío, lo pone odentIA. La ayuda y el error van junto a cada
 * campo; arriba solo queda lo que no es de un campo.
 */
import { findInventoryUnit, formatMoneyInput, parseMoney, unitFor } from "@odentia/clinical"
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  toast,
} from "@odentia/ui"
import { FormDrawer } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import {
  createProduct,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  parseWhole,
  type ProductDetail,
  type ProductInputBody,
  updateProduct,
} from "../../lib/inventory"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { MoneyInput, Optional, QuantityInput, UnitSelect } from "./fields"
import { useInventory } from "./inventory-scope"
import { appWords } from "../../lib/product-words"

type FieldKey = "name" | "usage" | "unit" | "purchase" | "minimum" | "salePrice" | "sku"

/** A qué campo va un rechazo del servidor (sus mensajes ya vienen en palabras). */
function fieldOfMessage(message: string): FieldKey | null {
  if (/código/i.test(message)) return "sku"
  if (/unidad de compra|cada unidad de compra|se compra igual|en qué unidad se compra/i.test(message)) return "purchase"
  if (/unidad/i.test(message)) return "unit"
  if (/mínimo/i.test(message)) return "minimum"
  if (/precio de venta|moneda/i.test(message)) return "salePrice"
  if (/nombre/i.test(message)) return "name"
  if (/marca si se usa/i.test(message)) return "usage"
  return null
}

/** La palabra de una unidad y, si es de la lista, su código. */
function unitBody(word: string): { word: string; code: string | null } {
  const listed = findInventoryUnit(word)
  return listed ? { word: listed.word, code: listed.code } : { word: word.trim(), code: null }
}

const same = (a: string, b: string) => a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es")

export function ProductFormDrawer({
  product,
  onClose,
  onSaved,
}: {
  /** Sin producto, es uno nuevo. */
  product: ProductDetail | null
  onClose: () => void
  onSaved: (id: string) => void
}) {
  const scope = useInventory()
  const { branches, branchName, currency, locale, can } = scope
  const queryClient = useQueryClient()
  const ids = React.useId()
  // Se arma una vez al abrir: lo que llega después no pisa lo escrito.
  const [initial] = React.useState(() => ({
      name: product?.name ?? "",
      usedInCare: product?.usedInCare ?? true,
      forSale: product?.forSale ?? false,
      unit: product?.unit ?? "unidad",
      purchaseUnit: product?.purchaseUnit ?? product?.unit ?? "unidad",
      factor: product && product.purchaseFactor > 1 ? formatWhole(product.purchaseFactor) : "",
      minimums: Object.fromEntries(
        branches.map((branch) => {
          const found = product?.minimums.find((item) => item.branchId === branch.id)
          return [branch.id, found && found.minQuantity > 0 ? formatWhole(found.minQuantity) : ""]
        }),
      ) as Record<string, string>,
      salePrice:
        product?.salePriceCents != null && product.saleCurrency ? formatMoneyInput(product.salePriceCents, product.saleCurrency, locale) : "",
      sku: product?.sku ?? "",
  }))
  const [values, setValues] = React.useState(initial)
  const [errors, setErrors] = React.useState<Partial<Record<FieldKey, string>>>({})
  const [formError, setFormError] = React.useState<string | null>(null)
  const [moreOpen, setMoreOpen] = React.useState(false)
  const set = <K extends keyof typeof initial>(key: K, value: (typeof initial)[K]) => setValues((current) => ({ ...current, [key]: value }))
  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  const unitLocked = Boolean(product?.hasHistory && !product.unitReview)
  const purchaseSame = values.purchaseUnit.trim() === "" || same(values.purchaseUnit, values.unit)
  const useLabel = values.usedInCare && values.forSale ? "Se usa y se vende por" : values.forSale ? "Se vende por" : "Se usa por"

  const mutation = useMutation({
    mutationFn: (body: ProductInputBody) => (product ? updateProduct(product.id, body) : createProduct(body)),
    onSuccess: (saved) => {
      toast.success(product ? "Cambios guardados" : `${saved.name} quedó en el inventario`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onSaved(saved.id)
    },
    onError: (error) => {
      const message = inventoryErrorMessage(error, { repeatable: Boolean(product) })
      const field = isAmbiguousMutationError(error) ? null : fieldOfMessage(message)
      if (field) {
        setErrors({ [field]: message })
        if (field === "sku") setMoreOpen(true)
        setFormError(null)
      } else setFormError(message)
    },
  })

  // Lo que deja cada venta: con el último precio de compra, por unidad de uso.
  const last = product?.lastPurchase
  const costPerUse = last?.unitCostCents !== undefined && last.unitFactor > 0 ? Math.round(last.unitCostCents / last.unitFactor) : null
  const salePriceCents = (() => {
    if (!currency || !values.salePrice.trim()) return null
    try {
      return parseMoney(values.salePrice, currency, locale)
    } catch {
      return null
    }
  })()
  const saleHelp = (() => {
    if (costPerUse === null || !last?.currency) return `Lo que se cobra por ${values.unit || "unidad"} en «Cobrar».`
    const cost = moneyText(costPerUse, last.currency)
    if (salePriceCents === null) return `Te costó ${cost} la última vez, por ${values.unit}.`
    const gain = salePriceCents - costPerUse
    const share = salePriceCents > 0 ? Math.round((gain / salePriceCents) * 100) : 0
    return gain >= 0
      ? `Te costó ${cost} la última vez: ganas ${moneyText(gain, last.currency)} por ${values.unit} (${share} %).`
      : `Te costó ${cost} la última vez: pierdes ${moneyText(-gain, last.currency)} por ${values.unit}.`
  })()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    // Crear sin respuesta del servidor puede haber guardado: no se repite a ciegas.
    if (mutation.isPending || (!product && isAmbiguousMutationError(mutation.error))) return
    const found: Partial<Record<FieldKey, string>> = {}
    const name = values.name.trim()
    if (!name) found.name = "Escribe el nombre del producto."
    if (!values.usedInCare && !values.forSale) found.usage = "Marca si se usa en las atenciones, si se vende o las dos."
    if (!values.unit.trim()) found.unit = "Elige la unidad o escribe una."
    let factor = 1
    if (!purchaseSame) {
      const parsed = parseWhole(values.factor)
      if (parsed === null || Number.isNaN(parsed) || parsed < 2)
        found.purchase = `Escribe qué cantidad de ${unitFor(2, values.unit || "unidad")} trae cada ${values.purchaseUnit} (desde 2).`
      else factor = parsed
    }
    const minimums: Array<{ branchId: string; minQuantity: number }> = []
    for (const branch of branches) {
      const parsed = parseWhole(values.minimums[branch.id] ?? "")
      if (parsed !== null && Number.isNaN(parsed)) {
        found.minimum = branches.length > 1 ? `El mínimo de ${branch.name} debe ser un número desde 0.` : "Escribe un número desde 0."
        break
      }
      minimums.push({ branchId: branch.id, minQuantity: parsed ?? 0 })
    }
    let sale: number | null | undefined
    if (values.forSale && can.prices) {
      if (!values.salePrice.trim()) sale = null
      else if (!currency) found.salePrice = "Configura la moneda de la clínica antes de ponerle precio de venta."
      else {
        try {
          sale = parseMoney(values.salePrice, currency, locale)
        } catch (error) {
          found.salePrice = error instanceof Error ? `${error.message}.` : "El precio no es un importe válido."
        }
      }
    }
    setErrors(found)
    if (Object.keys(found).length > 0) {
      setFormError(null)
      return
    }
    const use = unitBody(values.unit)
    const purchase = purchaseSame ? null : unitBody(values.purchaseUnit)
    const unitChanged = !product || !same(values.unit, product.unit)
    const body: ProductInputBody = {
      name,
      usedInCare: values.usedInCare,
      forSale: values.forSale,
      ...(unitChanged ? { unit: use.word, unitCode: use.code } : {}),
      purchaseUnit: purchase?.word ?? null,
      purchaseUnitCode: purchase?.code ?? null,
      purchaseFactor: purchase ? factor : 1,
      minimums,
      ...(sale !== undefined ? { salePriceCents: sale } : {}),
      ...(product ? (values.sku.trim() && values.sku.trim() !== product.sku ? { sku: values.sku.trim() } : {}) : { sku: values.sku.trim() || null }),
    }
    setFormError(null)
    mutation.mutate(body)
  }

  const fieldId = (key: string) => `${ids}-${key}`
  const helpId = (key: string) => `${ids}-${key}-ayuda`
  const errorOf = (key: FieldKey) =>
    errors[key] ? (
      <FieldError id={`${ids}-${key}-error`}>{errors[key]}</FieldError>
    ) : null
  const described = (key: FieldKey, help = true) => [help ? helpId(key) : null, errors[key] ? `${ids}-${key}-error` : null].filter(Boolean).join(" ") || undefined

  return (
    <FormDrawer
      open
      onClose={onClose}
      title={product ? "Editar producto" : "Nuevo producto"}
      description={branchName}
      error={formError}
      isDirty={dirty}
      isSubmitting={mutation.isPending}
      submitDisabled={!product && isAmbiguousMutationError(mutation.error)}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
      onSubmit={submit}
    >
      <FieldGroup>
        <Field data-invalid={errors.name ? true : undefined}>
          <FieldLabel htmlFor={fieldId("name")}>Nombre</FieldLabel>
          <Input
            id={fieldId("name")}
            autoFocus={!product}
            maxLength={200}
            value={values.name}
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described("name", false)}
            onChange={(event) => set("name", event.target.value)}
          />
          {errorOf("name")}
        </Field>

        <FieldSet data-invalid={errors.usage ? true : undefined}>
          <FieldLegend variant="label">Cómo se usa</FieldLegend>
          <Field orientation="horizontal">
            <Checkbox
              id={fieldId("care")}
              checked={values.usedInCare}
              onCheckedChange={(checked) => set("usedInCare", checked === true)}
              aria-describedby={described("usage")}
            />
            <FieldContent>
              <FieldLabel htmlFor={fieldId("care")}>Se usa en las atenciones</FieldLabel>
              <FieldDescription>Se descuenta solo al cerrar la atención de un servicio que lo usa.</FieldDescription>
            </FieldContent>
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id={fieldId("sale")}
              checked={values.forSale}
              onCheckedChange={(checked) => set("forSale", checked === true)}
              aria-describedby={described("usage")}
            />
            <FieldContent>
              <FieldLabel htmlFor={fieldId("sale")}>Se vende</FieldLabel>
              <FieldDescription>Aparece en «Cobrar» con su precio de venta.</FieldDescription>
            </FieldContent>
          </Field>
          <FieldDescription id={helpId("usage")}>Marca una o las dos. Un enjuague puede usarse en la limpieza y venderse.</FieldDescription>
          {errorOf("usage")}
        </FieldSet>

        <Field data-invalid={errors.unit ? true : undefined}>
          <FieldLabel htmlFor={fieldId("unit")}>{useLabel}</FieldLabel>
          <UnitSelect
            id={fieldId("unit")}
            label={useLabel}
            value={values.unit}
            disabled={unitLocked}
            invalid={Boolean(errors.unit)}
            aria-describedby={described("unit")}
            onChange={(next) =>
              setValues((current) => ({
                ...current,
                unit: next,
                // Si se compraba igual que se usaba, la compra sigue a la unidad de uso.
                purchaseUnit: same(current.purchaseUnit, current.unit) || current.purchaseUnit === "" ? next : current.purchaseUnit,
              }))
            }
          />
          <FieldDescription id={helpId("unit")}>
            {unitLocked
              ? `Ya tiene movimientos o compras en «${product?.unit}»: la unidad de uso no se cambia. Para otra unidad, crea otro producto.`
              : "Lo que se descuenta en cada atención, se vende y se cuenta."}
          </FieldDescription>
          {errorOf("unit")}
        </Field>

        <Field data-invalid={errors.purchase ? true : undefined}>
          <FieldLabel htmlFor={fieldId("purchase")}>Se compra por</FieldLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            <UnitSelect
              id={fieldId("purchase")}
              label="Se compra por"
              value={values.purchaseUnit}
              invalid={Boolean(errors.purchase)}
              aria-describedby={described("purchase")}
              onChange={(next) => set("purchaseUnit", next)}
            />
            {purchaseSame ? null : (
              <QuantityInput
                aria-label={`Cantidad de ${unitFor(2, values.unit || "unidad")} que trae cada ${values.purchaseUnit || "unidad de compra"}`}
                prefix="de"
                suffix={unitFor(parseWhole(values.factor) ?? 2, values.unit || "unidad")}
                value={values.factor}
                invalid={Boolean(errors.purchase)}
                aria-describedby={described("purchase")}
                onChange={(next) => set("factor", next)}
              />
            )}
          </div>
          <FieldDescription id={helpId("purchase")}>
            Si se compra igual que se usa, elige «{values.unit || "unidad"}» y queda en 1.
          </FieldDescription>
          {errorOf("purchase")}
        </Field>

        {branches.length > 1 ? (
          <FieldSet data-invalid={errors.minimum ? true : undefined}>
            <FieldLegend variant="label">Mínimo</FieldLegend>
            <div className="grid gap-2 sm:grid-cols-2">
              {branches.map((branch) => (
                <QuantityInput
                  key={branch.id}
                  aria-label={`Mínimo en ${branch.name}`}
                  prefix={branch.name}
                  suffix={unitFor(parseWhole(values.minimums[branch.id] ?? "") ?? 2, values.unit || "unidad")}
                  value={values.minimums[branch.id] ?? ""}
                  invalid={Boolean(errors.minimum)}
                  aria-describedby={described("minimum")}
                  onChange={(next) => set("minimums", { ...values.minimums, [branch.id]: next })}
                />
              ))}
            </div>
            <FieldDescription id={helpId("minimum")}>Con menos, aparece en «Hacen falta».</FieldDescription>
            {errorOf("minimum")}
          </FieldSet>
        ) : (
          <Field data-invalid={errors.minimum ? true : undefined}>
            <FieldLabel htmlFor={fieldId("minimum")}>
              Mínimo <Optional />
            </FieldLabel>
            <QuantityInput
              id={fieldId("minimum")}
              suffix={unitFor(parseWhole(values.minimums[branches[0]?.id ?? ""] ?? "") ?? 2, values.unit || "unidad")}
              value={values.minimums[branches[0]?.id ?? ""] ?? ""}
              invalid={Boolean(errors.minimum)}
              aria-describedby={described("minimum")}
              onChange={(next) => {
                const only = branches[0]?.id
                if (only) set("minimums", { ...values.minimums, [only]: next })
              }}
            />
            <FieldDescription id={helpId("minimum")}>Con menos, aparece en «Hacen falta».</FieldDescription>
            {errorOf("minimum")}
          </Field>
        )}

        {values.forSale && can.prices && currency ? (
          <Field data-invalid={errors.salePrice ? true : undefined}>
            <FieldLabel htmlFor={fieldId("salePrice")}>
              Precio de venta <Optional />
            </FieldLabel>
            <MoneyInput
              id={fieldId("salePrice")}
              currency={currency}
              value={values.salePrice}
              placeholder={formatMoneyInput(0, currency, locale)}
              invalid={Boolean(errors.salePrice)}
              aria-describedby={described("salePrice")}
              onChange={(next) => set("salePrice", next)}
            />
            <FieldDescription id={helpId("salePrice")}>{saleHelp}</FieldDescription>
            {errorOf("salePrice")}
          </Field>
        ) : null}

        <Collapsible className="flex flex-col gap-4" open={moreOpen} onOpenChange={setMoreOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="link" className="group h-auto min-h-11 self-start p-0 sm:min-h-8">
                Más datos <span className="font-normal text-muted-foreground">código</span>
                <ChevronDown aria-hidden className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none" />
              </Button>
            }
          />
          <CollapsibleContent className="flex flex-col gap-4">
            <Field data-invalid={errors.sku ? true : undefined}>
              <FieldLabel htmlFor={fieldId("sku")}>
                Código <Optional />
              </FieldLabel>
              <Input
                id={fieldId("sku")}
                maxLength={60}
                autoComplete="off"
                value={values.sku}
                aria-invalid={errors.sku ? true : undefined}
                aria-describedby={described("sku")}
                onChange={(event) => set("sku", event.target.value)}
              />
              <FieldDescription id={helpId("sku")}>
                {product ? "Para encontrarlo rápido. Si lo dejas vacío, se queda el que tiene." : `Para encontrarlo rápido. Si lo dejas vacío, ${appWords().name} pone uno.`}
              </FieldDescription>
              {errorOf("sku")}
            </Field>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>
    </FormDrawer>
  )
}
