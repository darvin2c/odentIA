/**
 * Barras horizontales de Reportes: una fila por paso o por categoría, con su
 * nombre, su valor escrito y la barra medida contra la mayor (o `max`). Sirve
 * para un embudo (las mismas personas, paso a paso) y para un reparto con
 * nombres largos (canales, respuestas), que en columnas no se leen.
 *
 * Como los demás gráficos de datos: cada barra es un control con nombre que
 * dice su valor; las flechas recorren las filas y pasar el mouse, tocar o
 * enfocar una la destaca. Con `onSelect`, Enter o un clic abren lo que hay
 * detrás (su lista) y la fila lo dice. «Ver como tabla» da los mismos datos
 * escritos. La parte (`part`) se pinta más oscura dentro de su barra; el
 * color nunca es la única señal: el valor y la nota van escritos.
 */
import { Button, cn, ScrollArea, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@odentia/ui"
import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react"

export interface BarListRow {
  key: string
  label: string
  /** Aclaración bajo el nombre: «= Evaluación agendada en Oportunidades». */
  hint?: string
  value: number
  /** Parte del valor que va más oscura dentro de su barra (los que vinieron, de los que buscaron). */
  part?: number
  /** El valor escrito, en negrita: «52», «23 de 52». */
  valueText: string
  /** Lo que sigue al valor, más tenue: «54 % · agosto 50 %». */
  note?: string
  /** La nota pide atención (donde más se caen): va en el tono de aviso, además de decirlo con palabras. */
  attention?: boolean
  /** Gris: lo que no es una categoría propia («Otro», «No lo dijeron»). */
  muted?: boolean
}

export interface BarListProps {
  /** Nombre del gráfico para quien no lo ve; el título visible lo pone la tarjeta. */
  title: string
  rows: BarListRow[]
  /** Contra qué se miden las barras; por defecto, la mayor. */
  max?: number
  /** Qué es la barra y qué su parte más oscura, para la leyenda: «Nos buscaron» y «Vinieron». */
  legend?: { value: string; part: string }
  /** Abrir lo que hay detrás de una fila. Sin él, las filas solo se destacan. */
  onSelect?: (index: number) => void
  /** Lo que dice una fila que abre algo: «Ver quiénes». */
  selectLabel?: string
  /** Lo que va entre una fila y la siguiente: cuántos se cayeron en ese paso. */
  between?: (index: number) => ReactNode
  /** Encabezados de la tabla: la fila, el valor y, si hay, la nota. */
  table: { label: string; value: string; note?: string }
  /** Alto de la barra: `md` en una pestaña, `sm` en una tarjeta. */
  size?: "md" | "sm"
  className?: string
}

const BAR = "var(--primary)"
/** La barra que tiene una parte se aclara hacia la tarjeta: la parte se lee encima. */
const BAR_BASE = "color-mix(in oklab, var(--primary) 32%, var(--card))"
const MUTED = "var(--series-muted)"

/** La fila que no está destacada se aclara: sigue leyéndose, pero cede el foco. */
function faded(color: string): string {
  return `color-mix(in oklab, ${color} 45%, var(--card))`
}

export function BarList({ title, rows, max, legend, onSelect, selectLabel, between, table, size = "md", className }: BarListProps) {
  const id = useId()
  const [asTable, setAsTable] = useState(false)
  // Ninguna destacada hasta que se pasa, se toca o se enfoca una; la primera es la que recibe el Tab.
  const [active, setActive] = useState<number | null>(null)
  const [focusable, setFocusable] = useState(0)
  const buttons = useRef<Array<HTMLButtonElement | null>>([])
  const top = Math.max(max ?? 0, ...rows.map((row) => row.value), 0)
  const width = (value: number): string => `${top > 0 ? Math.max(0, Math.min(100, (value / top) * 100)) : 0}%`
  const hasPart = rows.some((row) => row.part !== undefined)

  const describe = (row: BarListRow): string =>
    [`${row.label}: ${row.valueText}`, row.note, row.hint, onSelect && selectLabel ? selectLabel : null].filter(Boolean).join(". ")
  const choose = (index: number, focus = false): void => {
    setActive(index)
    setFocusable(index)
    if (focus) buttons.current[index]?.focus()
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    // Arriba y abajo recorren las filas; Inicio y Fin van a la primera y a la última.
    const target =
      event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null
    if (target === null) return
    event.preventDefault()
    const next = Math.max(0, Math.min(rows.length - 1, target))
    if (next !== index) choose(next, true)
  }
  const selectable = Boolean(onSelect && selectLabel)
  const columns =
    size === "sm"
      ? "py-1.5 sm:grid-cols-[minmax(6.5rem,10rem)_minmax(0,1fr)_minmax(5rem,auto)]"
      : selectable
        ? "py-2 sm:grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)_minmax(6.5rem,auto)_auto]"
        : "py-2 sm:grid-cols-[minmax(8rem,13rem)_minmax(0,1fr)_minmax(6.5rem,auto)]"

  return (
    <figure className={cn("flex min-w-0 flex-col gap-2", className)} aria-labelledby={`${id}-title`}>
      <figcaption id={`${id}-title`} className="sr-only">
        {title}
      </figcaption>
      {asTable ? (
        <ScrollArea horizontal className="min-w-0 [&_[data-slot=table-container]]:overflow-visible">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{table.label}</TableHead>
                <TableHead scope="col" className="text-right">
                  {table.value}
                </TableHead>
                {table.note ? (
                  <TableHead scope="col" className="text-right">
                    {table.note}
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.valueText}</TableCell>
                  {table.note ? <TableCell className="text-right tabular-nums">{row.note ?? "—"}</TableCell> : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>
      ) : (
        <ul className="flex min-w-0 flex-col" onMouseLeave={() => setActive(null)}>
          {rows.map((row, index) => {
            const dim = active !== null && active !== index
            const color = row.muted ? MUTED : BAR
            const base = row.part !== undefined ? (row.muted ? faded(MUTED) : BAR_BASE) : color
            return (
              <li key={row.key} className="flex min-w-0 flex-col">
                <button
                  ref={(element) => {
                    buttons.current[index] = element
                  }}
                  type="button"
                  tabIndex={index === focusable ? 0 : -1}
                  aria-label={describe(row)}
                  onMouseEnter={() => setActive(index)}
                  onFocus={() => choose(index)}
                  onBlur={() => setActive(null)}
                  onClick={() => {
                    choose(index)
                    onSelect?.(index)
                  }}
                  onKeyDown={(event) => onKeyDown(event, index)}
                  className={cn(
                    "group grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1.5 rounded-lg px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    columns,
                    onSelect && "cursor-pointer hover:bg-muted/60",
                  )}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("truncate font-semibold", row.muted && "text-muted-foreground")}>{row.label}</span>
                    {/* En el teléfono la fila va en dos líneas y la aclaración la alargaría: queda en el nombre de la barra. */}
                    {row.hint ? <span className="hidden text-xs text-muted-foreground sm:block">{row.hint}</span> : null}
                  </span>
                  <span aria-hidden className={cn("relative col-span-2 row-start-2 block sm:col-span-1 sm:row-start-1 sm:col-start-2", size === "md" ? "h-6" : "h-4")}>
                    <span
                      className="absolute inset-y-0 left-0 rounded-r-md transition-[background-color] duration-150 motion-reduce:transition-none"
                      style={{ width: width(row.value), minWidth: row.value > 0 ? 3 : 0, background: dim ? faded(base) : base }}
                    />
                    {row.part !== undefined ? (
                      <span
                        className="absolute inset-y-0 left-0 rounded-r-md transition-[background-color] duration-150 motion-reduce:transition-none"
                        style={{ width: width(row.part), minWidth: row.part > 0 ? 3 : 0, background: dim ? faded(color) : color }}
                      />
                    ) : null}
                  </span>
                  <span className="justify-self-end text-right tabular-nums sm:col-start-3">
                    <strong className={cn(size === "md" ? "text-lg leading-6" : "text-[15px]", "font-extrabold")}>{row.valueText}</strong>
                    {row.note ? (
                      <span className={cn("text-[13px]", row.attention ? "font-bold text-warning" : "text-muted-foreground")}> · {row.note}</span>
                    ) : null}
                  </span>
                  {selectable && size === "md" ? (
                    <span aria-hidden className="hidden text-[13px] font-bold text-primary-soft-foreground group-hover:underline sm:col-start-4 sm:inline">
                      {selectLabel}
                    </span>
                  ) : null}
                </button>
                {between?.(index)}
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-1">
        {!asTable && legend && hasPart ? (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground">
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-3 rounded-[3px]" style={{ background: BAR_BASE }} />
              {legend.value}
            </li>
            <li className="flex items-center gap-1.5">
              <span aria-hidden className="size-3 rounded-[3px]" style={{ background: BAR }} />
              {legend.part}
            </li>
          </ul>
        ) : (
          <span />
        )}
        <Button type="button" variant="link" className="h-auto min-h-11 p-0 sm:min-h-8" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
          {asTable ? "Ver como gráfico" : "Ver como tabla"}
        </Button>
      </div>
    </figure>
  )
}
