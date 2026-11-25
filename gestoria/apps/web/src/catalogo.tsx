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
import { EmptyState, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Download, FileSpreadsheet, Package, Plus, Trash2, Upload } from "lucide-react"
import { useId, useRef, useState } from "react"
import { api } from "./lib/api"
import {
  type CatalogItem,
  money,
  optionsSummary,
  type ProductOption,
  readMoney,
  valuesSummary,
} from "./lib/tienda"
import {
  download,
  FormAlert,
  FormSheet,
  fieldErrors,
  MoneyField,
  Photo,
  TextField,
  useDirty,
} from "./piezas"
import { ErrorBlock, StoreHeader, useStoreContext } from "./tiendas"

/**
 * El catálogo (lienzo B, tablero 7): lo único de lo que habla Sofi. Cada producto agrupa sus
 * variantes; aquí se ven con su precio, sus opciones y lo que queda. Dueño y Administrador
 * agregan productos o suben una hoja; Ventas lo ve.
 */

export const CATALOG_KEY = (storeId: string) => ["catalogo", storeId]

export function useCatalog(storeId: string) {
  return useQuery({
    queryKey: CATALOG_KEY(storeId),
    queryFn: () => api<{ products: CatalogItem[] }>(`/api/tiendas/${storeId}/catalogo`),
  })
}

function priceSpan(item: { fromCents: number; toCents: number }, currency: string) {
  return item.fromCents === item.toCents
    ? money(item.fromCents, currency)
    : `${money(item.fromCents, currency)} a ${money(item.toCents, currency)}`
}

export function CatalogPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const catalog = useCatalog(store.id)
  const [adding, setAdding] = useState(false)
  const [uploading, setUploading] = useState(false)
  const products = catalog.data?.products ?? []
  const variants = products.reduce((n, p) => n + p.variantCount, 0)
  const soldOut = products.filter((p) => p.stock === 0).length

  return (
    <>
      <StoreHeader
        title="Catálogo"
        subtitle={
          catalog.data
            ? `${products.length} ${products.length === 1 ? "producto" : "productos"} · ${variants} ${variants === 1 ? "variante" : "variantes"}${soldOut ? ` · ${soldOut} ${soldOut === 1 ? "agotado" : "agotados"}` : ""}`
            : "Lo que vendes, con sus variantes y su stock."
        }
        primary={
          canEdit
            ? {
                label: "Agregar producto",
                icon: <Plus aria-hidden />,
                onClick: () => setAdding(true),
              }
            : undefined
        }
        secondary={
          canEdit
            ? {
                label: "Subir una hoja",
                icon: <Upload aria-hidden />,
                onClick: () => setUploading(true),
              }
            : undefined
        }
      />

      {catalog.isPending ? (
        <p className="text-sm text-muted-foreground">Cargando el catálogo…</p>
      ) : null}
      {catalog.isError ? (
        <ErrorBlock error={catalog.error} onRetry={() => void catalog.refetch()} />
      ) : null}
      {catalog.data && products.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Tu catálogo está vacío"
          description={
            canEdit
              ? "Agrega tus productos uno por uno o súbelos de una vez con una hoja. Sofi solo ofrece lo que está aquí."
              : "Cuando el dueño o un administrador agregue productos, aparecen aquí."
          }
          // En el celular la cabecera deja solo íconos: las dos formas de empezar, aquí con su nombre.
          actionLabel={canEdit ? "Agregar producto" : undefined}
          onAction={canEdit ? () => setAdding(true) : undefined}
          secondaryActionLabel={canEdit ? "Subir una hoja" : undefined}
          onSecondaryAction={canEdit ? () => setUploading(true) : undefined}
        />
      ) : null}
      {products.length > 0 ? (
        <div className="elevated overflow-hidden rounded-xl border bg-card">
          <div className="hidden grid-cols-[3.5rem_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_8rem] gap-4 border-b bg-surface-muted px-4 py-2.5 text-xs font-semibold text-muted-foreground md:grid">
            <span>Foto</span>
            <span>Producto</span>
            <span>Precio</span>
            <span>Variantes</span>
            <span>Queda</span>
          </div>
          <ul className="flex flex-col divide-y">
            {products.map((item) => (
              <li key={item.id}>
                <Link
                  to="/tiendas/$id/catalogo/$productId"
                  params={{ id: store.id, productId: item.id }}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset md:grid-cols-[3.5rem_minmax(0,1.6fr)_minmax(0,0.9fr)_minmax(0,1.4fr)_8rem]"
                >
                  <Photo
                    storeId={store.id}
                    photoId={item.photoId}
                    alt=""
                    className="row-span-3 size-11 md:row-span-1"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">{item.name}</span>
                    {item.category ? (
                      <span className="truncate text-xs text-muted-foreground">
                        {item.category}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-sm">{priceSpan(item, store.currency)}</span>
                  <span className="min-w-0 text-sm text-muted-foreground md:text-foreground">
                    {optionsSummary(item.options) || "Sin variantes"}
                  </span>
                  <span className="col-start-2 text-sm md:col-start-auto">
                    {item.stock === 0 ? (
                      <Badge variant="outline">0 · agotado</Badge>
                    ) : (
                      `${item.stock} ${item.stock === 1 ? "unidad" : "unidades"}`
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {adding ? <NewProduct onClose={() => setAdding(false)} /> : null}
      {uploading ? <SheetUpload onClose={() => setUploading(false)} /> : null}
    </>
  )
}

/** Una opción mientras se escribe: su nombre y sus valores separados por comas. */
export interface OptionDraft {
  name: string
  values: string
}

/** «35 a 42» o «35-42» son las tallas seguidas; lo demás, separado por comas. */
export function readValues(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const range = /^(\d{1,3})\s*(?:a|-)\s*(\d{1,3})$/i.exec(part)
      if (!range) return [part]
      const [from, to] = [Number(range[1]), Number(range[2])]
      if (to < from || to - from > 40) return [part]
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
    })
}

export function draftsOf(options: ProductOption[]): OptionDraft[] {
  return options.map((o) => ({ name: o.name, values: valuesSummary(o.values) }))
}

export function optionsOf(drafts: OptionDraft[]): ProductOption[] {
  return drafts
    .filter((d) => d.name.trim() || d.values.trim())
    .map((d) => ({ name: d.name.trim(), values: readValues(d.values) }))
}

/** Las hasta tres opciones de un producto (talla, color, material). */
export function OptionsEditor({
  drafts,
  onChange,
  error,
  disabled,
}: {
  drafts: OptionDraft[]
  onChange: (drafts: OptionDraft[]) => void
  error?: string
  disabled?: boolean
}) {
  const combinations = optionsOf(drafts).reduce((n, o) => n * Math.max(1, o.values.length), 1)
  return (
    <FieldSet>
      <FieldLegend variant="label">Opciones</FieldLegend>
      <FieldDescription>
        Hasta tres, como talla, color o material. Se arman todas las combinaciones; después borras
        las que no vendes. Para tallas seguidas escribe «35 a 42».
      </FieldDescription>
      <div className="flex flex-col gap-2">
        {drafts.map((draft, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: el orden de las opciones es su identidad
            key={i}
            className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_auto] items-end gap-2"
          >
            <TextField
              label={`Opción ${i + 1}`}
              value={draft.name}
              onChange={(name) => onChange(drafts.map((d, j) => (j === i ? { ...d, name } : d)))}
              placeholder={["Color", "Talla", "Material"][i]}
              maxLength={30}
            />
            <TextField
              label="Valores"
              value={draft.values}
              onChange={(values) =>
                onChange(drafts.map((d, j) => (j === i ? { ...d, values } : d)))
              }
              placeholder={["blanca, negra", "35 a 42", "cuero, gamuza"][i]}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={`Quitar la opción ${i + 1}`}
              onClick={() => onChange(drafts.filter((_, j) => j !== i))}
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        {drafts.length < 3 ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={disabled}
            onClick={() => onChange([...drafts, { name: "", values: "" }])}
          >
            <Plus aria-hidden />
            {drafts.length === 0 ? "Agregar una opción" : "Otra opción"}
          </Button>
        ) : null}
      </div>
      {drafts.length > 0 ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {combinations} {combinations === 1 ? "combinación" : "combinaciones"}
        </p>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </FieldSet>
  )
}

/** El primer error de las opciones que dice el servidor (`options.0.values`). */
export function optionsError(errors: Record<string, string>): string | undefined {
  return (
    Object.entries(errors).find(([key]) => key === "options" || key.startsWith("options."))?.[1] ??
    errors[""]
  )
}

function NewProduct({ onClose }: { onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const catalog = useCatalog(store.id)
  const [name, setName] = useState("")
  const [category, setCategory] = useState("")
  const [price, setPrice] = useState("")
  const [drafts, setDrafts] = useState<OptionDraft[]>([])
  const [description, setDescription] = useState("")
  const [errors, setErrors] = useState<Record<string, string>>({})
  const categoriesId = useId()
  const descriptionId = useId()
  const dirty = useDirty({ name, category, price, drafts, description })
  const categories = [
    ...new Set((catalog.data?.products ?? []).map((p) => p.category).filter(Boolean)),
  ]

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ product: { id: string } }>(`/api/tiendas/${store.id}/productos`, {
        method: "POST",
        body,
      }),
    onSuccess: async ({ product }) => {
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Producto agregado. Ahora suma sus fotos y su stock.")
      onClose()
      await navigate({
        to: "/tiendas/$id/catalogo/$productId",
        params: { id: store.id, productId: product.id },
      })
    },
    onError: (error) => setErrors(fieldErrors(error)),
  })

  function submit() {
    const next: Record<string, string> = {}
    if (!name.trim()) next.name = "Escribe el nombre del producto"
    const listPriceCents = readMoney(price, store.currency)
    if (!listPriceCents) next.listPriceCents = "Escribe el precio, como 129 o 129.90"
    const options = optionsOf(drafts)
    if (options.some((o) => !o.name || o.values.length === 0))
      next.options = "Cada opción necesita su nombre y al menos un valor"
    setErrors(next)
    if (Object.keys(next).length > 0) return
    create.mutate({ name, category: category || null, description, listPriceCents, options })
  }

  return (
    <FormSheet
      open
      title="Nuevo producto"
      dirty={dirty}
      description="Después le sumas sus fotos, su stock y lo que Sofi puede negociar."
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={create.isPending}>
            Agregar producto
          </SubmitButton>
        </>
      }
    >
      <FieldGroup className="gap-5">
        <TextField
          label="Nombre"
          value={name}
          onChange={setName}
          error={errors.name}
          placeholder="Zapatilla urbana"
          maxLength={120}
          autoFocus
        />
        <Field>
          <FieldLabel htmlFor={`${categoriesId}-input`}>Categoría (opcional)</FieldLabel>
          <Input
            id={`${categoriesId}-input`}
            list={categoriesId}
            value={category}
            maxLength={60}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Zapatillas"
          />
          <datalist id={categoriesId}>
            {categories.map((c) => (
              <option key={c} value={c ?? ""} />
            ))}
          </datalist>
        </Field>
        <MoneyField
          label="Precio de lista"
          currency={store.currency}
          value={price}
          onChange={setPrice}
          error={errors.listPriceCents}
          help="El de siempre. Si una variante cuesta distinto, se lo pones en el producto."
        />
        <OptionsEditor drafts={drafts} onChange={setDrafts} error={optionsError(errors)} />
        <Field data-invalid={errors.description ? true : undefined}>
          <FieldLabel htmlFor={descriptionId}>Lo que Sofi puede contar</FieldLabel>
          <Textarea
            id={descriptionId}
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Cuero sintético, planta de goma. Horma normal: pide tu talla de siempre."
          />
          {errors.description ? <FieldError>{errors.description}</FieldError> : null}
        </Field>
        <FormAlert error={create.error} />
      </FieldGroup>
    </FormSheet>
  )
}

interface SheetResult {
  products: {
    name: string
    category: string | null
    options: ProductOption[]
    variants: number
    stock: number
    fromCents: number
    toCents: number
  }[]
  errors: { row: number; message: string }[]
  saved: boolean
}

/**
 * «Subir una hoja» (decisión 10): una fila por variante. Primero muestra qué se va a crear y qué
 * errores hay; nada se guarda hasta confirmar.
 */
function SheetUpload({ onClose }: { onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const send = (text: string, confirm: boolean) =>
    api<SheetResult>(`/api/tiendas/${store.id}/catalogo/hoja${confirm ? "?confirmar=1" : ""}`, {
      method: "POST",
      raw: { type: "text/csv", data: text },
    })
  const preview = useMutation({ mutationFn: (text: string) => send(text, false) })
  const save = useMutation({
    mutationFn: (text: string) => send(text, true),
    onSuccess: async (result) => {
      if (!result.saved) {
        preview.reset()
        preview.mutate(file?.text ?? "")
        return
      }
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success(
        `Listo: ${result.products.length} ${result.products.length === 1 ? "producto agregado" : "productos agregados"}. Suma sus fotos en cada uno.`,
      )
      onClose()
    },
  })
  const example = useMutation({
    mutationFn: () =>
      api<Blob>(`/api/tiendas/${store.id}/catalogo/hoja-de-ejemplo`, { as: "blob" }),
    onSuccess: (blob) => download(blob, "catalogo-ejemplo.csv"),
    onError: (error) => toast.error(error.message),
  })

  async function choose(chosen: File | undefined) {
    if (!chosen) return
    setProblem(null)
    save.reset()
    if (!/\.(csv|txt)$/i.test(chosen.name)) {
      setFile(null)
      setProblem(
        "Guarda tu hoja como CSV y súbela otra vez. En Excel: Archivo › Guardar como › CSV UTF-8. En Google Sheets: Archivo › Descargar › CSV.",
      )
      return
    }
    if (chosen.size > 1_000_000) {
      setFile(null)
      setProblem("La hoja es muy grande: divídela en partes de hasta 2000 filas.")
      return
    }
    const text = await chosen.text()
    setFile({ name: chosen.name, text })
    preview.mutate(text)
  }

  const result = preview.data
  const ready = result && result.errors.length === 0 && result.products.length > 0
  const variants = result?.products.reduce((n, p) => n + p.variants, 0) ?? 0

  return (
    <FormSheet
      open
      title="Subir una hoja"
      description="Una fila por variante: el producto, sus opciones, el precio y el stock. Las fotos se agregan después en cada producto."
      onClose={onClose}
      onSubmit={() => (ready && file ? save.mutate(file.text) : input.current?.click())}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          {ready ? (
            <SubmitButton type="submit" pending={save.isPending}>
              Crear {result.products.length}{" "}
              {result.products.length === 1 ? "producto" : "productos"}
            </SubmitButton>
          ) : (
            <Button type="submit" variant={file ? "outline" : "default"}>
              <FileSpreadsheet aria-hidden />
              {file ? "Elegir otra hoja" : "Elegir la hoja"}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2 rounded-lg border bg-surface-muted p-4 text-sm">
          <p>
            Empieza con la hoja de ejemplo: ábrela en Excel o Google Sheets, reemplaza las filas por
            las tuyas y guárdala como CSV.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={example.isPending}
            onClick={() => example.mutate()}
          >
            <Download aria-hidden />
            Descargar la hoja de ejemplo
          </Button>
        </div>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => {
            void choose(e.target.files?.[0])
            e.target.value = ""
          }}
        />
        {problem ? (
          <p role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}
        {file ? <p className="text-sm font-medium">{file.name}</p> : null}
        {preview.isPending ? (
          <p className="text-sm text-muted-foreground">Revisando la hoja…</p>
        ) : null}
        <FormAlert error={preview.error ?? save.error} />
        {result && result.errors.length > 0 ? (
          <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger/40 p-4">
            <p className="text-sm font-semibold">
              {result.errors.length === 1 ? "Hay un error" : `Hay ${result.errors.length} errores`}:
              corrígelos en tu hoja y súbela otra vez. No se guardó nada.
            </p>
            <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto text-sm">
              {result.errors.map((e) => (
                <li key={`${e.row}-${e.message}`}>
                  {e.row > 0 ? <span className="font-medium">Fila {e.row}: </span> : null}
                  {e.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {result && result.products.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">
              {ready ? "Se va a crear" : "Lo que se leyó bien"}: {result.products.length}{" "}
              {result.products.length === 1 ? "producto" : "productos"} con {variants}{" "}
              {variants === 1 ? "variante" : "variantes"}
            </p>
            <ul className="flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border text-sm">
              {result.products.map((p) => (
                <li key={p.name} className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground">
                    {[
                      priceSpan(p, store.currency),
                      optionsSummary(p.options) || "Sin variantes",
                      `${p.stock} en stock`,
                    ].join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </FormSheet>
  )
}
