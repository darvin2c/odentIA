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
import { PageNotice, RadioChips } from "@odentia/ui-patterns"
import { Check, Pipette, Plus, Trash2 } from "lucide-react"
import { type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from "react"
import { readValues } from "../catalogo"
import {
  cellKey,
  type Draft,
  emptyCell,
  type Grid,
  type GridRow,
  NO_AXIS,
  newId,
  sameText,
  valuesText,
} from "../lib/ficha"
import { money, moneyInput, readMoney, variantName } from "../lib/tienda"
import { Photo, usePhotoUrl } from "../piezas"
import { isLight, palette } from "./color"
import { useFichaContext } from "./contexto"
import { Hoja, type HojaAxisItem } from "./hoja"
import { ColorProposals } from "./ia"
import { FieldProblem, Section, Swatch } from "./piezas"

/**
 * Variantes (tablero 8; prototipo `ficha/variantes.tsx`): los colores con su muestra y las tallas
 * arriba, y abajo la cuadrícula de stock, precio y código de barras. Todo va al borrador y se
 * guarda junto con `POST /productos/:id/cuadricula`: subir el stock entra al kardex; bajarlo pide
 * motivo.
 */

type Measure = "stock" | "precio" | "codigo"

/** Cambia el nombre de un color o una talla en el borrador, con sus promociones. */
function renameIn(draft: Draft, axis: "rows" | "columns", from: string, to: string) {
  for (const promo of draft.promotions)
    if (promo.scope?.axis === axis && sameText(promo.scope.value, from)) promo.scope.value = to
}

/** Un nombre que todavía no está en la lista: «Color nuevo», «Color nuevo 2»… */
function freeName(base: string, taken: string[]) {
  let name = base
  for (let n = 2; taken.some((t) => sameText(t, name)); n++) name = `${base} ${n}`
  return name
}

/* ------------------------------------------------------------------ el cuentagotas */

function Dropper({ src, onPick }: { src: string; onPick: (hex: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<{ x: number; y: number; hex: string } | null>(null)
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const c = canvas.current
      if (!c) return
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      c.getContext("2d", { willReadFrequently: true })?.drawImage(img, 0, 0)
    }
    img.src = src
  }, [src])
  const read = (e: ReactPointerEvent<HTMLCanvasElement>) => {
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

function HexField({
  value,
  onChange,
  label,
  disabled,
}: {
  value: string | null
  onChange: (v: string) => void
  label: string
  disabled?: boolean
}) {
  const [text, setText] = useState((value ?? "").replace("#", ""))
  useEffect(() => setText((value ?? "").replace("#", "")), [value])
  return (
    <InputGroup className="w-32">
      <InputGroupAddon>#</InputGroupAddon>
      <InputGroupInput
        aria-label={label}
        value={text}
        maxLength={6}
        spellCheck={false}
        disabled={disabled}
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

/** Los colores que se ven en las fotos del producto, para tocar uno. */
function FromPhotos({
  sources,
  value,
  onPick,
  disabled,
}: {
  sources: (string | null)[]
  value: string | null
  onPick: (hex: string) => void
  disabled?: boolean
}) {
  const [colors, setColors] = useState<string[] | null>(null)
  const ready = sources.filter((s): s is string => !!s)
  const key = ready.join()
  // biome-ignore lint/correctness/useExhaustiveDependencies: se lee de nuevo si cambian las fotos
  useEffect(() => {
    let alive = true
    if (!ready.length) {
      setColors([])
      return
    }
    void Promise.all(ready.slice(0, 2).map((src) => palette(src, 4))).then((lists) => {
      const all: string[] = []
      for (const list of lists)
        for (const h of list) if (!all.includes(h) && all.length < 6) all.push(h)
      if (alive) setColors(all)
    })
    return () => {
      alive = false
    }
  }, [key])
  if (colors === null)
    return (
      <div className="flex gap-2" aria-hidden>
        {[0, 1, 2, 3, 4].map((i) => (
          <span key={i} className="brillo size-8 rounded-full" />
        ))}
      </div>
    )
  if (!colors.length)
    return <p className="text-sm text-muted-foreground">Con una foto, aquí salen sus colores.</p>
  return (
    <div className="flex flex-wrap gap-2">
      {colors.map((h, i) => {
        const on = value?.toLowerCase() === h.toLowerCase()
        return (
          <button
            key={h}
            type="button"
            aria-pressed={on}
            aria-label={`Usar ${h}`}
            disabled={disabled}
            onClick={() => onPick(h)}
            style={{ animationDelay: `${i * 40}ms` }}
            className={cn(
              "entra relative size-8 rounded-full outline-none ring-offset-2 ring-offset-popover transition-transform hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none",
              on && "ring-2 ring-primary",
            )}
          >
            <Swatch hex={h} className="size-8" />
            {on ? (
              <Check
                className={cn(
                  "absolute inset-0 m-auto size-4",
                  isLight(h) ? "text-black/70" : "text-white",
                )}
                aria-hidden
              />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

/** Una foto del producto para elegir: la que manda Sofi cuando piden ese color. */
function PhotoChoice({
  photoId,
  on,
  disabled,
  onClick,
}: {
  photoId: string
  on: boolean
  disabled?: boolean
  onClick: () => void
}) {
  const { store } = useFichaContext()
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={on}
      aria-label={on ? "La foto de este color" : "Usar esta foto para este color"}
      onClick={onClick}
      className={cn(
        "relative size-12 overflow-hidden rounded-lg outline-none ring-offset-2 ring-offset-popover transition-all focus-visible:ring-3 focus-visible:ring-ring/50",
        on ? "ring-2 ring-primary" : "opacity-60 hover:opacity-100",
      )}
    >
      <Photo storeId={store.id} photoId={photoId} alt="" className="size-full rounded-none" />
    </button>
  )
}

function ColorEditor({ row, onClose }: { row: GridRow; onClose: () => void }) {
  const { draft, edit, change, rubro, sheet, store } = useFichaContext()
  const [dropper, setDropper] = useState<1 | 2 | null>(null)
  const [name, setName] = useState(row.value)
  const nameId = useId()
  const grid = draft.grid!
  const rowLabel = (grid.rowName ?? rubro?.rowLabel ?? "Color").toLowerCase()
  // Las fotos de este color primero: de ahí salen sus colores.
  const own = sheet.photos.filter(
    (p) =>
      p.id === row.photoId ||
      p.colorId === sheet.colors.find((c) => sameText(c.value, row.value))?.id,
  )
  const source = usePhotoUrl(store.id, (own[0] ?? sheet.photos[0])?.id ?? null)
  const second = usePhotoUrl(store.id, own[1]?.id ?? null)
  useEffect(() => setName(row.value), [row.value])

  const set = (label: string, fn: (r: GridRow, d: Draft) => void, group?: string) =>
    change(
      label,
      (d) => {
        const target = d.grid?.rows.find((r) => r.id === row.id)
        if (target) fn(target, d)
      },
      { group },
    )
  const rename = (next: string) => {
    const value = next.trim()
    if (!value || value === row.value) return
    if (grid.rows.some((r) => r.id !== row.id && sameText(r.value, value))) return
    set(`Cambiaste «${row.value}» por «${value}»`, (r, d) => {
      renameIn(d, "rows", r.value, value)
      r.value = value
    })
  }
  const taken = grid.rows.some((r) => r.id !== row.id && sameText(r.value, name.trim()))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Swatch
          hex={row.hex}
          hex2={row.hex2}
          className="size-11 transition-[background] duration-300"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor={nameId} className="text-xs font-medium text-muted-foreground">
            Nombre del {rowLabel}
          </label>
          <Input
            id={nameId}
            value={name}
            disabled={!edit}
            maxLength={30}
            aria-invalid={taken || undefined}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => rename(name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                rename(name)
              }
            }}
          />
          {taken ? <FieldProblem message={`«${name.trim()}» ya está`} /> : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium text-muted-foreground">De las fotos</span>
        <FromPhotos
          sources={[source, second]}
          value={row.hex}
          disabled={!edit}
          onPick={(h) => set(`«${row.value}» con ${h}`, (r) => (r.hex = h))}
        />
      </div>

      <div className="flex items-center gap-2">
        <HexField
          value={row.hex}
          label="Código del color"
          disabled={!edit}
          onChange={(h) => set(`«${row.value}» con ${h}`, (r) => (r.hex = h), `hex-${row.id}`)}
        />
        <Button
          variant={dropper === 1 ? "default" : "outline"}
          size="sm"
          disabled={!edit || !source}
          aria-pressed={dropper === 1}
          onClick={() => setDropper(dropper === 1 ? null : 1)}
        >
          <Pipette aria-hidden />
          Cuentagotas
        </Button>
      </div>
      {dropper && source ? (
        <Dropper
          src={source}
          onPick={(h) => {
            if (dropper === 1) set(`«${row.value}» con ${h}`, (r) => (r.hex = h))
            else set(`Segundo color ${h}`, (r) => (r.hex2 = h))
            setDropper(null)
          }}
        />
      ) : null}

      <div className="flex flex-col gap-2 border-t pt-3">
        <div className="flex items-center justify-between gap-3 text-sm font-medium">
          <label htmlFor={`${nameId}-dos`}>Es de dos colores</label>
          <Switch
            id={`${nameId}-dos`}
            checked={!!row.hex2}
            disabled={!edit || !row.hex}
            onCheckedChange={(on) =>
              set(on ? "Ahora es de dos colores" : "Ya no es de dos colores", (r) => {
                r.hex2 = on ? "#ffffff" : null
              })
            }
          />
        </div>
        {row.hex2 ? (
          <div className="entra flex items-center gap-2">
            <Swatch hex={row.hex2} className="size-8" />
            <HexField
              value={row.hex2}
              label="Código del segundo color"
              disabled={!edit}
              onChange={(h) => set(`Segundo color ${h}`, (r) => (r.hex2 = h), `hex2-${row.id}`)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!edit || !source}
              onClick={() => setDropper(dropper === 2 ? null : 2)}
            >
              <Pipette aria-hidden />
              De la foto
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 border-t pt-3">
        <span className="text-xs font-medium text-muted-foreground">
          Su foto · Sofi manda esta cuando piden «{row.value}»
        </span>
        {sheet.photos.length ? (
          <div className="flex flex-wrap gap-2">
            {sheet.photos.map((photo) => {
              const on = row.photoId === photo.id
              return (
                <PhotoChoice
                  key={photo.id}
                  photoId={photo.id}
                  on={on}
                  disabled={!edit}
                  onClick={() =>
                    set(
                      on ? `«${row.value}» sin foto` : `La foto de «${row.value}»`,
                      (r) => (r.photoId = on ? null : photo.id),
                    )
                  }
                />
              )
            })}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Sube sus fotos en «Fotos».</p>
        )}
      </div>

      {edit ? (
        <div className="flex items-center justify-between border-t pt-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={grid.rows.length < 2}
            onClick={() => {
              onClose()
              change(`Quitaste «${row.value}»`, (d) => {
                const g = d.grid!
                g.rows = g.rows.filter((r) => r.id !== row.id)
                for (const key of Object.keys(g.cells))
                  if (key.startsWith(`${row.id}|`)) delete g.cells[key]
                d.promotions = d.promotions.filter(
                  (p) => !(p.scope?.axis === "rows" && sameText(p.scope.value, row.value)),
                )
              })
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

const chipClass =
  "inline-flex h-9 items-center gap-2 rounded-full border border-input-border bg-card pr-3.5 pl-2 text-sm font-medium outline-none transition-[background,box-shadow,transform] hover:bg-muted active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring/40 aria-expanded:border-primary aria-expanded:ring-3 aria-expanded:ring-ring/20"

/** El chip de un color: su muestra y su nombre. Abre su editor en un popover o, en el celular, un cajón. */
function ColorChip({ row, startOpen }: { row: GridRow; startOpen?: boolean }) {
  const { draft, rubro } = useFichaContext()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(!!startOpen)
  const rowLabel = draft.grid?.rowName ?? rubro?.rowLabel ?? "Color"
  const chip = (
    <>
      <Swatch
        hex={row.hex}
        hex2={row.hex2}
        className="size-5 transition-[background] duration-300"
      />
      <span>{row.value}</span>
    </>
  )
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
                {rowLabel} «{row.value}»
              </DrawerTitle>
              <DrawerDescription>
                Así se ve en el catálogo y en lo que manda Sofi.
              </DrawerDescription>
            </DrawerHeader>
            <div className="overflow-y-auto px-4 pb-6">
              <ColorEditor row={row} onClose={() => setOpen(false)} />
            </div>
          </DrawerContent>
        </Drawer>
      </>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button type="button" className={chipClass} aria-label={`${rowLabel} ${row.value}`} />
        }
      >
        {chip}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-[22rem] rounded-2xl p-4">
        <ColorEditor row={row} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** Las tallas: se escriben como se dicen («35 a 42», «S, M, L»). */
function SizesChip({ grid }: { grid: Grid }) {
  const { edit, change, rubro } = useFichaContext()
  const [open, setOpen] = useState(false)
  const sizesId = useId()
  const values = grid.columnName === null ? [] : grid.columns.map((c) => c.value)
  const [text, setText] = useState(valuesText(values))
  const joined = values.join()
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambian las tallas
  useEffect(() => setText(valuesText(values)), [joined])
  const next = readValues(text)
  const label = grid.columnName ?? rubro?.columnLabel ?? "Talla"
  const duplicated = next.find((v, i) => next.findIndex((o) => sameText(o, v)) !== i)
  const apply = () => {
    if (!next.length || duplicated || next.join() === values.join()) return setOpen(false)
    change(`${label}s: ${valuesText(next)}`, (d) => {
      const g = d.grid!
      const before = g.columnName === null ? [] : g.columns
      const columns = next.map(
        (value) => before.find((c) => sameText(c.value, value)) ?? { id: newId("c"), value },
      )
      const cells: Grid["cells"] = {}
      // Lo que tenía sin tallas pasa a la primera talla.
      for (const row of g.rows)
        for (const [i, column] of columns.entries())
          cells[cellKey(row.id, column.id)] =
            g.cells[cellKey(row.id, column.id)] ??
            (g.columnName === null && i === 0 ? g.cells[cellKey(row.id, NO_AXIS)] : undefined) ??
            emptyCell()
      const gone = before.filter((c) => !columns.includes(c)).map((c) => c.value)
      d.promotions = d.promotions.filter(
        (p) => !(p.scope?.axis === "columns" && gone.some((v) => sameText(v, p.scope!.value))),
      )
      g.columnName = g.columnName ?? label
      g.columns = columns
      g.cells = cells
    })
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        disabled={!edit}
        render={
          <button
            type="button"
            aria-label={`${label}s: ${values.length ? valuesText(values) : "ninguna"}`}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-input-border bg-card px-3.5 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-100 aria-expanded:border-primary"
          />
        }
      >
        {values.length ? (
          <>
            {valuesText(values)}
            <span className="text-muted-foreground">· {values.length}</span>
          </>
        ) : (
          <>
            <Plus className="size-4" aria-hidden />
            {label}s
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 rounded-2xl p-4">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            apply()
          }}
        >
          <label
            className="flex flex-col gap-1.5 text-sm font-medium"
            htmlFor={`${sizesId}-tallas`}
          >
            {label}s
            <Input
              id={`${sizesId}-tallas`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="35 a 42, o S, M, L"
              aria-invalid={duplicated ? true : undefined}
            />
          </label>
          {duplicated ? <FieldProblem message={`«${duplicated}» está dos veces`} /> : null}
          <div className="flex flex-wrap gap-1.5" aria-live="polite">
            {next.map((z) => (
              <span
                key={z}
                className={cn(
                  "entra rounded-md bg-muted px-2 py-0.5 text-xs font-medium",
                  !values.includes(z) && "bg-primary-soft text-primary-soft-foreground",
                )}
              >
                {z}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Quitar una talla con stock pide el motivo antes de guardar.
          </p>
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

/** El motivo para bajar el stock: se pide aquí, junto a la cuadrícula, y no frena lo demás. */
function StockReason({ cells }: { cells: number }) {
  const { setReason, base, draft } = useFichaContext()
  // Sumar el primer color o la primera talla arma las variantes de nuevo: su stock sale de las de
  // antes y entra en las nuevas, y eso también lleva su motivo en el kardex.
  const reshaped =
    (base.grid?.rowName === null && draft.grid?.rowName !== null) ||
    (base.grid?.columnName === null && draft.grid?.columnName !== null)
  const [choice, setChoice] = useState<string | null>(null)
  const [other, setOther] = useState("")
  const options = ["Conté y corregí", "Se dañó o se perdió", "Se vendió fuera de gestorIA", "Otro"]
  const send = (value: string | null, text: string) => {
    const reason = value === "Otro" ? text.trim() : value
    if (reason && reason.length >= 3) setReason(reason)
  }
  return (
    <section
      className="entra flex flex-col gap-3 rounded-xl border border-warning/50 bg-warning-soft/40 p-3"
      aria-labelledby="motivo-stock"
    >
      <p id="motivo-stock" className="text-sm font-semibold">
        {reshaped
          ? "Las variantes se arman de nuevo con la opción que sumaste. ¿Por qué cambia el stock?"
          : `Bajaste el stock de ${cells} ${cells === 1 ? "variante" : "variantes"}. ¿Por qué?`}
      </p>
      <p className="text-sm text-muted-foreground">
        Queda en el kardex con tu nombre. Lo demás de la ficha ya se guarda; esto, al elegir el
        motivo.
      </p>
      <RadioChips
        aria-labelledby="motivo-stock"
        value={choice}
        options={options.map((o) => ({ value: o, label: o }))}
        onChange={(o) => {
          setChoice(o)
          if (o !== "Otro") send(o, "")
        }}
      />
      {choice === "Otro" ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            send("Otro", other)
          }}
        >
          <Input
            autoFocus
            value={other}
            maxLength={300}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Cuéntalo en pocas palabras"
            aria-label="Otro motivo"
            className="h-9 max-w-xs flex-1"
          />
          <Button size="sm" type="submit" disabled={other.trim().length < 3}>
            Guardar con este motivo
          </Button>
        </form>
      ) : null}
    </section>
  )
}

/** Variantes: las opciones arriba y la cuadrícula abajo. */
export function VariantsCard() {
  const ficha = useFichaContext()
  const { draft, base, edit, change, rubro, store, sheet, errors, status } = ficha
  const isMobile = useIsMobile()
  const [measure, setMeasure] = useState<Measure>("stock")
  const [fresh, setFresh] = useState<string | null>(null)
  const grid = draft.grid

  if (!grid)
    return (
      <Section id="variantes" title="Variantes" summary={`${sheet.variants.length} variantes`}>
        <ColorProposals />
        <PageNotice tone="aviso" label="Sin cuadrícula">
          La cuadrícula es de colores y tallas, y las opciones de este producto son otras. Sus
          variantes se ven aquí y su stock se cambia en el kardex.
        </PageNotice>
        <ul className="flex flex-col divide-y rounded-xl border text-sm">
          {sheet.variants.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <span>{variantName(v)}</span>
              <span className="tabular-nums">{v.stock}</span>
            </li>
          ))}
        </ul>
      </Section>
    )

  const rowLabel = grid.rowName ?? rubro?.rowLabel ?? "Color"
  const columnLabel = grid.columnName ?? rubro?.columnLabel ?? "Talla"
  const colorItems: HojaAxisItem[] = grid.rows.map((r) => ({
    id: r.id,
    label: grid.rowName === null ? "Stock" : r.value,
    ...(grid.rowName === null ? {} : { hex: r.hex, hex2: r.hex2 }),
  }))
  const sizeItems: HojaAxisItem[] = grid.columns.map((c) => ({
    id: c.id,
    label: grid.columnName === null ? (grid.rowName === null ? "Única" : "Stock") : c.value,
  }))
  // En la computadora, tallas en filas y colores en columnas (como el prototipo); en el celular,
  // los colores quedan fijos a la izquierda y las tallas se deslizan.
  const transpose = !isMobile
  const cellOf = (g: Grid | null, a: string, b: string) =>
    g?.cells[transpose ? cellKey(b, a) : cellKey(a, b)]
  const total = grid.rows.length * grid.columns.length
  const readStock = (text: string) => {
    const clean = text.trim()
    if (!clean) return "0"
    // Solo cifras: «1.000» o «2,5» no se adivinan.
    return /^\d{1,6}$/.test(clean) && Number(clean) <= 100_000 ? String(Number(clean)) : undefined
  }
  const readPrice = (text: string) => {
    if (!text.trim()) return null
    const cents = readMoney(text, store.currency)
    return cents && cents > 0 ? String(cents) : undefined
  }
  const readBarcode = (text: string) => {
    const digits = text.replace(/[\s-]/g, "")
    if (!digits) return null
    return /^(\d{8}|\d{12,14})$/.test(digits) ? digits : undefined
  }
  const read = { stock: readStock, precio: readPrice, codigo: readBarcode }[measure]
  const show = (cell: Grid["cells"][string] | undefined): string | null => {
    if (!cell) return null
    if (measure === "stock") return String(cell.stock)
    if (measure === "precio")
      return cell.priceCents === null ? null : moneyInput(cell.priceCents, store.currency)
    return cell.barcode
  }
  const label = { stock: "Stock", precio: "Precio", codigo: "Código de barras" }[measure]
  const gridErrors = Object.entries(errors).filter(([k]) =>
    /^(grid|rows|columns|cells|reason)/.test(k),
  )

  return (
    <Section
      id="variantes"
      title="Variantes"
      summary={[
        grid.rowName === null ? null : grid.rows.map((r) => r.value).join(", "),
        grid.columnName === null ? null : valuesText(grid.columns.map((c) => c.value)),
      ]
        .filter(Boolean)
        .join(" · ")}
      contains={["stock"]}
    >
      <ColorProposals />
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3">
        <span className="text-sm text-muted-foreground">{rowLabel}</span>
        <div className="flex flex-wrap items-center gap-2">
          {grid.rowName === null
            ? null
            : grid.rows.map((r) => <ColorChip key={r.id} row={r} startOpen={r.id === fresh} />)}
          {edit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-9 rounded-full"
              onClick={() => {
                const id = newId("r")
                setFresh(id)
                change(`Agregaste un ${rowLabel.toLowerCase()}`, (d) => {
                  const g = d.grid!
                  const value = freeName(
                    `${rowLabel} nuevo`,
                    g.rows.map((r) => r.value),
                  )
                  if (g.rowName === null) {
                    // El primer color: lo que había sin color pasa a ser de él.
                    for (const column of g.columns) {
                      g.cells[cellKey(id, column.id)] = g.cells[cellKey(NO_AXIS, column.id)] ?? {
                        stock: 0,
                        priceCents: null,
                        barcode: null,
                      }
                      delete g.cells[cellKey(NO_AXIS, column.id)]
                    }
                    g.rowName = rowLabel
                    g.rows = [{ id, value, hex: null, hex2: null, photoId: null }]
                    return
                  }
                  g.rows.push({ id, value, hex: null, hex2: null, photoId: null })
                  for (const column of g.columns) g.cells[cellKey(id, column.id)] = emptyCell()
                })
              }}
            >
              <Plus aria-hidden />
              {rowLabel}
            </Button>
          ) : grid.rowName === null ? (
            <span className="text-sm text-muted-foreground">Sin {rowLabel.toLowerCase()}</span>
          ) : null}
        </div>
        <span className="text-sm text-muted-foreground">{columnLabel}</span>
        <div>
          <SizesChip grid={grid} />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
        <Tabs value={measure} onValueChange={(v) => setMeasure(v as Measure)}>
          <TabsList className="h-9 bg-muted">
            <TabsTrigger value="stock">Stock</TabsTrigger>
            <TabsTrigger value="precio">Precio</TabsTrigger>
            <TabsTrigger value="codigo">Código de barras</TabsTrigger>
          </TabsList>
        </Tabs>
        <span className="text-sm text-muted-foreground">
          {total} {total === 1 ? "variante" : "variantes"}
          {measure === "precio" ? ` · vacío = ${money(draft.listPriceCents, store.currency)}` : ""}
        </span>
      </div>
      <div id="stock" className="scroll-mt-24 rounded-xl">
        <Hoja
          key={measure}
          label={label}
          rows={transpose ? sizeItems : colorItems}
          columns={transpose ? colorItems : sizeItems}
          rowLabel={transpose ? columnLabel : rowLabel}
          columnLabel={transpose ? rowLabel : columnLabel}
          get={(a, b) => show(cellOf(grid, a, b))}
          saved={(a, b) => show(cellOf(base.grid, a, b))}
          parse={read}
          placeholder={
            measure === "precio" ? moneyInput(draft.listPriceCents, store.currency) : undefined
          }
          totals={measure === "stock"}
          edit={edit}
          inputMode={measure === "precio" ? "decimal" : "numeric"}
          stickyFirst
          set={(cells, text) =>
            change(text, (d) => {
              for (const { row, column, value } of cells) {
                const key = transpose ? cellKey(column, row) : cellKey(row, column)
                const cell = d.grid!.cells[key] ?? emptyCell()
                if (measure === "stock") cell.stock = Number(value ?? 0)
                else if (measure === "precio") {
                  const cents = value === null ? null : Number(value)
                  cell.priceCents = cents === d.listPriceCents ? null : cents
                } else cell.barcode = value
                d.grid!.cells[key] = cell
              }
            })
          }
        />
      </div>
      {status.kind === "reason" && edit ? <StockReason cells={status.cells} /> : null}
      {gridErrors.length ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-destructive">
          {gridErrors.slice(0, 3).map(([key, message]) => (
            <p key={key}>{message}</p>
          ))}
        </div>
      ) : null}
    </Section>
  )
}
