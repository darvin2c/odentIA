import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
} from "@odentia/ui"
import { ErrorState } from "@odentia/ui-patterns"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  Camera,
  Check,
  ImagePlus,
  MoreHorizontal,
  Play,
  Sparkles,
  Star,
  Trash2,
  Video,
} from "lucide-react"
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { CATALOG_KEY } from "../catalogo"
import { ApiError, api } from "../lib/api"
import type { GridRow, Sheet } from "../lib/ficha"
import {
  duration,
  isImageFile,
  isVideoFile,
  MAX_PHOTOS,
  MEDIA_KEY,
  MEDIA_OFF,
  type MediaPhoto,
  type MediaVideo,
  moveItem,
  preparePhoto,
  prepareVideo,
  useProductMedia,
  VideoProblem,
} from "../lib/medios"
import { Photo } from "../piezas"
import { useFichaContext } from "./contexto"
import { PRODUCT_KEY } from "./datos"
import { Section, Swatch } from "./piezas"

/**
 * «Fotos y videos» de la ficha (prototipo `ficha/fotos.tsx`; ADR 0236). La primera foto es la
 * portada. Se agregan soltando, pegando (Ctrl+V) o eligiendo, y en el celular con la cámara o la
 * galería; se ordenan arrastrando o con «Mover» (también Alt y las flechas). Cada foto puede ser de
 * un color, y una por color es la que manda Sofi (★). El video corto va al final, con su duración.
 * La foto sin fondo es una propuesta: se ve solo si hay una, con «Usar esta» o «Dejar la original».
 */

/** El color de la foto que manda Sofi (★): el que la tiene como su foto en la cuadrícula. */
function sofiRowOf(rows: GridRow[], photoId: string): GridRow | undefined {
  return rows.find((r) => r.photoId === photoId)
}

/** El color al que pertenece una foto (o un video): el que le puso la tienda. */
function colorOf(sheet: Sheet, colorId: string | null) {
  return colorId ? sheet.colors.find((c) => c.id === colorId) : undefined
}

/** Lo que pasa al subir: cuántas van y, en un video, cuánto falta para tenerlo listo. */
type Upload = { done: number; total: number; video?: number } | null

function useMediaActions() {
  const { sheet, store } = useFichaContext()
  const queryClient = useQueryClient()
  const [off, setOff] = useState(false)
  const [progress, setProgress] = useState<Upload>(null)
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: PRODUCT_KEY(store.id, sheet.id) }),
      queryClient.invalidateQueries({ queryKey: MEDIA_KEY(store.id, sheet.id) }),
    ])
    await queryClient.invalidateQueries({ queryKey: CATALOG_KEY(store.id), refetchType: "none" })
  }
  const fail = (error: unknown) => {
    if (error instanceof ApiError && error.code === MEDIA_OFF) setOff(true)
    else toast.error(error instanceof Error ? error.message : "No se pudo subir")
  }
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const photos = files.filter((f) => isImageFile(f) && !isVideoFile(f))
      const videos = files.filter(isVideoFile)
      const room = Math.max(0, MAX_PHOTOS - sheet.photos.length)
      const take = photos.slice(0, room)
      if (photos.length > room)
        toast.info(`Hasta ${MAX_PHOTOS} fotos por producto: se agregan ${take.length}.`)
      let done = 0
      const total = take.length + Math.min(1, videos.length)
      setProgress({ done, total })
      for (const file of take) {
        const blob = await preparePhoto(file)
        await api(`/api/tiendas/${store.id}/productos/${sheet.id}/fotos`, {
          method: "POST",
          raw: { type: blob.type || "image/jpeg", data: blob },
        })
        done++
        setProgress({ done, total })
      }
      if (videos.length > 1) toast.info("Un video por vez: se sube el primero.")
      const [video] = videos
      if (video) {
        const ready = await prepareVideo(video, (part) => setProgress({ done, total, video: part }))
        const form = new FormData()
        form.set("video", ready.video, "video.mp4")
        form.set("poster", ready.poster, "poster.jpg")
        await api(`/api/tiendas/${store.id}/productos/${sheet.id}/videos`, {
          method: "POST",
          form,
        })
        done++
      }
      return { photos: take.length, video: Boolean(video) }
    },
    onSuccess: async (result) => {
      setProgress(null)
      setOff(false)
      await refresh()
      const parts = [
        result.photos ? (result.photos === 1 ? "1 foto" : `${result.photos} fotos`) : "",
        result.video ? "el video" : "",
      ].filter(Boolean)
      if (parts.length) toast.success(`Agregaste ${parts.join(" y ")}`)
    },
    onError: async (error) => {
      setProgress(null)
      await refresh()
      if (error instanceof VideoProblem) toast.error(error.message)
      else fail(error)
    },
  })
  const patch = useMutation({
    mutationFn: (input: { path: string; body: unknown; done: string }) =>
      api(input.path, { method: "PATCH", body: input.body }),
    onSuccess: async (_, input) => {
      await refresh()
      toast.success(input.done)
    },
    onError: async (error) => {
      await refresh()
      fail(error)
    },
  })
  const remove = useMutation({
    mutationFn: (input: { path: string; done: string }) => api(input.path, { method: "DELETE" }),
    onSuccess: async (_, input) => {
      await refresh()
      toast.success(input.done)
    },
    onError: (error) => fail(error),
  })
  return { upload, patch, remove, off, progress }
}

/** Pegar una foto con Ctrl+V en la ficha (fuera de un campo de texto). */
function usePaste(enabled: boolean, onFiles: (files: File[]) => void) {
  const handler = useRef(onFiles)
  handler.current = onFiles
  useEffect(() => {
    if (!enabled) return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target?.closest("input,textarea,[contenteditable=true],[role=grid]")) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      handler.current(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [enabled])
}

export function PhotosCard() {
  const { sheet, draft, store, edit, change } = useFichaContext()
  const media = useProductMedia(store.id, sheet.id)
  const { upload, patch, remove, off, progress } = useMediaActions()
  const rows = draft.grid?.rowName ? draft.grid.rows : []
  const input = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [order, setOrder] = useState(() => sheet.photos.map((p) => p.id))
  const [dragId, setDragId] = useState<string | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const nodes = useRef(new Map<string, HTMLElement>())
  const rects = useRef(new Map<string, { x: number; y: number }>())
  const drag = useRef<{
    id: string
    startX: number
    startY: number
    px: number
    py: number
    grabX: number
    grabY: number
    started: boolean
  } | null>(null)

  const add = (files: File[]) => {
    if (!edit || upload.isPending) return
    const usable = files.filter((f) => isImageFile(f) || isVideoFile(f))
    if (!usable.length) {
      toast.error("Eso no es una foto ni un video.")
      return
    }
    upload.mutate(usable)
  }
  usePaste(edit, add)

  // Lo guardado manda, salvo mientras se arrastra.
  const ids = sheet.photos.map((p) => p.id).join()
  useEffect(() => {
    if (!drag.current?.started) setOrder(ids.split(",").filter(Boolean))
  }, [ids])

  // Cada foto parte de donde estaba y se desliza a su lugar nuevo (FLIP).
  // biome-ignore lint/correctness/useExhaustiveDependencies: se mide al cambiar el orden
  useLayoutEffect(() => {
    const box = grid.current?.getBoundingClientRect()
    if (!box) return
    for (const [id, el] of nodes.current) {
      const r = el.getBoundingClientRect()
      const now = { x: r.left - box.left, y: r.top - box.top }
      const prev = rects.current.get(id)
      rects.current.set(id, now)
      if (id === drag.current?.id) {
        follow(id)
        continue
      }
      if (!prev || window.matchMedia("(prefers-reduced-motion: reduce)").matches) continue
      const dx = prev.x - now.x
      const dy = prev.y - now.y
      if (!dx && !dy) continue
      el.style.transition = "none"
      el.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        el.style.transition = "transform 300ms cubic-bezier(.2,.9,.3,1.12)"
        el.style.transform = ""
      })
    }
  }, [order.join(), sheet.photos.length])

  const byId = new Map((media.data?.photos ?? []).map((m) => [m.id, m]))
  const videos = media.data?.videos ?? []
  const photoCount = sheet.photos.length

  /** Guarda el lugar nuevo de una foto: el servidor corre las demás. */
  function commit(id: string, to: number) {
    const from = order.indexOf(id)
    if (from < 0 || from === to) return
    setOrder(moveItem(order, from, to))
    patch.mutate({
      path: `/api/tiendas/${store.id}/fotos/${id}`,
      body: { position: to },
      done: to === 0 ? "Cambiaste la portada" : "Moviste la foto",
    })
  }

  function follow(id: string) {
    const d = drag.current
    const el = nodes.current.get(id)
    const box = grid.current?.getBoundingClientRect()
    if (!d || !el || !box) return
    const tx = d.px - d.grabX - (box.left + el.offsetLeft)
    const ty = d.py - d.grabY - (box.top + el.offsetTop)
    el.style.transition = "none"
    el.style.transform = `translate(${tx}px, ${ty}px) scale(1.04)`
  }
  function onPointerDown(e: ReactPointerEvent, id: string) {
    if (!edit || e.pointerType === "touch" || e.button !== 0) return
    if ((e.target as HTMLElement).closest("button,[role=menuitem]")) return
    const el = nodes.current.get(id)
    const box = grid.current?.getBoundingClientRect()
    if (!el || !box) return
    drag.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      px: e.clientX,
      py: e.clientY,
      grabX: e.clientX - (box.left + el.offsetLeft),
      grabY: e.clientY - (box.top + el.offsetTop),
      started: false,
    }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  function onPointerMove(e: ReactPointerEvent) {
    const d = drag.current
    if (!d) return
    d.px = e.clientX
    d.py = e.clientY
    if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return
    if (!d.started) {
      d.started = true
      setDragId(d.id)
    }
    let target = -1
    order.forEach((oid, i) => {
      if (oid === d.id) return
      const r = nodes.current.get(oid)?.getBoundingClientRect()
      if (
        r &&
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      )
        target = i
    })
    const from = order.indexOf(d.id)
    if (target >= 0 && target !== from) setOrder(moveItem(order, from, target))
    follow(d.id)
  }
  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (!d?.started) return
    const el = nodes.current.get(d.id)
    if (el) {
      el.style.transition = "transform 280ms cubic-bezier(.2,.9,.3,1.12)"
      el.style.transform = ""
    }
    setDragId(null)
    const to = order.indexOf(d.id)
    const from = ids.split(",").indexOf(d.id)
    if (to !== from)
      patch.mutate({
        path: `/api/tiendas/${store.id}/fotos/${d.id}`,
        body: { position: to },
        done: to === 0 ? "Cambiaste la portada" : "Moviste la foto",
      })
  }

  const busy = upload.isPending
  const full = photoCount >= MAX_PHOTOS
  const summary = `${photoCount} ${photoCount === 1 ? "foto" : "fotos"}${videos.length ? ` · ${videos.length} video` : ""}`
  const pick = (
    <input
      ref={input}
      type="file"
      accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/*"
      multiple
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        add([...(e.target.files ?? [])])
        e.target.value = ""
      }}
    />
  )
  const shoot = (
    <input
      ref={camera}
      type="file"
      accept="image/*"
      capture="environment"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        add([...(e.target.files ?? [])])
        e.target.value = ""
      }}
    />
  )

  return (
    <Section id="fotos" title="Fotos y videos" summary={summary}>
      {off ? (
        <ErrorState
          title="Ahora no se pueden subir fotos ni videos"
          message="Lo demás de la ficha sigue funcionando. Avísale a soporte de gestorIA desde la Ayuda."
          className="mb-3"
        />
      ) : null}
      {edit ? (
        // En el celular, la cámara y la galería primero.
        <div className="mb-3 grid grid-cols-2 gap-2 md:hidden">
          <Button variant="outline" disabled={busy || full} onClick={() => camera.current?.click()}>
            <Camera aria-hidden />
            Tomar foto
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
            <ImagePlus aria-hidden />
            Galería
          </Button>
        </div>
      ) : null}
      {progress ? (
        <div className="mb-3 flex flex-col gap-1.5" role="status">
          <span className="text-sm text-muted-foreground">
            {progress.video !== undefined
              ? `Preparando el video para WhatsApp… ${Math.round(progress.video * 100)} %`
              : `Subiendo ${Math.min(progress.done + 1, progress.total)} de ${progress.total}…`}
          </span>
          <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
            <span
              className="block h-full rounded-full bg-primary transition-[width] duration-300"
              style={{
                width: `${
                  progress.video !== undefined
                    ? progress.video * 100
                    : (progress.done / Math.max(1, progress.total)) * 100
                }%`,
              }}
            />
          </span>
        </div>
      ) : null}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: soltar archivos; «Agregar», «Tomar foto» y «Galería» son la alternativa */}
      <div
        className="relative"
        onDragOver={(e) => {
          if (!edit || !e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
        }}
        onDrop={(e) => {
          if (!edit) return
          e.preventDefault()
          setOver(false)
          add([...e.dataTransfer.files])
        }}
      >
        {photoCount === 0 && videos.length === 0 ? (
          <button
            type="button"
            disabled={!edit || busy}
            onClick={() => input.current?.click()}
            className="flex min-h-48 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-input-border text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50 disabled:hover:bg-transparent"
          >
            <ImagePlus className="size-6" aria-hidden />
            <span className="font-medium text-foreground">
              {edit ? "Suelta tus fotos o un video" : "Sin fotos todavía"}
            </span>
            {edit ? (
              <span>
                O pégalos con Ctrl+V · la primera es la portada · hasta {MAX_PHOTOS} fotos y un
                video corto
              </span>
            ) : null}
          </button>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: una cuadrícula que se reordena arrastrando
          <div
            ref={grid}
            role="list"
            aria-label="Fotos y videos, la primera es la portada"
            className="relative grid grid-cols-3 gap-3 sm:grid-cols-4"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {order.map((id, i) => {
              const saved = sheet.photos.find((p) => p.id === id)
              if (!saved) return null
              const m = byId.get(id)
              const color = colorOf(sheet, saved.colorId)
              const sofi = sofiRowOf(rows, id)
              const cover = i === 0
              const label = `Foto ${i + 1}${cover ? ", portada" : ""}${color ? `, color ${color.value}` : ""}${sofi ? `, la que manda Sofi de ${sofi.value}` : ""}`
              return (
                // biome-ignore lint/a11y/useSemanticElements: se arrastra con el puntero y se mueve con el teclado
                <div
                  key={id}
                  role="listitem"
                  ref={(el) => {
                    if (el) nodes.current.set(id, el)
                    else nodes.current.delete(id)
                  }}
                  tabIndex={edit ? 0 : -1}
                  aria-label={edit ? `${label}. Alt y las flechas para moverla.` : label}
                  onPointerDown={(e) => onPointerDown(e, id)}
                  onKeyDown={(e) => {
                    if (!edit || !e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return
                    e.preventDefault()
                    const to = Math.max(
                      0,
                      Math.min(order.length - 1, i + (e.key === "ArrowLeft" ? -1 : 1)),
                    )
                    commit(id, to)
                  }}
                  className={cn(
                    "group relative touch-pan-y overflow-hidden rounded-xl bg-muted outline-none ring-offset-2 ring-offset-card focus-visible:ring-3 focus-visible:ring-ring/50",
                    cover ? "col-span-2 row-span-2 aspect-square" : "aspect-square",
                    edit && "cursor-grab active:cursor-grabbing",
                    dragId === id && "z-10 shadow-xl ring-2 ring-primary",
                  )}
                >
                  <Tile storeId={store.id} photo={m} photoId={id} cover={cover} />
                  {cover ? (
                    <Badge
                      variant="secondary"
                      className="absolute top-2 left-2 bg-background/90 backdrop-blur"
                    >
                      <Star aria-hidden />
                      Portada
                    </Badge>
                  ) : null}
                  <span className="absolute right-2 bottom-2 left-2 flex items-center gap-1.5">
                    {color ? (
                      <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
                        <Swatch hex={color.hex} hex2={color.hex2} />
                        <span className="truncate">{color.value}</span>
                        {sofi ? (
                          <Star
                            className="size-3 fill-current text-primary"
                            aria-label="La que manda Sofi"
                          />
                        ) : null}
                      </span>
                    ) : sofi ? (
                      <span className="flex h-6 items-center gap-1 rounded-full bg-background/90 px-2 text-xs font-medium backdrop-blur">
                        <Star className="size-3 fill-current text-primary" aria-hidden />
                        {sofi.value}
                      </span>
                    ) : null}
                    {m?.cutout === "propuesta" && edit ? (
                      <CutoutProposal photo={m} storeId={store.id} patch={patch} />
                    ) : null}
                  </span>
                  {edit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="secondary"
                            aria-label={`Opciones de la foto ${i + 1}`}
                            className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-64">
                        {!cover ? (
                          <DropdownMenuItem onClick={() => commit(id, 0)}>
                            <Star aria-hidden />
                            Usar como portada
                          </DropdownMenuItem>
                        ) : null}
                        {sheet.colors.some((c) => c.id) ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>Es del color</DropdownMenuLabel>
                            {sheet.colors.map((c) =>
                              c.id ? (
                                <DropdownMenuItem
                                  key={c.id}
                                  onClick={() =>
                                    patch.mutate({
                                      path: `/api/tiendas/${store.id}/fotos/${id}`,
                                      body: { colorId: saved.colorId === c.id ? null : c.id },
                                      done:
                                        saved.colorId === c.id
                                          ? "La foto vale para todos los colores"
                                          : `La foto es de «${c.value}»`,
                                    })
                                  }
                                >
                                  <Swatch hex={c.hex} hex2={c.hex2} />
                                  {c.value}
                                  {saved.colorId === c.id ? (
                                    <Check className="ml-auto" aria-hidden />
                                  ) : null}
                                </DropdownMenuItem>
                              ) : null,
                            )}
                          </DropdownMenuGroup>
                        ) : null}
                        {rows.length ? (
                          <DropdownMenuGroup>
                            <DropdownMenuLabel>La que manda Sofi</DropdownMenuLabel>
                            {rows.map((row) => (
                              <DropdownMenuItem
                                key={row.id}
                                onClick={() =>
                                  change(`La foto que manda Sofi de «${row.value}»`, (d) => {
                                    for (const r of d.grid?.rows ?? []) {
                                      if (r.id === row.id) r.photoId = id
                                      else if (r.photoId === id) r.photoId = null
                                    }
                                  })
                                }
                              >
                                <Swatch hex={row.hex} hex2={row.hex2} />
                                Cuando pidan «{row.value}»
                                {row.photoId === id ? (
                                  <Star className="ml-auto fill-current" aria-hidden />
                                ) : null}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuGroup>
                        ) : null}
                        <DropdownMenuSeparator />
                        {i > 0 ? (
                          <DropdownMenuItem onClick={() => commit(id, i - 1)}>
                            Mover antes
                          </DropdownMenuItem>
                        ) : null}
                        {i < order.length - 1 ? (
                          <DropdownMenuItem onClick={() => commit(id, i + 1)}>
                            Mover después
                          </DropdownMenuItem>
                        ) : null}
                        {m?.cutout === "usada" ? (
                          <DropdownMenuItem
                            onClick={() =>
                              patch.mutate({
                                path: `/api/tiendas/${store.id}/fotos/${id}/sin-fondo`,
                                body: { usar: false },
                                done: "Volviste a la foto original",
                              })
                            }
                          >
                            Volver a la original
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={remove.isPending}
                          onClick={() =>
                            remove.mutate({
                              path: `/api/tiendas/${store.id}/fotos/${id}`,
                              done: "Quitaste la foto",
                            })
                          }
                        >
                          <Trash2 aria-hidden />
                          Quitar la foto
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              )
            })}
            {videos.map((v) => (
              <VideoTile key={v.id} video={v} sheet={sheet} patch={patch} remove={remove} />
            ))}
            {edit && !full ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => input.current?.click()}
                className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-input-border text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-primary-soft/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <ImagePlus className="size-5" aria-hidden />
                {busy ? "Subiendo…" : "Agregar"}
              </button>
            ) : null}
          </div>
        )}
        {over ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-semibold text-primary-soft-foreground backdrop-blur-[2px]">
            Suelta para agregar
          </div>
        ) : null}
        {pick}
        {shoot}
      </div>
    </Section>
  )
}

type Patch = ReturnType<typeof useMediaActions>["patch"]
type Remove = ReturnType<typeof useMediaActions>["remove"]

/** La foto de una casilla: el enlace firmado si ya está en el almacenamiento; si no, la de antes. */
function Tile({
  storeId,
  photo,
  photoId,
  cover,
}: {
  storeId: string
  photo: MediaPhoto | undefined
  photoId: string
  cover: boolean
}) {
  if (photo?.urls)
    return (
      <img
        src={cover ? photo.urls.vitrina : photo.urls.miniatura}
        alt=""
        draggable={false}
        className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
      />
    )
  return <Photo storeId={storeId} photoId={photoId} alt="" className="size-full rounded-none" />
}

/**
 * La propuesta sin fondo (decisión 9): solo si hay una. Se ven la original y la propuesta, y la
 * persona elige; la original se guarda siempre.
 */
function CutoutProposal({
  photo,
  storeId,
  patch,
}: {
  photo: MediaPhoto
  storeId: string
  patch: Patch
}) {
  const [open, setOpen] = useState(false)
  const choose = (usar: boolean) => {
    setOpen(false)
    patch.mutate({
      path: `/api/tiendas/${storeId}/fotos/${photo.id}/sin-fondo`,
      body: { usar },
      done: usar ? "Usas la foto sin fondo" : "Dejaste la original",
    })
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="ml-auto flex h-6 items-center gap-1 rounded-full border border-dashed border-agent/70 bg-agent-soft px-2 text-xs font-medium text-agent backdrop-blur"
          />
        }
      >
        <Sparkles className="size-3" aria-hidden />
        Sin fondo
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <p className="mb-2 text-sm font-medium">Propuesta de la IA: la foto sin fondo</p>
        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <figure className="flex flex-col gap-1">
            <img
              src={photo.urls?.miniatura}
              alt="La original"
              className="aspect-square rounded-lg object-cover"
            />
            <figcaption>La original</figcaption>
          </figure>
          <figure className="flex flex-col gap-1">
            <img
              src={photo.urls?.sinFondo?.miniatura}
              alt="La propuesta sin fondo"
              className="aspect-square rounded-lg bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] object-contain"
            />
            <figcaption>Propuesta</figcaption>
          </figure>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">La original se guarda siempre.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => choose(false)}>
            Dejar la original
          </Button>
          <Button size="sm" onClick={() => choose(true)}>
            Usar esta
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** El video corto: su póster, su duración y lo que muestra («Puesta, caminando»). */
function VideoTile({
  video,
  sheet,
  patch,
  remove,
}: {
  video: MediaVideo
  sheet: Sheet
  patch: Patch
  remove: Remove
}) {
  const { store, edit } = useFichaContext()
  const [playing, setPlaying] = useState(false)
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState(video.label)
  const color = colorOf(sheet, video.colorId)
  const path = `/api/tiendas/${store.id}/videos/${video.id}`
  return (
    // biome-ignore lint/a11y/useSemanticElements: el video va en la misma cuadrícula que las fotos
    <div
      role="listitem"
      aria-label={`Video de ${duration(video.durationMs)}${video.label ? `, ${video.label}` : ""}${color ? `, color ${color.value}` : ""}`}
      className="group relative aspect-square overflow-hidden rounded-xl bg-muted"
    >
      {playing ? (
        // biome-ignore lint/a11y/useMediaCaption: el video del producto no tiene diálogo
        <video
          src={video.urls.video}
          poster={video.urls.poster}
          controls
          autoPlay
          playsInline
          className="size-full bg-black object-contain"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label="Ver el video"
          className="relative block size-full"
        >
          <img src={video.urls.poster} alt="" className="size-full object-cover" />
          <span className="absolute inset-0 flex items-center justify-center bg-black/15">
            <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
              <Play className="size-4 fill-current" aria-hidden />
            </span>
          </span>
        </button>
      )}
      <span className="pointer-events-none absolute right-2 bottom-2 left-2 flex items-center gap-1.5">
        {color ? (
          <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
            <Swatch hex={color.hex} hex2={color.hex2} />
            <span className="truncate">{color.value}</span>
          </span>
        ) : null}
        <span className="ml-auto flex h-6 items-center gap-1 rounded-full bg-background/90 px-2 text-xs font-medium tabular-nums backdrop-blur">
          {duration(video.durationMs)}
          <Check className="size-3 text-success" aria-label="Listo para WhatsApp" />
        </span>
      </span>
      {video.label ? (
        <span className="pointer-events-none absolute top-2 left-2 max-w-[calc(100%-3rem)] truncate rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium backdrop-blur">
          {video.label}
        </span>
      ) : null}
      {edit ? (
        <Popover open={naming} onOpenChange={setNaming}>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="secondary"
                  aria-label="Opciones del video"
                  className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                />
              }
            >
              <MoreHorizontal aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={() => setNaming(true)}>
                <Video aria-hidden />
                Qué muestra
              </DropdownMenuItem>
              {sheet.colors.some((c) => c.id) ? (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Es del color</DropdownMenuLabel>
                  {sheet.colors.map((c) =>
                    c.id ? (
                      <DropdownMenuItem
                        key={c.id}
                        onClick={() =>
                          patch.mutate({
                            path,
                            body: { colorId: video.colorId === c.id ? null : c.id },
                            done:
                              video.colorId === c.id
                                ? "El video es del producto"
                                : `El video es de «${c.value}»`,
                          })
                        }
                      >
                        <Swatch hex={c.hex} hex2={c.hex2} />
                        {c.value}
                        {video.colorId === c.id ? <Check className="ml-auto" aria-hidden /> : null}
                      </DropdownMenuItem>
                    ) : null,
                  )}
                </DropdownMenuGroup>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => remove.mutate({ path, done: "Quitaste el video" })}
              >
                <Trash2 aria-hidden />
                Quitar el video
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <PopoverTrigger render={<span className="absolute top-2 right-2 size-0" />} />
          <PopoverContent align="end" className="w-72">
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                setNaming(false)
                patch.mutate({ path, body: { label }, done: "Guardaste qué muestra el video" })
              }}
            >
              <label htmlFor={`video-${video.id}`} className="text-sm font-medium">
                Qué muestra el video
              </label>
              <Input
                id={`video-${video.id}`}
                value={label}
                maxLength={60}
                placeholder="Puesta, caminando"
                onChange={(e) => setLabel(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Sofi lo dice al mandarlo: «Te mando cómo se ve puesta».
              </p>
              <Button type="submit" size="sm" className="self-end">
                Guardar
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}

/** En el celular, arriba de todo: las fotos y el video para pasar con el dedo. */
export function PhotoCarousel() {
  const { sheet, draft, store } = useFichaContext()
  const media = useProductMedia(store.id, sheet.id)
  const [index, setIndex] = useState(0)
  const byId = new Map((media.data?.photos ?? []).map((m) => [m.id, m]))
  const videos = media.data?.videos ?? []
  const count = sheet.photos.length + videos.length
  return (
    <div className="-mx-4 flex flex-col gap-2">
      <div
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 [scrollbar-width:none]"
        onScroll={(e) => {
          const el = e.currentTarget
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth - 24)))
        }}
      >
        {count === 0 ? (
          <div className="flex aspect-[6/5] w-full shrink-0 items-center justify-center rounded-2xl bg-muted text-sm text-muted-foreground">
            Sin fotos todavía
          </div>
        ) : (
          <>
            {sheet.photos.map((photo, j) => {
              const m = byId.get(photo.id)
              const color = colorOf(sheet, photo.colorId)
              return (
                <div
                  key={photo.id}
                  className="relative aspect-[6/5] w-[calc(100%-1.5rem)] shrink-0 snap-center overflow-hidden rounded-2xl bg-muted first:w-full"
                >
                  {m?.urls ? (
                    <img
                      src={m.urls.vitrina}
                      alt={j === 0 ? `${draft.name}, portada` : ""}
                      className="size-full object-cover"
                    />
                  ) : (
                    <Photo
                      storeId={store.id}
                      photoId={photo.id}
                      alt={j === 0 ? `${draft.name}, portada` : ""}
                      className="size-full rounded-none"
                    />
                  )}
                  {color ? (
                    <span className="absolute bottom-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
                      <Swatch hex={color.hex} hex2={color.hex2} />
                      {color.value}
                    </span>
                  ) : null}
                </div>
              )
            })}
            {videos.map((v) => (
              <div
                key={v.id}
                className="relative aspect-[6/5] w-[calc(100%-1.5rem)] shrink-0 snap-center overflow-hidden rounded-2xl bg-black"
              >
                {/* biome-ignore lint/a11y/useMediaCaption: el video del producto no tiene diálogo */}
                <video
                  src={v.urls.video}
                  poster={v.urls.poster}
                  controls
                  playsInline
                  preload="none"
                  className="size-full object-contain"
                />
                <span className="pointer-events-none absolute top-2.5 left-2.5 flex h-6 items-center rounded-full bg-background/90 px-2 text-xs font-medium tabular-nums">
                  {duration(v.durationMs)}
                  {v.label ? ` · ${v.label}` : ""}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      {count > 1 ? (
        <div className="flex justify-center gap-1.5" aria-hidden>
          {Array.from({ length: count }, (_, j) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: son puntos, uno por lugar
              key={j}
              className={cn(
                "h-1.5 rounded-full bg-foreground/20 transition-all duration-300",
                j === index ? "w-4 bg-foreground/70" : "w-1.5",
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
