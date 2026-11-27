import {
  Button,
  cn,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  Input,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  useIsMobile,
} from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { Check, Pipette, Plus, Sparkles, Trash2 } from "lucide-react"
import { type PointerEvent as RPointerEvent, useEffect, useId, useRef, useState } from "react"
import { isHex, isLight, palette } from "../color"
import { type Color, foto, nid, type Producto, type Rubro } from "../datos"
import { key, money } from "../precio"
import { cambiar } from "../tienda"
import { Hoja } from "./hoja"
import { Propuesto, Seccion, Swatch } from "./piezas"

/** «35 a 42» o «35-42» son las tallas seguidas; lo demás, separado por comas. */
export function readValues(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => {
      const m = /^(\d{1,3})\s*(?:a|-)\s*(\d{1,3})$/i.exec(part)
      if (!m) return [part]
      const [a, b] = [Number(m[1]), Number(m[2])]
      if (b < a || b - a > 40) return [part]
      return Array.from({ length: b - a + 1 }, (_, i) => String(a + i))
    })
}
export const sizesText = (s: string[]) => {
  const nums = s.map(Number)
  const seq =
    s.length > 2 && nums.every((n, i) => Number.isInteger(n) && (i === 0 || n === nums[i - 1]! + 1))
  return seq ? `${s[0]} a ${s.at(-1)}` : s.join(", ")
}

/* ---------- el cuentagotas sobre la foto ---------- */
function Cuentagotas({ src, onPick }: { src: string; onPick: (hex: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; hex: string } | null>(null)
  useEffect(() => {
    const img = new Image()
    img.crossOrigin = "anonymous"
    img.onload = () => {
      const c = canvas.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext("2d", { willReadFrequently: true })?.drawImage(img, 0, 0)
    }
    img.src = foto(src)
  }, [src])
  const read = (e: RPointerEvent<HTMLCanvasElement>) => {
    const c = e.currentTarget
    const r = c.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * c.width
    const y = ((e.clientY - r.top) / r.height) * c.height
    let d: Uint8ClampedArray | undefined
    try {
      d = c
        .getContext("2d", { willReadFrequently: true })
        ?.getImageData(Math.floor(x), Math.floor(y), 1, 1).data
    } catch {
      return null
    }
    if (!d) return null
    const hex = `#${[d[0], d[1], d[2]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`
    return { x: e.clientX - r.left, y: e.clientY - r.top, hex }
  }
  return (
    <div className="entra relative overflow-hidden rounded-xl">
      <canvas
        ref={canvas}
        aria-label="Toca la foto para tomar su color"
        className="block aspect-square w-full cursor-crosshair touch-none bg-muted"
        onPointerMove={(e) => setHover(read(e))}
        onPointerDown={(e) => setHover(read(e))}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          const h = read(e)
          if (h) onPick(h.hex)
        }}
      />
      {hover ? (
        <span
          aria-hidden
          className="pointer-events-none absolute flex size-14 -translate-x-1/2 -translate-y-[calc(100%+10px)] items-end justify-center rounded-full border-4 border-background shadow-lg"
          style={{ left: hover.x, top: hover.y, background: hover.hex }}
        >
          <span
            className={cn(
              "mb-1.5 font-mono text-[9px] font-semibold",
              isLight(hover.hex) ? "text-black/70" : "text-white/85",
            )}
          >
            {hover.hex}
          </span>
        </span>
      ) : null}
      <span className="pointer-events-none absolute bottom-2 left-2 rounded-full bg-background/90 px-2 py-0.5 text-xs font-medium backdrop-blur">
        Toca el color en la foto
      </span>
    </div>
  )
}

/* ---------- el editor de un color ---------- */
function HexField({
  value,
  onChange,
  label,
}: {
  value: string
  onChange: (v: string) => void
  label: string
}) {
  const [text, setText] = useState(value.replace("#", ""))
  useEffect(() => setText(value.replace("#", "")), [value])
  return (
    <InputGroup className="w-32">
      <InputGroupAddon>#</InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        value={text}
        maxLength={6}
        spellCheck={false}
        className="font-mono uppercase"
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9a-f]/gi, "")
          setText(v)
          if (v.length === 6) onChange(`#${v.toLowerCase()}`)
        }}
      />
    </InputGroup>
  )
}

function Paleta({
  fuentes,
  value,
  onPick,
  ai,
}: {
  fuentes: string[]
  value: string
  onPick: (h: string) => void
  ai?: string
}) {
  const [cols, setCols] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void Promise.all(fuentes.slice(0, 2).map((s) => palette(foto(s), 4))).then((ps) => {
      const all: string[] = ai ? [ai] : []
      for (const p of ps) for (const h of p) if (!all.includes(h) && all.length < 6) all.push(h)
      // Si la foto no se puede leer aquí, quedan el de la IA y el de ahora.
      if (all.length < 2 && !all.includes(value)) all.push(value)
      if (alive) setCols(all)
    })
    return () => {
      alive = false
    }
  }, [fuentes.join(), ai])
  if (!cols.length)
    return (
      <div className="flex gap-2" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="brillo size-8 rounded-full" />
        ))}
      </div>
    )
  return (
    <div
      className="flex flex-wrap gap-2"
      role="radiogroup"
      aria-label="Colores sacados de las fotos"
    >
      {cols.map((h, i) => (
        <button
          key={h}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === h.toLowerCase()}
          aria-label={h}
          onClick={() => onPick(h)}
          style={{ animationDelay: `${i * 40}ms` }}
          className={cn(
            "entra relative size-8 rounded-full outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50",
            value.toLowerCase() === h.toLowerCase() && "ring-2 ring-primary",
          )}
        >
          <Swatch hex={h} className="size-8" />
          {value.toLowerCase() === h.toLowerCase() ? (
            <Check
              className={cn(
                "absolute inset-0 m-auto size-4",
                isLight(h) ? "text-black/70" : "text-white",
              )}
              aria-hidden
            />
          ) : null}
        </button>
      ))}
    </div>
  )
}

function ColorEditor({
  p,
  color,
  edit,
  R,
  onClose,
}: {
  p: Producto
  color: Color
  edit: boolean
  R: Rubro
  onClose: () => void
}) {
  const [gotas, setGotas] = useState<1 | 2 | null>(null)
  const nameId = useId()
  const fotos = p.media.filter((m) => m.kind === "foto")
  const mias = fotos.filter((m) => m.color === color.id)
  const fuente = (mias[0] ?? fotos[0])?.src
  const set = (label: string, fn: (c: Color) => void, group?: string) =>
    cambiar(
      p.id,
      label,
      (x) => {
        const c = x.colors.find((y) => y.id === color.id)
        if (c) fn(c)
      },
      { group, toast: !group },
    )
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Swatch color={color} className="size-11 transition-[background] duration-300" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
            Nombre del {R.row.toLowerCase()}
          </label>
          <Input
            id={nameId}
            value={color.name}
            disabled={!edit}
            onChange={(e) =>
              set(
                "Cambiaste el nombre del color",
                (c) => (c.name = e.target.value),
                `nombre-${color.id}`,
              )
            }
          />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="size-3.5 text-primary" aria-hidden />
            Sacados de las fotos
          </span>
          {color.aiHex && color.aiHex !== color.hex && edit ? (
            <Propuesto
              label="Propuesta de la IA"
              porque={`En la foto, «${color.name}» se ve ${color.aiHex}. Así se verá en el catálogo y en lo que muestre Sofi.`}
              onAccept={() =>
                set(`«${color.name}» con el color de la foto`, (c) => {
                  c.hex = c.aiHex!
                  delete c.aiHex
                })
              }
              onDiscard={() =>
                set("Descartaste el color de la foto", (c) => {
                  delete c.aiHex
                })
              }
            />
          ) : null}
        </div>
        <Paleta
          fuentes={mias.map((m) => m.src)}
          ai={color.aiHex}
          value={color.hex}
          onPick={(h) =>
            edit &&
            set(`«${color.name}» con ${h}`, (c) => {
              c.hex = h
              if (c.aiHex === h) delete c.aiHex
            })
          }
        />
      </div>

      <div className="flex items-center gap-2">
        <HexField
          value={color.hex}
          label="Código del color"
          onChange={(h) =>
            edit && set(`«${color.name}» con ${h}`, (c) => (c.hex = h), `hex-${color.id}`)
          }
        />
        <Button
          variant={gotas === 1 ? "default" : "outline"}
          size="sm"
          disabled={!edit || !fuente}
          aria-pressed={gotas === 1}
          onClick={() => setGotas(gotas === 1 ? null : 1)}
        >
          <Pipette aria-hidden />
          Cuentagotas
        </Button>
      </div>
      {gotas && fuente ? (
        <Cuentagotas
          src={fuente}
          onPick={(h) => {
            if (gotas === 1) set(`«${color.name}» con ${h}`, (c) => (c.hex = h))
            else set(`Segundo color ${h}`, (c) => (c.hex2 = h))
            setGotas(null)
          }}
        />
      ) : null}

      <div className="flex flex-col gap-2 border-t pt-3">
        <label className="flex items-center justify-between gap-3 text-sm font-medium">
          Es de dos colores
          <Switch
            checked={!!color.hex2}
            disabled={!edit}
            onCheckedChange={(on) =>
              set(on ? "Ahora es bicolor" : "Ya no es bicolor", (c) => {
                if (on) c.hex2 = "#ffffff"
                else delete c.hex2
              })
            }
          />
        </label>
        {color.hex2 ? (
          <div className="entra flex items-center gap-2">
            <Swatch hex={color.hex2} className="size-8" />
            <HexField
              value={color.hex2}
              label="Código del segundo color"
              onChange={(h) => set(`Segundo color ${h}`, (c) => (c.hex2 = h), `hex2-${color.id}`)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!edit || !fuente}
              onClick={() => setGotas(gotas === 2 ? null : 2)}
            >
              <Pipette aria-hidden />
              De la foto
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-xs font-medium text-muted-foreground">
          Sus fotos · Sofi manda estas cuando piden «{color.name}»
        </span>
        <div className="flex flex-wrap gap-2">
          {fotos.map((m) => {
            const on = m.color === color.id
            return (
              <button
                key={m.id}
                type="button"
                disabled={!edit}
                aria-pressed={on}
                aria-label={on ? "Foto de este color" : "Asignar esta foto a este color"}
                onClick={() =>
                  cambiar(
                    p.id,
                    on ? "La foto quedó sin color" : `La foto es de «${color.name}»`,
                    (x) => {
                      const t = x.media.find((y) => y.id === m.id)
                      if (!t) return
                      t.color = on ? undefined : color.id
                      t.aiColor = false
                    },
                    { toast: true },
                  )
                }
                className={cn(
                  "relative size-12 overflow-hidden rounded-lg outline-none ring-offset-2 ring-offset-popover transition-all focus-visible:ring-3 focus-visible:ring-ring/50",
                  on ? "ring-2 ring-primary" : "opacity-60 hover:opacity-100",
                )}
              >
                <img src={foto(m.src)} alt="" className="size-full object-cover" />
                {on && m.aiColor ? (
                  <span className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Sparkles className="size-2.5" aria-label="Lo puso la IA" />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>

      {edit ? (
        <div className="flex items-center justify-between border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={p.colors.length < 2}
            onClick={() => {
              onClose()
              cambiar(
                p.id,
                `Quitaste «${color.name}»`,
                (x) => {
                  x.colors = x.colors.filter((c) => c.id !== color.id)
                  for (const m of x.media) if (m.color === color.id) m.color = undefined
                },
                { toast: true },
              )
            }}
          >
            <Trash2 aria-hidden />
            Quitar
          </Button>
          <Button size="sm" onClick={onClose}>
            Listo
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/** El chip de un color: muestra y nombre. Abre su editor en un popover (escritorio) o un cajón (celular). */
function ColorChip({
  p,
  color,
  edit,
  R,
  startOpen,
}: {
  p: Producto
  color: Color
  edit: boolean
  R: Rubro
  startOpen?: boolean
}) {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(!!startOpen)
  const chip = (
    <>
      <Swatch color={color} className="size-5 transition-[background] duration-300" />
      <span>{color.name}</span>
      {color.aiHex && color.aiHex !== color.hex ? (
        <Sparkles className="size-3.5 text-primary" aria-label="Con propuesta de la IA" />
      ) : null}
    </>
  )
  const chipClass =
    "inline-flex h-9 items-center gap-2 rounded-full border border-input-border bg-card pr-3.5 pl-2 text-sm font-medium outline-none transition-[background,box-shadow,transform] hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40 aria-expanded:border-primary aria-expanded:ring-3 aria-expanded:ring-ring/20"
  if (isMobile)
    return (
      <>
        <button
          type="button"
          className={chipClass}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          {chip}
        </button>
        <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
          <DrawerContent>
            <DrawerHeader className="text-left">
              <DrawerTitle>
                {R.row} «{color.name}»
              </DrawerTitle>
              <DrawerDescription>
                Así se ve en el catálogo y en lo que manda Sofi.
              </DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-6">
              <ColorEditor p={p} color={color} edit={edit} R={R} onClose={() => setOpen(false)} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<button type="button" className={chipClass} />}>
        {chip}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[22rem] rounded-2xl p-4">
        <ColorEditor p={p} color={color} edit={edit} R={R} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

function SizesChip({ p, edit, R }: { p: Producto; edit: boolean; R: Rubro }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(sizesText(p.sizes))
  useEffect(() => setText(sizesText(p.sizes)), [p.sizes.join()])
  const next = readValues(text)
  const apply = () => {
    if (!next.length || next.join() === p.sizes.join()) return setOpen(false)
    cambiar(
      p.id,
      `${R.col}s: ${sizesText(next)}`,
      (x) => {
        x.sizes = next
        for (const c of x.colors) for (const z of next) x.stock[key(c.id, z)] ??= 0
      },
      { toast: true },
    )
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={!edit}
        render={
          <button
            type="button"
            className="inline-flex h-9 items-center gap-2 rounded-full border border-input-border bg-card px-3.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 aria-expanded:border-primary"
          />
        }
      >
        {sizesText(p.sizes)}
        <span className="text-muted-foreground">· {p.sizes.length}</span>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 rounded-2xl p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {R.col}s
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="35 a 42, o S, M, L"
            />
          </label>
          <div className="flex flex-wrap gap-1.5" aria-live="polite">
            {next.map((z) => (
              <span
                key={z}
                className={cn(
                  "entra rounded-md bg-muted px-2 py-0.5 text-xs font-medium",
                  !p.sizes.includes(z) && "bg-primary-soft text-primary-soft-foreground",
                )}
              >
                {z}
              </span>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button type="submit" size="sm">
              Listo
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}

/** Variantes: las opciones arriba (colores con su muestra, tallas) y abajo la hoja de stock y precio. */
export function VariantsCard({
  p,
  saved,
  edit,
  R,
}: {
  p: Producto
  saved: Producto | undefined
  edit: boolean
  R: Rubro
}) {
  const [measure, setMeasure] = useState<"stock" | "precio">("stock")
  const [nuevo, setNuevo] = useState<string | null>(null)
  const total = p.colors.length * p.sizes.length
  return (
    <Seccion
      id="variantes"
      title="Variantes"
      summary={`${p.colors.map((c) => c.name).join(", ")}${R.col ? ` · ${sizesText(p.sizes)}` : ""}`}
      contains={["stock"]}
    >
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <span className="text-sm text-muted-foreground">{R.row}</span>
        <div className="flex flex-wrap items-center gap-2">
          {p.colors.map((c) => (
            <ColorChip key={c.id} p={p} color={c} edit={edit} R={R} startOpen={c.id === nuevo} />
          ))}
          {edit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-full"
              onClick={() => {
                const id = nid("c")
                setNuevo(id)
                cambiar(
                  p.id,
                  `Agregaste un ${R.row.toLowerCase()}`,
                  (x) => {
                    x.colors.push({ id, name: "nuevo", hex: "#9ca3af" })
                    for (const z of x.sizes) x.stock[key(id, z)] = 0
                  },
                  { toast: true },
                )
              }}
            >
              <Plus aria-hidden />
              {R.row}
            </Button>
          ) : null}
        </div>
        {R.col ? (
          <>
            <span className="text-sm text-muted-foreground">{R.col}</span>
            <div>
              <SizesChip p={p} edit={edit} R={R} />
            </div>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Tabs value={measure} onValueChange={(v) => setMeasure(v as "stock" | "precio")}>
          <TabsList className="h-9 bg-muted">
            <TabsTrigger value="stock">Stock</TabsTrigger>
            <TabsTrigger value="precio">Precio</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-sm text-muted-foreground">
          {total} {total === 1 ? "variante" : "variantes"}
          {measure === "precio" ? ` · vacío = ${money(p.list)}` : ""}
        </span>
      </div>
      <div id="stock" className="scroll-mt-24 rounded-xl">
        {measure === "stock" ? (
          <Hoja
            key="stock"
            label="Stock"
            rows={p.sizes}
            cols={p.colors}
            rowLabel={R.col ?? "Stock"}
            get={(r, c) => p.stock[key(c, r)] ?? 0}
            saved={(r, c) => saved?.stock[key(c, r)] ?? 0}
            emptyValue={0}
            totals
            edit={edit}
            set={(cells, v, label) =>
              cambiar(
                p.id,
                label,
                (x) => {
                  for (const { r, c } of cells) x.stock[key(c, r)] = Math.max(0, Math.round(v ?? 0))
                },
                { toast: true },
              )
            }
            setMany={(cells, label) =>
              cambiar(
                p.id,
                label,
                (x) => {
                  for (const { r, c, v } of cells)
                    x.stock[key(c, r)] = Math.max(0, Math.round(v ?? 0))
                },
                { toast: true },
              )
            }
          />
        ) : (
          <Hoja
            key="precio"
            label="Precio"
            rows={p.sizes}
            cols={p.colors}
            rowLabel={R.col ?? "Precio"}
            get={(r, c) => p.prices[key(c, r)] ?? null}
            saved={(r, c) => saved?.prices[key(c, r)] ?? null}
            placeholder={String(p.list)}
            emptyValue={null}
            edit={edit}
            set={(cells, v, label) =>
              cambiar(
                p.id,
                label,
                (x) => {
                  for (const { r, c } of cells) {
                    if (v == null || v === x.list) delete x.prices[key(c, r)]
                    else x.prices[key(c, r)] = v
                  }
                },
                { toast: true },
              )
            }
            setMany={(cells, label) =>
              cambiar(
                p.id,
                label,
                (x) => {
                  for (const { r, c, v } of cells) {
                    if (v == null || v === x.list) delete x.prices[key(c, r)]
                    else x.prices[key(c, r)] = v
                  }
                },
                { toast: true },
              )
            }
          />
        )}
      </div>
    </Seccion>
  )
}

export { isHex }
