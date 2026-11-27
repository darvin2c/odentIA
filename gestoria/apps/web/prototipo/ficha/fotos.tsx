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
  toast,
} from "@odentia/ui"
import { Check, ImagePlus, MoreHorizontal, Play, Sparkles, Star, Trash2 } from "lucide-react"
import {
  type PointerEvent as RPointerEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { nearestOf } from "../color"
import { foto, type Media, nid, type Producto } from "../datos"
import { cambiar } from "../tienda"
import { Seccion, Swatch } from "./piezas"

/** Mueve un elemento de una lista a otra posición. */
const move = <T,>(arr: T[], from: number, to: number) => {
  const a = [...arr]
  const [x] = a.splice(from, 1)
  a.splice(to, 0, x as T)
  return a
}

/** Agrega fotos de archivos (soltadas, pegadas o elegidas): la IA les asigna su color. */
export async function addFiles(p: Producto, files: File[]) {
  const imgs = files.filter((f) => f.type.startsWith("image/") || f.type.startsWith("video/"))
  if (!imgs.length) return
  const nuevas: Media[] = []
  for (const f of imgs) {
    const src = URL.createObjectURL(f)
    const isVideo = f.type.startsWith("video/")
    const color = isVideo ? undefined : await nearestOf(src, p.colors)
    nuevas.push({
      id: nid("m"),
      src,
      kind: isVideo ? "video" : "foto",
      color,
      aiColor: !!color,
      poster: isVideo ? p.media[0]?.src : undefined,
      dur: isVideo ? 8 : undefined,
    })
  }
  cambiar(
    p.id,
    nuevas.length === 1 ? "Agregaste una foto" : `Agregaste ${nuevas.length} fotos`,
    (x) => {
      x.media = [...x.media, ...nuevas]
    },
    { toast: true },
  )
}

/**
 * Fotos y videos: la portada grande y las demás al lado. Se ordenan arrastrando (con su
 * movimiento) o desde el menú de cada foto; se agregan soltando, pegando o eligiendo.
 */
export function PhotosCard({ p, edit }: { p: Producto; edit: boolean }) {
  const [order, setOrder] = useState(() => p.media.map((m) => m.id))
  const [dragId, setDragId] = useState<string | null>(null)
  const [over, setOver] = useState(false)
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
  const input = useRef<HTMLInputElement>(null)

  // Lo de afuera (deshacer, otra pantalla) manda, salvo mientras se arrastra.
  const ids = p.media.map((m) => m.id).join()
  useEffect(() => {
    if (!drag.current?.started) setOrder(ids.split(",").filter(Boolean))
  }, [ids])

  // FLIP: cada foto parte de donde estaba y se desliza a su lugar nuevo.
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
      if (!prev) continue
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
  }, [order.join(), p.media.length])

  const byId = new Map(p.media.map((m) => [m.id, m]))
  const list = order.map((id) => byId.get(id)).filter(Boolean) as Media[]
  const colorOf = (m: Media) => p.colors.find((c) => c.id === m.color)
  const aiCount = p.media.filter((m) => m.aiColor).length

  function commit(next: string[], label: string) {
    cambiar(
      p.id,
      label,
      (x) => {
        const map = new Map(x.media.map((m) => [m.id, m]))
        x.media = next.map((id) => map.get(id)!).filter(Boolean)
      },
      { toast: true },
    )
  }

  /** Dónde va la foto arrastrada: bajo el puntero, desde su lugar actual en la cuadrícula. */
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

  function onPointerDown(e: RPointerEvent, id: string) {
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
  function onPointerMove(e: RPointerEvent) {
    const d = drag.current
    if (!d) return
    d.px = e.clientX
    d.py = e.clientY
    if (!d.started && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 6) return
    if (!d.started) {
      d.started = true
      setDragId(d.id)
    }
    // El lugar bajo el puntero: el de la foto cuyo recuadro lo contiene.
    let target = -1
    order.forEach((oid, i) => {
      if (oid === d.id) return
      const n = nodes.current.get(oid)
      if (!n) return
      const r = n.getBoundingClientRect()
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      )
        target = i
    })
    const from = order.indexOf(d.id)
    if (target >= 0 && target !== from) setOrder(move(order, from, target))
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
    if (order.join() !== ids)
      commit(order, order[0] !== ids.split(",")[0] ? "Cambiaste la portada" : "Moviste una foto")
  }

  return (
    <Seccion
      id="fotos"
      title="Fotos y videos"
      summary={`${p.media.filter((m) => m.kind === "foto").length} fotos · ${p.media.filter((m) => m.kind === "video").length} video`}
      action={
        edit && aiCount ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-primary"
            onClick={() =>
              cambiar(
                p.id,
                "Aceptaste los colores de las fotos",
                (x) => {
                  for (const m of x.media) m.aiColor = false
                },
                { toast: true },
              )
            }
          >
            <Sparkles aria-hidden />
            {aiCount === 1
              ? "La IA puso 1 foto en su color"
              : `La IA puso ${aiCount} fotos en su color`}
            <span className="font-semibold">· Aceptar</span>
          </Button>
        ) : null
      }
    >
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
          e.preventDefault()
          setOver(false)
          void addFiles(p, [...e.dataTransfer.files])
        }}
      >
        {list.length === 0 ? (
          <button
            type="button"
            disabled={!edit}
            onClick={() => input.current?.click()}
            className="flex min-h-48 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-input-border text-center text-sm text-muted-foreground transition-colors hover:bg-muted/50"
          >
            <ImagePlus className="size-6" aria-hidden />
            <span className="font-medium text-foreground">Suelta tus fotos o videos</span>
            <span>o pégalos con Ctrl+V · la IA los pone en su color</span>
          </button>
        ) : (
          <div
            ref={grid}
            role="list"
            aria-label="Fotos y videos, la primera es la portada"
            className="relative grid grid-cols-3 gap-3 sm:grid-cols-4"
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {list.map((m, i) => {
              const c = colorOf(m)
              const cover = i === 0
              return (
                <div
                  key={m.id}
                  role="listitem"
                  ref={(el) => {
                    if (el) nodes.current.set(m.id, el)
                    else nodes.current.delete(m.id)
                  }}
                  tabIndex={edit ? 0 : -1}
                  aria-label={`${m.kind === "video" ? "Video" : "Foto"} ${i + 1}${cover ? ", portada" : ""}${c ? `, color ${c.name}` : ""}. Alt y flechas para moverla.`}
                  onPointerDown={(e) => onPointerDown(e, m.id)}
                  onKeyDown={(e) => {
                    if (!edit || !e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return
                    e.preventDefault()
                    const to = Math.max(
                      0,
                      Math.min(order.length - 1, i + (e.key === "ArrowLeft" ? -1 : 1)),
                    )
                    if (to !== i)
                      commit(
                        move(order, i, to),
                        to === 0 ? "Cambiaste la portada" : "Moviste una foto",
                      )
                  }}
                  className={cn(
                    "group relative overflow-hidden rounded-xl bg-muted outline-none ring-offset-2 ring-offset-card focus-visible:ring-3 focus-visible:ring-ring/50",
                    cover ? "col-span-2 row-span-2 aspect-square" : "aspect-square",
                    edit && "cursor-grab active:cursor-grabbing",
                    dragId === m.id && "z-10 shadow-xl ring-2 ring-primary",
                  )}
                >
                  <img
                    src={foto(m.kind === "video" ? (m.poster ?? "") : m.src)}
                    alt=""
                    draggable={false}
                    className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                  />
                  {m.kind === "video" ? (
                    <span className="absolute inset-0 flex items-center justify-center bg-black/15">
                      <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur">
                        <Play className="size-4 fill-current" aria-hidden />
                      </span>
                    </span>
                  ) : null}
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
                    {c ? (
                      <span
                        className={cn(
                          "flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur",
                          m.aiColor && "ring-1 ring-primary/50 ring-dashed",
                        )}
                      >
                        <Swatch color={c} className="size-4" />
                        <span className="truncate">{c.name}</span>
                        {m.aiColor ? (
                          <Sparkles className="size-3 text-primary" aria-label="Lo puso la IA" />
                        ) : null}
                      </span>
                    ) : null}
                    {m.kind === "video" ? (
                      <span className="ml-auto flex h-6 items-center gap-1 rounded-full bg-background/90 px-2 text-xs font-medium backdrop-blur">
                        0:0{m.dur ?? 6}
                        <Check className="size-3 text-success" aria-label="Listo para WhatsApp" />
                      </span>
                    ) : null}
                  </span>
                  {edit ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="secondary"
                            aria-label="Opciones de la foto"
                            className="absolute top-2 right-2 bg-background/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 aria-expanded:opacity-100 max-md:opacity-100"
                          />
                        }
                      >
                        <MoreHorizontal aria-hidden />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        {!cover ? (
                          <DropdownMenuItem
                            onClick={() => commit(move(order, i, 0), "Cambiaste la portada")}
                          >
                            <Star aria-hidden />
                            Usar como portada
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Es del color</DropdownMenuLabel>
                          {p.colors.map((col) => (
                            <DropdownMenuItem
                              key={col.id}
                              onClick={() =>
                                cambiar(
                                  p.id,
                                  `La foto es de «${col.name}»`,
                                  (x) => {
                                    const t = x.media.find((y) => y.id === m.id)
                                    if (t) {
                                      t.color = col.id
                                      t.aiColor = false
                                    }
                                  },
                                  { toast: true },
                                )
                              }
                            >
                              <Swatch color={col} />
                              {col.name}
                              {m.color === col.id ? (
                                <Check className="ml-auto" aria-hidden />
                              ) : null}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                        <DropdownMenuSeparator />
                        {i > 0 ? (
                          <DropdownMenuItem
                            onClick={() => commit(move(order, i, i - 1), "Moviste una foto")}
                          >
                            Mover antes
                          </DropdownMenuItem>
                        ) : null}
                        {i < order.length - 1 ? (
                          <DropdownMenuItem
                            onClick={() => commit(move(order, i, i + 1), "Moviste una foto")}
                          >
                            Mover después
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            cambiar(
                              p.id,
                              m.kind === "video" ? "Quitaste el video" : "Quitaste una foto",
                              (x) => {
                                x.media = x.media.filter((y) => y.id !== m.id)
                              },
                              { toast: true },
                            )
                          }
                        >
                          <Trash2 aria-hidden />
                          Quitar
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              )
            })}
            {edit ? (
              <button
                type="button"
                onClick={() => input.current?.click()}
                className="flex aspect-square flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-input-border text-xs font-medium text-muted-foreground outline-none transition-colors hover:border-primary/50 hover:bg-primary-soft/40 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40"
              >
                <ImagePlus className="size-5" aria-hidden />
                Agregar
              </button>
            ) : null}
          </div>
        )}
        {over ? (
          <div className="entra pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary-soft/80 text-sm font-semibold text-primary-soft-foreground backdrop-blur-[2px]">
            Suelta para agregar · la IA las pone en su color
          </div>
        ) : null}
        <input
          ref={input}
          type="file"
          accept="image/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(p, [...(e.target.files ?? [])])
            e.target.value = ""
          }}
        />
      </div>
    </Seccion>
  )
}

/** En el celular, arriba de todo: las fotos para pasar con el dedo. */
export function PhotoCarousel({ p }: { p: Producto }) {
  const [i, setI] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div className="-mx-4 flex flex-col gap-2">
      <div
        ref={ref}
        className="flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 [scrollbar-width:none]"
        onScroll={(e) => {
          const el = e.currentTarget
          setI(Math.round(el.scrollLeft / (el.clientWidth - 24)))
        }}
      >
        {p.media.length === 0 ? (
          <div className="flex aspect-[6/5] w-full shrink-0 items-center justify-center rounded-2xl bg-muted text-sm text-muted-foreground">
            Sin fotos todavía
          </div>
        ) : (
          p.media.map((m, j) => {
            const c = p.colors.find((x) => x.id === m.color)
            return (
              <div
                key={m.id}
                className="relative aspect-[6/5] w-[calc(100%-1.5rem)] shrink-0 snap-center overflow-hidden rounded-2xl bg-muted first:w-full"
              >
                <img
                  src={foto(m.kind === "video" ? (m.poster ?? "") : m.src)}
                  alt={j === 0 ? `${p.name}, portada` : ""}
                  className="size-full object-cover"
                />
                {m.kind === "video" ? (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="flex size-12 items-center justify-center rounded-full bg-black/55 text-white">
                      <Play className="size-5 fill-current" aria-hidden />
                    </span>
                  </span>
                ) : null}
                {c ? (
                  <span className="absolute bottom-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-background/90 pr-2 pl-1 text-xs font-medium backdrop-blur">
                    <Swatch color={c} />
                    {c.name}
                  </span>
                ) : null}
              </div>
            )
          })
        )}
      </div>
      {p.media.length > 1 ? (
        <div className="flex justify-center gap-1.5" aria-hidden>
          {p.media.map((m, j) => (
            <span
              key={m.id}
              className={cn(
                "h-1.5 rounded-full bg-foreground/20 transition-all duration-300",
                j === i ? "w-4 bg-foreground/70" : "w-1.5",
              )}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Pegar una foto con Ctrl+V en cualquier parte de la ficha (fuera de un campo). */
export function usePastePhotos(p: Producto, edit: boolean) {
  const ref = useRef(p)
  ref.current = p
  useEffect(() => {
    if (!edit) return
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest("input,textarea,[role=grid]")) return
      const files = [...(e.clipboardData?.files ?? [])]
      if (!files.length) return
      e.preventDefault()
      void addFiles(ref.current, files)
      toast("La IA está mirando la foto…", { id: "pegar", duration: 1200 })
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [edit])
}
