import { Button, cn, Input, useIsMobile } from "@odentia/ui"
import { Eraser } from "lucide-react"
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react"
import type { Color } from "../datos"
import { readNum } from "../precio"
import { Swatch } from "./piezas"

/**
 * La hoja de variantes: tallas por colores, como una hoja de cálculo. Flechas y Tab para moverse,
 * arrastrar (o Mayús + flechas) para elegir un rango, escribir un número para todo el rango, pegar
 * desde Excel y Ctrl+C para copiar. Lo cambiado queda marcado hasta guardar.
 */

export interface HojaProps {
  label: string
  rows: string[]
  cols: Color[]
  rowLabel: string
  get: (r: string, c: string) => number | null
  saved: (r: string, c: string) => number | null
  /** Lo que se ve en una celda vacía (el precio del producto). */
  placeholder?: string
  set: (cells: { r: string; c: string }[], value: number | null, label: string) => void
  setMany: (cells: { r: string; c: string; v: number | null }[], label: string) => void
  format?: (v: number) => string
  totals?: boolean
  edit: boolean
  /** Lo que vale «vaciar»: 0 en el stock, el precio del producto en el precio. */
  emptyValue: number | null
  unit?: string
}

type Pos = { r: number; c: number }

export function Hoja(props: HojaProps) {
  const { rows, cols, get, saved, edit } = props
  const id = useId()
  const grid = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 })
  const [focus, setFocus] = useState<Pos>({ r: 0, c: 0 })
  const [editing, setEditing] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [active, setActive] = useState(false)
  const [bulk, setBulk] = useState("")
  const touch = useIsMobile()

  useEffect(() => {
    const up = () => setDragging(false)
    window.addEventListener("pointerup", up)
    return () => window.removeEventListener("pointerup", up)
  }, [])

  const r0 = Math.min(anchor.r, focus.r)
  const r1 = Math.max(anchor.r, focus.r)
  const c0 = Math.min(anchor.c, focus.c)
  const c1 = Math.max(anchor.c, focus.c)
  const inSel = (r: number, c: number) => r >= r0 && r <= r1 && c >= c0 && c <= c1
  const selCells = () => {
    const out: { r: string; c: string }[] = []
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) out.push({ r: rows[r]!, c: cols[c]!.id })
    return out
  }
  const count = (r1 - r0 + 1) * (c1 - c0 + 1)
  const cellId = (r: number, c: number) => `${id}-${r}-${c}`
  const fmt = (v: number | null) => (v == null ? "" : props.format ? props.format(v) : String(v))

  function glow(cells: { r: string; c: string }[]) {
    setFlash(new Set(cells.map((x) => `${x.r}|${x.c}`)))
    setTimeout(() => setFlash(new Set()), 720)
  }

  function apply(text: string, cells = selCells()) {
    const v = text.trim() === "" ? props.emptyValue : readNum(text)
    if (text.trim() !== "" && v == null) return
    props.set(
      cells,
      v,
      cells.length === 1
        ? `${props.label}: ${rows[focus.r]} ${cols[focus.c]?.name}`
        : `${props.label} de ${cells.length} variantes`,
    )
    glow(cells)
  }

  function moveTo(r: number, c: number, extend = false) {
    const nr = Math.max(0, Math.min(rows.length - 1, r))
    const nc = Math.max(0, Math.min(cols.length - 1, c))
    setFocus({ r: nr, c: nc })
    if (!extend) setAnchor({ r: nr, c: nc })
    document.getElementById(cellId(nr, nc))?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  function startEdit(initial: string) {
    if (!edit) return
    setEditing(initial)
  }
  function commit(text: string, then?: "down" | "right" | "left" | "up") {
    apply(text)
    setEditing(null)
    grid.current?.focus({ preventScroll: true })
    if (then === "down") moveTo(r1 + 1 > rows.length - 1 ? r0 : r1 + 1, c0)
    if (then === "right") moveTo(focus.r, focus.c + 1)
    if (then === "left") moveTo(focus.r, focus.c - 1)
    if (then === "up") moveTo(focus.r - 1, focus.c)
  }

  function onKeyDown(e: KeyboardEvent) {
    if (editing != null) return
    const k = e.key
    const mod = e.ctrlKey || e.metaKey
    const arrows: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    }
    if (arrows[k]) {
      e.preventDefault()
      const [dr, dc] = arrows[k]!
      if (mod)
        moveTo(
          dr ? (dr < 0 ? 0 : rows.length - 1) : focus.r,
          dc ? (dc < 0 ? 0 : cols.length - 1) : focus.c,
          e.shiftKey,
        )
      else moveTo(focus.r + dr, focus.c + dc, e.shiftKey)
      return
    }
    if (k === "Tab") {
      const last = focus.r === rows.length - 1 && focus.c === cols.length - 1
      const first = focus.r === 0 && focus.c === 0
      if ((!e.shiftKey && last) || (e.shiftKey && first)) return
      e.preventDefault()
      if (e.shiftKey)
        focus.c > 0 ? moveTo(focus.r, focus.c - 1) : moveTo(focus.r - 1, cols.length - 1)
      else focus.c < cols.length - 1 ? moveTo(focus.r, focus.c + 1) : moveTo(focus.r + 1, 0)
      return
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault()
      setAnchor({ r: 0, c: 0 })
      setFocus({ r: rows.length - 1, c: cols.length - 1 })
      return
    }
    if (mod) return
    if (k === "Enter" || k === "F2") {
      e.preventDefault()
      startEdit(fmt(get(rows[focus.r]!, cols[focus.c]!.id)))
      return
    }
    if (k === "Escape") {
      setAnchor(focus)
      return
    }
    if ((k === "Delete" || k === "Backspace") && edit) {
      e.preventDefault()
      apply("")
      return
    }
    if (/^[0-9.,]$/.test(k) && edit) {
      e.preventDefault()
      startEdit(k)
    }
  }

  function onCopy(e: ClipboardEvent) {
    if (editing != null) return
    e.preventDefault()
    const lines: string[] = []
    for (let r = r0; r <= r1; r++) {
      const vals: string[] = []
      for (let c = c0; c <= c1; c++) vals.push(fmt(get(rows[r]!, cols[c]!.id)))
      lines.push(vals.join("\t"))
    }
    e.clipboardData.setData("text/plain", lines.join("\n"))
  }

  function onPaste(e: ClipboardEvent) {
    if (editing != null || !edit) return
    e.preventDefault()
    const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n$/, "")
    const table = text.split("\n").map((l) => l.split("\t"))
    // Un solo valor pegado sobre un rango llena todo el rango.
    if (table.length === 1 && table[0]!.length === 1) {
      apply(table[0]![0]!)
      return
    }
    const cells: { r: string; c: string; v: number | null }[] = []
    table.forEach((line, dr) =>
      line.forEach((raw, dc) => {
        const r = r0 + dr
        const c = c0 + dc
        if (r >= rows.length || c >= cols.length) return
        const v = raw.trim() === "" ? props.emptyValue : readNum(raw)
        if (v == null && raw.trim() !== "") return
        cells.push({ r: rows[r]!, c: cols[c]!.id, v })
      }),
    )
    if (!cells.length) return
    props.setMany(cells, `Pegaste ${cells.length} valores de ${props.label.toLowerCase()}`)
    glow(cells)
    setAnchor({ r: r0, c: c0 })
    setFocus({
      r: Math.min(rows.length - 1, r0 + table.length - 1),
      c: Math.min(cols.length - 1, c0 + (table[0]?.length ?? 1) - 1),
    })
  }

  const totalCol = (c: string) => rows.reduce((n, r) => n + (get(r, c) ?? 0), 0)
  const totalRow = (r: string) => cols.reduce((n, c) => n + (get(r, c.id) ?? 0), 0)
  const changed = rows.reduce(
    (n, r) => n + cols.filter((c) => (get(r, c.id) ?? null) !== (saved(r, c.id) ?? null)).length,
    0,
  )

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setActive(false)
      }}
    >
      <div className="overflow-x-auto rounded-xl border">
        <div
          ref={grid}
          role="grid"
          tabIndex={0}
          aria-label={`${props.label} por ${props.rowLabel.toLowerCase()} y color`}
          aria-activedescendant={cellId(focus.r, focus.c)}
          aria-multiselectable="true"
          aria-readonly={!edit || undefined}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
          className="hoja outline-none"
        >
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead>
              <tr className="bg-surface-muted">
                <th
                  scope="col"
                  className="sticky left-0 z-[1] h-11 w-20 border-b bg-surface-muted px-3 text-left text-xs font-semibold text-muted-foreground"
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="hover:text-foreground"
                    onClick={() => {
                      setAnchor({ r: 0, c: 0 })
                      setFocus({ r: rows.length - 1, c: cols.length - 1 })
                      grid.current?.focus()
                    }}
                  >
                    {props.rowLabel}
                  </button>
                </th>
                {cols.map((c, ci) => (
                  <th
                    key={c.id}
                    scope="col"
                    className="h-11 min-w-24 border-b border-l px-3 text-right font-medium"
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      className="inline-flex items-center gap-1.5 rounded-md hover:text-primary"
                      onClick={() => {
                        setAnchor({ r: 0, c: ci })
                        setFocus({ r: rows.length - 1, c: ci })
                        grid.current?.focus()
                      }}
                    >
                      <Swatch color={c} />
                      {c.name}
                    </button>
                  </th>
                ))}
                {props.totals && cols.length > 1 ? (
                  <th className="h-11 w-20 border-b border-l px-3 text-right text-xs font-semibold text-muted-foreground">
                    Total
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={r} className="group/row">
                  <th
                    scope="row"
                    className="sticky left-0 z-[1] h-11 border-b bg-card px-3 text-left font-medium group-last/row:border-b-0"
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      className="rounded-md hover:text-primary"
                      onClick={() => {
                        setAnchor({ r: ri, c: 0 })
                        setFocus({ r: ri, c: cols.length - 1 })
                        grid.current?.focus()
                      }}
                    >
                      {r}
                    </button>
                  </th>
                  {cols.map((c, ci) => {
                    const v = get(r, c.id)
                    const was = saved(r, c.id)
                    const isFocus = active && focus.r === ri && focus.c === ci
                    const sel = active && inSel(ri, ci) && count > 1
                    const k = `${r}|${c.id}`
                    return (
                      <td
                        key={c.id}
                        id={cellId(ri, ci)}
                        role="gridcell"
                        aria-selected={sel || isFocus}
                        data-cambio={(v ?? null) !== (was ?? null) ? "1" : undefined}
                        title={
                          (v ?? null) !== (was ?? null)
                            ? `Antes: ${was == null ? (props.placeholder ?? "vacío") : fmt(was)}`
                            : undefined
                        }
                        onPointerDown={(e) => {
                          if (e.button !== 0) return
                          if (editing != null) commit(editing)
                          if (e.shiftKey) setFocus({ r: ri, c: ci })
                          else {
                            setAnchor({ r: ri, c: ci })
                            setFocus({ r: ri, c: ci })
                          }
                          if (e.pointerType === "touch") {
                            setActive(true)
                            startEdit(fmt(v))
                            return
                          }
                          setDragging(true)
                          setActive(true)
                          e.preventDefault()
                          grid.current?.focus({ preventScroll: true })
                        }}
                        onPointerEnter={() => {
                          if (dragging) setFocus({ r: ri, c: ci })
                        }}
                        onDoubleClick={() => startEdit(fmt(v))}
                        className={cn(
                          "relative h-11 border-b border-l px-3 text-right transition-colors group-last/row:border-b-0",
                          flash.has(k) && "celda-llena",
                          edit ? "cursor-cell" : "cursor-default",
                        )}
                      >
                        {isFocus && editing != null ? (
                          <input
                            // biome-ignore lint/a11y/noAutofocus: la celda se edita donde se escribió
                            autoFocus
                            inputMode="decimal"
                            aria-label={`${props.label} de ${r} ${c.name}`}
                            className="absolute inset-0 z-[2] w-full bg-card px-3 text-right tabular-nums outline-none ring-2 ring-primary ring-inset"
                            value={editing}
                            onChange={(e) => setEditing(e.target.value)}
                            onFocus={(e) => {
                              if (e.target.value.length > 1) e.target.select()
                            }}
                            onBlur={() => editing != null && commit(editing)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                commit(editing, e.shiftKey ? "up" : "down")
                              } else if (e.key === "Tab") {
                                e.preventDefault()
                                commit(editing, e.shiftKey ? "left" : "right")
                              } else if (e.key === "Escape") {
                                e.preventDefault()
                                setEditing(null)
                                grid.current?.focus()
                              } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                                e.preventDefault()
                                commit(editing, e.key === "ArrowDown" ? "down" : "up")
                              }
                            }}
                          />
                        ) : (
                          <span
                            className={cn(
                              v == null && "text-muted-foreground/70",
                              v === 0 && props.totals && "text-warning",
                            )}
                          >
                            {v == null ? props.placeholder : fmt(v)}
                          </span>
                        )}
                        {(v ?? null) !== (was ?? null) ? (
                          <span
                            aria-hidden
                            className="absolute top-1.5 left-1.5 size-1.5 rounded-full bg-primary"
                          />
                        ) : null}
                        {isFocus && editing == null ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0 ring-2 ring-primary ring-inset"
                          />
                        ) : null}
                      </td>
                    )
                  })}
                  {props.totals && cols.length > 1 ? (
                    <td className="h-11 border-b border-l bg-surface-muted/50 px-3 text-right text-muted-foreground group-last/row:border-b-0">
                      {totalRow(r)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            {props.totals ? (
              <tfoot>
                <tr className="bg-surface-muted">
                  <th
                    scope="row"
                    className="sticky left-0 h-10 border-t bg-surface-muted px-3 text-left text-xs font-semibold text-muted-foreground"
                  >
                    Total
                  </th>
                  {cols.map((c) => (
                    <td key={c.id} className="h-10 border-t border-l px-3 text-right font-semibold">
                      {totalCol(c.id)}
                    </td>
                  ))}
                  {cols.length > 1 ? (
                    <td className="h-10 border-t border-l px-3 text-right font-semibold">
                      {cols.reduce((n, c) => n + totalCol(c.id), 0)}
                    </td>
                  ) : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </div>
      <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        {edit && count > 1 && active ? (
          <form
            className="entra flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (bulk.trim()) apply(bulk)
              setBulk("")
              grid.current?.focus()
            }}
          >
            <span className="font-medium">{count} variantes</span>
            <Input
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
              inputMode="decimal"
              placeholder="Un valor para todas"
              aria-label={`${props.label} para las ${count} variantes elegidas`}
              className="h-8 w-40"
            />
            <Button size="sm" type="submit">
              Poner
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => apply("")}>
              <Eraser aria-hidden />
              Vaciar
            </Button>
          </form>
        ) : (
          <span className="text-muted-foreground">
            {!edit
              ? "Solo lectura."
              : touch
                ? "Toca una celda para cambiarla, o una talla o un color para llenar toda la fila o la columna."
                : "Arrastra para elegir varias, escribe un número y Enter. También pegas desde Excel."}
          </span>
        )}
        {changed ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            {changed} {changed === 1 ? "celda cambiada" : "celdas cambiadas"}
          </span>
        ) : null}
      </div>
    </div>
  )
}
