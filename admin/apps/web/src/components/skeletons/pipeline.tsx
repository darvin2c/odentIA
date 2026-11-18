/** Embudo (`routes/_app/pipeline.tsx`): filtros, columnas y tarjetas, con sus nombres reales. */
import { ScrollArea, Skeleton } from "@odentia/ui"
import { DataTableSkeleton } from "@odentia/ui-patterns"
import { useSearch } from "@tanstack/react-router"
import { useIsAdmin } from "../../lib/session"
import { ControlSkeleton, PageLoading, ProductFilterSkeleton, TextSm, TextXs } from "./page-loading"

export const PIPELINE_SUBTITLE =
  "Las ventas abiertas, por etapa. Una tarjeta cambia de columna cuando pasa el hecho que la mueve."

/** El Embudo «Alta»: una sola versión (Soporte ve las mismas palabras, sin las columnas de cobros). */
export const ALTA_SUBTITLE =
  "Las clínicas que entraron, por lo que les falta. Una tarjeta avanza sola cuando se da el paso."

/**
 * Las columnas como en la pantalla: una debajo de otra en el teléfono, en fila
 * desde tableta, dentro de un `ScrollArea` horizontal que las recorre de lado.
 */
export const PIPELINE_BOARD_CLASS = "flex flex-col gap-4 md:flex-row md:items-start md:pb-2"
export const PIPELINE_COLUMN_CLASS =
  "flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/40 p-3 md:w-72 md:shrink-0"

const COLUMNS = ["Contacto", "Presentación agendada", "Presentación hecha", "Propuesta"]
const ALTA_COLUMNS = ["Bienvenida", "Sus datos", "Arranque"]

export function PipelineBoardSkeleton() {
  return <BoardSkeleton columns={COLUMNS} folded="Decidió" />
}

/** Soporte no ve «Primer pago» ni «Pagó». */
export function AltaBoardSkeleton({ admin }: { admin: boolean }) {
  return (
    <BoardSkeleton
      columns={admin ? [...ALTA_COLUMNS, "Primer pago"] : ALTA_COLUMNS}
      folded={admin ? "Pagó" : null}
    />
  )
}

function BoardSkeleton({ columns, folded }: { columns: string[]; folded: string | null }) {
  return (
    <ScrollArea horizontal className="min-w-0 max-w-full rounded-xl">
      <div className={PIPELINE_BOARD_CLASS}>
        {columns.map((title) => (
          <div key={title} className={PIPELINE_COLUMN_CLASS}>
            <div>
              <span className="text-sm font-semibold">{title}</span>
              <TextXs className="w-32" />
            </div>
            {[0, 1].map((card) => (
              <div key={card} className="flex flex-col gap-1.5 rounded-lg border bg-card p-3">
                <TextXs className="w-20" />
                <TextSm className="w-40" />
                <TextXs className="w-48" />
                <TextXs className="w-24" />
              </div>
            ))}
          </div>
        ))}
        {folded ? (
          <div className={PIPELINE_COLUMN_CLASS}>
            <span className="text-sm font-semibold">{folded}</span>
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ) : null}
      </div>
    </ScrollArea>
  )
}

export function PipelineListSkeleton() {
  return <DataTableSkeleton columnCount={6} rowCount={5} label="Cargando las ventas" />
}

export function AltaListSkeleton() {
  return <DataTableSkeleton columnCount={6} rowCount={5} label="Cargando el alta" />
}

export function PipelineFiltersSkeleton() {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <ProductFilterSkeleton />
      <ControlSkeleton className="w-56" />
      <ControlSkeleton className="w-48" />
    </div>
  )
}

const TAB_ON =
  "inline-flex min-h-9 items-center rounded-md bg-background px-3 text-sm font-medium shadow-xs"
const TAB_OFF = "inline-flex min-h-9 items-center px-3 text-sm text-muted-foreground"

export function PipelinePageSkeleton() {
  const search = useSearch({ strict: false }) as { pestana?: unknown; vista?: unknown }
  const admin = useIsAdmin()
  const alta = search.pestana === "alta"
  const list = search.vista === "lista"
  return (
    <PageLoading
      title="Embudo"
      subtitle={alta ? ALTA_SUBTITLE : PIPELINE_SUBTITLE}
      className="space-y-5"
      bodyClassName="space-y-5"
    >
      <div aria-hidden className="flex flex-wrap gap-3">
        <div className="flex gap-1">
          <span className={alta ? TAB_OFF : TAB_ON}>Venta</span>
          <span className={alta ? TAB_ON : TAB_OFF}>Alta</span>
        </div>
        <div className="flex gap-1">
          <span className={list ? TAB_OFF : TAB_ON}>Tablero</span>
          <span className={list ? TAB_ON : TAB_OFF}>Lista</span>
        </div>
      </div>
      <PipelineFiltersSkeleton />
      {alta ? (
        list ? (
          <AltaListSkeleton />
        ) : (
          <AltaBoardSkeleton admin={admin} />
        )
      ) : list ? (
        <PipelineListSkeleton />
      ) : (
        <PipelineBoardSkeleton />
      )}
    </PageLoading>
  )
}
