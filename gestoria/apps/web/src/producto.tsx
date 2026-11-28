import { Badge, Button, FieldGroup, Input, toast } from "@odentia/ui"
import {
  ConfirmDialog,
  clearSubmitErrors,
  DatePickerButton,
  ErrorState,
  FormDrawer,
  RadioChips,
  SubmitButton,
  submitErrorMessage,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { ArrowLeft, ImagePlus, Plus, Trash2, X } from "lucide-react"
import { type ReactNode, useId, useRef, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import {
  CATALOG_KEY,
  CategoryOptions,
  draftsOf,
  OPTIONS_HELP,
  OptionsEditor,
  optionsField,
  optionsOf,
  optionsSchema,
  useCatalog,
} from "./catalogo"
import { api } from "./lib/api"
import {
  MOVEMENT_NAMES,
  type Movement,
  money,
  moneyInput,
  type ProductDetail,
  type Promotion,
  priceRange,
  type Relation,
  readMoney,
  type Variant,
  variantName,
} from "./lib/tienda"
import { Photo, shrinkPhoto } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Un producto del catálogo (lienzo B, tableros 7 y 14): sus datos y opciones, el precio y lo que
 * Sofi puede negociar, sus fotos, cada variante con su stock y su kardex, y lo que Sofi puede
 * recomendar junto a él. Ventas lo ve todo sin cambiarlo; el servidor lo rechaza igual.
 */

const PRODUCT_KEY = (storeId: string, productId: string) => ["producto", storeId, productId]

function Card({
  title,
  description,
  action,
  children,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

export function ProductPage() {
  const { store } = useStoreContext()
  const { productId } = useParams({ strict: false }) as { productId: string }
  const canEdit = store.permissions.includes("configuracion")
  const product = useQuery({
    queryKey: PRODUCT_KEY(store.id, productId),
    queryFn: () =>
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/productos/${productId}`),
  })
  const back = (
    <Link
      to="/tiendas/$id/catalogo"
      params={{ id: store.id }}
      className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Catálogo
    </Link>
  )
  if (product.isPending)
    return (
      <>
        {back}
        <StoreHeader title="Producto" />
        <p className="text-sm text-muted-foreground">Cargando el producto…</p>
      </>
    )
  if (product.isError)
    return (
      <>
        {back}
        <StoreHeader title="Producto" />
        <ErrorState error={product.error} onRetry={() => void product.refetch()} />
      </>
    )
  const p = product.data.product
  return (
    <>
      {back}
      <StoreHeader
        title={p.name}
        subtitle={[
          p.category,
          priceRange(p.fromCents, p.toCents, store.currency),
          `${p.variants.length} ${p.variants.length === 1 ? "variante" : "variantes"}`,
          `${p.variants.reduce((n, v) => n + v.stock, 0)} en stock`,
        ]
          .filter(Boolean)
          .join(" · ")}
      />
      {canEdit ? null : (
        <p className="text-sm text-muted-foreground">
          Lo ves como Ventas: los cambios los hacen el dueño o un administrador.
        </p>
      )}
      <div className="grid min-w-0 gap-6 lg:grid-cols-2 lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <DataCard key={`datos-${p.id}`} product={p} canEdit={canEdit} />
          <PhotosCard product={p} canEdit={canEdit} />
          <RelatedCard product={p} canEdit={canEdit} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <PriceCard key={`precio-${p.id}`} product={p} canEdit={canEdit} />
        </div>
      </div>
      <VariantsCard product={p} canEdit={canEdit} />
      {canEdit ? <DeleteProduct product={p} /> : null}
    </>
  )
}

/** Guarda un cambio del producto y deja la página con lo que devolvió el servidor. */
function useSaveProduct(product: ProductDetail, done: string) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/productos/${product.id}`, {
        method: "PATCH",
        body: patch,
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData(PRODUCT_KEY(store.id, product.id), result)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
      toast.success(done)
    },
  })
}

function DataCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const save = useSaveProduct(product, "Producto guardado")
  const categoriesId = useId()
  const form = useAppForm({
    defaultValues: {
      name: product.name,
      category: product.category ?? "",
      description: product.description,
      drafts: draftsOf(product.options),
    },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, "Escribe el nombre del producto"),
        category: z.string(),
        description: z.string(),
        drafts: optionsSchema,
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      // Las opciones van solo si se tocaron: guardar el nombre no rehace las variantes.
      const touched = JSON.stringify(value.drafts) !== JSON.stringify(draftsOf(product.options))
      await save.mutateAsync({
        name: value.name,
        category: value.category || null,
        description: value.description,
        ...(touched ? { options: optionsOf(value.drafts) } : {}),
      })
      formApi.reset(value)
    },
  })
  const submit = useFormSubmit(form, { fieldMap: optionsField })
  const error = useFormSubmitError(form)

  return (
    <Card title="Datos y opciones">
      <form noValidate onSubmit={submit}>
        <fieldset disabled={!canEdit} className="contents">
          <FieldGroup className="gap-5">
            <form.AppField name="name">
              {(field) => <field.TextField label="Nombre" maxLength={120} />}
            </form.AppField>
            <form.AppField name="category">
              {(field) => <field.TextField label="Categoría" list={categoriesId} maxLength={60} />}
            </form.AppField>
            <CategoryOptions id={categoriesId} storeId={store.id} />
            <form.AppField name="description">
              {(field) => (
                <field.TextareaField
                  label="Lo que Sofi puede contar"
                  rows={3}
                  maxLength={2000}
                  description="Material, horma, cuidados. Sofi no inventa lo que no está aquí."
                />
              )}
            </form.AppField>
            <form.AppField name="drafts">
              {(field) => (
                <field.Group legend="Opciones" description={OPTIONS_HELP}>
                  {(control) => (
                    <OptionsEditor
                      control={control}
                      drafts={field.state.value}
                      onChange={field.handleChange}
                      disabled={!canEdit}
                    />
                  )}
                </field.Group>
              )}
            </form.AppField>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            {canEdit ? (
              <form.Subscribe selector={(state) => state.isSubmitting}>
                {(pending) => (
                  <SubmitButton type="submit" pending={pending} className="self-start">
                    Guardar
                  </SubmitButton>
                )}
              </form.Subscribe>
            ) : null}
          </FieldGroup>
        </fieldset>
      </form>
    </Card>
  )
}

/** El aviso del precio mínimo frente a lo que costó (tablero 14): avisa y deja guardar igual. */
function CostNotice({ product }: { product: ProductDetail }) {
  const { store } = useStoreContext()
  const w = product.costWarning
  if (!w) return null
  const text =
    w.kind === "perdida"
      ? `Venderías con pérdida de ${money(w.lossCents, store.currency)} por unidad: te costó ${money(w.costCents, store.currency)} (la última entrada del kardex). Si es una liquidación, déjalo así.`
      : w.marginCents === 0
        ? `Es justo lo que te costó (${money(w.costCents, store.currency)}, la última entrada del kardex). Si es una liquidación, déjalo así.`
        : `Está a ${money(w.marginCents, store.currency)} de lo que te costó (${money(w.costCents, store.currency)}, la última entrada del kardex). Si es una liquidación, déjalo así.`
  return (
    <p
      role="status"
      className="rounded-lg border border-warning/50 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground"
    >
      {text}
    </p>
  )
}

/** Lo que el servidor señala del precio (`quantityPrices.0.unitPriceCents`), en su campo. */
function priceField(serverField: string): string | undefined {
  if (serverField === "listPriceCents") return "list"
  if (serverField === "minPriceCents") return "min"
  if (serverField === "quantityPrices" || serverField.startsWith("quantityPrices.")) return "tiers"
  if (serverField === "promotions" || serverField.startsWith("promotions.")) return "promos"
  return undefined
}

function PriceCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const currency = store.currency
  const save = useSaveProduct(product, "Precios guardados")
  const form = useAppForm({
    defaultValues: {
      list: moneyInput(product.listPriceCents, currency),
      min: moneyInput(product.minPriceCents, currency),
      tiers: product.quantityPrices.map((t) => ({
        quantity: String(t.minQuantity),
        price: moneyInput(t.unitPriceCents, currency),
      })),
      promos: product.promotions as Promotion[],
    },
    validators: {
      onSubmit: z
        .object({
          list: z.string(),
          min: z.string(),
          tiers: z.array(z.object({ quantity: z.string(), price: z.string() })),
          promos: z.array(
            z.object({
              name: z.string(),
              percentOff: z.number(),
              startsOn: z.string(),
              endsOn: z.string(),
            }),
          ),
        })
        .superRefine((value, ctx) => {
          const issue = (path: string, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message })
          const listCents = readMoney(value.list, currency)
          const minCents = value.min.trim() ? readMoney(value.min, currency) : null
          if (!listCents) issue("list", "Escribe el precio, como 129 o 129.90")
          if (value.min.trim() && !minCents)
            issue("min", "Escribe el precio mínimo, o déjalo vacío")
          if (listCents && minCents && minCents > listCents)
            issue("min", "El mínimo no puede ser mayor que el de lista")
          if (
            value.tiers.some((t) => {
              const n = Number(t.quantity)
              return !Number.isInteger(n) || n < 2 || !readMoney(t.price, currency)
            })
          )
            issue(
              "tiers",
              "Cada precio por cantidad necesita desde cuántas unidades (2 o más) y su precio",
            )
          if (
            value.promos.some(
              (p) =>
                !p.name.trim() ||
                !p.startsOn ||
                !p.endsOn ||
                !(p.percentOff >= 1 && p.percentOff <= 90),
            )
          )
            issue(
              "promos",
              "Cada promoción necesita su nombre, el porcentaje (1 a 90) y sus fechas",
            )
        }),
    },
    onSubmit: async ({ value, formApi }) => {
      await save.mutateAsync({
        listPriceCents: readMoney(value.list, currency),
        minPriceCents: value.min.trim() ? readMoney(value.min, currency) : null,
        quantityPrices: value.tiers.map((t) => ({
          minQuantity: Number(t.quantity),
          unitPriceCents: readMoney(t.price, currency),
        })),
        promotions: value.promos,
      })
      formApi.reset(value)
    },
  })
  const submit = useFormSubmit(form, { fieldMap: priceField })
  const error = useFormSubmitError(form)
  const differs = product.fromCents !== product.toCents

  return (
    <Card
      title="Precio y negociación"
      description={
        differs
          ? `Sofi siempre da un número: como las variantes cuestan distinto, dice «Desde ${money(product.fromCents, currency)}» y el exacto al elegir.`
          : `Sofi siempre da un número: «Cuesta ${money(product.fromCents, currency)}».`
      }
    >
      <form noValidate onSubmit={submit}>
        <fieldset disabled={!canEdit} className="contents">
          <form.Subscribe selector={(state) => state.values}>
            {(values) => {
              const listCents = readMoney(values.list, currency)
              const minCents = values.min.trim() ? readMoney(values.min, currency) : null
              return (
                <FieldGroup className="gap-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <form.AppField name="list">
                      {(field) => (
                        <field.Control label="Precio de lista">
                          {(control) => (
                            <MoneyInput
                              control={control}
                              currency={currency}
                              value={field.state.value}
                              onChange={field.handleChange}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                    <form.AppField name="min">
                      {(field) => (
                        <field.Control
                          label="Precio mínimo de venta"
                          description={
                            listCents && minCents && minCents <= listCents
                              ? `Sofi puede ceder hasta ${money(listCents - minCents, currency)} por unidad.`
                              : "Vacío: no se negocia."
                          }
                        >
                          {(control) => (
                            <MoneyInput
                              control={control}
                              currency={currency}
                              value={field.state.value}
                              onChange={field.handleChange}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  </div>
                  <CostNotice product={product} />
                  <form.AppField name="tiers" mode="array">
                    {(tiers) => (
                      <tiers.Group
                        legend="Precio por cantidad"
                        description="No se suma con una promoción: va el mejor para el cliente."
                      >
                        {() => (
                          <>
                            {tiers.state.value.map((tier, i) => {
                              const unit = readMoney(tier.price, currency)
                              const qty = Number(tier.quantity)
                              return (
                                <div
                                  // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                                  key={i}
                                  className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-end gap-2"
                                >
                                  <form.AppField name={`tiers[${i}].quantity`}>
                                    {(field) => (
                                      <field.TextField
                                        label="Desde"
                                        inputMode="numeric"
                                        description="unidades"
                                      />
                                    )}
                                  </form.AppField>
                                  <form.AppField name={`tiers[${i}].price`}>
                                    {(field) => (
                                      <field.Control
                                        label="Cada una a"
                                        description={
                                          unit && qty >= 2
                                            ? `${qty} cuestan ${money(unit * qty, currency)}`
                                            : " "
                                        }
                                      >
                                        {(control) => (
                                          <MoneyInput
                                            control={control}
                                            currency={currency}
                                            value={field.state.value}
                                            onChange={field.handleChange}
                                          />
                                        )}
                                      </field.Control>
                                    )}
                                  </form.AppField>
                                  {canEdit ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="mb-6"
                                      aria-label={`Quitar el precio desde ${tier.quantity || "esta cantidad"}`}
                                      onClick={() => tiers.removeValue(i)}
                                    >
                                      <Trash2 aria-hidden />
                                    </Button>
                                  ) : null}
                                </div>
                              )
                            })}
                            {canEdit && tiers.state.value.length < 5 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="self-start"
                                onClick={() => tiers.pushValue({ quantity: "2", price: "" })}
                              >
                                <Plus aria-hidden />
                                Precio por cantidad
                              </Button>
                            ) : null}
                            {tiers.state.value.length === 0 && !canEdit ? (
                              <p className="text-sm text-muted-foreground">
                                Sin precio por cantidad.
                              </p>
                            ) : null}
                          </>
                        )}
                      </tiers.Group>
                    )}
                  </form.AppField>
                  <form.AppField name="promos" mode="array">
                    {(promos) => (
                      <promos.Group
                        legend="Promociones"
                        description="Un porcentaje menos, de un día a otro. No se pisan ni se suman."
                      >
                        {() => (
                          <>
                            {promos.state.value.map((promo, i) => {
                              const promoCents = Math.round(
                                (listCents ?? 0) * (1 - promo.percentOff / 100),
                              )
                              return (
                                <div
                                  // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                                  key={i}
                                  className="flex flex-col gap-2 rounded-lg border p-3"
                                >
                                  <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2">
                                    <form.AppField name={`promos[${i}].name`}>
                                      {(field) => (
                                        <field.TextField
                                          label="Nombre"
                                          maxLength={60}
                                          placeholder="Cyber"
                                        />
                                      )}
                                    </form.AppField>
                                    <form.AppField name={`promos[${i}].percentOff`}>
                                      {(field) => (
                                        <field.Control label="% menos">
                                          {(control) => (
                                            <Input
                                              {...control.props}
                                              inputMode="numeric"
                                              value={
                                                field.state.value ? String(field.state.value) : ""
                                              }
                                              onChange={(e) =>
                                                field.handleChange(
                                                  Number(e.target.value.replace(/\D/g, "")),
                                                )
                                              }
                                            />
                                          )}
                                        </field.Control>
                                      )}
                                    </form.AppField>
                                    {canEdit ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        aria-label={`Quitar la promoción ${promo.name || i + 1}`}
                                        onClick={() => promos.removeValue(i)}
                                      >
                                        <Trash2 aria-hidden />
                                      </Button>
                                    ) : null}
                                  </div>
                                  <div className="grid gap-2 sm:grid-cols-2">
                                    <form.AppField name={`promos[${i}].startsOn`}>
                                      {(field) => (
                                        <field.Control label="Desde">
                                          {(control) => (
                                            <DatePickerButton
                                              {...control.props}
                                              value={field.state.value}
                                              disabled={!canEdit}
                                              onChange={field.handleChange}
                                            />
                                          )}
                                        </field.Control>
                                      )}
                                    </form.AppField>
                                    <form.AppField name={`promos[${i}].endsOn`}>
                                      {(field) => (
                                        <field.Control label="Hasta">
                                          {(control) => (
                                            <DatePickerButton
                                              {...control.props}
                                              value={field.state.value}
                                              min={promo.startsOn || undefined}
                                              disabled={!canEdit}
                                              onChange={field.handleChange}
                                            />
                                          )}
                                        </field.Control>
                                      )}
                                    </form.AppField>
                                  </div>
                                  {promo.percentOff >= 1 &&
                                  listCents &&
                                  minCents &&
                                  promoCents < minCents ? (
                                    <p className="text-sm text-muted-foreground">
                                      Con esta promoción cuesta {money(promoCents, currency)}, menos
                                      que el mínimo.
                                    </p>
                                  ) : null}
                                </div>
                              )
                            })}
                            {canEdit && promos.state.value.length < 10 ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="self-start"
                                onClick={() =>
                                  promos.pushValue({
                                    name: "",
                                    percentOff: 10,
                                    startsOn: "",
                                    endsOn: "",
                                  })
                                }
                              >
                                <Plus aria-hidden />
                                Promoción
                              </Button>
                            ) : null}
                            {promos.state.value.length === 0 && !canEdit ? (
                              <p className="text-sm text-muted-foreground">Sin promociones.</p>
                            ) : null}
                          </>
                        )}
                      </promos.Group>
                    )}
                  </form.AppField>
                  {error ? (
                    <p role="alert" className="text-sm text-danger">
                      {error}
                    </p>
                  ) : null}
                  {canEdit ? (
                    <form.Subscribe selector={(state) => state.isSubmitting}>
                      {(pending) => (
                        <SubmitButton type="submit" pending={pending} className="self-start">
                          Guardar precios
                        </SubmitButton>
                      )}
                    </form.Subscribe>
                  ) : null}
                </FieldGroup>
              )
            }}
          </form.Subscribe>
        </fieldset>
      </form>
    </Card>
  )
}

function PhotosCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, product.id) })
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const blob = await shrinkPhoto(file)
        await api(`/api/tiendas/${store.id}/productos/${product.id}/fotos`, {
          method: "POST",
          raw: { type: blob.type, data: blob },
        })
      }
    },
    onSuccess: async () => {
      await refresh()
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
      toast.success("Foto agregada")
    },
    onError: async (error) => {
      await refresh()
      toast.error(error.message)
    },
  })
  const remove = useMutation({
    mutationFn: (photoId: string) =>
      api(`/api/tiendas/${store.id}/fotos/${photoId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refresh()
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
      toast.success("Foto borrada")
    },
    onError: (error) => toast.error(error.message),
  })
  const full = product.photos.length >= 8
  return (
    <Card
      title="Fotos"
      description={
        product.photos.length === 0
          ? "La primera es la que se ve en el catálogo. Hasta 8."
          : undefined
      }
    >
      <div className="flex flex-wrap gap-2">
        {product.photos.map((photo, i) => (
          <div key={photo.id} className="relative">
            <Photo
              storeId={store.id}
              photoId={photo.id}
              alt={`Foto ${i + 1} de ${product.name}`}
              className="size-20"
            />
            {canEdit ? (
              <Button
                type="button"
                variant="secondary"
                size="icon-sm"
                className="absolute -top-2 -right-2 rounded-full"
                aria-label={`Borrar la foto ${i + 1}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(photo.id)}
              >
                <X aria-hidden />
              </Button>
            ) : null}
          </div>
        ))}
        {canEdit && !full ? (
          <Button
            type="button"
            variant="outline"
            className="size-20 flex-col border-dashed"
            disabled={upload.isPending}
            onClick={() => input.current?.click()}
          >
            <ImagePlus aria-hidden />
            {upload.isPending ? "Subiendo…" : "Subir"}
          </Button>
        ) : null}
        {!canEdit && product.photos.length === 0 ? (
          <p className="text-sm text-muted-foreground">Sin fotos.</p>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])].slice(0, 8 - product.photos.length)
          if (files.length > 0) upload.mutate(files)
          e.target.value = ""
        }}
      />
    </Card>
  )
}

function VariantsCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const [kardexOf, setKardexOf] = useState<Variant | null>(null)
  const [editing, setEditing] = useState<Variant | null>(null)
  const [removing, setRemoving] = useState<Variant | null>(null)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: (variant: Variant) =>
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/variantes/${variant.id}`, {
        method: "DELETE",
      }),
    onSuccess: async (result) => {
      queryClient.setQueryData(PRODUCT_KEY(store.id, product.id), result)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
      toast.success("Variante quitada. Su kardex se conserva.")
      setRemoving(null)
    },
  })
  return (
    <Card
      title="Variantes y stock"
      description="El stock solo cambia con un movimiento: una entrada, una venta o un ajuste con su motivo."
    >
      <ul className="grid rounded-lg border md:grid-cols-2 md:divide-x-0 [&>li]:border-b md:[&>li:nth-child(odd)]:border-r">
        {product.variants.map((variant) => (
          <li key={variant.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <Photo
              storeId={store.id}
              photoId={variant.photoId ?? product.photos[0]?.id ?? null}
              alt=""
              className="size-9"
            />
            <div className="flex min-w-32 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{variantName(variant)}</span>
              <span className="truncate text-xs text-muted-foreground">
                {variant.sku} ·{" "}
                {variant.priceCents
                  ? money(variant.priceCents, store.currency)
                  : "precio del producto"}
              </span>
            </div>
            <span className="w-20 text-right text-sm tabular-nums">
              {variant.stock === 0 ? (
                <Badge variant="outline">Agotado</Badge>
              ) : (
                `${variant.stock} en stock`
              )}
            </span>
            <div className="flex gap-1">
              <Button variant="outline" size="sm" onClick={() => setKardexOf(variant)}>
                Kardex<span className="sr-only"> de {variantName(variant)}</span>
              </Button>
              {canEdit ? (
                <Button variant="ghost" size="sm" onClick={() => setEditing(variant)}>
                  Editar<span className="sr-only"> {variantName(variant)}</span>
                </Button>
              ) : null}
              {canEdit && product.variants.length > 1 ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Quitar ${variantName(variant)}`}
                  onClick={() => setRemoving(variant)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {kardexOf ? (
        <KardexSheet
          // En la columna lateral se puede abrir otro kardex sin cerrar este: cada variante, su formulario.
          key={kardexOf.id}
          product={product}
          variant={kardexOf}
          canEdit={canEdit}
          onClose={() => setKardexOf(null)}
        />
      ) : null}
      {editing ? (
        <VariantSheet
          key={editing.id}
          product={product}
          variant={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`¿Quitar «${removing ? variantName(removing) : ""}»?`}
        description={
          removing && removing.stock > 0
            ? `Tiene ${removing.stock} en stock: antes ajústalo a 0 desde su kardex, con el motivo.`
            : "Sofi deja de ofrecerla. Su kardex se conserva."
        }
        confirmLabel="Quitar"
        confirmDisabled={Boolean(removing && removing.stock > 0)}
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() => removing && remove.mutate(removing)}
        onClose={() => {
          remove.reset()
          setRemoving(null)
        }}
      />
    </Card>
  )
}

function VariantSheet({
  product,
  variant,
  onClose,
}: {
  product: ProductDetail
  variant: Variant
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/variantes/${variant.id}`, {
        method: "PATCH",
        body,
      }),
  })
  const form = useAppForm({
    defaultValues: {
      sku: variant.sku,
      price: moneyInput(variant.priceCents, store.currency),
      photoId: variant.photoId ?? "",
    },
    validators: {
      onSubmit: z.object({
        sku: z
          .string()
          .refine(
            (sku) => /^[A-Za-z0-9._/-]{1,40}$/.test(sku.trim()),
            "Hasta 40 letras, números, puntos o guiones, sin espacios",
          ),
        price: z
          .string()
          .refine(
            (price) => !price.trim() || Boolean(readMoney(price, store.currency)),
            "Escribe el precio, o déjalo vacío para usar el del producto",
          ),
        photoId: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const result = await save.mutateAsync({
        sku: value.sku.trim(),
        priceCents: value.price.trim() ? readMoney(value.price, store.currency) : null,
        photoId: value.photoId || null,
      })
      queryClient.setQueryData(PRODUCT_KEY(store.id, product.id), result)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
      toast.success("Variante guardada")
      onClose()
    },
  })
  const surface = useFormSurface(form, { fieldMap: { priceCents: "price" } })
  return (
    <FormDrawer
      {...surface}
      open
      title={variantName(variant)}
      description={product.name}
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="sku">
          {(field) => (
            <field.TextField
              label="Código"
              maxLength={40}
              description="El de tu inventario o el de Meta. Único en la tienda."
            />
          )}
        </form.AppField>
        <form.AppField name="price">
          {(field) => (
            <field.Control
              label="Precio propio (opcional)"
              description={`Vacío: usa el del producto, ${money(product.listPriceCents, store.currency)}.`}
            >
              {(control) => (
                <MoneyInput
                  control={control}
                  currency={store.currency}
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </field.Control>
          )}
        </form.AppField>
        <form.AppField name="photoId">
          {(field) => (
            <div className="flex flex-col gap-2">
              <field.SelectField
                label="Foto"
                options={[
                  { value: "", label: "La del producto" },
                  ...product.photos.map((photo, i) => ({
                    value: photo.id,
                    label: `Foto ${i + 1}`,
                  })),
                ]}
                description={
                  product.photos.length === 0
                    ? "Sube fotos en el producto para elegir una aquí."
                    : undefined
                }
              />
              {field.state.value ? (
                <Photo
                  storeId={store.id}
                  photoId={field.state.value}
                  alt="La foto elegida"
                  className="size-20"
                />
              ) : null}
            </div>
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

type MovementKind = "entrada" | "ajuste"

function KardexSheet({
  product,
  variant,
  canEdit,
  onClose,
}: {
  product: ProductDetail
  variant: Variant
  canEdit: boolean
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const key = ["kardex", store.id, variant.id]
  const kardex = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ stock: number; movements: Movement[] }>(
        `/api/tiendas/${store.id}/variantes/${variant.id}/kardex`,
      ),
  })
  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/tiendas/${store.id}/variantes/${variant.id}/movimientos`, { method: "POST", body }),
  })
  // Lo elegido en «Entrada o ajuste»: cambia lo que se pregunta y el botón.
  const [kind, setKind] = useState<MovementKind>("entrada")
  const form = useAppForm({
    defaultValues: { kind: "entrada" as MovementKind, quantity: "", cost: "", reason: "" },
    validators: {
      onSubmit: z
        .object({
          kind: z.enum(["entrada", "ajuste"]),
          quantity: z.string(),
          cost: z.string(),
          reason: z.string(),
        })
        .superRefine((value, ctx) => {
          const n = Number(value.quantity)
          const issue = (path: string, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message })
          if (value.kind === "entrada") {
            if (!Number.isInteger(n) || n < 1) issue("quantity", "Escribe cuántas entran")
            if (value.cost.trim() && readMoney(value.cost, store.currency) === null)
              issue("cost", "Escribe el costo, como 68 o 68.50, o déjalo vacío")
          } else {
            if (value.quantity.trim() === "" || !Number.isInteger(n) || n < 0)
              issue("quantity", "Escribe cuántas hay de verdad, 0 o más")
            if (value.reason.trim().length < 3)
              issue("reason", "Escribe el motivo del ajuste, como «par dañado»")
          }
        }),
    },
    onSubmit: async ({ value, formApi }) => {
      const n = Number(value.quantity)
      await move.mutateAsync(
        value.kind === "entrada"
          ? {
              kind: value.kind,
              quantity: n,
              unitCostCents: value.cost.trim() ? readMoney(value.cost, store.currency) : null,
              reason: value.reason.trim() || undefined,
            }
          : { kind: value.kind, counted: n, reason: value.reason },
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, product.id) }),
        queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" }),
      ])
      toast.success(value.kind === "entrada" ? "Entrada anotada" : "Ajuste anotado")
      formApi.reset({ kind: value.kind, quantity: "", cost: "", reason: "" })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { unitCostCents: "cost", counted: "quantity" },
  })
  const stock = kardex.data?.stock ?? variant.stock

  const when = (iso: string) =>
    new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short" })

  return (
    // Cambiar entre entrada y ajuste no es escribir: cerrar pregunta solo si hay algo escrito.
    <form.Subscribe
      selector={(state) =>
        Boolean(
          state.values.quantity.trim() || state.values.cost.trim() || state.values.reason.trim(),
        )
      }
    >
      {(typed) => (
        <FormDrawer
          {...surface}
          isDirty={typed}
          open
          title={`Kardex · ${variantName(variant)}`}
          description={`${product.name} · ${variant.sku} · quedan ${stock}`}
          onClose={onClose}
          cancelLabel="Cerrar"
          hideSubmit={!canEdit}
          submitLabel={kind === "entrada" ? "Anotar la entrada" : "Anotar el ajuste"}
        >
          <div className="flex flex-col gap-5">
            {canEdit ? (
              <FieldGroup className="gap-4">
                <form.AppField
                  name="kind"
                  listeners={{
                    onChange: ({ value }) => {
                      setKind(value)
                      // Lo que se dijo de la otra forma ya no corresponde.
                      clearSubmitErrors(form)
                    },
                  }}
                >
                  {(field) => (
                    <field.Group
                      legend="Entrada o ajuste"
                      description="Entrada: llegó mercadería. Ajuste: contaste y no cuadra."
                    >
                      {(control) => (
                        <RadioChips
                          aria-label="Entrada o ajuste"
                          value={field.state.value}
                          options={[
                            { value: "entrada", label: "Entrada" },
                            { value: "ajuste", label: "Ajuste" },
                          ]}
                          onChange={field.handleChange}
                          invalid={control.invalid}
                        />
                      )}
                    </field.Group>
                  )}
                </form.AppField>
                {kind === "entrada" ? (
                  <div className="grid grid-cols-2 gap-3">
                    <form.AppField name="quantity">
                      {(field) => <field.TextField label="Cuántas entran" inputMode="numeric" />}
                    </form.AppField>
                    <form.AppField name="cost">
                      {(field) => (
                        <field.Control
                          label="Costo por unidad"
                          description="Opcional. Con él se avisa si el mínimo queda cerca."
                        >
                          {(control) => (
                            <MoneyInput
                              control={control}
                              currency={store.currency}
                              value={field.state.value}
                              onChange={field.handleChange}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  </div>
                ) : (
                  <form.AppField name="quantity">
                    {(field) => (
                      <field.TextField
                        label="Cuántas hay de verdad"
                        inputMode="numeric"
                        description={`Hoy dice ${stock}. El ajuste es la diferencia.`}
                      />
                    )}
                  </form.AppField>
                )}
                <form.AppField name="reason">
                  {(field) => (
                    <field.TextareaField
                      label={kind === "ajuste" ? "Motivo" : "Nota (opcional)"}
                      rows={2}
                      maxLength={300}
                      placeholder={
                        kind === "ajuste"
                          ? "par dañado, conteo de fin de mes"
                          : "compra al proveedor"
                      }
                    />
                  )}
                </form.AppField>
              </FieldGroup>
            ) : null}
            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">Movimientos</h3>
              {kardex.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
              {kardex.isError ? (
                <ErrorState error={kardex.error} onRetry={() => void kardex.refetch()} />
              ) : null}
              {kardex.data && kardex.data.movements.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Todavía sin movimientos: el stock es 0.
                </p>
              ) : null}
              {kardex.data && kardex.data.movements.length > 0 ? (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="py-1.5 pr-2 font-semibold">Fecha</th>
                      <th className="py-1.5 pr-2 font-semibold">Movimiento</th>
                      <th className="py-1.5 pr-2 text-right font-semibold">Cant.</th>
                      <th className="py-1.5 text-right font-semibold">Saldo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {kardex.data.movements.map((m) => (
                      <tr key={m.id} className="border-b align-top last:border-0">
                        <td className="py-1.5 pr-2 whitespace-nowrap">{when(m.createdAt)}</td>
                        <td className="py-1.5 pr-2">
                          {MOVEMENT_NAMES[m.kind]}
                          {m.reference ? ` ${m.reference}` : ""}
                          {m.reason ? ` · «${m.reason}»` : ""}
                          {m.unitCostCents !== null
                            ? ` · ${money(m.unitCostCents, store.currency)} c/u`
                            : ""}
                          {m.actorName ? (
                            <span className="text-muted-foreground"> · {m.actorName}</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">
                          {m.quantity > 0 ? `+${m.quantity}` : `−${-m.quantity}`}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{m.balance}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          </div>
        </FormDrawer>
      )}
    </form.Subscribe>
  )
}

const RELATIONS: Record<Relation, string> = { parecido: "Parecido", combina: "Combina con" }

function RelatedCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const catalog = useCatalog(store.id)
  const save = useSaveProduct(product, "Recomendaciones guardadas")
  const drop = useSaveProduct(product, "Recomendaciones guardadas")
  // Lo elegido en «Cómo», para no ofrecer lo que ya está con esa relación.
  const [kind, setKind] = useState<Relation>("parecido")
  const current = product.links.map((l) => ({ productId: l.productId, kind: l.kind }))
  const form = useAppForm({
    defaultValues: { kind: "parecido" as Relation, other: "" },
    validators: {
      onSubmit: z.object({
        kind: z.enum(["parecido", "combina"]),
        other: z.string().min(1, "Elige un producto"),
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await save.mutateAsync({ links: [...current, { productId: value.other, kind: value.kind }] })
      formApi.reset({ kind: value.kind, other: "" })
    },
  })
  const submit = useFormSubmit(form, { fieldMap: { links: "other" } })
  const error = useFormSubmitError(form)
  const options = (catalog.data?.products ?? []).filter(
    (p) =>
      p.id !== product.id && !product.links.some((l) => l.productId === p.id && l.kind === kind),
  )
  return (
    <Card
      title="Sofi lo recomienda con"
      description="Lo parecido, si no hay su talla; lo que combina, para sumar al mismo despacho."
    >
      {product.links.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin productos relacionados.</p>
      ) : null}
      {(Object.keys(RELATIONS) as Relation[]).map((k) => {
        const list = product.links.filter((l) => l.kind === k)
        if (list.length === 0) return null
        return (
          <div key={k} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{RELATIONS[k]}</span>
            <ul className="flex flex-wrap gap-2">
              {list.map((l) => (
                <li
                  key={l.productId}
                  className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-3 text-sm"
                >
                  <Link
                    to="/tiendas/$id/catalogo/$productId"
                    params={{ id: store.id, productId: l.productId }}
                    className="hover:underline"
                  >
                    {l.name}
                  </Link>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-full"
                      aria-label={`Quitar ${l.name}`}
                      disabled={drop.isPending}
                      onClick={() =>
                        drop.mutate(
                          {
                            links: current.filter(
                              (c) => !(c.productId === l.productId && c.kind === l.kind),
                            ),
                          },
                          { onError: (failure) => toast.error(submitErrorMessage(failure)) },
                        )
                      }
                    >
                      <X aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {canEdit ? (
        <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
          <form.AppField name="kind" listeners={{ onChange: ({ value }) => setKind(value) }}>
            {(field) => (
              <field.Group legend="Cómo">
                {(control) => (
                  <RadioChips
                    aria-label="Cómo"
                    value={field.state.value}
                    options={(Object.keys(RELATIONS) as Relation[]).map((k) => ({
                      value: k,
                      label: RELATIONS[k],
                    }))}
                    onChange={field.handleChange}
                    invalid={control.invalid}
                  />
                )}
              </field.Group>
            )}
          </form.AppField>
          <div className="flex flex-wrap items-end gap-2">
            <form.AppField name="other">
              {(field) => (
                <field.SelectField
                  label="Producto"
                  className="min-w-40 flex-1"
                  placeholder="Elige un producto"
                  options={options.map((p) => ({ value: p.id, label: p.name }))}
                />
              )}
            </form.AppField>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(pending) => (
                <SubmitButton type="submit" variant="outline" pending={pending}>
                  Agregar
                </SubmitButton>
              )}
            </form.Subscribe>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </Card>
  )
}

function DeleteProduct({ product }: { product: ProductDetail }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [asking, setAsking] = useState(false)
  const remove = useMutation({
    mutationFn: () => api(`/api/tiendas/${store.id}/productos/${product.id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success(`${product.name} borrado`)
      await navigate({ to: "/tiendas/$id/catalogo", params: { id: store.id } })
    },
  })
  return (
    <div>
      <Button variant="ghost" className="text-danger" onClick={() => setAsking(true)}>
        <Trash2 aria-hidden />
        Borrar el producto
      </Button>
      <ConfirmDialog
        open={asking}
        title={`¿Borrar «${product.name}»?`}
        description="Solo se borra un producto que nunca movió stock. Si ya tiene kardex, quita las variantes que no vendes."
        confirmLabel="Borrar"
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          remove.reset()
          setAsking(false)
        }}
      />
    </div>
  )
}
