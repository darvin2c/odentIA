import {
  Badge,
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Input,
  toast,
} from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { ConfirmDialog, DatePickerButton, ErrorState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import { ArrowLeft, ImagePlus, Plus, Trash2, X } from "lucide-react"
import { type ReactNode, useId, useRef, useState } from "react"
import {
  CATALOG_KEY,
  draftsOf,
  type OptionDraft,
  OptionsEditor,
  optionsError,
  optionsOf,
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
  readMoney,
  type Relation,
  type Variant,
  variantName,
} from "./lib/tienda"
import {
  fieldErrors,
  FormAlert,
  FormSheet,
  MoneyField,
  Photo,
  SELECT_CLASSES,
  shrinkPhoto,
  TextField,
} from "./piezas"
import { ErrorBlock, useStoreContext } from "./tiendas"

/**
 * Un producto del catálogo (lienzo B, tableros 7 y 14): sus datos y opciones, el precio y lo que
 * Sofi puede negociar, sus fotos, cada variante con su stock y su kardex, y lo que Sofi puede
 * recomendar junto a él. Ventas lo ve todo sin cambiarlo; el servidor lo rechaza igual.
 */

const PRODUCT_KEY = (storeId: string, productId: string) => ["producto", storeId, productId]

function Card({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="elevated flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={id} className="text-base font-semibold">
            {title}
          </h3>
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
    queryFn: () => api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/productos/${productId}`),
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
  if (product.isPending) return <>{back}<p className="text-sm text-muted-foreground">Cargando el producto…</p></>
  if (product.isError)
    return (
      <>
        {back}
        <ErrorBlock error={product.error} onRetry={() => void product.refetch()} />
      </>
    )
  const p = product.data.product
  return (
    <>
      {back}
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-bold">{p.name}</h2>
        <p className="text-sm text-muted-foreground">
          {[p.category, priceRange(p.fromCents, p.toCents, store.currency), `${p.variants.length} ${p.variants.length === 1 ? "variante" : "variantes"}`, `${p.variants.reduce((n, v) => n + v.stock, 0)} en stock`]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {canEdit ? null : (
          <p className="text-sm text-muted-foreground">Lo ves como Ventas: los cambios los hacen el dueño o un administrador.</p>
        )}
      </div>
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
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success(done)
    },
  })
}

function DataCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const catalog = useCatalog(store.id)
  const [name, setName] = useState(product.name)
  const [category, setCategory] = useState(product.category ?? "")
  const [description, setDescription] = useState(product.description)
  const [drafts, setDrafts] = useState<OptionDraft[]>(draftsOf(product.options))
  const save = useSaveProduct(product, "Producto guardado")
  const errors = fieldErrors(save.error)
  const [local, setLocal] = useState<Record<string, string>>({})
  const descriptionId = useId()
  const categoriesId = useId()
  const categories = [...new Set((catalog.data?.products ?? []).map((c) => c.category).filter(Boolean))]

  function submit() {
    const options = optionsOf(drafts)
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = "Escribe el nombre del producto"
    if (options.some((o) => !o.name || o.values.length === 0))
      next.options = "Cada opción necesita su nombre y al menos un valor"
    setLocal(next)
    if (Object.keys(next).length > 0) return
    save.mutate({ name, category: category || null, description, options })
  }
  const shown = { ...errors, ...local }

  return (
    <Card title="Datos y opciones">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <fieldset disabled={!canEdit} className="contents">
          <FieldGroup className="gap-5">
            <TextField label="Nombre" value={name} onChange={setName} error={shown.name} maxLength={120} />
            <Field>
              <FieldLabel htmlFor={`${categoriesId}-input`}>Categoría</FieldLabel>
              <Input
                id={`${categoriesId}-input`}
                list={categoriesId}
                value={category}
                maxLength={60}
                onChange={(e) => setCategory(e.target.value)}
              />
              <datalist id={categoriesId}>
                {categories.map((c) => (
                  <option key={c} value={c ?? ""} />
                ))}
              </datalist>
            </Field>
            <Field data-invalid={shown.description ? true : undefined}>
              <FieldLabel htmlFor={descriptionId}>Lo que Sofi puede contar</FieldLabel>
              <Textarea
                id={descriptionId}
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
              <FieldDescription>Material, horma, cuidados. Sofi no inventa lo que no está aquí.</FieldDescription>
            </Field>
            <OptionsEditor drafts={drafts} onChange={setDrafts} error={optionsError(shown)} disabled={!canEdit} />
            <FormAlert error={save.error} />
            {canEdit ? (
              <SubmitButton type="submit" pending={save.isPending} className="self-start">
                Guardar
              </SubmitButton>
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
    <p role="status" className="rounded-lg border border-warning/50 bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">
      {text}
    </p>
  )
}

function PriceCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const currency = store.currency
  const [list, setList] = useState(moneyInput(product.listPriceCents, currency))
  const [min, setMin] = useState(moneyInput(product.minPriceCents, currency))
  const [tiers, setTiers] = useState(
    product.quantityPrices.map((t) => ({ quantity: String(t.minQuantity), price: moneyInput(t.unitPriceCents, currency) })),
  )
  const [promos, setPromos] = useState<Promotion[]>(product.promotions)
  const save = useSaveProduct(product, "Precios guardados")
  const [local, setLocal] = useState<Record<string, string>>({})
  const shown = { ...fieldErrors(save.error), ...local }
  const listCents = readMoney(list, currency)
  const minCents = min.trim() ? readMoney(min, currency) : null
  const differs = product.fromCents !== product.toCents

  function submit() {
    const next: Record<string, string> = {}
    if (!listCents) next.listPriceCents = "Escribe el precio, como 129 o 129.90"
    if (min.trim() && !minCents) next.minPriceCents = "Escribe el precio mínimo, o déjalo vacío"
    if (listCents && minCents && minCents > listCents) next.minPriceCents = "El mínimo no puede ser mayor que el de lista"
    const quantityPrices = tiers.map((t) => ({ minQuantity: Number(t.quantity), unitPriceCents: readMoney(t.price, currency) }))
    if (quantityPrices.some((t) => !Number.isInteger(t.minQuantity) || t.minQuantity < 2 || !t.unitPriceCents))
      next.quantityPrices = "Cada precio por cantidad necesita desde cuántas unidades (2 o más) y su precio"
    if (promos.some((p) => !p.name.trim() || !p.startsOn || !p.endsOn || !(p.percentOff >= 1 && p.percentOff <= 90)))
      next.promotions = "Cada promoción necesita su nombre, el porcentaje (1 a 90) y sus fechas"
    setLocal(next)
    if (Object.keys(next).length > 0) return
    save.mutate({ listPriceCents: listCents, minPriceCents: minCents, quantityPrices, promotions: promos })
  }

  const firstError = (prefix: string) =>
    Object.entries(shown).find(([key]) => key === prefix || key.startsWith(`${prefix}.`))?.[1]

  return (
    <Card
      title="Precio y negociación"
      description={
        differs
          ? `Sofi siempre da un número: como las variantes cuestan distinto, dice «Desde ${money(product.fromCents, currency)}» y el exacto al elegir.`
          : `Sofi siempre da un número: «Cuesta ${money(product.fromCents, currency)}».`
      }
    >
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <fieldset disabled={!canEdit} className="contents">
          <FieldGroup className="gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <MoneyField
                label="Precio de lista"
                currency={currency}
                value={list}
                onChange={setList}
                error={shown.listPriceCents}
              />
              <MoneyField
                label="Precio mínimo de venta"
                currency={currency}
                value={min}
                onChange={setMin}
                error={shown.minPriceCents}
                help={
                  listCents && minCents && minCents <= listCents
                    ? `Sofi puede ceder hasta ${money(listCents - minCents, currency)} por unidad.`
                    : "Vacío: no se negocia."
                }
              />
            </div>
            <CostNotice product={product} />
            <FieldSet>
              <FieldLegend variant="label">Precio por cantidad</FieldLegend>
              <FieldDescription>No se suma con una promoción: va el mejor para el cliente.</FieldDescription>
              {tiers.map((tier, i) => {
                const unit = readMoney(tier.price, currency)
                const qty = Number(tier.quantity)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                  <div key={i} className="grid grid-cols-[6rem_minmax(0,1fr)_auto] items-end gap-2">
                    <TextField
                      label="Desde"
                      inputMode="numeric"
                      value={tier.quantity}
                      onChange={(quantity) => setTiers(tiers.map((t, j) => (j === i ? { ...t, quantity } : t)))}
                      help="unidades"
                    />
                    <MoneyField
                      label="Cada una a"
                      currency={currency}
                      value={tier.price}
                      onChange={(price) => setTiers(tiers.map((t, j) => (j === i ? { ...t, price } : t)))}
                      help={unit && qty >= 2 ? `${qty} cuestan ${money(unit * qty, currency)}` : " "}
                    />
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mb-6"
                        aria-label={`Quitar el precio desde ${tier.quantity || "esta cantidad"}`}
                        onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                )
              })}
              {canEdit && tiers.length < 5 ? (
                <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setTiers([...tiers, { quantity: "2", price: "" }])}>
                  <Plus aria-hidden />
                  Precio por cantidad
                </Button>
              ) : null}
              {tiers.length === 0 && !canEdit ? <p className="text-sm text-muted-foreground">Sin precio por cantidad.</p> : null}
              {firstError("quantityPrices") ? <FieldError>{firstError("quantityPrices")}</FieldError> : null}
            </FieldSet>
            <FieldSet>
              <FieldLegend variant="label">Promociones</FieldLegend>
              <FieldDescription>Un porcentaje menos, de un día a otro. No se pisan ni se suman.</FieldDescription>
              {promos.map((promo, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: las filas no tienen id hasta guardarse
                <div key={i} className="flex flex-col gap-2 rounded-lg border p-3">
                  <div className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-end gap-2">
                    <TextField
                      label="Nombre"
                      value={promo.name}
                      onChange={(name) => setPromos(promos.map((p, j) => (j === i ? { ...p, name } : p)))}
                      maxLength={60}
                      placeholder="Cyber"
                    />
                    <TextField
                      label="% menos"
                      inputMode="numeric"
                      value={promo.percentOff ? String(promo.percentOff) : ""}
                      onChange={(v) => setPromos(promos.map((p, j) => (j === i ? { ...p, percentOff: Number(v.replace(/\D/g, "")) } : p)))}
                    />
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Quitar la promoción ${promo.name || i + 1}`}
                        onClick={() => setPromos(promos.filter((_, j) => j !== i))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>Desde</FieldLabel>
                      <DatePickerButton
                        value={promo.startsOn}
                        disabled={!canEdit}
                        onChange={(startsOn) => setPromos(promos.map((p, j) => (j === i ? { ...p, startsOn } : p)))}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Hasta</FieldLabel>
                      <DatePickerButton
                        value={promo.endsOn}
                        min={promo.startsOn || undefined}
                        disabled={!canEdit}
                        onChange={(endsOn) => setPromos(promos.map((p, j) => (j === i ? { ...p, endsOn } : p)))}
                      />
                    </Field>
                  </div>
                  {promo.percentOff >= 1 && listCents && minCents && Math.round(listCents * (1 - promo.percentOff / 100)) < minCents ? (
                    <p className="text-sm text-muted-foreground">
                      Con esta promoción cuesta {money(Math.round(listCents * (1 - promo.percentOff / 100)), currency)}, menos que el mínimo.
                    </p>
                  ) : null}
                </div>
              ))}
              {canEdit && promos.length < 10 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="self-start"
                  onClick={() => setPromos([...promos, { name: "", percentOff: 10, startsOn: "", endsOn: "" }])}
                >
                  <Plus aria-hidden />
                  Promoción
                </Button>
              ) : null}
              {promos.length === 0 && !canEdit ? <p className="text-sm text-muted-foreground">Sin promociones.</p> : null}
              {firstError("promotions") ? <FieldError>{firstError("promotions")}</FieldError> : null}
            </FieldSet>
            <FormAlert error={save.error} />
            {canEdit ? (
              <SubmitButton type="submit" pending={save.isPending} className="self-start">
                Guardar precios
              </SubmitButton>
            ) : null}
          </FieldGroup>
        </fieldset>
      </form>
    </Card>
  )
}

function PhotosCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const refresh = () => queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, product.id) })
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
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Foto agregada")
    },
    onError: async (error) => {
      await refresh()
      toast.error(error.message)
    },
  })
  const remove = useMutation({
    mutationFn: (photoId: string) => api(`/api/tiendas/${store.id}/fotos/${photoId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await refresh()
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Foto borrada")
    },
    onError: (error) => toast.error(error.message),
  })
  const full = product.photos.length >= 8
  return (
    <Card title="Fotos" description={product.photos.length === 0 ? "La primera es la que se ve en el catálogo. Hasta 8." : undefined}>
      <div className="flex flex-wrap gap-2">
        {product.photos.map((photo, i) => (
          <div key={photo.id} className="relative">
            <Photo storeId={store.id} photoId={photo.id} alt={`Foto ${i + 1} de ${product.name}`} className="size-20" />
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
        {!canEdit && product.photos.length === 0 ? <p className="text-sm text-muted-foreground">Sin fotos.</p> : null}
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
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/variantes/${variant.id}`, { method: "DELETE" }),
    onSuccess: async (result) => {
      queryClient.setQueryData(PRODUCT_KEY(store.id, product.id), result)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
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
                {variant.sku} · {variant.priceCents ? money(variant.priceCents, store.currency) : "precio del producto"}
              </span>
            </div>
            <span className="w-20 text-right text-sm tabular-nums">
              {variant.stock === 0 ? <Badge variant="outline">Agotado</Badge> : `${variant.stock} en stock`}
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
        <KardexSheet product={product} variant={kardexOf} canEdit={canEdit} onClose={() => setKardexOf(null)} />
      ) : null}
      {editing ? <VariantSheet product={product} variant={editing} onClose={() => setEditing(null)} /> : null}
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

function VariantSheet({ product, variant, onClose }: { product: ProductDetail; variant: Variant; onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [sku, setSku] = useState(variant.sku)
  const [price, setPrice] = useState(moneyInput(variant.priceCents, store.currency))
  const [photoId, setPhotoId] = useState(variant.photoId ?? "")
  const [local, setLocal] = useState<Record<string, string>>({})
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ product: ProductDetail }>(`/api/tiendas/${store.id}/variantes/${variant.id}`, { method: "PATCH", body }),
    onSuccess: async (result) => {
      queryClient.setQueryData(PRODUCT_KEY(store.id, product.id), result)
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Variante guardada")
      onClose()
    },
  })
  const shown = { ...fieldErrors(save.error), ...local }
  const photoSelect = useId()
  function submit() {
    const priceCents = price.trim() ? readMoney(price, store.currency) : null
    const next: Record<string, string> = {}
    if (price.trim() && !priceCents) next.priceCents = "Escribe el precio, o déjalo vacío para usar el del producto"
    if (!/^[A-Za-z0-9._/-]{1,40}$/.test(sku.trim())) next.sku = "Hasta 40 letras, números, puntos o guiones, sin espacios"
    setLocal(next)
    if (Object.keys(next).length > 0) return
    save.mutate({ sku: sku.trim(), priceCents, photoId: photoId || null })
  }
  return (
    <FormSheet
      open
      title={variantName(variant)}
      description={product.name}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={save.isPending}>
            Guardar
          </SubmitButton>
        </>
      }
    >
      <FieldGroup className="gap-5">
        <TextField label="Código" value={sku} onChange={setSku} error={shown.sku} maxLength={40} help="El de tu inventario o el de Meta. Único en la tienda." />
        <MoneyField
          label="Precio propio (opcional)"
          currency={store.currency}
          value={price}
          onChange={setPrice}
          error={shown.priceCents}
          help={`Vacío: usa el del producto, ${money(product.listPriceCents, store.currency)}.`}
        />
        <Field>
          <FieldLabel htmlFor={photoSelect}>Foto</FieldLabel>
          <select id={photoSelect} className={SELECT_CLASSES} value={photoId} onChange={(e) => setPhotoId(e.target.value)}>
            <option value="">La del producto</option>
            {product.photos.map((photo, i) => (
              <option key={photo.id} value={photo.id}>
                Foto {i + 1}
              </option>
            ))}
          </select>
          {photoId ? <Photo storeId={store.id} photoId={photoId} alt="La foto elegida" className="size-20" /> : null}
          {product.photos.length === 0 ? <FieldDescription>Sube fotos en el producto para elegir una aquí.</FieldDescription> : null}
        </Field>
        <FormAlert error={save.error} />
      </FieldGroup>
    </FormSheet>
  )
}

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
    queryFn: () => api<{ stock: number; movements: Movement[] }>(`/api/tiendas/${store.id}/variantes/${variant.id}/kardex`),
  })
  const [kind, setKind] = useState<"entrada" | "ajuste">("entrada")
  const [quantity, setQuantity] = useState("")
  const [cost, setCost] = useState("")
  const [reason, setReason] = useState("")
  const [local, setLocal] = useState<Record<string, string>>({})
  const move = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/tiendas/${store.id}/variantes/${variant.id}/movimientos`, { method: "POST", body }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, product.id) }),
        queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) }),
      ])
      toast.success(kind === "entrada" ? "Entrada anotada" : "Ajuste anotado")
      setQuantity("")
      setCost("")
      setReason("")
    },
  })
  const shown = { ...fieldErrors(move.error), ...local }
  const reasonId = useId()
  const stock = kardex.data?.stock ?? variant.stock

  function submit() {
    const n = Number(quantity)
    const next: Record<string, string> = {}
    if (kind === "entrada") {
      if (!Number.isInteger(n) || n < 1) next.quantity = "Escribe cuántas entran"
      const costCents = cost.trim() ? readMoney(cost, store.currency) : null
      if (cost.trim() && costCents === null) next.unitCostCents = "Escribe el costo, como 68 o 68.50, o déjalo vacío"
      setLocal(next)
      if (Object.keys(next).length > 0) return
      move.mutate({ kind, quantity: n, unitCostCents: costCents, reason: reason.trim() || undefined })
    } else {
      if (quantity.trim() === "" || !Number.isInteger(n) || n < 0) next.counted = "Escribe cuántas hay de verdad, 0 o más"
      if (reason.trim().length < 3) next.reason = "Escribe el motivo del ajuste, como «par dañado»"
      setLocal(next)
      if (Object.keys(next).length > 0) return
      move.mutate({ kind, counted: n, reason })
    }
  }

  const when = (iso: string) => new Date(iso).toLocaleDateString("es", { day: "numeric", month: "short" })

  return (
    <FormSheet
      open
      title={`Kardex · ${variantName(variant)}`}
      description={`${product.name} · ${variant.sku} · quedan ${stock}`}
      onClose={onClose}
      onSubmit={canEdit ? submit : onClose}
      footer={
        canEdit ? (
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cerrar
            </Button>
            <SubmitButton type="submit" pending={move.isPending}>
              {kind === "entrada" ? "Anotar la entrada" : "Anotar el ajuste"}
            </SubmitButton>
          </>
        ) : (
          <Button type="submit">Listo</Button>
        )
      }
    >
      <div className="flex flex-col gap-5">
        {canEdit ? (
          <FieldGroup className="gap-4">
            <FieldSet>
              <FieldLegend variant="label">Entrada o ajuste</FieldLegend>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["entrada", "Entrada", "Llegó mercadería"],
                    ["ajuste", "Ajuste", "Contaste y no cuadra"],
                  ] as const
                ).map(([value, title, hint]) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 has-checked:border-primary has-checked:bg-primary-soft/40 has-focus-visible:ring-3 has-focus-visible:ring-ring/30"
                  >
                    <input
                      type="radio"
                      name="movement-kind"
                      value={value}
                      checked={kind === value}
                      onChange={() => {
                        setKind(value)
                        setLocal({})
                        move.reset()
                      }}
                      className="mt-1 accent-[var(--primary-fill)]"
                    />
                    <span className="flex flex-col">
                      <span className="text-sm font-semibold">{title}</span>
                      <span className="text-xs text-muted-foreground">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </FieldSet>
            {kind === "entrada" ? (
              <div className="grid grid-cols-2 gap-3">
                <TextField label="Cuántas entran" inputMode="numeric" value={quantity} onChange={setQuantity} error={shown.quantity} />
                <MoneyField
                  label="Costo por unidad"
                  currency={store.currency}
                  value={cost}
                  onChange={setCost}
                  error={shown.unitCostCents}
                  help="Opcional. Con él se avisa si el mínimo queda cerca."
                />
              </div>
            ) : (
              <TextField
                label="Cuántas hay de verdad"
                inputMode="numeric"
                value={quantity}
                onChange={setQuantity}
                error={shown.counted}
                help={`Hoy dice ${stock}. El ajuste es la diferencia.`}
              />
            )}
            <Field data-invalid={shown.reason ? true : undefined}>
              <FieldLabel htmlFor={reasonId}>{kind === "ajuste" ? "Motivo" : "Nota (opcional)"}</FieldLabel>
              <Textarea
                id={reasonId}
                rows={2}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={kind === "ajuste" ? "par dañado, conteo de fin de mes" : "compra al proveedor"}
                aria-invalid={shown.reason ? true : undefined}
              />
              {shown.reason ? <FieldError>{shown.reason}</FieldError> : null}
            </Field>
            <FormAlert error={move.error} />
          </FieldGroup>
        ) : null}
        <div className="flex flex-col gap-2">
          <h4 className="text-sm font-semibold">Movimientos</h4>
          {kardex.isPending ? <p className="text-sm text-muted-foreground">Cargando…</p> : null}
          {kardex.isError ? <ErrorState error={kardex.error} onRetry={() => void kardex.refetch()} /> : null}
          {kardex.data && kardex.data.movements.length === 0 ? (
            <p className="text-sm text-muted-foreground">Todavía sin movimientos: el stock es 0.</p>
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
                      {m.unitCostCents !== null ? ` · ${money(m.unitCostCents, store.currency)} c/u` : ""}
                      {m.actorName ? <span className="text-muted-foreground"> · {m.actorName}</span> : null}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{m.quantity > 0 ? `+${m.quantity}` : `−${-m.quantity}`}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.balance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </FormSheet>
  )
}

const RELATIONS: Record<Relation, string> = { parecido: "Parecido", combina: "Combina con" }

function RelatedCard({ product, canEdit }: { product: ProductDetail; canEdit: boolean }) {
  const { store } = useStoreContext()
  const catalog = useCatalog(store.id)
  const save = useSaveProduct(product, "Recomendaciones guardadas")
  const [other, setOther] = useState("")
  const [kind, setKind] = useState<Relation>("parecido")
  const selectId = useId()
  const kindId = useId()
  const options = (catalog.data?.products ?? []).filter(
    (p) => p.id !== product.id && !product.links.some((l) => l.productId === p.id && l.kind === kind),
  )
  const links = (next: { productId: string; kind: Relation }[]) => save.mutate({ links: next })
  const current = product.links.map((l) => ({ productId: l.productId, kind: l.kind }))
  return (
    <Card title="Sofi lo recomienda con" description="Lo parecido, si no hay su talla; lo que combina, para sumar al mismo despacho.">
      {product.links.length === 0 ? <p className="text-sm text-muted-foreground">Sin productos relacionados.</p> : null}
      {(Object.keys(RELATIONS) as Relation[]).map((k) => {
        const list = product.links.filter((l) => l.kind === k)
        if (list.length === 0) return null
        return (
          <div key={k} className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">{RELATIONS[k]}</span>
            <ul className="flex flex-wrap gap-2">
              {list.map((l) => (
                <li key={l.productId} className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-3 text-sm">
                  <Link to="/tiendas/$id/catalogo/$productId" params={{ id: store.id, productId: l.productId }} className="hover:underline">
                    {l.name}
                  </Link>
                  {canEdit ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-full"
                      aria-label={`Quitar ${l.name}`}
                      disabled={save.isPending}
                      onClick={() => links(current.filter((c) => !(c.productId === l.productId && c.kind === l.kind)))}
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
        <form
          noValidate
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!other) return
            links([...current, { productId: other, kind }])
            setOther("")
          }}
        >
          <Field className="w-36">
            <FieldLabel htmlFor={kindId}>Cómo</FieldLabel>
            <select id={kindId} className={SELECT_CLASSES} value={kind} onChange={(e) => setKind(e.target.value as Relation)}>
              {(Object.keys(RELATIONS) as Relation[]).map((k) => (
                <option key={k} value={k}>
                  {RELATIONS[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field className="min-w-40 flex-1">
            <FieldLabel htmlFor={selectId}>Producto</FieldLabel>
            <select id={selectId} className={SELECT_CLASSES} value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Elige un producto</option>
              {options.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
          <SubmitButton type="submit" variant="outline" pending={save.isPending} disabled={!other}>
            Agregar
          </SubmitButton>
        </form>
      ) : null}
      <FormAlert error={save.error} />
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
