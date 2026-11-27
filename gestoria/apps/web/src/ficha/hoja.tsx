import { Button, cn, Input, useIsMobile } from "@odentia/ui"
import { Eraser } from "lucide-react"
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react"
import { Swatch } from "./piezas"

/**
 * La cuadrícula de variantes, como una hoja de cálculo (lienzo «La ficha del producto», tablero 8;
 * prototipo `ficha/hoja.tsx`): flechas y Tab para moverse, Mayúscula + flechas (o arrastrar) para
 * elegir un rango, escribir un número para llenar todo el rango, pegar desde Excel o Google
 * Sheets (texto con tabulaciones) y Ctrl+C para copiar. Lo cambiado queda marcado hasta que se
 * guarda. Es propia de gestorIA: pasa a lo común solo si otra app la pide.
 */

export interface HojaAxisItem {
  id: string
  label: string
  hex?: string | null
  hex2?: string | null
}

export interface HojaProps {
  /** Lo que se llena: «Stock», «Precio» o «Código de barras». */
  label: string
  rows: HojaAxisItem[]
  columns: HojaAxisItem[]
  /** El nombre de las filas, arriba a la izquierda («Talla»). */
  rowLabel: string
  /** El nombre de las columnas, para leerlo («color»). */
  columnLabel: string
  get: (row: string, column: string) => string | null
  saved: (row: string, column: string) => string | null
  /** Lee lo escrito: `undefined` si no vale (no se pone). Vacío es `null`. */
  parse: (text: string) => string | null | undefined
  set: (cells: { row: string; column: string; value: string | null }[], label: string) => void
  /** Lo que se ve en una celda vacía (el precio del producto). */
  placeholder?: string
  /** Suma filas y columnas (el stock). */
  totals?: boolean
  edit: boolean
  inputMode?: "numeric" | "decimal"
  /** La columna de las filas queda fija al deslizar de lado (en el celular, los colores). */
  stickyFirst?: boolean
}

type Pos = { r: number; c: number }

export function Hoja(props: HojaProps) {
  const { rows, columns, get, saved, edit } = props
  const id = useId()
  const grid = useRef<HTMLTableElement>(null)
  const [anchor, setAnchor] = useState<Pos>({ r: 0, c: 0 })
  const [focus, setFocus] = useState<Pos>({ r: 0, c: 0 })
  const [editing, setEditing] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [active, setActive] = useState(false)
  const [bulk, setBulk] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const touch = useIsMobile()

  useEffect(() => {
    const up = () => setDragging(false)
    window.addEventListener("pointerup", up)
    return () => window.removeEventListener("pointerup", up)
  }, [])
  // Si se quitan filas o columnas, el foco queda dentro.
  useEffect(() => {
    const clamp = (p: Pos) => ({
      r: Math.min(p.r, Math.max(0, rows.length - 1)),
      c: Math.min(p.c, Math.max(0, columns.length - 1)),
    })
    setFocus(clamp)
    setAnchor(clamp)
  }, [rows.length, columns.length])

  const r0 = Math.min(anchor.r, focus.r)
  const r1 = Math.max(anchor.r, focus.r)
  const c0 = Math.min(anchor.c, focus.c)
  const c1 = Math.max(anchor.c, focus.c)
  const inSel = (r: number, c: number) => r >= r0 && r <= r1 && c >= c0 && c <= c1
  const selection = () => {
    const out: { row: string; column: string }[] = []
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) out.push({ row: rows[r]!.id, column: columns[c]!.id })
    return out
  }
  const count = (r1 - r0 + 1) * (c1 - c0 + 1)
  const cellId = (r: number, c: number) => `${id}-${r}-${c}`
  const nameOf = (r: number, c: number) =>
    [rows[r]?.label, columns[c]?.label].filter(Boolean).join(" ") || "la variante"

  function glow(cells: { row: string; column: string }[]) {
    setFlash(new Set(cells.map((x) => `${x.row}|${x.column}`)))
    setTimeout(() => setFlash(new Set()), 720)
  }

  function apply(text: string, cells = selection()) {
    const value = props.parse(text)
    if (value === undefined) {
      setProblem(`«${text.trim()}» no vale aquí.`)
      return
    }
    setProblem(null)
    props.set(
      cells.map((cell) => ({ ...cell, value })),
      cells.length === 1
        ? `${props.label}: ${nameOf(focus.r, focus.c)}`
        : `${props.label} de ${cells.length} variantes`,
    )
    glow(cells)
  }

  function moveTo(r: number, c: number, extend = false) {
    const nr = Math.max(0, Math.min(rows.length - 1, r))
    const nc = Math.max(0, Math.min(columns.length - 1, c))
    setFocus({ r: nr, c: nc })
    if (!extend) setAnchor({ r: nr, c: nc })
    document.getElementById(cellId(nr, nc))?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }

  function selectAll() {
    setAnchor({ r: 0, c: 0 })
    setFocus({ r: rows.length - 1, c: columns.length - 1 })
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
    const arrow = arrows[k]
    if (arrow) {
      e.preventDefault()
      const [dr, dc] = arrow
      if (mod)
        moveTo(
          dr ? (dr < 0 ? 0 : rows.length - 1) : focus.r,
          dc ? (dc < 0 ? 0 : columns.length - 1) : focus.c,
          e.shiftKey,
        )
      else moveTo(focus.r + dr, focus.c + dc, e.shiftKey)
      return
    }
    if (k === "Tab") {
      const last = focus.r === rows.length - 1 && focus.c === columns.length - 1
      const first = focus.r === 0 && focus.c === 0
      // En la primera o la última celda, Tab sale de la cuadrícula.
      if ((!e.shiftKey && last) || (e.shiftKey && first)) return
      e.preventDefault()
      if (e.shiftKey)
        focus.c > 0 ? moveTo(focus.r, focus.c - 1) : moveTo(focus.r - 1, columns.length - 1)
      else focus.c < columns.length - 1 ? moveTo(focus.r, focus.c + 1) : moveTo(focus.r + 1, 0)
      return
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault()
      selectAll()
      return
    }
    if (mod) return
    if (k === "Enter" || k === "F2") {
      e.preventDefault()
      startEdit(get(rows[focus.r]!.id, columns[focus.c]!.id) ?? "")
      return
    }
    if (k === "Escape") {
      if (r0 !== r1 || c0 !== c1) {
        e.preventDefault()
        setAnchor(focus)
      }
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

  function startEdit(initial: string) {
    if (!edit) return
    setEditing(initial)
  }

  function onCopy(e: ClipboardEvent) {
    if (editing != null) return
    e.preventDefault()
    const lines: string[] = []
    for (let r = r0; r <= r1; r++) {
      const values: string[] = []
      for (let c = c0; c <= c1; c++) values.push(get(rows[r]!.id, columns[c]!.id) ?? "")
      lines.push(values.join("\t"))
    }
    e.clipboardData.setData("text/plain", lines.join("\n"))
  }

  function onPaste(e: ClipboardEvent) {
    if (editing != null || !edit) return
    e.preventDefault()
    const text = e.clipboardData.getData("text/plain").replace(/\r/g, "").replace(/\n$/, "")
    const table = text.split("\n").map((line) => line.split("\t"))
    // Un solo valor pegado sobre un rango llena todo el rango.
    if (table.length === 1 && table[0]!.length === 1) {
      apply(table[0]![0]!)
      return
    }
    const cells: { row: string; column: string; value: string | null }[] = []
    let skipped = 0
    table.forEach((line, dr) => {
      line.forEach((raw, dc) => {
        const r = r0 + dr
        const c = c0 + dc
        if (r >= rows.length || c >= columns.length) {
          skipped++
          return
        }
        const value = props.parse(raw)
        if (value === undefined) {
          skipped++
          return
        }
        cells.push({ row: rows[r]!.id, column: columns[c]!.id, value })
      })
    })
    setProblem(
      skipped
        ? `${skipped} ${skipped === 1 ? "valor no se pegó" : "valores no se pegaron"}: no valían o no cabían.`
        : null,
    )
    if (!cells.length) return
    props.set(cells, `Pegaste ${cells.length} valores de ${props.label.toLowerCase()}`)
    glow(cells)
    setAnchor({ r: r0, c: c0 })
    setFocus({
      r: Math.min(rows.length - 1, r0 + table.length - 1),
      c: Math.min(columns.length - 1, c0 + (table[0]?.length ?? 1) - 1),
    })
  }

  const num = (v: string | null) => (v ? Number(v) || 0 : 0)
  const totalColumn = (c: string) => rows.reduce((n, r) => n + num(get(r.id, c)), 0)
  const totalRow = (r: string) => columns.reduce((n, c) => n + num(get(r, c.id)), 0)
  const changed = rows.reduce(
    (n, r) => n + columns.filter((c) => get(r.id, c.id) !== saved(r.id, c.id)).length,
    0,
  )
  const axisLabel = (item: HojaAxisItem) => (
    <>
      {item.hex !== undefined ? <Swatch hex={item.hex ?? null} hex2={item.hex2} /> : null}
      {item.label}
    </>
  )

  return (
    // Lo elegido se ve mientras el foco está en la cuadrícula o en su barra («Poner»).
    // biome-ignore lint/a11y/noStaticElementInteractions: solo escucha el foco de lo de adentro
    <div
      className="flex min-w-0 flex-col gap-3"
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setActive(false)
      }}
    >
      <div className="overflow-x-auto rounded-xl border">
        <table
          ref={grid}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: la tabla es la cuadrícula de WAI-ARIA (APG «Data Grid»), con sus celdas como gridcell
          role="grid"
          tabIndex={0}
          aria-label={`${props.label} por ${props.rowLabel.toLowerCase()} y ${props.columnLabel.toLowerCase()}`}
          aria-activedescendant={cellId(focus.r, focus.c)}
          aria-multiselectable="true"
          aria-readonly={!edit || undefined}
          onKeyDown={onKeyDown}
          onCopy={onCopy}
          onPaste={onPaste}
          className="hoja w-full border-collapse text-sm tabular-nums outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset"
        >
          <thead>
            <tr className="bg-surface-muted">
              <th
                scope="col"
                className={cn(
                  "h-11 min-w-20 border-b bg-surface-muted px-3 text-left text-xs font-semibold text-muted-foreground",
                  props.stickyFirst && "sticky left-0 z-[1]",
                )}
              >
                <button
                  type="button"
                  tabIndex={-1}
                  className="hover:text-foreground"
                  onClick={() => {
                    selectAll()
                    grid.current?.focus()
                  }}
                >
                  {props.rowLabel}
                </button>
              </th>
              {columns.map((column, ci) => (
                <th
                  key={column.id}
                  scope="col"
                  className={cn(
                    "h-11 border-b border-l text-right font-medium",
                    touch ? "min-w-14 px-2.5" : "min-w-24 px-3",
                  )}
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
                    {axisLabel(column)}
                  </button>
                </th>
              ))}
              {props.totals && columns.length > 1 ? (
                <th className="h-11 w-20 border-b border-l px-3 text-right text-xs font-semibold text-muted-foreground">
                  Total
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={row.id} className="group/row">
                <th
                  scope="row"
                  className={cn(
                    "h-11 border-b bg-card px-3 text-left font-medium whitespace-nowrap group-last/row:border-b-0",
                    props.stickyFirst && "sticky left-0 z-[1]",
                  )}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    className="inline-flex items-center gap-1.5 rounded-md hover:text-primary"
                    onClick={() => {
                      setAnchor({ r: ri, c: 0 })
                      setFocus({ r: ri, c: columns.length - 1 })
                      grid.current?.focus()
                    }}
                  >
                    {axisLabel(row)}
                  </button>
                </th>
                {columns.map((column, ci) => {
                  const value = get(row.id, column.id)
                  const was = saved(row.id, column.id)
                  const isFocus = active && focus.r === ri && focus.c === ci
                  const selected = active && inSel(ri, ci) && count > 1
                  const differs = value !== was
                  return (
                    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: dentro de role=grid, un td es gridcell
                    <td
                      key={column.id}
                      id={cellId(ri, ci)}
                      aria-selected={selected || isFocus}
                      aria-label={`${nameOf(ri, ci)}: ${value ?? props.placeholder ?? "vacío"}${differs ? ", sin guardar" : ""}`}
                      data-cambio={differs ? "1" : undefined}
                      title={differs ? `Antes: ${was ?? props.placeholder ?? "vacío"}` : undefined}
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
                          startEdit(value ?? "")
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
                      onDoubleClick={() => startEdit(value ?? "")}
                      className={cn(
                        "relative h-11 border-b border-l text-right transition-colors group-last/row:border-b-0",
                        touch ? "px-2.5" : "px-3",
                        flash.has(`${row.id}|${column.id}`) && "celda-llena",
                        edit ? "cursor-cell" : "cursor-default",
                      )}
                    >
                      {isFocus && editing != null ? (
                        <input
                          // biome-ignore lint/a11y/noAutofocus: la celda se edita donde se escribió
                          autoFocus
                          inputMode={props.inputMode ?? "numeric"}
                          aria-label={`${props.label} de ${nameOf(ri, ci)}`}
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
                            value == null && "text-muted-foreground/70",
                            value === "0" && props.totals && "text-warning",
                          )}
                        >
                          {value ?? props.placeholder}
                        </span>
                      )}
                      {differs ? (
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
                {props.totals && columns.length > 1 ? (
                  <td className="h-11 border-b border-l bg-surface-muted/50 px-3 text-right text-muted-foreground group-last/row:border-b-0">
                    {totalRow(row.id)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
          {props.totals && rows.length > 1 ? (
            <tfoot>
              <tr className="bg-surface-muted">
                <th
                  scope="row"
                  className={cn(
                    "h-10 border-t bg-surface-muted px-3 text-left text-xs font-semibold text-muted-foreground",
                    props.stickyFirst && "sticky left-0",
                  )}
                >
                  Total
                </th>
                {columns.map((column) => (
                  <td
                    key={column.id}
                    className="h-10 border-t border-l px-3 text-right font-semibold"
                  >
                    {totalColumn(column.id)}
                  </td>
                ))}
                {columns.length > 1 ? (
                  <td className="h-10 border-t border-l px-3 text-right font-semibold">
                    {columns.reduce((n, c) => n + totalColumn(c.id), 0)}
                  </td>
                ) : null}
              </tr>
            </tfoot>
          ) : null}
        </table>
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
              inputMode={props.inputMode ?? "numeric"}
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
                ? `Toca una celda para cambiarla, o un nombre para elegir toda la fila o la columna.${columns.length > 4 ? " Desliza para ver las demás." : ""}`
                : "Arrastra o usa Mayúscula y las flechas para elegir varias, escribe un número y Enter. También pegas desde Excel."}
          </span>
        )}
        {problem ? (
          <span role="alert" className="text-destructive">
            {problem}
          </span>
        ) : null}
        {changed ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-muted-foreground">
            <span className="size-1.5 rounded-full bg-primary" aria-hidden />
            {changed} {changed === 1 ? "celda sin guardar" : "celdas sin guardar"}
          </span>
        ) : null}
      </div>
    </div>
  )
}
