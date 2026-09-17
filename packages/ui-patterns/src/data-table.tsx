import {
  cn,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@odentia/ui"
import type { Cell, Column, Row, Table as TanStackTable } from "@tanstack/react-table"
import { flexRender } from "@tanstack/react-table"
import * as React from "react"
import { common } from "./common.js"
import {
  columnLabel,
  type DataTableView,
  isInteractiveTarget,
  resolveViewColumns,
  useResolvedView,
  type ViewColumns,
} from "./data-table-view.js"

export interface DataTableProps<TData> {
  table: TanStackTable<TData>
  onRowClick?: (row: TData) => void
  /**
   * Vista en pantallas de `md` (768px) o más. Por debajo de ese ancho siempre
   * se renderiza `list`, aunque aquí se pida `table` o `card`. Default `table`.
   */
  view?: DataTableView
  className?: string
}

export interface DataTableSkeletonProps {
  columnCount?: number
  rowCount?: number
  showPagination?: boolean
  label?: string
}

const skeletonWidths = ["w-40", "w-20", "w-24", "w-16", "w-8"] as const

function skeletonWidth(index: number): string {
  return skeletonWidths[index % skeletonWidths.length] ?? "w-20"
}

interface LayoutProps<TData> {
  table: TanStackTable<TData>
  onRowClick?: (row: TData) => void
  className?: string
}

/**
 * Tabla de datos con tres vistas que comparten celdas: el contenido sale
 * siempre de `ColumnDef.cell` (vía `flexRender`); lo único que cambia es el
 * layout. `list` y `card` reparten esas mismas celdas entre título, resumen,
 * campos y acciones según `meta.view` de cada columna.
 */
export function DataTable<TData>({
  table,
  onRowClick,
  view = "table",
  className,
}: DataTableProps<TData>) {
  const resolved = useResolvedView(view)

  if (resolved === "list") {
    return <ListLayout table={table} onRowClick={onRowClick} className={className} />
  }
  if (resolved === "card") {
    return <CardLayout table={table} onRowClick={onRowClick} className={className} />
  }
  return <TableLayout table={table} onRowClick={onRowClick} className={className} />
}

function TableLayout<TData>({ table, onRowClick, className }: LayoutProps<TData>) {
  return (
    <div className={cn("overflow-hidden rounded-md bg-card", className)}>
      <Table>
        <TableHeader className="bg-muted/65">
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className="h-12 px-3 text-sm">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow
              key={row.id}
              className={onRowClick ? "cursor-pointer" : undefined}
              onClick={(event) => {
                if (!onRowClick) return
                if (isInteractiveTarget(event.target)) return
                onRowClick(row.original)
              }}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ListLayout<TData>({ table, onRowClick, className }: LayoutProps<TData>) {
  const columns = resolveViewColumns(table)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SelectionBar table={table} columns={columns} />
      <div className="flex flex-col gap-2">
        {table.getRowModel().rows.map((row) => {
          const cells = cellsByColumn(row)
          return (
            <Item
              key={row.id}
              className={cn("rounded-md bg-card", onRowClick && "cursor-pointer")}
              onClick={rowClickHandler(row, onRowClick)}
            >
              {columns.select ? (
                <ItemMedia variant="icon">{renderCell(cells, columns.select)}</ItemMedia>
              ) : null}
              {columns.media ? (
                <ItemMedia variant="image">{renderCell(cells, columns.media)}</ItemMedia>
              ) : null}
              <ItemContent>
                <ItemTitle>{renderCell(cells, columns.title)}</ItemTitle>
                {columns.summary.length > 0 ? (
                  <ItemDescription>
                    <span className="flex flex-wrap items-center gap-x-1.5">
                      {columns.summary.map((column, index) => (
                        <React.Fragment key={column.id}>
                          {index > 0 ? (
                            <span aria-hidden="true" className="text-muted-foreground">
                              ·
                            </span>
                          ) : null}
                          <span className="inline-flex items-center gap-1">
                            {renderCell(cells, column)}
                          </span>
                        </React.Fragment>
                      ))}
                    </span>
                  </ItemDescription>
                ) : null}
              </ItemContent>
              {columns.actions ? (
                <ItemActions>{renderCell(cells, columns.actions)}</ItemActions>
              ) : null}
            </Item>
          )
        })}
      </div>
    </div>
  )
}

function CardLayout<TData>({ table, onRowClick, className }: LayoutProps<TData>) {
  const columns = resolveViewColumns(table)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SelectionBar table={table} columns={columns} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {table.getRowModel().rows.map((row) => {
          const cells = cellsByColumn(row)
          return (
            <div
              key={row.id}
              className={cn("rounded-md bg-card p-4", onRowClick && "cursor-pointer")}
              onClick={rowClickHandler(row, onRowClick)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-3">
                  {columns.select ? (
                    <div className="shrink-0">{renderCell(cells, columns.select)}</div>
                  ) : null}
                  {columns.media ? (
                    <div className="shrink-0">{renderCell(cells, columns.media)}</div>
                  ) : null}
                  <div className="min-w-0 text-sm font-medium">
                    {renderCell(cells, columns.title)}
                  </div>
                </div>
                {columns.actions ? (
                  <div className="shrink-0">{renderCell(cells, columns.actions)}</div>
                ) : null}
              </div>
              {columns.cardFields.length > 0 ? (
                <dl className="mt-3 flex flex-col gap-2">
                  {columns.cardFields.map((column) => {
                    const label = columnLabel(column)
                    return (
                      <div key={column.id} className="flex flex-col gap-0.5">
                        {label ? <dt className="text-xs text-muted-foreground">{label}</dt> : null}
                        <dd className="text-sm">{renderCell(cells, column)}</dd>
                      </div>
                    )
                  })}
                </dl>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * La tabla expone «seleccionar todas» en la cabecera; lista y card no tienen
 * cabecera, así que la columna de selección monta su header en una barra propia.
 * Sin esto, forzar `list` en móvil perdería la selección masiva.
 */
function SelectionBar<TData>({
  table,
  columns,
}: {
  table: TanStackTable<TData>
  columns: ViewColumns<TData>
}) {
  const select = columns.select
  if (!select) return null
  const header = table
    .getHeaderGroups()[0]
    ?.headers.find((candidate) => candidate.column.id === select.id)
  if (!header) return null

  return (
    <div className="flex items-center gap-2 rounded-md bg-card px-3 py-2">
      {flexRender(select.columnDef.header, header.getContext())}
      <span className="text-sm text-muted-foreground">{common.views.selectAll}</span>
    </div>
  )
}

function cellsByColumn<TData>(row: Row<TData>): Map<string, Cell<TData, unknown>> {
  return new Map(row.getVisibleCells().map((cell) => [cell.column.id, cell]))
}

function renderCell<TData>(
  cells: Map<string, Cell<TData, unknown>>,
  column: Column<TData, unknown> | null,
): React.ReactNode {
  if (!column) return null
  const cell = cells.get(column.id)
  if (!cell) return null
  return flexRender(cell.column.columnDef.cell, cell.getContext())
}

/**
 * Click en la fila completa para lista y card: misma conducta que la vista tabla
 * (que tampoco lleva handler de teclado), con el mismo filtro para no abrir el
 * registro al pulsar un control interno. El acceso por teclado lo dan los
 * controles reales de la fila (el `Link` del título, `RowActions`). Se descarta
 * `role="button"` + `tabIndex` en el contenedor porque anidaría interactivos
 * (dropdown de acciones, checkbox) dentro de un botón.
 */
function rowClickHandler<TData>(
  row: Row<TData>,
  onRowClick?: (row: TData) => void,
): React.MouseEventHandler | undefined {
  if (!onRowClick) return undefined
  return (event) => {
    if (isInteractiveTarget(event.target)) return
    onRowClick(row.original)
  }
}

export function DataTableSkeleton({
  columnCount = 5,
  rowCount = 6,
  showPagination = false,
  label = common.states.loading,
}: DataTableSkeletonProps) {
  const columns = Array.from({ length: columnCount })
  const rows = Array.from({ length: rowCount })

  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="overflow-hidden rounded-lg border border-border bg-surface"
    >
      <Table aria-hidden="true">
        <TableHeader>
          <TableRow>
            {columns.map((_, columnIndex) => (
              <TableHead key={columnIndex}>
                <Skeleton className={cn("h-3", skeletonWidth(columnIndex))} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((_, rowIndex) => (
            <TableRow key={rowIndex}>
              {columns.map((_, columnIndex) => (
                <TableCell key={columnIndex}>
                  <Skeleton
                    className={cn(
                      "h-4",
                      skeletonWidth((columnIndex + rowIndex + 1) % skeletonWidths.length),
                    )}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {showPagination ? (
        <div
          aria-hidden="true"
          className="flex items-center justify-between gap-2 border-t border-border p-3"
        >
          <Skeleton className="h-9 w-24 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-full" />
        </div>
      ) : null}
    </div>
  )
}
