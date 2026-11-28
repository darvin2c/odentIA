import {
  Badge,
  Button,
  Checkbox,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Input,
  toast,
} from "@odentia/ui"
import {
  ConfirmDialog,
  DataTable,
  DataTableSkeleton,
  EmptyState,
  ErrorState,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import {
  type ColumnDef,
  getCoreRowModel,
  type RowSelectionState,
  useReactTable,
} from "@tanstack/react-table"
import {
  ArrowLeft,
  Camera,
  FileSpreadsheet,
  ImagePlus,
  Images,
  Merge,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { LoadIaPanel, useLoadIa } from "./cargar-ia"
import { CATALOG_KEY } from "./catalogo"
import { ApiError, api } from "./lib/api"
import { isImageFile, MEDIA_OFF, preparePhoto } from "./lib/medios"
import { when } from "./lib/pedidos"
import { currencySymbol, moneyInput, readMoney } from "./lib/tienda"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * «Cargar muchos» (decisiones 3 y 4 del lienzo «La ficha del producto»; ADR 0236): se sueltan
 * las fotos como salen del celular, cada una arma un producto y se juntan o se mueven a mano; la
 * hoja de la tienda (CSV o Excel, con las tallas en filas o en columnas) suma productos y les pone
 * sus fotos por nombre. Se revisa en una tabla, se pone el precio a muchos a la vez y nada pasa al
 * catálogo hasta «Crear», que guarda todo o nada.
 */

interface LoadPhoto {
  id: string
  itemId: string | null
  position: number
  fileName: string
  urls: { miniatura: string; vitrina: string } | null
}

interface LoadItem {
  id: string
  position: number
  state: "revisar" | "listo" | "quitado"
  name: string
  category: string | null
  listPriceCents: number | null
  colors: string[]
  sizes: string[]
  options: { name: string; values: string[] }[]
  variants: { values: string[]; stock: number }[]
  doubt: string | null
  sheetRow: number | null
  photos: LoadPhoto[]
}

interface LoadDetail {
  load: {
    id: string
    state: "abierta" | "creada" | "descartada"
    createdProducts: number | null
    createdBy: string
    createdByName: string | null
    createdAt: string
  }
  items: LoadItem[]
  loosePhotos: LoadPhoto[]
  counts: { items: number; ready: number; doubts: number; withoutPrice: number }
}

interface LoadSummary {
  id: string
  state: "abierta" | "creada" | "descartada"
  createdAt: string
  items: number
  photos: number
}

/** Cambia cuando un dato no se pudo guardar: los campos vuelven a lo guardado. */
const ResetContext = createContext(0)

const LOADS_KEY = (storeId: string) => ["cargas", storeId]
const LOAD_KEY = (storeId: string, loadId: string) => ["carga", storeId, loadId]

const list = (text: string) =>
  [
    ...new Set(
      text
        .split(/[,;]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ].slice(0, 40)

/** Las tallas escritas como «35 a 42» o «S, M, L». */
export function readSizes(text: string): string[] {
  const range = /^\s*(\d{1,2})\s*(?:a|-|al)\s*(\d{1,2})\s*$/i.exec(text)
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])]
    if (from <= to && to - from <= 30)
      return Array.from({ length: to - from + 1 }, (_, i) => String(from + i))
  }
  return list(text)
}

const sizesText = (sizes: string[]) => {
  const n = sizes.map(Number)
  if (
    sizes.length > 2 &&
    n.every((x, i) => Number.isInteger(x) && (i === 0 || x === n[i - 1]! + 1))
  )
    return `${sizes[0]} a ${sizes.at(-1)}`
  return sizes.join(", ")
}

export function BulkLoadPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const loads = useQuery({
    queryKey: LOADS_KEY(store.id),
    queryFn: () => api<{ loads: LoadSummary[] }>(`/api/tiendas/${store.id}/cargas`),
    enabled: canEdit,
  })
  const open = loads.data?.loads.find((l) => l.state === "abierta")
  const [loadId, setLoadId] = useState<string | null>(null)
  const current = loadId ?? open?.id ?? null
  // Viven aquí y no en cada vista: la primera subida sigue (con su avance y su aviso) cuando la
  // página pasa de «Start» a la carga recién abierta.
  const upload = useUploadPhotos(current)
  const sheet = useSheet()

  const back = (
    <Link
      to="/tiendas/$id/catalogo"
      params={{ id: store.id }}
      className="inline-flex items-center gap-1 self-start rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Catálogo
    </Link>
  )
  if (!canEdit)
    return (
      <>
        {back}
        <EmptyState
          icon={Images}
          title="Cargar muchos es para quien cambia el catálogo"
          description="Pídeselo al Dueño o a un Administrador de la tienda."
        />
      </>
    )
  if (loads.isPending)
    return (
      <>
        {back}
        <SkeletonRegion message="Cargando la carga">
          <DataTableSkeleton columnCount={6} rowCount={3} label="Cargando la carga" />
        </SkeletonRegion>
      </>
    )
  if (loads.isError)
    return (
      <>
        {back}
        <ErrorState error={loads.error} onRetry={() => void loads.refetch()} />
      </>
    )
  return current ? (
    <LoadView
      back={back}
      loadId={current}
      upload={upload}
      sheet={sheet}
      onClosed={() => setLoadId(null)}
    />
  ) : (
    <Start back={back} upload={upload} sheet={sheet} onOpened={setLoadId} />
  )
}

/** Sube las fotos a la carga, de a una, con su nombre: cada una arma un producto. */
function useUploadPhotos(loadId: string | null) {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [off, setOff] = useState(false)
  const mutation = useMutation({
    mutationFn: async ({ files, to }: { files: File[]; to?: string }) => {
      const id = to ?? loadId
      if (!id) throw new Error("Abre una carga primero")
      const photos = files.filter(isImageFile)
      setProgress({ done: 0, total: photos.length })
      let failed = 0
      for (const [i, file] of photos.entries()) {
        try {
          const blob = await preparePhoto(file)
          await api(
            `/api/tiendas/${store.id}/cargas/${id}/fotos?archivo=${encodeURIComponent(file.name.slice(0, 200))}&producto=nuevo`,
            { method: "POST", raw: { type: blob.type || "image/jpeg", data: blob } },
          )
        } catch (error) {
          if (error instanceof ApiError && error.code === MEDIA_OFF) throw error
          failed++
        }
        setProgress({ done: i + 1, total: photos.length })
      }
      return { id, sent: photos.length - failed, failed }
    },
    onSettled: async (_, __, input) => {
      const id = input.to ?? loadId
      if (!id) return
      await queryClient.invalidateQueries({ queryKey: LOAD_KEY(store.id, id) })
      await queryClient.invalidateQueries({ queryKey: LOADS_KEY(store.id) })
    },
    onSuccess: ({ sent, failed }) => {
      setProgress(null)
      setOff(false)
      if (sent) toast.success(sent === 1 ? "Subiste 1 foto" : `Subiste ${sent} fotos`)
      if (failed)
        toast.error(
          failed === 1 ? "1 foto no se pudo abrir" : `${failed} fotos no se pudieron abrir`,
        )
    },
    onError: (error) => {
      setProgress(null)
      if (error instanceof ApiError && error.code === MEDIA_OFF) setOff(true)
      else toast.error(error.message)
    },
  })
  return { ...mutation, progress, off }
}

function DropZone({
  onFiles,
  onSheet,
  busy,
  big,
}: {
  onFiles: (files: File[]) => void
  onSheet: (file: File) => void
  busy: boolean
  big?: boolean
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const sheet = useRef<HTMLInputElement>(null)
  // Pegar fotos con Ctrl+V en la página.
  const handler = useRef(onFiles)
  handler.current = onFiles
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest("input,textarea")) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      handler.current(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [])
  return (
    <div className="flex flex-col gap-3">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: soltar archivos; «Elegir fotos» y «Una hoja de Excel» son la alternativa */}
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed bg-card p-6 text-center transition-colors",
          big
            ? "min-h-64"
            : "min-h-28 max-md:gap-2 max-md:p-4 md:flex-row md:justify-between md:text-left",
          over ? "border-primary bg-primary-soft/40" : "border-input-border",
        )}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const files = [...e.dataTransfer.files]
          const book = files.find((f) => /\.(csv|xlsx)$/i.test(f.name))
          if (book) onSheet(book)
          const photos = files.filter(isImageFile)
          if (photos.length) onFiles(photos)
        }}
      >
        <span className={cn("flex flex-col items-center gap-2", !big && "md:flex-row md:gap-4")}>
          <span
            className={cn(
              "flex size-12 items-center justify-center rounded-2xl bg-muted",
              !big && "max-md:hidden",
            )}
          >
            <Upload className="size-6 text-muted-foreground" aria-hidden />
          </span>
          <span className="flex flex-col gap-1">
            <span className={cn("font-semibold", big && "text-lg")}>
              {big ? (
                "Suelta aquí todas tus fotos"
              ) : (
                <>
                  <span className="md:hidden">Agrega más fotos o tu hoja</span>
                  <span className="max-md:hidden">Suelta más fotos o tu hoja</span>
                </>
              )}
            </span>
            <span className={cn("max-w-md text-sm text-muted-foreground", !big && "max-md:hidden")}>
              Como salen del celular, sin ordenarlas. También con Ctrl+V. Tu hoja de Excel o CSV,
              con las tallas en filas o en columnas.
            </span>
          </span>
        </span>
        <span className="flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="outline"
            className="md:hidden"
            disabled={busy}
            onClick={() => camera.current?.click()}
          >
            <Camera aria-hidden />
            Tomar foto
          </Button>
          <Button disabled={busy} onClick={() => input.current?.click()}>
            <ImagePlus aria-hidden />
            Elegir fotos
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => sheet.current?.click()}>
            <FileSpreadsheet aria-hidden />
            Una hoja de Excel
          </Button>
        </span>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          if (files.length) onFiles(files)
          e.target.value = ""
        }}
      />
      <input
        ref={sheet}
        type="file"
        accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onSheet(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

function Progress({ progress }: { progress: { done: number; total: number } | null }) {
  if (!progress) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border bg-card p-4" role="status">
      <span className="flex items-center justify-between text-sm">
        <span className="font-medium">
          {progress.done} de {progress.total} fotos
        </span>
        <span className="text-muted-foreground">No cierres esta pestaña mientras sube</span>
      </span>
      <span className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
        <span
          className="block h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
        />
      </span>
    </div>
  )
}

/** Sin carga abierta: soltar las fotos (o la hoja) abre una. */
type Uploads = ReturnType<typeof useUploadPhotos>
type Sheets = ReturnType<typeof useSheet>

function Start({
  back,
  upload,
  sheet,
  onOpened,
}: {
  back: React.ReactNode
  upload: Uploads
  sheet: Sheets
  onOpened: (id: string) => void
}) {
  const { store } = useStoreContext()
  const openLoad = async () => {
    const { load } = await api<{ load: { id: string } }>(`/api/tiendas/${store.id}/cargas`, {
      method: "POST",
    })
    return load.id
  }
  return (
    <>
      {back}
      <StoreHeader
        title="Cargar muchos"
        subtitle="Todas tus fotos de una vez: cada foto arma un producto, tú los juntas y les pones precio. Nada pasa al catálogo hasta «Crear»."
      />
      {upload.off ? (
        <ErrorState
          title="Ahora no se pueden subir fotos"
          message="Puedes cargar tu hoja igual. Avísale a soporte de gestorIA desde la Ayuda."
        />
      ) : null}
      <Progress progress={upload.progress} />
      <DropZone
        big
        busy={upload.isPending || sheet.isPending}
        onFiles={async (files) => {
          try {
            const id = await openLoad()
            onOpened(id)
            upload.mutate({ files, to: id })
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "No se pudo abrir la carga")
          }
        }}
        onSheet={async (file) => {
          try {
            const id = await openLoad()
            onOpened(id)
            sheet.mutate({ file, loadId: id })
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "No se pudo abrir la carga")
          }
        }}
      />
    </>
  )
}

/** La hoja de la carga: suma productos; con un error no suma nada y dice cuál. */
function useSheet() {
  const { store } = useStoreContext()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, loadId }: { file: File; loadId: string }) => {
      const result = await api<{ added: number; errors: { row: number; message: string }[] }>(
        `/api/tiendas/${store.id}/cargas/${loadId}/hoja`,
        { method: "POST", raw: { type: file.type || "text/csv", data: file } },
      )
      return { ...result, loadId }
    },
    onSuccess: async ({ added, errors, loadId }) => {
      await queryClient.invalidateQueries({ queryKey: LOAD_KEY(store.id, loadId) })
      if (errors.length)
        toast.error(
          errors
            .slice(0, 3)
            .map((e) => (e.row ? `Fila ${e.row}: ${e.message}` : e.message))
            .join(" · "),
          { description: "La hoja no sumó nada. Corrígela y vuelve a subirla." },
        )
      else
        toast.success(added === 1 ? "La hoja sumó 1 producto" : `La hoja sumó ${added} productos`)
    },
    onError: (error) => toast.error(error.message),
  })
}

function LoadView({
  back,
  loadId,
  upload,
  sheet,
  onClosed,
}: {
  back: React.ReactNode
  loadId: string
  upload: Uploads
  sheet: Sheets
  onClosed: () => void
}) {
  const { store, meId } = useStoreContext()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [discarding, setDiscarding] = useState(false)
  const detail = useQuery({
    queryKey: LOAD_KEY(store.id, loadId),
    queryFn: () => api<LoadDetail>(`/api/tiendas/${store.id}/cargas/${loadId}`),
    staleTime: 4 * 60_000,
    refetchInterval: 8 * 60_000,
  })
  const [selection, setSelection] = useState<RowSelectionState>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [general, setGeneral] = useState<string[]>([])
  // Cambia cuando un dato no se pudo guardar: cada campo vuelve a lo guardado.
  const [reset, setReset] = useState(0)
  const refresh = () => queryClient.invalidateQueries({ queryKey: LOAD_KEY(store.id, loadId) })
  const base = `/api/tiendas/${store.id}/cargas/${loadId}`
  const ia = useLoadIa(loadId, refresh)
  const iaRef = useRef(ia)
  iaRef.current = ia

  const call = useMutation({
    mutationFn: (input: { path: string; method: string; body?: unknown }) =>
      api(`${base}${input.path}`, { method: input.method, body: input.body }),
    onSuccess: () => refresh(),
    onError: async (error) => {
      await refresh()
      toast.error(error.message)
    },
  })
  const create = useMutation({
    mutationFn: () =>
      api<{ created: number; errors: { itemId: string; message: string }[] }>(`${base}/crear`, {
        method: "POST",
      }),
    onSuccess: async (result) => {
      if (result.errors.length) {
        setErrors(
          Object.fromEntries(
            result.errors.filter((e) => e.itemId).map((e) => [e.itemId, e.message]),
          ),
        )
        setGeneral(result.errors.filter((e) => !e.itemId).map((e) => e.message))
        toast.error("No se creó nada: revisa lo marcado en rojo")
        return
      }
      setErrors({})
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      await queryClient.invalidateQueries({ queryKey: LOADS_KEY(store.id) })
      toast.success(
        result.created === 1 ? "Creaste 1 producto" : `Creaste ${result.created} productos`,
      )
      onClosed()
      void navigate({ to: "/tiendas/$id/catalogo", params: { id: store.id } })
    },
    onError: (error) => toast.error(error.message),
  })
  const discard = useMutation({
    mutationFn: () => api(base, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LOADS_KEY(store.id) })
      setDiscarding(false)
      toast.success("Descartaste la carga: nada pasó al catálogo")
      onClosed()
    },
  })

  const items = useMemo(
    () => (detail.data?.items ?? []).filter((i) => i.state !== "quitado"),
    [detail.data],
  )
  // «No crear este» no borra nada: el producto queda aparte, con «Volver a incluir».
  const removed = (detail.data?.items ?? []).filter((i) => i.state === "quitado")
  const everyPhoto = (detail.data?.items ?? []).reduce(
    (n, i) => n + i.photos.length,
    detail.data?.loosePhotos.length ?? 0,
  )
  const loose = detail.data?.loosePhotos ?? []
  // Las columnas no cambian con los datos: si cambiaran, cada fila se volvería a montar al
  // guardar otra y se perdería lo que se está escribiendo.
  const live = useRef({ items, errors })
  live.current = { items, errors }
  const allPhotos = items.reduce((n, i) => n + i.photos.length, 0) + loose.length
  const chosen = items.filter((i) => selection[i.id]).map((i) => i.id)

  /** «Mover a…»: a otro producto de la carga, a uno nuevo o sin producto. */
  const moveTo = (photoId: string, target: string | null | "nuevo") =>
    call.mutate({
      path: `/fotos/${photoId}`,
      method: "PATCH",
      body: target === "nuevo" ? { newItem: true } : { itemId: target },
    })
  const save = (itemId: string, body: Record<string, unknown>, onSuccess?: () => void) => {
    setErrors(({ [itemId]: _, ...rest }) => rest)
    call.mutate(
      { path: `/productos/${itemId}`, method: "PATCH", body },
      { onError: () => setReset((n) => n + 1), onSuccess },
    )
  }
  const nameOf = (item: LoadItem) => (item.name.trim() ? `«${item.name.trim()}»` : "Este producto")
  /** «No crear este», con «Deshacer» en el aviso y «Volver a incluir» abajo de la tabla. */
  const leaveOut = (item: LoadItem) =>
    save(item.id, { state: "quitado" }, () =>
      toast.success(`${nameOf(item)} no se va a crear`, {
        description: "Sigue abajo de la tabla, con «Volver a incluir».",
        action: { label: "Deshacer", onClick: () => save(item.id, { state: item.state }) },
      }),
    )
  const include = (item: LoadItem) => save(item.id, { state: "revisar" })

  // biome-ignore lint/correctness/useExhaustiveDependencies: las acciones no cambian la forma de la tabla
  const columns = useMemo<ColumnDef<LoadItem>[]>(
    () => [
      {
        id: "elegir",
        meta: { view: { role: "select" } },
        header: ({ table }) => (
          <Checkbox
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected()}
            onCheckedChange={(v) => table.toggleAllRowsSelected(!!v)}
            aria-label="Elegir todos"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(!!v)}
            aria-label={`Elegir ${row.original.name || "este producto"}`}
            onClick={(e) => e.stopPropagation()}
          />
        ),
      },
      {
        id: "fotos",
        header: "Fotos",
        meta: { view: { role: "media" } },
        cell: ({ row }) => (
          <PhotoStack
            photos={row.original.photos}
            items={live.current.items}
            itemId={row.original.id}
            onMove={moveTo}
            onDrop={(photoId) => moveTo(photoId, row.original.id)}
          />
        ),
      },
      {
        id: "producto",
        header: "Producto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <div className="flex min-w-44 flex-col gap-1">
            <TextCell
              label="Nombre"
              value={row.original.name}
              placeholder="Ponle nombre"
              invalid={Boolean(live.current.errors[row.original.id])}
              onSave={(name) => save(row.original.id, { name })}
            />
            <TextCell
              label="Categoría"
              value={row.original.category ?? ""}
              placeholder="Categoría"
              small
              onSave={(category) => save(row.original.id, { category: category || null })}
            />
          </div>
        ),
      },
      {
        id: "colores",
        header: "Colores",
        meta: { view: { tableOnly: true } },
        cell: ({ row }) => (
          <TextCell
            label="Colores"
            value={row.original.colors.join(", ")}
            placeholder="blanca, negra"
            onSave={(text) => save(row.original.id, { colors: list(text) })}
          />
        ),
      },
      {
        id: "tallas",
        header: "Tallas",
        cell: ({ row }) => (
          <TextCell
            label="Tallas"
            value={sizesText(row.original.sizes)}
            placeholder="35 a 42"
            onSave={(text) => save(row.original.id, { sizes: readSizes(text) })}
          />
        ),
      },
      {
        id: "precio",
        header: "Precio",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <TextCell
            label="Precio"
            prefix={currencySymbol(store.currency)}
            inputMode="decimal"
            value={moneyInput(row.original.listPriceCents, store.currency)}
            placeholder="0"
            className="w-28"
            onSave={(text) => {
              const cents = text.trim() ? readMoney(text, store.currency) : null
              if (text.trim() && !cents) return toast.error("Escribe el precio con números")
              save(row.original.id, { listPriceCents: cents })
            }}
          />
        ),
      },
      {
        id: "stock",
        header: "Stock c/u",
        cell: ({ row }) => {
          const stocks = new Set(row.original.variants.map((v) => v.stock))
          return (
            <TextCell
              label="Stock de cada variante"
              inputMode="numeric"
              className="w-20"
              value={stocks.size === 1 ? String([...stocks][0]) : ""}
              placeholder={stocks.size > 1 ? "varios" : "0"}
              onSave={(text) => {
                if (!/^\d{1,6}$/.test(text.trim())) return
                save(row.original.id, { stock: Number(text.trim()) })
              }}
            />
          )
        },
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <ItemState item={row.original} error={live.current.errors[row.original.id]} />
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Acciones</span>,
        cell: ({ row }) => (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Opciones de ${row.original.name || "este producto"}`}
                  onClick={(e) => e.stopPropagation()}
                />
              }
            >
              <MoreHorizontal aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={() => iaRef.current.complete.mutate(row.original.id)}>
                <Sparkles aria-hidden />
                Completar con IA
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => leaveOut(row.original)}>
                <Trash2 aria-hidden />
                No crear este
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ),
      },
    ],
    [store.currency],
  )
  const table = useReactTable({
    data: items,
    columns,
    getRowId: (row) => row.id,
    state: { rowSelection: selection },
    onRowSelectionChange: setSelection,
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
  })

  const counts = detail.data?.counts
  const ready = items.filter((i) => i.name.trim() && i.listPriceCents).length
  return (
    <>
      {back}
      <StoreHeader
        title="Cargar muchos"
        subtitle={
          counts
            ? `${allPhotos} ${allPhotos === 1 ? "foto" : "fotos"} en ${counts.items} ${counts.items === 1 ? "producto" : "productos"} · ${ready} ${ready === 1 ? "listo" : "listos"}${counts.doubts ? ` · ${counts.doubts} con ${counts.doubts === 1 ? "duda" : "dudas"}` : ""}${counts.withoutPrice ? ` · ${counts.withoutPrice} sin precio` : ""}`
            : "Nada pasa al catálogo hasta «Crear»."
        }
        primary={{
          label: create.isPending
            ? "Creando…"
            : `Crear ${items.length} ${items.length === 1 ? "producto" : "productos"}`,
          icon: <Images aria-hidden />,
          onClick: () => create.mutate(),
          disabled: create.isPending || items.length === 0,
        }}
        secondary={{
          label: ia.group.isPending ? "Mirando las fotos…" : "Juntar con IA",
          icon: <Sparkles aria-hidden />,
          onClick: () => ia.group.mutate(),
          disabled: ia.group.isPending || allPhotos < 2,
        }}
        menu={[
          {
            label: "Descartar la carga",
            icon: <Trash2 aria-hidden />,
            onSelect: () => setDiscarding(true),
            disabled: discard.isPending,
          },
        ]}
      />
      {detail.data ? <LoadOwner load={detail.data.load} meId={meId} /> : null}
      <ConfirmDialog
        open={discarding}
        title="¿Descartar la carga?"
        description={`${
          detail.data && detail.data.load.createdBy !== meId
            ? `Es la carga que abrió ${detail.data.load.createdByName ?? "otra persona del equipo"}. `
            : ""
        }Se borran ${everyPhoto === 1 ? "su foto" : `sus ${everyPhoto} fotos`} y ${
          items.length + removed.length === 1
            ? "su producto"
            : `sus ${items.length + removed.length} productos`
        } por crear, y nada pasa al catálogo. No se puede deshacer.`}
        confirmLabel="Descartar la carga"
        cancelLabel="Seguir con la carga"
        pending={discard.isPending}
        error={discard.isError ? discard.error.message : null}
        onConfirm={() => discard.mutate()}
        onClose={() => {
          setDiscarding(false)
          discard.reset()
        }}
      />
      {upload.off ? (
        <ErrorState
          title="Ahora no se pueden subir fotos"
          message="Lo que ya está en la carga sigue aquí. Avísale a soporte de gestorIA desde la Ayuda."
        />
      ) : null}
      {general.length ? (
        <p role="alert" className="text-sm text-destructive">
          {general.join(" · ")}
        </p>
      ) : null}
      <Progress progress={upload.progress} />
      <DropZone
        busy={upload.isPending || sheet.isPending}
        onFiles={(files) => upload.mutate({ files })}
        onSheet={(file) => sheet.mutate({ file, loadId })}
      />
      {loose.length ? (
        <section
          aria-label="Fotos sin producto"
          className="flex flex-col gap-2 rounded-xl border border-dashed bg-card p-3"
        >
          <span className="text-sm font-medium">
            {loose.length === 1 ? "1 foto sin producto" : `${loose.length} fotos sin producto`}
            <span className="font-normal text-muted-foreground">
              {" "}
              · arrástralas a un producto o usa «Mover a…»
            </span>
          </span>
          <PhotoStack photos={loose} items={items} itemId={null} onMove={moveTo} spread />
        </section>
      ) : null}
      <LoadIaPanel
        loadId={loadId}
        items={items}
        photos={[...items.flatMap((i) => i.photos), ...loose]}
        ia={ia}
      />
      {chosen.length ? (
        <BulkBar
          count={chosen.length}
          currency={store.currency}
          busy={call.isPending}
          onApply={(set) => {
            call.mutate(
              { path: "/productos", method: "PATCH", body: { ids: chosen, set } },
              { onSuccess: () => toast.success(`Listo: se aplicó a ${chosen.length}`) },
            )
          }}
          onJoin={
            chosen.length > 1
              ? () => {
                  const [first, ...rest] = chosen
                  call.mutate(
                    { path: `/productos/${first}/juntar`, method: "POST", body: { from: rest } },
                    {
                      onSuccess: () => {
                        setSelection({})
                        toast.success("Juntaste las fotos en un producto")
                      },
                    },
                  )
                }
              : undefined
          }
          onClear={() => setSelection({})}
        />
      ) : null}
      {detail.isPending ? (
        <DataTableSkeleton columnCount={8} rowCount={4} label="Cargando la carga" />
      ) : detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Images}
          title="Todavía no hay productos en la carga"
          description="Suelta tus fotos o tu hoja arriba: cada foto arma un producto."
        />
      ) : (
        <>
          <ResetContext.Provider value={reset}>
            <DataTable table={table} isFetching={detail.isFetching} wrap />
          </ResetContext.Provider>
          <p className="text-sm text-muted-foreground">
            {ready === items.length
              ? "Todos tienen nombre y precio: «Crear» los pasa al catálogo de una vez."
              : `${items.length - ready} todavía sin nombre o sin precio. «Crear» no pasa nada al catálogo hasta que todos estén.`}
          </p>
        </>
      )}
      {removed.length ? (
        <section
          aria-label="Lo que no se va a crear"
          className="flex flex-col gap-2 rounded-xl border border-dashed bg-card p-3"
        >
          <span className="text-sm font-medium">
            {removed.length === 1
              ? "1 que no se va a crear"
              : `${removed.length} que no se van a crear`}
            <span className="font-normal text-muted-foreground">
              {" "}
              · «Crear» no los pasa al catálogo y sus fotos se borran
            </span>
          </span>
          <ul className="flex flex-col gap-1.5">
            {removed.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                  {item.name.trim() || "Sin nombre"}
                  <span className="text-muted-foreground">
                    {" "}
                    · {item.photos.length === 1 ? "1 foto" : `${item.photos.length} fotos`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={call.isPending}
                  onClick={() => include(item)}
                >
                  <Undo2 aria-hidden />
                  Volver a incluir
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  )
}

/** De quién es la carga abierta y desde cuándo: la carga es de la tienda, y se dice de quién es. */
function LoadOwner({ load, meId }: { load: LoadDetail["load"]; meId: string }) {
  const mine = load.createdBy === meId
  return (
    <p className="text-sm text-muted-foreground">
      {mine
        ? `Abriste esta carga el ${when(load.createdAt)}.`
        : `Esta carga la abrió ${load.createdByName ?? "otra persona del equipo"} el ${when(load.createdAt)}. Lo que cambies, crees o descartes aquí es de esa carga.`}
    </p>
  )
}

/** Un dato de la fila que se escribe y se guarda al salir del campo (o con Enter). */
function TextCell({
  label,
  value,
  onSave,
  placeholder,
  prefix,
  small,
  invalid,
  className,
  inputMode,
}: {
  label: string
  value: string
  onSave: (value: string) => void
  placeholder?: string
  prefix?: string
  small?: boolean
  invalid?: boolean
  className?: string
  inputMode?: "decimal" | "numeric"
}) {
  const [text, setText] = useState(value)
  const reset = useContext(ResetContext)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reset` vuelve a lo guardado
  useEffect(() => setText(value), [value, reset])
  const commit = () => {
    if (text.trim() !== value.trim()) onSave(text)
  }
  return (
    <span className={cn("relative block", className)}>
      {prefix ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted-foreground"
        >
          {prefix}
        </span>
      ) : null}
      <Input
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={text}
        inputMode={inputMode}
        placeholder={placeholder}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur()
          if (e.key === "Escape") setText(value)
        }}
        className={cn(
          "h-8",
          prefix && (prefix.length > 2 ? "pl-11" : "pl-8"),
          small && "h-7 text-xs text-muted-foreground",
        )}
      />
    </span>
  )
}

function ItemState({ item, error }: { item: LoadItem; error?: string }) {
  // La etiqueta es corta; lo que dice va debajo, entero y legible, sin salirse de la fila.
  const note = (badge: React.ReactNode, text: string, tone: string) => (
    <span className="flex max-w-56 min-w-0 flex-col items-start gap-1">
      {badge}
      <span className={cn("text-xs leading-snug [overflow-wrap:anywhere]", tone)}>{text}</span>
    </span>
  )
  if (error)
    return note(<Badge variant="destructive">No se puede crear</Badge>, error, "text-destructive")
  if (item.doubt)
    return note(
      <Badge
        variant="outline"
        className="border-warning/50 bg-warning-soft text-warning-foreground"
      >
        Con duda
      </Badge>,
      item.doubt,
      "text-muted-foreground",
    )
  if (!item.name.trim()) return <Badge variant="outline">Sin nombre</Badge>
  if (!item.listPriceCents) return <Badge variant="outline">Sin precio</Badge>
  return <Badge variant="success">Listo para crear</Badge>
}

/** Las fotos de un producto de la carga: se arrastran a otro producto o se mueven con «Mover a…». */
function PhotoStack({
  photos,
  items,
  itemId,
  onMove,
  onDrop,
  spread,
}: {
  photos: LoadPhoto[]
  items: LoadItem[]
  itemId: string | null
  onMove: (photoId: string, target: string | null | "nuevo") => void
  onDrop?: (photoId: string) => void
  spread?: boolean
}) {
  const [over, setOver] = useState(false)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: soltar una foto aquí; «Mover a…» es la alternativa
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg p-0.5",
        over && "ring-2 ring-primary",
        spread ? "flex-wrap" : "",
      )}
      onDragOver={(e) => {
        if (!onDrop || !e.dataTransfer.types.includes("text/x-foto-carga")) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const id = e.dataTransfer.getData("text/x-foto-carga")
        setOver(false)
        if (id && onDrop) {
          e.preventDefault()
          onDrop(id)
        }
      }}
    >
      {photos.length === 0 ? (
        <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <ImagePlus className="size-4" aria-hidden />
          <span className="sr-only">Sin fotos</span>
        </span>
      ) : null}
      {photos.slice(0, spread ? 50 : 4).map((photo, index) => (
        <DropdownMenu key={photo.id}>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                draggable
                onDragStart={(e) => e.dataTransfer.setData("text/x-foto-carga", photo.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`${photo.fileName || "Foto"}: mover a…`}
                className={cn(
                  "size-11 shrink-0 cursor-grab overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
                  // En el celular la fila lleva la primera y cuántas más.
                  !spread && index > 0 && "max-md:hidden",
                )}
              />
            }
          >
            {photo.urls ? (
              <img
                src={photo.urls.miniatura}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : null}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Mover a…</DropdownMenuLabel>
              {items
                .filter((i) => i.id !== itemId)
                .map((i) => (
                  <DropdownMenuItem key={i.id} onClick={() => onMove(photo.id, i.id)}>
                    <span className="truncate">{i.name || "Producto sin nombre"}</span>
                  </DropdownMenuItem>
                ))}
              <DropdownMenuItem onClick={() => onMove(photo.id, "nuevo")}>
                <Merge aria-hidden />
                Un producto nuevo
              </DropdownMenuItem>
              {itemId ? (
                <DropdownMenuItem onClick={() => onMove(photo.id, null)}>
                  Sin producto
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
      {!spread && photos.length > 4 ? (
        <span className="text-xs text-muted-foreground max-md:hidden">+{photos.length - 4}</span>
      ) : null}
      {!spread && photos.length > 1 ? (
        <span className="text-xs text-muted-foreground md:hidden">+{photos.length - 1}</span>
      ) : null}
    </div>
  )
}

/** «Poner a los 20»: lo mismo a los elegidos. Solo lo que se escribe se cambia. */
function BulkBar({
  count,
  currency,
  busy,
  onApply,
  onJoin,
  onClear,
}: {
  count: number
  currency: string
  busy: boolean
  onApply: (set: Record<string, unknown>) => void
  onJoin?: () => void
  onClear: () => void
}) {
  const [price, setPrice] = useState("")
  const [sizes, setSizes] = useState("")
  const [stock, setStock] = useState("")
  const apply = () => {
    const set: Record<string, unknown> = {}
    if (price.trim()) {
      const cents = readMoney(price, currency)
      if (!cents) return toast.error("Escribe el precio con números")
      set.listPriceCents = cents
    }
    if (sizes.trim()) set.sizes = readSizes(sizes)
    if (stock.trim()) {
      if (!/^\d{1,6}$/.test(stock.trim())) return toast.error("El stock es un número entero")
      set.stock = Number(stock.trim())
    }
    if (!Object.keys(set).length) return toast.info("Escribe el precio, las tallas o el stock")
    onApply(set)
  }
  return (
    <div
      role="toolbar"
      aria-label={`Lo mismo a los ${count} elegidos`}
      className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl bg-foreground p-2.5 text-background shadow-lg"
    >
      <b className="px-1 text-sm">
        {count} {count === 1 ? "elegido" : "elegidos"}
      </b>
      <Input
        aria-label="Precio para los elegidos"
        placeholder={`Precio ${currencySymbol(currency)}`}
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        className="h-8 w-28 bg-background text-foreground"
      />
      <Input
        aria-label="Tallas para los elegidos"
        placeholder="Tallas: 35 a 42"
        value={sizes}
        onChange={(e) => setSizes(e.target.value)}
        className="h-8 w-36 bg-background text-foreground"
      />
      <Input
        aria-label="Stock por talla para los elegidos"
        placeholder="Stock c/u"
        inputMode="numeric"
        value={stock}
        onChange={(e) => setStock(e.target.value)}
        className="h-8 w-24 bg-background text-foreground"
      />
      <Button size="sm" variant="secondary" disabled={busy} onClick={apply}>
        Poner a los {count}
      </Button>
      {onJoin ? (
        <Button
          size="sm"
          variant="ghost"
          className="text-background hover:bg-background/10 hover:text-background"
          disabled={busy}
          onClick={onJoin}
        >
          <Merge aria-hidden />
          Juntar en uno
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto text-background hover:bg-background/10 hover:text-background"
        onClick={onClear}
      >
        Listo
      </Button>
    </div>
  )
}
