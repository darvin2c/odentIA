/**
 * Las piezas con las que se arman los esqueletos de Pacientes, de la página de
 * la persona y de la atención: cada una copia las clases del componente real
 * que reemplaza, para que web y móvil coincidan solos.
 */
import {
  Button,
  cn,
  Item,
  ItemContent,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useIsMobile,
  useSidebarOptional,
} from "@odentia/ui"
import { HeaderCompactProvider, MobileNavTrigger, PageHeaderMenu, useHeaderUtilities } from "@odentia/ui-patterns"
import type { ReactNode } from "react"

const LINE_SIZE = {
  xs: "my-0.5 h-3",
  sm: "my-0.5 h-4",
  base: "my-0.5 h-5",
} as const

/** Una línea de texto: ocupa el alto de línea de su tamaño (16, 20 o 24 px), para que nada salte. */
export function Line({ size = "sm", className }: { size?: keyof typeof LINE_SIZE; className?: string }) {
  return <Skeleton className={cn(LINE_SIZE[size], "max-w-full", className)} />
}

/** El hueco de un botón `size="sm"` cuyo nombre depende de los datos. */
export function ButtonBar({ className }: { className?: string }) {
  return <Skeleton className={cn("h-8 w-20 shrink-0 rounded-full", className)} />
}

/** Un botón cuyo nombre ya se sabe; no hace nada hasta que llegan los datos. */
export function WaitingButton({ children, size = "sm", className }: { children: ReactNode; size?: "sm" | "default"; className?: string }) {
  return (
    <Button type="button" size={size} variant="outline" disabled className={className}>
      {children}
    </Button>
  )
}

/** Lo mismo que `SummaryCard`, con su título real. */
export function SummaryCardShape({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 elevated rounded-xl border bg-card p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Filas de una lista dentro de una tarjeta: dos líneas y, si la lleva, su botón. */
export function RowsShape({ rows = 3, action = true, className }: { rows?: number; action?: boolean; className?: string }) {
  return (
    <ul className={cn("flex flex-col divide-y", className)}>
      {Array.from({ length: rows }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <li key={index} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span className="flex min-w-0 flex-1 flex-col">
            <Line className={index % 2 === 0 ? "w-40" : "w-48"} />
            <Line className={index % 2 === 0 ? "w-56" : "w-44"} />
          </span>
          {action ? <ButtonBar /> : null}
        </li>
      ))}
    </ul>
  )
}

/**
 * Lo mismo que `DataTable` con `view="table"`: tabla con sus rótulos reales desde
 * `md` y filas de la lista por debajo, con las clases de cada vista.
 */
export function TableShape({
  columns,
  rows = 6,
  cell,
  listTitle,
  listSummary,
}: {
  /** Los rótulos de las columnas, tal como los dice la pantalla. */
  columns: readonly string[]
  rows?: number
  /** Una celda de la tabla, por su columna. */
  cell: (column: number) => ReactNode
  /** El título y la línea de resumen de cada fila en la lista. */
  listTitle: ReactNode
  listSummary?: ReactNode
}) {
  const slots = Array.from({ length: rows }, (_, index) => index)
  return (
    <>
      <div aria-hidden="true" className="hidden overflow-hidden rounded-md bg-card md:block">
        <Table>
          <TableHeader className="bg-muted/65">
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column} className="h-12 px-3 text-sm">
                  {column}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {slots.map((row) => (
              <TableRow key={row}>
                {columns.map((column, index) => (
                  <TableCell key={column}>{cell(index)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div aria-hidden="true" className="flex flex-col gap-2 md:hidden">
        {slots.map((row) => (
          <Item key={row} className="rounded-md bg-card">
            <ItemContent className="min-w-0 basis-full">
              <div className="min-w-0 text-sm font-medium">{listTitle}</div>
              {listSummary ? <div className="text-sm text-muted-foreground">{listSummary}</div> : null}
            </ItemContent>
          </Item>
        ))}
      </div>
    </>
  )
}

/**
 * Lo mismo que `PageHeader` cuando el título todavía no se sabe (es el nombre de
 * la persona): sus clases y sus utilidades, que no dependen de los datos.
 */
export function HeaderShape({ titleClassName }: { titleClassName?: string }) {
  const sidebar = useSidebarOptional()
  const utilities = useHeaderUtilities()
  const isMobile = useIsMobile()
  return (
    <HeaderCompactProvider value={isMobile}>
      <header className="flex min-w-0 flex-nowrap items-center gap-2">
        {sidebar ? <MobileNavTrigger /> : null}
        <div className="flex min-h-[26px] min-w-0 flex-1 items-center md:min-h-8">
          <Skeleton className={cn("h-5 max-w-full md:h-7", titleClassName ?? "w-48")} />
        </div>
        <div className="flex shrink-0 items-center gap-1 md:gap-2">
          {utilities?.utilities}
          <PageHeaderMenu />
        </div>
      </header>
    </HeaderCompactProvider>
  )
}
