import {
  Badge,
  Button,
  cn,
  Drawer,
  DrawerContent,
  DrawerTitle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  useIsMobile,
} from "@odentia/ui"
import { PageHeader, PageNotice, PageShell, useIconSidebarWhileMounted } from "@odentia/ui-patterns"
import {
  ArrowLeft,
  Check,
  Copy,
  Eye,
  History,
  Keyboard,
  Redo2,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Undo2,
} from "lucide-react"
import { useEffect, useState, useSyncExternalStore } from "react"
import { ESTADOS, foto, RUBROS } from "../datos"
import { priceSpan, soldOut, totalStock } from "../precio"
import { href, ir } from "../ruta"
import { resumen, saber } from "../sofi"
import {
  descartar,
  deshacer,
  diff,
  guardar,
  rehacer,
  stockCambiado,
  useDb,
  useProducto,
  useTienda,
} from "../tienda"
import {
  HistoryDrawer,
  KardexDrawer,
  SearchDialog,
  ShortcutsDialog,
  StockReasonDialog,
} from "./cajones"
import { DataCard } from "./datos-card"
import { PhotoCarousel, PhotosCard, usePastePhotos } from "./fotos"
import {
  ActivityCard,
  CrossSellCard,
  InventoryCard,
  OrganizationCard,
  PackageCard,
  StatusCard,
  WebCard,
} from "./lateral"
import { irA, SofiDot } from "./piezas"
import { PriceCard } from "./precio-card"
import { ProbarPanel } from "./probar"
import { VistaPrevia } from "./vista-previa"
import { nueva } from "../vitrina/compra"
import { TextCard } from "./texto-card"
import { VariantsCard } from "./variantes"

function useMedia(q: string) {
  return useSyncExternalStore(
    (f) => {
      const m = window.matchMedia(q)
      m.addEventListener("change", f)
      return () => m.removeEventListener("change", f)
    },
    () => window.matchMedia(q).matches,
  )
}

/** Mientras Sofi está al lado, el menú queda en íconos: la ficha necesita el ancho. */
function IconSidebar() {
  useIconSidebarWhileMounted()
  return null
}

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el?.closest?.(
    "input,textarea,select,[contenteditable=true],[role=grid],[role=dialog],[role=listbox],[role=menu]",
  )
}

export function ProductPage({ pid }: { pid: string }) {
  const p = useProducto(pid)
  const d = useDb()
  const rol = useTienda((s) => s.rol)
  const canUndo = useTienda((s) => s.undo.some((x) => x.pid === pid))
  const canRedo = useTienda((s) => s.redo.some((x) => x.pid === pid))
  const borradorAt = useTienda((s) => s.borradorAt)
  const R = RUBROS[useTienda((s) => s.rubro)]
  const isMobile = useIsMobile()
  const wide = useMedia("(min-width: 1280px)")
  const [sofi, setSofi] = useState(() => window.matchMedia("(min-width: 1360px)").matches)
  // La prueba como clienta: un carrito y una conversación que siguen mientras se edita la ficha.
  const [compra, setCompra] = useState(() => nueva(d.products.find((x) => x.id === pid) ?? d.products[0]!))
  const [preview, setPreview] = useState(false)
  const [buscar, setBuscar] = useState(false)
  const [kardex, setKardex] = useState(false)
  const [hist, setHist] = useState(false)
  const [atajos, setAtajos] = useState(false)
  const [motivo, setMotivo] = useState(false)
  const edit = rol === "dueno"
  const saved = p ? d.saved[p.id] : undefined
  const cambios = p ? diff(saved, p) : []
  const dirty = cambios.length > 0
  const nStock = p ? stockCambiado(saved, p) : 0
  usePastePhotos(p ?? (d.products[0] as never), edit && !!p)

  const save = () => {
    if (!p || !dirty || !edit) return
    if (nStock) setMotivo(true)
    else guardar(p.id)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === "z" && !typing(e.target)) {
        e.preventDefault()
        if (e.shiftKey) rehacer()
        else deshacer()
        return
      }
      if (mod && e.key.toLowerCase() === "y" && !typing(e.target)) {
        e.preventDefault()
        rehacer()
        return
      }
      if (mod || e.altKey || typing(e.target)) return
      if (e.key === "g" || e.key === "G") {
        e.preventDefault()
        save()
      } else if (e.key === "/") {
        e.preventDefault()
        setBuscar(true)
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault()
        setSofi((v) => !v)
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault()
        setPreview(true)
      } else if (e.key === "?") {
        e.preventDefault()
        setAtajos(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  if (!p)
    return (
      <PageShell className="flex flex-col gap-4">
        <a
          href={href("/catalogo")}
          className="inline-flex items-center gap-1 self-start text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Catálogo
        </a>
        <PageHeader title="Producto no encontrado" />
      </PageShell>
    )

  const L = saber(p, R, d.tpl)
  const s = resumen(L)
  const est = ESTADOS.find((x) => x.id === p.estado)!
  const cover = p.media.find((m) => m.kind === "foto")
  const docked = sofi && wide && !isMobile
  const cats = [
    ...new Set([...d.products.map((x) => x.cat), ...Object.values(R.kinds).map((k) => k.cat)]),
  ]
  const total = totalStock(p)
  const sin = soldOut(p)
  const historial = d.historial[p.id] ?? []

  const sofiLine = (
    <button
      type="button"
      onClick={() => setSofi(true)}
      className="group inline-flex min-h-9 max-w-full items-center gap-2.5 self-start rounded-full border bg-card py-1 pr-3.5 pl-1.5 text-left text-sm shadow-xs outline-none transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/40"
      aria-label="Probar como clienta: lo que sabe Sofi"
    >
      <SofiDot done={s.done} total={s.total} vendeSola={s.vendeSola} size={22} />
      <span className="min-w-0 truncate">
        {s.completo ? (
          <span className="font-medium">Sofi responde todo sobre este producto</span>
        ) : s.vendeSola ? (
          <>
            <span className="font-medium">Sofi lo vende sola</span>
            <span className="text-muted-foreground">
              {" "}
              · {s.plusMiss.length}{" "}
              {isMobile
                ? "para responder todo"
                : s.plusMiss.length === 1
                  ? "cosa para que responda todo"
                  : "cosas para que responda todo"}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium text-warning">
              Sofi necesita {s.needMiss.length} {s.needMiss.length === 1 ? "dato" : "datos"}
            </span>
            <span className="text-muted-foreground"> para venderlo sola</span>
          </>
        )}
      </span>
      <span className="shrink-0 font-semibold text-primary group-hover:underline">{isMobile ? "Probar" : "Probar como clienta"}</span>
    </button>
  )

  const saveState = (
    <span
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground"
      aria-live="polite"
    >
      {dirty ? (
        <>
          <span className="size-2 rounded-full bg-primary" aria-hidden />
          {cambios.length} {cambios.length === 1 ? "cambio sin guardar" : "cambios sin guardar"}
          {borradorAt ? <span className="max-sm:hidden"> · borrador a salvo</span> : null}
        </>
      ) : (
        <>
          <Check className="size-4 text-success" aria-hidden />
          Guardado
        </>
      )}
    </span>
  )

  const statusBadge = (
    <Badge
      variant={p.estado === "disponible" ? "success" : p.estado === "no" ? "outline" : "warning"}
      className="h-6 px-2.5 text-[13px]"
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          p.estado === "disponible"
            ? "bg-success"
            : p.estado === "no"
              ? "bg-muted-foreground"
              : "bg-warning",
        )}
        aria-hidden
      />
      {est.label}
    </Badge>
  )

  const menu = [
    { label: "Buscar en la ficha", icon: <Search aria-hidden />, onSelect: () => setBuscar(true) },
    { label: "Quién cambió qué", icon: <History aria-hidden />, onSelect: () => setHist(true) },
    ...(edit
      ? [
          { label: "Duplicar", icon: <Copy aria-hidden /> },
          ...(dirty
            ? [
                {
                  label: "Volver a lo guardado",
                  icon: <RotateCcw aria-hidden />,
                  onSelect: () => descartar(p.id),
                },
              ]
            : []),
        ]
      : []),
    { label: "Atajos de teclado", icon: <Keyboard aria-hidden />, onSelect: () => setAtajos(true) },
    ...(edit ? [{ label: "Archivar", icon: <Trash2 aria-hidden /> }] : []),
  ]

  const main = (
    <>
      {isMobile ? null : <PhotosCard p={p} edit={edit} />}
      <TextCard p={p} edit={edit} R={R} />
      <VariantsCard p={p} saved={saved} edit={edit} R={R} />
      <PriceCard p={p} edit={edit} costos={edit} R={R} />
      <DataCard p={p} edit={edit} R={R} tpl={d.tpl} />
    </>
  )
  const side = (
    <>
      <StatusCard p={p} edit={edit} />
      <WebCard p={p} edit={edit} R={R} />
      <OrganizationCard p={p} edit={edit} cats={cats} />
      <InventoryCard p={p} R={R} onKardex={() => setKardex(true)} />
      <PackageCard p={p} edit={edit} />
      <CrossSellCard p={p} edit={edit} all={d.products} />
      <ActivityCard items={historial} onAll={() => setHist(true)} />
    </>
  )

  return (
    <div className="flex min-w-0 items-start">
      {docked ? <IconSidebar /> : null}
      <PageShell className={cn("flex min-w-0 flex-col gap-4", isMobile && dirty && "pb-28")}>
        <a
          href={href("/catalogo")}
          className="inline-flex items-center gap-1 self-start rounded-md text-sm font-medium text-primary hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Catálogo
        </a>
        <div className="flex min-w-0 items-center gap-3">
          {!isMobile && cover ? (
            <img
              src={foto(cover.src)}
              alt=""
              className="size-10 shrink-0 rounded-lg border object-cover"
            />
          ) : null}
          <div className="flex min-w-0 flex-1 flex-col">
            <PageHeader
              title={p.name}
              secondary={{
                label: "Vista previa",
                icon: <Eye aria-hidden />,
                onClick: () => setPreview(true),
              }}
              primary={
                edit && dirty && !isMobile
                  ? {
                      label: "Guardar",
                      icon: <Save aria-hidden />,
                      render: <button type="button" className="entra" onClick={save} />,
                    }
                  : undefined
              }
              menu={menu}
            />
          </div>
        </div>

        {isMobile ? (
          <>
            <PhotoCarousel p={p} />
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xl font-semibold tabular-nums">{priceSpan(p)}</span>
                <button type="button" className="rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/40" aria-label={`Estado: ${est.label}. Cambiarlo`} onClick={() => irA("estado")}>
                  {statusBadge}
                </button>
              </div>
              <span className="text-sm text-muted-foreground">
                {p.cat} · {total} {R.unit}
                {sin ? ` · ${sin} sin stock` : ""}
              </span>
            </div>
            {sofiLine}
          </>
        ) : (
          <>
            <div className="-mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
              {statusBadge}
              <span>{p.cat}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{priceSpan(p)}</span>
              <span aria-hidden>·</span>
              <span className="tabular-nums">
                {total} {R.unit}
                {sin ? ` · ${sin} sin stock` : ""}
              </span>
              <span className="ml-auto flex items-center gap-1">
                {saveState}
                {edit ? (
                  <>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Deshacer"
                            disabled={!canUndo}
                            onClick={deshacer}
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
                            disabled={!canRedo}
                            onClick={rehacer}
                          />
                        }
                      >
                        <Redo2 aria-hidden />
                      </TooltipTrigger>
                      <TooltipContent>Rehacer · Ctrl+Mayús+Z</TooltipContent>
                    </Tooltip>
                  </>
                ) : null}
              </span>
            </div>
            {sofiLine}
          </>
        )}

        {!edit ? (
          <PageNotice tone="aviso" label="Solo lectura">
            Lo ves como Ventas: el precio, el stock y los datos los cambian el Dueño o un
            Administrador.
          </PageNotice>
        ) : null}

        {isMobile ? (
          <div className="flex flex-col gap-3">
            <PhotosCard p={p} edit={edit} />
            {main}
            {side}
          </div>
        ) : (
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="flex min-w-0 flex-col gap-5">{main}</div>
            <div className="flex min-w-0 flex-col gap-4">{side}</div>
          </div>
        )}
      </PageShell>

      {docked ? (
        <aside
          aria-label="Probar como clienta"
          className="sticky top-(--notice-strip-h,0px) h-[calc(100svh-var(--notice-strip-h,0px))] w-[25.5rem] shrink-0 animate-in border-l duration-300 fade-in slide-in-from-right-4"
        >
          <ProbarPanel
            p={p}
            R={R}
            tpl={d.tpl}
            all={d.products}
            c={compra}
            set={setCompra}
            dirty={dirty}
            edit={edit}
            onClose={() => setSofi(false)}
          />
        </aside>
      ) : (
        <Drawer
          open={sofi && !docked}
          onOpenChange={setSofi}
          swipeDirection={isMobile ? "down" : "right"}
          showSwipeHandle={isMobile}
        >
          <DrawerContent
            className={cn(
              isMobile
                ? "[--drawer-content-height:calc(100dvh-1.5rem)] [--drawer-inset:0.375rem]"
                : "data-[swipe-axis=x]:sm:[--drawer-content-width:27rem]",
            )}
          >
            <DrawerTitle className="sr-only">Probar como clienta</DrawerTitle>
            <ProbarPanel
              p={p}
              R={R}
              tpl={d.tpl}
              all={d.products}
              c={compra}
              set={setCompra}
              dirty={dirty}
              edit={edit}
              onClose={() => setSofi(false)}
              onGo={() => setSofi(false)}
              className="rounded-[inherit]"
            />
          </DrawerContent>
        </Drawer>
      )}

      {isMobile && edit && dirty ? (
        <div className="fixed inset-x-0 bottom-0 z-30 flex animate-in items-center gap-2 border-t bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgb(0_0_0/0.18)] backdrop-blur duration-300 slide-in-from-bottom-4">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Deshacer"
            disabled={!canUndo}
            onClick={deshacer}
          >
            <Undo2 aria-hidden />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm">
            {cambios.length} {cambios.length === 1 ? "cambio sin guardar" : "cambios sin guardar"}
          </span>
          <Button size="lg" onClick={save}>
            <Save aria-hidden />
            Guardar
          </Button>
        </div>
      ) : null}

      <VistaPrevia p={p} R={R} tpl={d.tpl} all={d.products} open={preview} onClose={() => setPreview(false)} />
      <KardexDrawer p={p} saved={saved} R={R} open={kardex} onClose={() => setKardex(false)} />
      <HistoryDrawer
        items={historial}
        pendientes={cambios}
        open={hist}
        onClose={() => setHist(false)}
      />
      <SearchDialog p={p} R={R} tpl={d.tpl} open={buscar} onClose={() => setBuscar(false)} />
      <ShortcutsDialog open={atajos} onClose={() => setAtajos(false)} />
      <StockReasonDialog
        open={motivo}
        n={nStock}
        onClose={() => setMotivo(false)}
        onSave={(m) => {
          setMotivo(false)
          guardar(p.id, m)
        }}
      />
    </div>
  )
}

export { ir }
