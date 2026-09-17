import type { Column, RowData, Table as TanStackTable } from "@tanstack/react-table"
import * as React from "react"

/**
 * Vista de una `DataTable`. Se elige por código (prop `view`); `table` es la
 * default. El único cambio automático es el responsive: por debajo del
 * breakpoint móvil (`md`, 768px) siempre se renderiza `list`, aunque la página
 * haya pedido `table` o `card`.
 */
export type DataTableView = "table" | "list" | "card"

/** Papel de una columna dentro de la vista. */
export type ColumnViewRole = "title" | "media" | "actions" | "select" | "field"

export interface ColumnViewMeta {
  /** Default `field`; `actions` se deduce de `id: "actions"` (convención del repo). */
  role?: ColumnViewRole
  /** Entra en la línea de resumen de la vista lista. Sin ninguna, las 2 siguientes al título. */
  primary?: boolean
  /** Etiqueta en card cuando `header` no es un string. */
  label?: string
  /** Solo se muestra en la vista tabla (columnas técnicas o demasiado densas). */
  tableOnly?: boolean
}

declare module "@tanstack/react-table" {
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Papel de la columna en las vistas `list` y `card` de `DataTable`. */
    view?: ColumnViewMeta
  }
}

export interface ViewColumns<TData> {
  /** Columna de selección masiva (checkbox). Única del repo: catálogo de prestaciones. */
  select: Column<TData, unknown> | null
  /** Media de la fila (avatar, iconos de canal). */
  media: Column<TData, unknown> | null
  /** Identificador del registro: título de la fila en lista y de la card. */
  title: Column<TData, unknown> | null
  /** Campos de la línea de resumen en lista. */
  summary: Column<TData, unknown>[]
  actions: Column<TData, unknown> | null
  /** Todo lo visible salvo título, media, acciones y selección: pares etiqueta/valor de la card. */
  cardFields: Column<TData, unknown>[]
}

function viewMeta<TData>(column: Column<TData, unknown>): ColumnViewMeta | undefined {
  return column.columnDef.meta?.view
}

function roleOf<TData>(column: Column<TData, unknown>): ColumnViewRole {
  const role = viewMeta(column)?.role
  if (role) return role
  return column.id === "actions" ? "actions" : "field"
}

/**
 * Reparte las columnas visibles entre los huecos de las vistas lista y card.
 * Pura y determinista: las tres vistas renderizan las MISMAS celdas
 * (`ColumnDef.cell`), solo cambia dónde se montan.
 */
export function resolveViewColumns<TData>(table: TanStackTable<TData>): ViewColumns<TData> {
  const visible = table.getVisibleLeafColumns()
  const byRole = (role: ColumnViewRole) => visible.find((column) => roleOf(column) === role) ?? null

  const select = byRole("select")
  const media = byRole("media")
  const actions = byRole("actions")
  const fields = visible.filter(
    (column) =>
      column !== select &&
      column !== media &&
      column !== actions &&
      viewMeta(column)?.tableOnly !== true,
  )
  const title = fields.find((column) => viewMeta(column)?.role === "title") ?? fields[0] ?? null
  const rest = fields.filter((column) => column !== title)
  const primary = rest.filter((column) => viewMeta(column)?.primary === true)

  return {
    select,
    media,
    title,
    actions,
    summary: primary.length > 0 ? primary : rest.slice(0, 2),
    cardFields: rest,
  }
}

/** Etiqueta del par label/valor en card: el `header` textual o el `label` del meta. */
export function columnLabel<TData>(column: Column<TData, unknown>): string | null {
  const header = column.columnDef.header
  if (typeof header === "string" && header.trim() !== "") return header
  return viewMeta(column)?.label ?? null
}

const INTERACTIVE_SELECTOR = "button, a, input, select, textarea, [role='menuitem']"

/**
 * Un click sobre un control interno (RowActions, Link, Checkbox) no debe abrir
 * el registro: mismo criterio que ya aplicaba la vista tabla.
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(INTERACTIVE_SELECTOR) !== null
}

// Mismo corte que `useIsMobile` de @odentia/ui (768) y que el `md:` de FilterBar.
// Se declara aquí para no acoplar el paquete a un hook instalado por `shadcn add`.
const MOBILE_QUERY = "(max-width: 767px)"

// Corrige la vista antes del primer paint (sin flash table→list en móvil); en el
// servidor cae a `useEffect` para no emitir el aviso de `useLayoutEffect` en SSR.
const useEffectBeforePaint: typeof React.useEffect =
  typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

/**
 * Vista efectiva: `list` en pantallas pequeñas, la pedida por código en el resto.
 *
 * El estado inicial es `false` (escritorio) a propósito: coincide con el HTML
 * que sirve el servidor, así la hidratación no desajusta, y el efecto de layout
 * resuelve el ancho real antes de pintar. Sin JS, el móvil se queda con la
 * tabla y su scroll horizontal (comportamiento previo, no una regresión).
 */
export function useResolvedView(view: DataTableView): DataTableView {
  const [isMobile, setIsMobile] = React.useState(false)

  useEffectBeforePaint(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia(MOBILE_QUERY)
    const apply = () => setIsMobile(query.matches)
    apply()
    query.addEventListener("change", apply)
    return () => query.removeEventListener("change", apply)
  }, [])

  return isMobile ? "list" : view
}
