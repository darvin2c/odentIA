import {
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast,
  useIsMobile,
} from "@odentia/ui"
import {
  ConfirmDialog,
  ErrorState,
  PageNotice,
  SkeletonRegion,
  UnsavedDialog,
  useDraftBlocker,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import {
  ArrowLeft,
  Check,
  CircleAlert,
  CloudOff,
  Eye,
  History,
  Keyboard,
  Loader2,
  Redo2,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CATALOG_KEY } from "../catalogo"
import { api } from "../lib/api"
import { anchorOf, cellKey, type Readiness, type RubroTemplate, type Sheet } from "../lib/ficha"
import { money } from "../lib/tienda"
import { Photo } from "../piezas"
import { StoreHeader, useStoreContext } from "../tiendas"
import { type SaveStatus, useFicha, useFichaStore } from "./borrador"
import { HistoryDrawer, KardexDrawer, SearchDialog, ShortcutsDialog } from "./cajones"
import { type Ficha, FichaContext } from "./contexto"
import { DataCard, PRODUCT_KEY, useTemplates } from "./datos"
import { PhotoCarousel, PhotosCard } from "./fotos"
import {
  ActivityCard,
  CrossSellCard,
  InventoryCard,
  OrganizationCard,
  PackageCard,
  StateBadge,
  StatusCard,
  stateOf,
  WebCard,
} from "./lateral"
import { goTo, SofiDot } from "./piezas"
import { PriceCard } from "./precio"
import { ProbarPanel } from "./probar"
import { TextCard } from "./texto"
import { VariantsCard } from "./variantes"
import { PreviewDrawer } from "./vista-previa"

/**
 * La ficha del producto en página completa (lienzo «La ficha del producto»; prototipo aprobado
 * `ficha/ficha.tsx`): la cabecera con el estado, el precio, el stock, cómo va el guardado y qué
 * tan lista está para Sofi; a la izquierda lo que se vende (fotos, texto, variantes, precio y los
 * datos del rubro) y al costado lo demás. Se guarda sola, con deshacer y rehacer. Ventas la ve
 * sin cambiarla (el servidor lo rechaza igual) y no ve costos.
 */

/** Lo que escribe la persona en un campo: los atajos de la ficha no se meten ahí. */
const typing = (target: EventTarget | null) =>
  !!(target as HTMLElement | null)?.closest?.(
    "input,textarea,select,[contenteditable=true],[role=dialog],[role=listbox],[role=menu]",
  )

function SaveState({ status, pending }: { status: SaveStatus; pending: number }) {
  const icon = {
    saved: <Check className="size-4 text-success" aria-hidden />,
    pending: <span className="size-2 rounded-full bg-primary" aria-hidden />,
    saving: <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />,
    offline: <CloudOff className="size-4 text-warning" aria-hidden />,
    rejected: <CircleAlert className="size-4 text-destructive" aria-hidden />,
    reason: <CircleAlert className="size-4 text-warning" aria-hidden />,
    incomplete: <span className="size-2 rounded-full bg-warning" aria-hidden />,
  }[status.kind]
  const text = {
    saved: "Guardado",
    pending: pending === 1 ? "1 cambio sin guardar" : `${pending} cambios sin guardar`,
    saving: "Guardando…",
    offline: "Sin conexión: lo guardo al volver",
    rejected: "No se guardó todo",
    reason: "Falta el motivo del stock",
    incomplete: "Falta completar el paquete",
  }[status.kind]
  const detail = "message" in status ? status.message : undefined
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
      title={detail}
    >
      {icon}
      <span className="truncate">{text}</span>
    </span>
  )
}

/**
 * La línea de Sofi: lo vende sola o no, y qué le falta, con lo que mira cada cosa; y «Probar como
 * clienta», que abre la prueba con este producto (para quien cambia la ficha, como la prueba).
 */
function SofiLine({ readiness, onTry }: { readiness: Readiness; onTry?: () => void }) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const neededMissing = readiness.items.filter((i) => i.needed && !i.ok)
  const extraMissing = readiness.items.filter((i) => !i.needed && !i.ok)
  return (
    <div className="flex max-w-full flex-wrap items-center gap-x-1 gap-y-1 self-start rounded-full border bg-card py-0.5 pr-1 pl-0.5 shadow-xs max-sm:rounded-2xl">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="group inline-flex min-h-8 min-w-0 max-w-full items-center gap-2.5 rounded-full py-0.5 pr-2.5 pl-1 text-left text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/40"
              aria-label="Lo que sabe Sofi de este producto"
            />
          }
        >
          <SofiDot
            done={readiness.done}
            total={readiness.total}
            sellsAlone={readiness.sellsAlone}
            size={22}
          />
          <span className="min-w-0 truncate">
            {readiness.complete ? (
              <span className="font-medium">Sofi responde todo sobre este producto</span>
            ) : readiness.sellsAlone ? (
              <>
                <span className="font-medium">Sofi lo vende sola</span>
                <span className="text-muted-foreground">
                  {" "}
                  · {extraMissing.length}{" "}
                  {isMobile
                    ? "para responder todo"
                    : extraMissing.length === 1
                      ? "cosa para que responda todo"
                      : "cosas para que responda todo"}
                </span>
              </>
            ) : (
              <>
                <span className="font-medium text-warning">
                  Sofi necesita {neededMissing.length}{" "}
                  {neededMissing.length === 1 ? "dato" : "datos"}
                </span>
                <span className="text-muted-foreground"> para venderlo sola</span>
              </>
            )}
          </span>
          <span className="shrink-0 font-semibold text-primary group-hover:underline">Ver</span>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[22rem] max-w-[calc(100vw-2rem)] gap-3 rounded-2xl p-4"
        >
          <div className="flex items-center gap-3">
            <SofiDot
              done={readiness.done}
              total={readiness.total}
              sellsAlone={readiness.sellsAlone}
              size={30}
            />
            <div className="flex flex-col">
              <span className="font-semibold">
                {readiness.sellsAlone ? "Lo vende sola" : "Le falta para venderlo sola"}
              </span>
              <span className="text-xs text-muted-foreground">
                Sabe {readiness.done} de {readiness.total}. Nada de esto frena una venta.
              </span>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {[...neededMissing, ...extraMissing, ...readiness.items.filter((i) => i.ok)].map(
              (item) => (
                <li key={item.id} className="flex min-h-8 items-center gap-2">
                  {item.ok ? (
                    <Check className="size-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <span
                      className={cn(
                        "mx-1 size-2 shrink-0 rounded-full",
                        item.needed ? "bg-warning" : "bg-muted-foreground/50",
                      )}
                      aria-hidden
                    />
                  )}
                  <span className={cn("min-w-0 flex-1", item.ok && "text-muted-foreground")}>
                    {item.label}
                    {!item.ok ? (
                      <span className="sr-only">{item.needed ? ", lo necesita" : ", suma"}</span>
                    ) : null}
                  </span>
                  {!item.ok ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        setOpen(false)
                        goTo(anchorOf(item.id))
                      }}
                    >
                      Completar
                    </Button>
                  ) : null}
                </li>
              ),
            )}
          </ul>
        </PopoverContent>
      </Popover>
      {onTry ? (
        <Button variant="ghost" size="sm" className="rounded-full text-primary" onClick={onTry}>
          Probar como clienta
        </Button>
      ) : null}
    </div>
  )
}

function FichaSkeleton() {
  return (
    <SkeletonRegion message="Cargando el producto" className="flex flex-col gap-4">
      <Skeleton className="h-5 w-24" />
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-lg" />
        <Skeleton className="h-8 w-64 max-w-full" />
      </div>
      <Skeleton className="h-6 w-80 max-w-full" />
      <Skeleton className="h-9 w-72 max-w-full rounded-full" />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex flex-col gap-5">
          <Skeleton className="h-72 rounded-xl" />
          <Skeleton className="h-48 rounded-xl" />
        </div>
        <div className="flex flex-col gap-4">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      </div>
    </SkeletonRegion>
  )
}

export function ProductPage() {
  const { store } = useStoreContext()
  const { productId } = useParams({ strict: false }) as { productId: string }
  const queryClient = useQueryClient()
  const edit = store.permissions.includes("configuracion")
  const product = useQuery({
    queryKey: PRODUCT_KEY(store.id, productId),
    queryFn: () => api<{ product: Sheet }>(`/api/tiendas/${store.id}/productos/${productId}`),
  })
  const templates = useTemplates(store.id)
  const saveApi = useMemo(
    () => ({
      get: () =>
        api<{ product: Sheet }>(`/api/tiendas/${store.id}/productos/${productId}`).then(
          (r) => r.product,
        ),
      patch: (body: Record<string, unknown>) =>
        api<{ product: Sheet }>(`/api/tiendas/${store.id}/productos/${productId}`, {
          method: "PATCH",
          body,
        }).then((r) => r.product),
      grid: (body: unknown) =>
        api<{ product: Sheet }>(`/api/tiendas/${store.id}/productos/${productId}/cuadricula`, {
          method: "POST",
          body,
        }).then((r) => r.product),
    }),
    [store.id, productId],
  )
  const onSaved = useCallback(
    (sheet: Sheet) => {
      queryClient.setQueryData(PRODUCT_KEY(store.id, productId), { product: sheet })
      void queryClient.invalidateQueries({ queryKey: ["historial", store.id, productId] })
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
    },
    [queryClient, store.id, productId],
  )
  const fichaStore = useFichaStore(product.data?.product, saveApi, onSaved, !edit)
  const state = useFicha(fichaStore)

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
  if (product.isError)
    return (
      <>
        {back}
        <StoreHeader title="Producto" />
        <ErrorState error={product.error} onRetry={() => void product.refetch()} />
      </>
    )
  if (!fichaStore || !state.draft) return <FichaSkeleton />
  return (
    <ProductSheet
      key={productId}
      back={back}
      store={fichaStore}
      state={state}
      templates={templates.data?.rubros ?? []}
      edit={edit}
    />
  )
}

function ProductSheet({
  back,
  store: fichaStore,
  state,
  templates,
  edit,
}: {
  back: React.ReactNode
  store: NonNullable<ReturnType<typeof useFichaStore>>
  state: ReturnType<typeof useFicha>
  templates: RubroTemplate[]
  edit: boolean
}) {
  const { store } = useStoreContext()
  const isMobile = useIsMobile()
  const { sheet, draft, base, status, history, errors } = state
  const [searching, setSearching] = useState(false)
  const [kardex, setKardex] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [trying, setTrying] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const pending = fichaStore.pendingCount()
  const rubro = templates.find((t) => t.id === draft.rubro) ?? null
  const unit = rubro?.unit ?? "unidades"
  const unitOne = rubro?.unitOne ?? "unidad"
  const costs = store.permissions.includes("costos.ver")

  const undo = useCallback(() => {
    const label = fichaStore.undo()
    if (label)
      toast(`Deshiciste: ${label}`, {
        action: { label: "Rehacer", onClick: () => fichaStore.redo() },
      })
  }, [fichaStore])
  const redo = useCallback(() => {
    const label = fichaStore.redo()
    if (label)
      toast(`Rehiciste: ${label}`, {
        action: { label: "Deshacer", onClick: () => fichaStore.undo() },
      })
  }, [fichaStore])

  // Lo último que se cambió, con «Deshacer» a mano (como el prototipo).
  const last = state.last
  useEffect(() => {
    if (!last || last.label.startsWith("Deshiciste") || last.label.startsWith("Rehiciste")) return
    toast(last.label, {
      id: "ficha-cambio",
      action: { label: "Deshacer", onClick: () => fichaStore.undo() },
    })
  }, [last, fichaStore])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      // En un campo, Ctrl+Z es el del campo; en la cuadrícula, el de la ficha.
      if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && e.key.toLowerCase() === "y" && !typing(e.target)) {
        e.preventDefault()
        redo()
        return
      }
      if (
        mod ||
        e.altKey ||
        typing(e.target) ||
        (e.target as HTMLElement | null)?.closest?.("[role=grid]")
      )
        return
      if (e.key === "/") {
        e.preventDefault()
        setSearching(true)
      } else if (e.key === "?") {
        e.preventDefault()
        setShortcuts(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  // Salir con algo que no se pudo guardar (sin red, rechazado o sin el motivo) pregunta antes.
  const stuck = pending > 0 && ["offline", "rejected", "reason", "incomplete"].includes(status.kind)
  const blocker = useDraftBlocker({
    disabled: !stuck,
    enableBeforeUnload: stuck,
    shouldBlockFn: () => stuck,
  })
  const blocked = blocker.status === "blocked"

  const stock = draft.grid
    ? Object.entries(draft.grid.cells)
        .filter(([key]) =>
          draft.grid!.rows.some((r) =>
            draft.grid!.columns.some((c) => cellKey(r.id, c.id) === key),
          ),
        )
        .reduce((n, [, c]) => n + c.stock, 0)
    : sheet.variants.reduce((n, v) => n + v.stock, 0)
  const cells = draft.grid
    ? draft.grid.rows.flatMap((r) =>
        draft.grid!.columns.map((c) => draft.grid!.cells[cellKey(r.id, c.id)]),
      )
    : []
  const out = cells.filter((c) => (c?.stock ?? 0) === 0).length
  const prices = cells.length
    ? cells.map((c) => c?.priceCents ?? draft.listPriceCents)
    : [draft.listPriceCents]
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const fmt = (cents: number) => money(cents, store.currency)
  const priceSpan = lo === hi ? fmt(lo) : `${fmt(lo)} a ${fmt(hi)}`
  const state0 = stateOf(draft.status, stock)

  const ficha: Ficha = {
    store,
    sheet,
    base,
    draft,
    errors,
    edit,
    costs,
    rubro,
    change: fichaStore.change.bind(fichaStore),
    status,
    setReason: (reason) => fichaStore.setReason(reason),
    unit,
    unitOne,
  }

  const menu = [
    {
      label: "Buscar en la ficha",
      icon: <Search aria-hidden />,
      onSelect: () => setSearching(true),
    },
    {
      label: "Quién cambió qué",
      icon: <History aria-hidden />,
      onSelect: () => setShowHistory(true),
    },
    ...(edit && pending
      ? [
          {
            label: "Volver a lo guardado",
            icon: <RotateCcw aria-hidden />,
            onSelect: () => fichaStore.discard(),
          },
        ]
      : []),
    {
      label: "Atajos de teclado",
      icon: <Keyboard aria-hidden />,
      onSelect: () => setShortcuts(true),
    },
    ...(edit
      ? [
          {
            label: "Borrar el producto",
            icon: <Trash2 aria-hidden />,
            onSelect: () => setDeleting(true),
          },
        ]
      : []),
  ]

  const undoRedo = edit ? (
    <span className="flex items-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Deshacer"
              disabled={!history.undo.length}
              onClick={undo}
            />
          }
        >
          <Undo2 aria-hidden />
        </TooltipTrigger>
        <TooltipContent>Deshacer · Ctrl+Z</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Rehacer"
              disabled={!history.redo.length}
              onClick={redo}
            />
          }
        >
          <Redo2 aria-hidden />
        </TooltipTrigger>
        <TooltipContent>Rehacer · Ctrl+Mayús+Z</TooltipContent>
      </Tooltip>
    </span>
  ) : null

  const main = (
    <>
      {isMobile ? null : <PhotosCard />}
      <TextCard />
      <VariantsCard />
      <PriceCard />
      <DataCard templates={templates} />
    </>
  )
  const side = (
    <>
      <StatusCard stock={stock} />
      <WebCard coverId={sheet.photos[0]?.id ?? null} />
      <OrganizationCard />
      <InventoryCard onKardex={() => setKardex(true)} />
      <PackageCard />
      <CrossSellCard />
      <ActivityCard onAll={() => setShowHistory(true)} />
    </>
  )

  return (
    <FichaContext.Provider value={ficha}>
      <div className={cn("flex min-w-0 flex-col gap-4", isMobile && edit && "pb-20")}>
        {back}
        <div className="flex min-w-0 items-center gap-3">
          {!isMobile && sheet.photos[0] ? (
            <Photo
              storeId={store.id}
              photoId={sheet.photos[0].id}
              alt=""
              className="size-10 border"
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <StoreHeader
              title={draft.name || sheet.name}
              secondary={{
                label: "Vista previa",
                icon: <Eye aria-hidden />,
                onClick: () => setPreviewing(true),
              }}
              menu={menu}
            />
          </div>
        </div>

        {isMobile ? (
          <>
            <PhotoCarousel />
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xl font-semibold tabular-nums">{priceSpan}</span>
                <button
                  type="button"
                  className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
                  aria-label={`Estado: ${state0}. Cambiarlo`}
                  onClick={() => goTo("estado")}
                >
                  <StateBadge state={state0} className="h-6 px-2.5 text-[13px]" />
                </button>
              </div>
              <span className="text-sm text-muted-foreground">
                {[draft.category, `${stock} ${unit}`, out ? `${out} sin stock` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
            <SofiLine
              readiness={sheet.readiness}
              onTry={edit ? () => setTrying(true) : undefined}
            />
          </>
        ) : (
          <>
            <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              <StateBadge state={state0} className="h-6 px-2.5 text-[13px]" />
              {draft.category ? (
                <>
                  <span>{draft.category}</span>
                  <span aria-hidden>·</span>
                </>
              ) : null}
              <span className="tabular-nums">{priceSpan}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {stock} {unit}
                {out ? ` · ${out} sin stock` : ""}
              </span>
              <span className="ml-auto flex min-w-0 items-center gap-1">
                {edit ? <SaveState status={status} pending={pending} /> : null}
                {undoRedo}
              </span>
            </div>
            <SofiLine
              readiness={sheet.readiness}
              onTry={edit ? () => setTrying(true) : undefined}
            />
          </>
        )}

        {!edit ? (
          <PageNotice tone="aviso" label="Solo lectura">
            Lo ves como {store.role === "support" ? "soporte" : "Ventas"}: el precio, el stock y los
            datos los cambian el Dueño o un Administrador.
          </PageNotice>
        ) : null}
        {status.kind === "rejected" && edit ? (
          <PageNotice tone="aviso" label="No se guardó todo">
            {status.message} Lo demás sí se guardó. Corrígelo o deshazlo.
          </PageNotice>
        ) : null}

        {isMobile ? (
          <div className="flex flex-col gap-3">
            <PhotosCard />
            {main}
            {side}
          </div>
        ) : (
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex min-w-0 flex-col gap-5">{main}</div>
            <div className="flex min-w-0 flex-col gap-4">{side}</div>
          </div>
        )}
      </div>

      {isMobile && edit && (pending > 0 || status.kind !== "saved" || history.undo.length > 0) ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-2 border-t bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.18)] backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Deshacer"
            disabled={!history.undo.length}
            onClick={undo}
          >
            <Undo2 aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rehacer"
            disabled={!history.redo.length}
            onClick={redo}
          >
            <Redo2 aria-hidden />
          </Button>
          <span className="min-w-0 flex-1">
            <SaveState status={status} pending={pending} />
          </span>
        </div>
      ) : null}

      {searching ? (
        <SearchDialog templates={templates} onClose={() => setSearching(false)} />
      ) : null}
      {kardex ? <KardexDrawer onClose={() => setKardex(false)} /> : null}
      {showHistory ? (
        <HistoryDrawer pending={pending} onClose={() => setShowHistory(false)} />
      ) : null}
      {shortcuts ? <ShortcutsDialog onClose={() => setShortcuts(false)} /> : null}
      {deleting ? <DeleteProduct onClose={() => setDeleting(false)} /> : null}
      {trying ? <ProbarPanel onClose={() => setTrying(false)} /> : null}
      {previewing ? <PreviewDrawer onClose={() => setPreviewing(false)} /> : null}
      <UnsavedDialog
        open={blocked}
        lost={
          status.kind === "reason"
            ? "Bajaste el stock y falta el motivo: sin él, ese cambio no se guarda."
            : status.kind === "offline"
              ? "No hay conexión y hay cambios que todavía no se guardaron."
              : "Hay cambios que no se guardaron."
        }
        onStay={() => {
          if (blocked) blocker.reset()
        }}
        onDiscard={() => {
          if (blocked) {
            fichaStore.discard()
            blocker.proceed()
          }
        }}
      />
    </FichaContext.Provider>
  )
}

function DeleteProduct({ onClose }: { onClose: () => void }) {
  const { store } = useStoreContext()
  const { productId } = useParams({ strict: false }) as { productId: string }
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const name = (
    queryClient.getQueryData(PRODUCT_KEY(store.id, productId)) as { product: Sheet } | undefined
  )?.product.name
  const remove = useMutation({
    mutationFn: () => api(`/api/tiendas/${store.id}/productos/${productId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id) })
      toast.success(`${name ?? "El producto"} borrado`)
      await navigate({ to: "/tiendas/$id/catalogo", params: { id: store.id } })
    },
  })
  return (
    <ConfirmDialog
      open
      title={`¿Borrar «${name ?? "este producto"}»?`}
      description="Solo se borra un producto que nunca movió stock. Si ya tiene kardex, ponlo en «Ya no se vende»."
      confirmLabel="Borrar"
      pending={remove.isPending}
      error={remove.error?.message ?? null}
      onConfirm={() => remove.mutate()}
      onClose={() => {
        remove.reset()
        onClose()
      }}
    />
  )
}
