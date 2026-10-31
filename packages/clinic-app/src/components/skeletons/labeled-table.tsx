/**
 * Esqueleto de una lista hecha con `DataTable` cuando se conocen sus columnas:
 * desde `md` la tabla con sus rótulos reales y en el teléfono las filas de la
 * vista lista (el mismo corte de `DataTable`). `DataTableSkeleton` pinta barras
 * en los rótulos; aquí se ven desde el primer momento.
 */
import {
  Item,
  ItemActions,
  ItemContent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@odentia/ui"
import type { ReactNode } from "react"

export interface LabeledColumn {
  /** El rótulo real de la columna. */
  label: string
  /** Lo que se dibuja en cada celda en vez del dato. */
  cell: ReactNode
}

export function LabeledTableSkeleton({
  columns,
  title,
  summary,
  actions,
  rowCount = 8,
}: {
  columns: LabeledColumn[]
  /** La primera línea de cada fila en el teléfono. */
  title: ReactNode
  /** Los datos que la vista lista junta bajo el título. */
  summary: ReactNode
  actions?: ReactNode
  rowCount?: number
}) {
  const rows = Array.from({ length: rowCount }, (_, index) => index)
  return (
    <>
      <div className="hidden overflow-hidden rounded-md bg-card md:block">
        <Table>
          <TableHeader className="bg-muted/65">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.label} className="h-12 px-3 text-sm">
                  {column.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row}>
                {columns.map((column) => (
                  <TableCell key={column.label}>{column.cell}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-col gap-2 md:hidden">
        {rows.map((row) => (
          <Item key={row} className="rounded-md bg-card">
            <ItemContent className="min-w-0 basis-full">
              <div className="min-w-0 text-sm font-medium">{title}</div>
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">{summary}</div>
            </ItemContent>
            {actions ? <ItemActions className="ml-auto">{actions}</ItemActions> : null}
          </Item>
        ))}
      </div>
    </>
  )
}

/** El botón ⋯ de una fila (`RowActions`): 44 px también en escritorio. */
export function RowActionsSkeleton() {
  return (
    <span className="flex size-11 shrink-0 items-center justify-center">
      <Skeleton className="size-5 rounded-full" />
    </span>
  )
}
