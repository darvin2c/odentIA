import {
  cn,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
  ScrollArea,
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
   * Fila abierta en el detalle: se marca para que se sepa qué registro se está
   * editando mientras el panel está al costado. El predicado lo aporta la
   * página, que conoce la identidad de su entidad (`row.id === editing?.id`).
   */
  isRowActive?: (row: TData) => boolean
  /**
   * Vista en pantallas de `md` (768px) o más. Por debajo de ese ancho siempre
   * se renderiza `list`, aunque aquí se pida `table` o `card`. Default `table`.
   */
  view?: DataTableView
  className?: string
}

export interface DataTableSkeletonProps {
  /**
   * Vista cuyo hueco se reserva mientras carga. Igual que en `DataTable`, por
   * debajo del breakpoint móvil siempre es el de `list`, aunque aquí se pida
   * `table` o `card`. Default `table`.
   */
  view?: DataTableView
  /** Columnas de la tabla; pares label/valor de cada card. En lista no aplica. */
  columnCount?: number
  rowCount?: number
  showPagination?: boolean
  label?: string
}

const skeletonWidths = ["w-40", "w-20", "w-24", "w-16", "w-8"] as const
const skeletonTitleWidths = ["w-40", "w-32", "w-44", "w-36"] as const
const skeletonSummaryWidths = ["w-56", "w-48", "w-60", "w-52"] as const
const skeletonFieldWidths = ["w-24", "w-20", "w-28", "w-16"] as const

function widthAt(widths: readonly string[], index: number): string {
  return widths[index % widths.length] ?? "w-20"
}

/** Claves de los placeholders: no tienen identidad propia, solo posición. */
function slotKeys(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`)
}

interface LayoutProps<TData> {
  table: TanStackTable<TData>
  onRowClick?: (row: TData) => void
  isRowActive?: (row: TData) => boolean
  className?: string
}

/**
 * Marca de fila activa: mismo tratamiento en las tres vistas (fondo hundido y
 * barra primaria a la izquierda) y `aria-current` para lectores de pantalla.
 */
function activeRowProps(active: boolean) {
  return active ? { "data-state": "active", "aria-current": "true" as const } : {}
}

const activeRowClass = "bg-muted shadow-[inset_2px_0_0_0_var(--color-primary)]"

/**
 * Tabla de datos con tres vistas que comparten celdas: el contenido sale
 * siempre de `ColumnDef.cell` (vía `flexRender`); lo único que cambia es el
 * layout. `list` y `card` reparten esas mismas celdas entre título, resumen,
 * campos y acciones según `meta.view` de cada columna.
 */
export function DataTable<TData>({
  table,
  onRowClick,
  isRowActive,
  view = "table",
  className,
}: DataTableProps<TData>) {
  const resolved = useResolvedView(view)

  if (resolved === "list") {
    return (
      <ListLayout
        table={table}
        onRowClick={onRowClick}
        isRowActive={isRowActive}
        className={className}
      />
    )
  }
  if (resolved === "card") {
    return (
      <CardLayout
        table={table}
        onRowClick={onRowClick}
        isRowActive={isRowActive}
        className={className}
      />
    )
  }
  return (
    <TableLayout
      table={table}
      onRowClick={onRowClick}
      isRowActive={isRowActive}
      className={className}
    />
  )
}

function TableLayout<TData>({ table, onRowClick, isRowActive, className }: LayoutProps<TData>) {
  return (
    <div className={cn("overflow-hidden rounded-md bg-card", className)}>
      {/* La tabla que no entra se recorre con la barra del sistema de diseño:
          el contenedor del registry deja de scrollear (`overflow-visible`) para
          que el desborde llegue al área, que solo scrollea en horizontal. Con
          `overflow-x-auto` el navegador dibujaba su barra nativa —una por tabla
          agrupada— y habilitaba además el scroll vertical del contenedor. */}
      <ScrollArea horizontal className="[&_[data-slot=table-container]]:overflow-visible">
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
            {table.getRowModel().rows.map((row) => {
              const active = isRowActive?.(row.original) ?? false
              return (
                <TableRow
                  key={row.id}
                  className={cn(onRowClick && "cursor-pointer", active && activeRowClass)}
                  {...activeRowProps(active)}
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
              )
            })}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

function ListLayout<TData>({ table, onRowClick, isRowActive, className }: LayoutProps<TData>) {
  const columns = resolveViewColumns(table)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SelectionBar table={table} columns={columns} />
      <div className="flex flex-col gap-2">
        {table.getRowModel().rows.map((row) => {
          const cells = cellsByColumn(row)
          const active = isRowActive?.(row.original) ?? false
          return (
            <Item
              key={row.id}
              className={cn(
                "rounded-md bg-card",
                onRowClick && "cursor-pointer",
                active && activeRowClass,
              )}
              {...activeRowProps(active)}
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

function CardLayout<TData>({ table, onRowClick, isRowActive, className }: LayoutProps<TData>) {
  const columns = resolveViewColumns(table)
  // Los campos de resumen suben a la cabecera (identidad + datos de un vistazo)
  // y no se repiten en la ficha: lo que queda abajo es el resto de campos.
  const summaryIds = new Set(columns.summary.map((column) => column.id))
  const fields = columns.cardFields.filter((column) => !summaryIds.has(column.id))

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <SelectionBar table={table} columns={columns} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {table.getRowModel().rows.map((row) => {
          const cells = cellsByColumn(row)
          const active = isRowActive?.(row.original) ?? false
          return (
            <div
              key={row.id}
              data-slot="data-table-card"
              className={cn(
                // La ficha se define por su superficie (`bg-card` sobre el fondo
                // de página) y el hover por elevación: el fondo de página y
                // `--muted` son el mismo gris, así que un hover de fondo se
                // funde con la página en vez de destacar.
                "@container flex flex-col rounded-md bg-card p-5 transition-[background-color,box-shadow] hover:shadow-sm",
                onRowClick && "cursor-pointer",
                active && activeRowClass,
              )}
              {...activeRowProps(active)}
              onClick={rowClickHandler(row, onRowClick)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  {columns.select ? (
                    <div className="shrink-0">{renderCell(cells, columns.select)}</div>
                  ) : null}
                  {columns.media ? (
                    <div className="shrink-0">{renderCell(cells, columns.media)}</div>
                  ) : null}
                  <div className="min-w-0">
                    <div className="text-base leading-tight font-semibold tracking-tight">
                      {renderCell(cells, columns.title)}
                    </div>
                    {columns.summary.length > 0 ? (
                      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
                        {columns.summary.map((column, index) => (
                          <React.Fragment key={column.id}>
                            {index > 0 ? <span aria-hidden="true">·</span> : null}
                            {renderCell(cells, column)}
                          </React.Fragment>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </div>
                {columns.actions ? (
                  <div className="shrink-0">{renderCell(cells, columns.actions)}</div>
                ) : null}
              </div>
              {fields.length > 0 ? (
                // La container query decide las columnas por el ancho real de la
                // card (en `xl:grid-cols-3` ninguna llega a la mitad del ancho
                // del viewport), no por el del viewport. Ojo: consulta el
                // CONTENT box, así que el `p-5` no cuenta para el umbral.
                <dl className="mt-4 grid gap-x-6 gap-y-2 @sm:grid-cols-2">
                  {fields.map((column) => {
                    const label = columnLabel(column)
                    return (
                      <div key={column.id} className="flex items-baseline gap-2">
                        {label ? (
                          <dt className="w-24 shrink-0 text-xs text-muted-foreground">{label}</dt>
                        ) : null}
                        <dd className="min-w-0 text-sm">{renderCell(cells, column)}</dd>
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

interface SkeletonShape {
  columnCount: number
  rowCount: number
  showPagination: boolean
  label: string
}

/**
 * Esqueleto de `DataTable`: reserva el hueco de la vista que va a montarse
 * encima, para que el contenido real no salte al llegar. Como en `DataTable`,
 * por debajo del breakpoint móvil el hueco reservado es el de la lista aunque
 * se pida tabla o card.
 */
export function DataTableSkeleton({
  view = "table",
  columnCount = 5,
  rowCount = 6,
  showPagination = false,
  label = common.states.loading,
}: DataTableSkeletonProps) {
  const resolved = useResolvedView(view)
  const shape: SkeletonShape = { columnCount, rowCount, showPagination, label }

  if (resolved === "list") return <ListSkeleton {...shape} />
  if (resolved === "card") return <CardSkeleton {...shape} />
  return <TableSkeleton {...shape} />
}

function statusProps(label: string) {
  return { role: "status" as const, "aria-label": label, "aria-busy": true as const }
}

/** Pie de paginación: mismas dos pastillas en las tres vistas. */
function SkeletonPagination({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("flex items-center justify-between gap-2 p-3", className)}
    >
      <Skeleton className="h-9 w-24 rounded-full" />
      <Skeleton className="h-9 w-24 rounded-full" />
    </div>
  )
}

function TableSkeleton({ columnCount, rowCount, showPagination, label }: SkeletonShape) {
  const columns = slotKeys(columnCount, "column")
  const rows = slotKeys(rowCount, "row")

  return (
    <div {...statusProps(label)} className="overflow-hidden rounded-md bg-card">
      <Table aria-hidden="true">
        <TableHeader>
          <TableRow>
            {columns.map((columnKey, columnIndex) => (
              <TableHead key={columnKey}>
                <Skeleton className={cn("h-3", widthAt(skeletonWidths, columnIndex))} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((rowKey, rowIndex) => (
            <TableRow key={rowKey}>
              {columns.map((columnKey, columnIndex) => (
                <TableCell key={columnKey}>
                  <Skeleton
                    className={cn("h-4", widthAt(skeletonWidths, columnIndex + rowIndex + 1))}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {showPagination ? <SkeletonPagination className="border-t border-border" /> : null}
    </div>
  )
}

/** Mismos huecos que `ListLayout`: media, título, línea de resumen y acciones. */
function ListSkeleton({ rowCount, showPagination, label }: SkeletonShape) {
  const rows = slotKeys(rowCount, "row")

  return (
    <div {...statusProps(label)} className="flex flex-col gap-2">
      <div aria-hidden="true" className="flex flex-col gap-2">
        {rows.map((rowKey, rowIndex) => (
          <Item key={rowKey} className="rounded-md bg-card">
            <ItemMedia variant="image">
              <Skeleton className="size-full rounded-sm" />
            </ItemMedia>
            <ItemContent>
              <Skeleton className={cn("h-4", widthAt(skeletonTitleWidths, rowIndex))} />
              <Skeleton className={cn("h-3", widthAt(skeletonSummaryWidths, rowIndex))} />
            </ItemContent>
            <ItemActions>
              <Skeleton className="size-9 rounded-full" />
            </ItemActions>
          </Item>
        ))}
      </div>
      {showPagination ? <SkeletonPagination className="rounded-md bg-card" /> : null}
    </div>
  )
}

/** Mismos huecos que `CardLayout`: identidad en la cabecera y ficha debajo. */
function CardSkeleton({ columnCount, rowCount, showPagination, label }: SkeletonShape) {
  const cards = slotKeys(rowCount, "card")
  const fields = slotKeys(columnCount, "field")

  return (
    <div {...statusProps(label)} className="flex flex-col gap-2">
      <div aria-hidden="true" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((cardKey, cardIndex) => (
          <div
            key={cardKey}
            data-slot="data-table-skeleton-card"
            className="@container flex flex-col rounded-md bg-card p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <Skeleton className="size-10 shrink-0 rounded-full @sm:size-14" />
                <div className="flex min-w-0 flex-col gap-1">
                  <Skeleton className={cn("h-4", widthAt(skeletonTitleWidths, cardIndex))} />
                  <Skeleton className={cn("h-3", widthAt(skeletonSummaryWidths, cardIndex))} />
                </div>
              </div>
              <Skeleton className="size-9 shrink-0 rounded-full" />
            </div>
            {fields.length > 0 ? (
              <div className="mt-4 grid gap-x-6 gap-y-2 @sm:grid-cols-2">
                {fields.map((fieldKey, fieldIndex) => (
                  <div
                    key={fieldKey}
                    data-slot="data-table-skeleton-field"
                    className="flex items-baseline gap-2"
                  >
                    <Skeleton className="h-3 w-24 shrink-0" />
                    <Skeleton className={cn("h-4", widthAt(skeletonFieldWidths, fieldIndex))} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {showPagination ? <SkeletonPagination className="rounded-md bg-card" /> : null}
    </div>
  )
}
