/**
 * Formulario de producto (tableros 7, 16 y 19): nombre, cómo se usa (en las
 * atenciones, se vende o las dos), en qué se usa y en qué se compra, el mínimo
 * de cada sede y, si se vende, su precio con lo que deja. El código va plegado
 * en «Más datos»: vacío, lo pone odentIA. La ayuda y el error van junto a cada
 * campo; junto a los botones solo queda lo que no es de un campo.
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
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  toast,
} from "@odentia/ui"
import { FormDrawer, useAppForm, useFormSurface } from "@odentia/ui-patterns"
import { useStore } from "@tanstack/react-form"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { ChevronDown } from "lucide-react"
import * as React from "react"
import { z } from "zod"
import {
  createProduct,
  formatWhole,
  inventoryKeys,
  inventoryUnconfirmedMessage,
  moneyText,
  type ProductDetail,
  type ProductInputBody,
  parseWhole,
  updateProduct,
} from "../../lib/inventory"
import { appWords } from "../../lib/product-words"
import { isAmbiguousMutationError } from "../../lib/query-error"
import { MoneyInput, Optional, QuantityInput, UnitSelect } from "./fields"
import { useInventory } from "./inventory-scope"

/** La palabra de una unidad y, si es de la lista, su código. */
function unitBody(word: string): { word: string; code: string | null } {
  const listed = findInventoryUnit(word)
  return listed ? { word: listed.word, code: listed.code } : { word: word.trim(), code: null }
}

const same = (a: string, b: string) => a.trim().toLocaleLowerCase("es") === b.trim().toLocaleLowerCase("es")

/** El precio escrito en la unidad menor de la moneda, o el motivo por el que no se entiende. */
function readPrice(text: string, currency: string, locale: string): { cents: number } | { error: string } {
  try {
    return { cents: parseMoney(text, currency, locale) }
  } catch (error) {
    return { error: error instanceof Error ? `${error.message}.` : "El precio no es un importe válido." }
  }
}

/** Los mismos topes que el servidor (`purchaseFactorOf`, `counted`, `cents`). */
const MAX_FACTOR = 100_000
const MAX_COUNT = 1_000_000_000
const MAX_CENTS = 2_147_483_647

const productShape = z.object({
  name: z.string().trim().min(1, "Escribe el nombre del producto.").max(200, "El nombre admite hasta 200 caracteres."),
  usage: z.object({ care: z.boolean(), sale: z.boolean() }),
  unit: z.string().trim().min(1, "Elige la unidad o escribe una.").max(60, "La unidad admite hasta 60 caracteres."),
  purchaseUnit: z.string().trim().max(60, "La unidad admite hasta 60 caracteres."),
  factor: z.string(),
  minimums: z.array(z.object({ branchId: z.string(), name: z.string(), minQuantity: z.string() })),
  salePrice: z.string(),
  sku: z.string().trim().max(60, "El código admite hasta 60 caracteres."),
})

type ProductValues = z.input<typeof productShape>

/** El servidor nombra los datos como el cuerpo; el formulario, como la pantalla. */
const SERVER_FIELDS: Record<string, string> = {
  usedInCare: "usage",
  forSale: "usage",
  purchaseFactor: "factor",
  salePriceCents: "salePrice",
}

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
  const [initial] = React.useState<ProductValues>(() => ({
    name: product?.name ?? "",
    usage: { care: product?.usedInCare ?? true, sale: product?.forSale ?? false },
    unit: product?.unit ?? "unidad",
    purchaseUnit: product?.purchaseUnit ?? product?.unit ?? "unidad",
    factor: product && product.purchaseFactor > 1 ? formatWhole(product.purchaseFactor) : "",
    minimums: branches.map((branch) => {
      const found = product?.minimums.find((item) => item.branchId === branch.id)
      return { branchId: branch.id, name: branch.name, minQuantity: found && found.minQuantity > 0 ? formatWhole(found.minQuantity) : "" }
    }),
    salePrice: product?.salePriceCents != null && product.saleCurrency ? formatMoneyInput(product.salePriceCents, product.saleCurrency, locale) : "",
    sku: product?.sku ?? "",
  }))
  const [moreOpen, setMoreOpen] = React.useState(false)
  const unitLocked = Boolean(product?.hasHistory && !product.unitReview)
  // El precio solo se pinta (y se valida y se envía) con permiso y con la moneda de la clínica.
  const priced = can.prices && Boolean(currency)

  const schema = React.useMemo(
    () =>
      productShape.superRefine((value, ctx) => {
        if (!value.usage.care && !value.usage.sale)
          ctx.addIssue({ code: "custom", path: ["usage"], message: "Marca si se usa en las atenciones, si se vende o las dos." })
        const purchaseSame = value.purchaseUnit.trim() === "" || same(value.purchaseUnit, value.unit)
        if (!purchaseSame) {
          const factor = parseWhole(value.factor)
          if (factor === null || Number.isNaN(factor) || factor < 2 || factor > MAX_FACTOR)
            ctx.addIssue({
              code: "custom",
              path: ["factor"],
              message: `Escribe qué cantidad de ${unitFor(2, value.unit || "unidad")} trae cada ${value.purchaseUnit} (de 2 a ${formatWhole(MAX_FACTOR)}).`,
            })
        }
        value.minimums.forEach((row, index) => {
          const parsed = parseWhole(row.minQuantity)
          if (parsed !== null && (Number.isNaN(parsed) || parsed > MAX_COUNT))
            ctx.addIssue({
              code: "custom",
              path: ["minimums", index, "minQuantity"],
              message: value.minimums.length > 1 ? `El mínimo de ${row.name} debe ser un número desde 0.` : "Escribe un número desde 0.",
            })
        })
        if (value.usage.sale && priced && currency && value.salePrice.trim()) {
          const price = readPrice(value.salePrice, currency, locale)
          if ("error" in price) ctx.addIssue({ code: "custom", path: ["salePrice"], message: price.error })
          else if (price.cents > MAX_CENTS) ctx.addIssue({ code: "custom", path: ["salePrice"], message: "El precio es demasiado alto." })
        }
      }),
    [currency, locale, priced],
  )

  const mutation = useMutation({
    mutationFn: (body: ProductInputBody) => (product ? updateProduct(product.id, body) : createProduct(body)),
    onSuccess: (saved) => {
      toast.success(product ? "Cambios guardados" : `${saved.name} quedó en el inventario`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      onSaved(saved.id)
    },
  })
  // Crear sin respuesta del servidor puede haber guardado: no se repite a ciegas.
  const blocked = !product && isAmbiguousMutationError(mutation.error)

  const form = useAppForm({
    defaultValues: initial,
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      const purchaseSame = value.purchaseUnit.trim() === "" || same(value.purchaseUnit, value.unit)
      const use = unitBody(value.unit)
      const purchase = purchaseSame ? null : unitBody(value.purchaseUnit)
      const unitChanged = !product || !same(value.unit, product.unit)
      let sale: number | null | undefined
      if (value.usage.sale && priced && currency) {
        const price = value.salePrice.trim() ? readPrice(value.salePrice, currency, locale) : null
        sale = price && "cents" in price ? price.cents : null
      }
      const body: ProductInputBody = {
        name: value.name.trim(),
        usedInCare: value.usage.care,
        forSale: value.usage.sale,
        ...(unitChanged ? { unit: use.word, unitCode: use.code } : {}),
        purchaseUnit: purchase?.word ?? null,
        purchaseUnitCode: purchase?.code ?? null,
        purchaseFactor: purchase ? (parseWhole(value.factor) ?? 1) : 1,
        // En el mismo orden que las filas: `minimums[i]` del servidor es la fila i.
        minimums: value.minimums.map((row) => ({ branchId: row.branchId, minQuantity: parseWhole(row.minQuantity) ?? 0 })),
        ...(sale !== undefined ? { salePriceCents: sale } : {}),
        ...(product ? (value.sku.trim() && value.sku.trim() !== product.sku ? { sku: value.sku.trim() } : {}) : { sku: value.sku.trim() || null }),
      }
      await mutation.mutateAsync(body)
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: SERVER_FIELDS,
    formMessage: (error) => inventoryUnconfirmedMessage(error, { repeatable: Boolean(product) }),
  })

  const values = useStore(form.store, (state) => state.values)
  const purchaseSame = values.purchaseUnit.trim() === "" || same(values.purchaseUnit, values.unit)
  const useLabel = values.usage.care && values.usage.sale ? "Se usa y se vende por" : values.usage.sale ? "Se vende por" : "Se usa por"

  // Un error del código (del cliente o del servidor) abre «Más datos»: nunca queda escondido.
  const skuError = useStore(form.store, (state) => Object.values(state.fieldMeta.sku?.errorMap ?? {}).some(Boolean))
  React.useEffect(() => {
    if (skuError) setMoreOpen(true)
  }, [skuError])

  // Lo que deja cada venta: con el último precio de compra, por unidad de uso.
  const last = product?.lastPurchase
  const costPerUse = last?.unitCostCents !== undefined && last.unitFactor > 0 ? Math.round(last.unitCostCents / last.unitFactor) : null
  const salePriceCents = (() => {
    if (!currency || !values.salePrice.trim()) return null
    const price = readPrice(values.salePrice, currency, locale)
    return "cents" in price ? price.cents : null
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

  return (
    <FormDrawer
      {...surface}
      open
      onClose={onClose}
      title={product ? "Editar producto" : "Nuevo producto"}
      description={branchName}
      submitDisabled={blocked}
      // Enter tampoco reenvía: el aviso de que no se pudo confirmar sigue a la vista.
      onSubmit={(event) => (blocked ? event.preventDefault() : surface.onSubmit(event))}
      submitLabel="Guardar"
      cancelLabel="Cancelar"
    >
      <FieldGroup>
        <form.AppField name="name">{(field) => <field.TextField label="Nombre" autoFocus={!product} maxLength={200} />}</form.AppField>

        <form.AppField name="usage">
          {(field) => (
            <field.Group legend="Cómo se usa" description={<>Marca una o las dos. {appWords().examples.usedAndSold}</>}>
              {(control) => (
                <>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${ids}-care`}
                      checked={field.state.value.care}
                      onCheckedChange={(checked) => field.handleChange({ ...field.state.value, care: checked === true })}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${ids}-care`}>Se usa en las atenciones</FieldLabel>
                      <FieldDescription>Se descuenta solo al cerrar la atención de un servicio que lo usa.</FieldDescription>
                    </FieldContent>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id={`${ids}-sale`}
                      checked={field.state.value.sale}
                      onCheckedChange={(checked) => field.handleChange({ ...field.state.value, sale: checked === true })}
                      aria-invalid={control.invalid || undefined}
                      aria-describedby={control.describedBy}
                      onBlur={control.onBlur}
                    />
                    <FieldContent>
                      <FieldLabel htmlFor={`${ids}-sale`}>Se vende</FieldLabel>
                      <FieldDescription>Aparece en «Cobrar» con su precio de venta.</FieldDescription>
                    </FieldContent>
                  </Field>
                </>
              )}
            </field.Group>
          )}
        </form.AppField>

        <form.AppField name="unit">
          {(field) => (
            <field.Control
              label={useLabel}
              description={
                unitLocked
                  ? `Ya tiene movimientos o compras en «${product?.unit}»: la unidad de uso no se cambia. Para otra unidad, crea otro producto.`
                  : "Lo que se descuenta en cada atención, se vende y se cuenta."
              }
            >
              {(control) => (
                <UnitSelect
                  id={control.id}
                  label={useLabel}
                  value={field.state.value}
                  disabled={unitLocked}
                  invalid={control.invalid}
                  aria-describedby={control.describedBy}
                  onChange={(next) => {
                    // Si se compraba igual que se usaba, la compra sigue a la unidad de uso.
                    const purchase = form.getFieldValue("purchaseUnit")
                    if (same(purchase, field.state.value) || purchase === "") form.setFieldValue("purchaseUnit", next)
                    field.handleChange(next)
                  }}
                />
              )}
            </field.Control>
          )}
        </form.AppField>

        <div className="grid gap-2 sm:grid-cols-2">
          <form.AppField name="purchaseUnit">
            {(field) => (
              <field.Control label="Se compra por" description={`Si se compra igual que se usa, elige «${values.unit || "unidad"}» y queda en 1.`}>
                {(control) => (
                  <UnitSelect
                    id={control.id}
                    label="Se compra por"
                    value={field.state.value}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
          {purchaseSame ? null : (
            <form.AppField name="factor">
              {(field) => (
                <field.Control
                  hideLabel
                  className="sm:pt-7"
                  label={`Cantidad de ${unitFor(2, values.unit || "unidad")} que trae cada ${values.purchaseUnit || "unidad de compra"}`}
                >
                  {(control) => (
                    <QuantityInput
                      id={control.id}
                      prefix="de"
                      suffix={unitFor(parseWhole(field.state.value) ?? 2, values.unit || "unidad")}
                      value={field.state.value}
                      invalid={control.invalid}
                      aria-describedby={control.describedBy}
                      onChange={(next) => field.handleChange(next)}
                    />
                  )}
                </field.Control>
              )}
            </form.AppField>
          )}
        </div>

        <form.AppField name="minimums" mode="array">
          {(list) =>
            branches.length > 1 ? (
              <FieldSet>
                <FieldLegend variant="label">Mínimo</FieldLegend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {list.state.value.map((row, index) => (
                    <form.AppField key={row.branchId} name={`minimums[${index}].minQuantity`}>
                      {(field) => (
                        <field.Control hideLabel label={`Mínimo en ${row.name}`}>
                          {(control) => (
                            <QuantityInput
                              id={control.id}
                              prefix={row.name}
                              suffix={unitFor(parseWhole(field.state.value) ?? 2, values.unit || "unidad")}
                              value={field.state.value}
                              invalid={control.invalid}
                              aria-describedby={[control.describedBy, `${ids}-minimo-ayuda`].filter(Boolean).join(" ")}
                              onChange={(next) => field.handleChange(next)}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  ))}
                </div>
                <FieldDescription id={`${ids}-minimo-ayuda`}>Con menos, aparece en «Hacen falta».</FieldDescription>
              </FieldSet>
            ) : (
              list.state.value.map((row, index) => (
                <form.AppField key={row.branchId} name={`minimums[${index}].minQuantity`}>
                  {(field) => (
                    <field.Control
                      label={
                        <>
                          Mínimo <Optional />
                        </>
                      }
                      description="Con menos, aparece en «Hacen falta»."
                    >
                      {(control) => (
                        <QuantityInput
                          id={control.id}
                          suffix={unitFor(parseWhole(field.state.value) ?? 2, values.unit || "unidad")}
                          value={field.state.value}
                          invalid={control.invalid}
                          aria-describedby={control.describedBy}
                          onChange={(next) => field.handleChange(next)}
                        />
                      )}
                    </field.Control>
                  )}
                </form.AppField>
              ))
            )
          }
        </form.AppField>

        {values.usage.sale && priced && currency ? (
          <form.AppField name="salePrice">
            {(field) => (
              <field.Control
                label={
                  <>
                    Precio de venta <Optional />
                  </>
                }
                description={saleHelp}
              >
                {(control) => (
                  <MoneyInput
                    id={control.id}
                    currency={currency}
                    value={field.state.value}
                    placeholder={formatMoneyInput(0, currency, locale)}
                    invalid={control.invalid}
                    aria-describedby={control.describedBy}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
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
          {/* Montado aunque esté plegado: lo que el servidor diga del código llega a su campo. */}
          <CollapsibleContent keepMounted className="flex flex-col gap-4">
            <form.AppField name="sku">
              {(field) => (
                <field.TextField
                  label={
                    <>
                      Código <Optional />
                    </>
                  }
                  description={
                    product ? "Para encontrarlo rápido. Si lo dejas vacío, se queda el que tiene." : `Para encontrarlo rápido. Si lo dejas vacío, ${appWords().name} pone uno.`
                  }
                  maxLength={60}
                  autoComplete="off"
                />
              )}
            </form.AppField>
          </CollapsibleContent>
        </Collapsible>
      </FieldGroup>
    </FormDrawer>
  )
}
