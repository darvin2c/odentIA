import { Badge, Button, Field, FieldGroup, FieldLabel, Input, toast } from "@odentia/ui"
import {
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  type FieldControl,
  FormDrawer,
  submitErrorMessage,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Download, Package, Plus, Trash2, Upload } from "lucide-react"
import { useId, useMemo, useRef, useState } from "react"
import { z } from "zod"
import { MoneyInput } from "./campos"
import { useTemplates } from "./ficha/datos"
import { StateBadge } from "./ficha/lateral"
import { SofiDot, Swatch } from "./ficha/piezas"
import { api } from "./lib/api"
import type { RubroTemplate } from "./lib/ficha"
import {
  type CatalogItem,
  money,
  optionsSummary,
  type ProductOption,
  readMoney,
  valuesSummary,
} from "./lib/tienda"
import { download, Photo } from "./piezas"
import { StoreHeader, useStoreContext } from "./tiendas"

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

/** Cómo se cuentan las unidades de cada rubro (de la plantilla); sin rubro, «unidades». */
function unitsOf(templates: RubroTemplate[] | undefined, rubro: CatalogItem["rubro"]) {
  const found = templates?.find((t) => t.id === rubro)
  return { unit: found?.unit ?? "unidades", unitOne: found?.unitOne ?? "unidad" }
}

/** «blanca, negra · 35 a 42»: los colores y el rango de la otra opción. */
function axisText(item: CatalogItem) {
  const sizes = item.options.find((_, i) => i !== item.colorOption)
  const range =
    sizes && sizes.values.length > 1 ? valuesSummary(sizes.values) : (sizes?.values[0] ?? "")
  return { colors: item.colors.map((c) => c.value).join(", "), range }
}

export function CatalogPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const catalog = useCatalog(store.id)
  const navigate = useNavigate()
  const templates = useTemplates(store.id)
  const [adding, setAdding] = useState(false)
  const [uploading, setUploading] = useState(false)
  const products = catalog.data?.products ?? []
  const variants = products.reduce((n, p) => n + p.variantCount, 0)
  const soldOut = products.filter((p) => p.stock === 0).length

  const columns = useMemo<ColumnDef<CatalogItem>[]>(
    () => [
      {
        id: "foto",
        header: "Foto",
        meta: { view: { role: "media" } },
        cell: ({ row }) => (
          <Photo storeId={store.id} photoId={row.original.photoId} alt="" className="size-11" />
        ),
      },
      {
        id: "producto",
        header: "Producto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            {/* El nombre es el enlace a la ficha: con Tab se llega, Enter la abre y el lector
                de pantalla lo lee por su nombre. Toda la fila también la abre con el mouse. */}
            <Link
              to="/tiendas/$id/catalogo/$productId"
              params={{ id: store.id, productId: row.original.id }}
              className="truncate rounded-sm font-semibold outline-none hover:underline focus-visible:underline focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              {row.original.name}
            </Link>
            {row.original.category ? (
              <span className="truncate text-xs text-muted-foreground">
                {row.original.category}
              </span>
            ) : null}
            {/* En el celular no hay columna de estado: lo que no es «Disponible» se dice aquí. */}
            {row.original.state !== "disponible" && row.original.state !== "agotado" ? (
              <StateBadge state={row.original.state} className="mt-1 self-start md:hidden" />
            ) : null}
          </span>
        ),
      },
      {
        id: "precio",
        header: "Precio",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className="tabular-nums">{priceSpan(row.original, store.currency)}</span>
        ),
      },
      {
        id: "variantes",
        header: "Color y talla",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const { colors, range } = axisText(row.original)
          if (!colors && !range) return <span className="text-muted-foreground">Única</span>
          return (
            <span className="flex min-w-0 items-center gap-2">
              {row.original.colors.length ? (
                <span className="flex -space-x-1">
                  {row.original.colors.map((c) => (
                    <Swatch
                      key={c.value}
                      hex={c.hex}
                      hex2={c.hex2}
                      className="size-4 ring-2 ring-card"
                    />
                  ))}
                </span>
              ) : null}
              <span className="truncate text-sm">
                {colors}
                {range ? (
                  <span className="text-muted-foreground">
                    {colors ? " · " : ""}
                    {range}
                  </span>
                ) : null}
              </span>
            </span>
          )
        },
      },
      {
        id: "stock",
        header: "Queda",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const item = row.original
          const { unit, unitOne } = unitsOf(templates.data?.rubros, item.rubro)
          // Por encargo, con cupo o en preventa se vende sin stock: no se dice «Agotado».
          const sellsAnyway = ["encargo", "cupo", "preventa"].includes(item.state)
          return item.stock === 0 ? (
            sellsAnyway ? (
              <span className="text-muted-foreground">Sin stock · se vende igual</span>
            ) : (
              <Badge variant="outline">Agotado</Badge>
            )
          ) : (
            <span className="tabular-nums">
              {item.stock} {item.stock === 1 ? unitOne : unit}
              {item.soldOut ? (
                <span className="text-muted-foreground"> · {item.soldOut} sin stock</span>
              ) : null}
            </span>
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => <StateBadge state={row.original.state} />,
      },
      {
        id: "sofi",
        header: "Sofi",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => {
          const r = row.original.readiness
          return (
            <span className="flex items-center gap-2 text-sm">
              <SofiDot done={r.done} total={r.total} sellsAlone={r.sellsAlone} />
              <span className={r.sellsAlone ? undefined : "text-warning"}>
                {r.complete
                  ? "Responde todo"
                  : r.sellsAlone
                    ? "Vende sola"
                    : `Le ${r.neededMissing === 1 ? "falta 1" : `faltan ${r.neededMissing}`}`}
              </span>
            </span>
          )
        },
      },
    ],
    [store.id, store.currency, templates.data],
  )
  const table = useReactTable({ data: products, columns, getCoreRowModel: getCoreRowModel() })

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
        <DataTableSkeleton columnCount={7} rowCount={4} label="Cargando el catálogo" />
      ) : null}
      {catalog.isError ? (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
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
        <DataTable
          table={table}
          isFetching={catalog.isFetching}
          onRowClick={(item) =>
            void navigate({
              to: "/tiendas/$id/catalogo/$productId",
              params: { id: store.id, productId: item.id },
            })
          }
        />
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

/** La ayuda del grupo «Opciones» (`field.Group`), la misma al crear y al editar un producto. */
export const OPTIONS_HELP =
  "Hasta tres, como talla, color o material. Se arman todas las combinaciones; después borras las que no vendes. Para tallas seguidas escribe «35 a 42»."

const OPTIONS_PROBLEM = "Cada opción necesita su nombre y al menos un valor"

/** Lo que el formulario dice de las opciones antes de enviarlas. */
export const optionsSchema = z
  .array(z.object({ name: z.string(), values: z.string() }))
  .refine(
    (drafts) => !optionsOf(drafts).some((o) => !o.name || o.values.length === 0),
    OPTIONS_PROBLEM,
  )

/** Lo que el servidor señala de las opciones (`options.0.values`) se dice en el grupo. */
export function optionsField(serverField: string): string | undefined {
  return serverField === "options" || serverField.startsWith("options.") ? "drafts" : undefined
}

/**
 * Las hasta tres opciones de un producto (talla, color, material). Va dentro de `field.Group`,
 * que pone su nombre, su ayuda y su error: aquí solo cada fila.
 */
export function OptionsEditor({
  control,
  drafts,
  onChange,
  disabled,
}: {
  control: FieldControl
  drafts: OptionDraft[]
  onChange: (drafts: OptionDraft[]) => void
  disabled?: boolean
}) {
  const combinations = optionsOf(drafts).reduce((n, o) => n * Math.max(1, o.values.length), 1)
  return (
    <div className="flex flex-col gap-2">
      {drafts.map((draft, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: el orden de las opciones es su identidad
          key={i}
          className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_auto] items-end gap-2"
        >
          <Field>
            <FieldLabel htmlFor={`${control.id}-${i}-nombre`}>{`Opción ${i + 1}`}</FieldLabel>
            <Input
              id={`${control.id}-${i}-nombre`}
              value={draft.name}
              onChange={(e) =>
                onChange(drafts.map((d, j) => (j === i ? { ...d, name: e.target.value } : d)))
              }
              placeholder={["Color", "Talla", "Material"][i]}
              maxLength={30}
              aria-invalid={control.invalid || undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${control.id}-${i}-valores`}>Valores</FieldLabel>
            <Input
              id={`${control.id}-${i}-valores`}
              value={draft.values}
              onChange={(e) =>
                onChange(drafts.map((d, j) => (j === i ? { ...d, values: e.target.value } : d)))
              }
              placeholder={["blanca, negra", "35 a 42", "cuero, gamuza"][i]}
              aria-invalid={control.invalid || undefined}
            />
          </Field>
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
      {drafts.length > 0 ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {combinations} {combinations === 1 ? "combinación" : "combinaciones"}
        </p>
      ) : null}
    </div>
  )
}

/** Las categorías que ya usa la tienda, para elegirlas al escribir (`list` del campo). */
export function CategoryOptions({ id, storeId }: { id: string; storeId: string }) {
  const catalog = useCatalog(storeId)
  const categories = [
    ...new Set((catalog.data?.products ?? []).map((p) => p.category).filter(Boolean)),
  ]
  return (
    <datalist id={id}>
      {categories.map((c) => (
        <option key={c} value={c ?? ""} />
      ))}
    </datalist>
  )
}

function NewProduct({ onClose }: { onClose: () => void }) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const categoriesId = useId()
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ product: { id: string } }>(`/api/tiendas/${store.id}/productos`, {
        method: "POST",
        body,
      }),
  })
  const form = useAppForm({
    defaultValues: {
      name: "",
      category: "",
      price: "",
      drafts: [] as OptionDraft[],
      description: "",
    },
    validators: {
      onSubmit: z.object({
        name: z.string().trim().min(1, "Escribe el nombre del producto"),
        category: z.string(),
        price: z
          .string()
          .refine(
            (price) => Boolean(readMoney(price, store.currency)),
            "Escribe el precio, como 129 o 129.90",
          ),
        drafts: optionsSchema,
        description: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const { product } = await create.mutateAsync({
        name: value.name,
        category: value.category || null,
        description: value.description,
        listPriceCents: readMoney(value.price, store.currency),
        options: optionsOf(value.drafts),
      })
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success("Producto agregado. Ahora suma sus fotos y su stock.")
      onClose()
      await navigate({
        to: "/tiendas/$id/catalogo/$productId",
        params: { id: store.id, productId: product.id },
      })
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: (key) => (key === "listPriceCents" ? "price" : optionsField(key)),
  })

  return (
    <FormDrawer
      {...surface}
      open
      title="Nuevo producto"
      description="Después le sumas sus fotos, su stock y lo que Sofi puede negociar."
      onClose={onClose}
      submitLabel="Agregar producto"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField
              label="Nombre"
              placeholder="Zapatilla urbana"
              maxLength={120}
              autoFocus
            />
          )}
        </form.AppField>
        <form.AppField name="category">
          {(field) => (
            <field.TextField
              label="Categoría (opcional)"
              list={categoriesId}
              maxLength={60}
              placeholder="Zapatillas"
            />
          )}
        </form.AppField>
        <CategoryOptions id={categoriesId} storeId={store.id} />
        <form.AppField name="price">
          {(field) => (
            <field.Control
              label="Precio de lista"
              description="El de siempre. Si una variante cuesta distinto, se lo pones en el producto."
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
        <form.AppField name="drafts">
          {(field) => (
            <field.Group legend="Opciones" description={OPTIONS_HELP}>
              {(control) => (
                <OptionsEditor
                  control={control}
                  drafts={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="description">
          {(field) => (
            <field.TextareaField
              label="Lo que Sofi puede contar"
              rows={3}
              maxLength={2000}
              placeholder="Cuero sintético, planta de goma. Horma normal: pide tu talla de siempre."
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
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
  const failed = preview.error ?? save.error

  return (
    <FormDrawer
      open
      title="Subir una hoja"
      description="Una fila por variante: el producto, sus opciones, el precio y el stock. Las fotos se agregan después en cada producto."
      onClose={onClose}
      onSubmit={() => (ready && file ? save.mutate(file.text) : input.current?.click())}
      isSubmitting={save.isPending}
      error={failed ? submitErrorMessage(failed) : null}
      submitLabel={
        ready
          ? `Crear ${result.products.length} ${result.products.length === 1 ? "producto" : "productos"}`
          : file
            ? "Elegir otra hoja"
            : "Elegir la hoja"
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
    </FormDrawer>
  )
}
