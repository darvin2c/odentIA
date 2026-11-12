/** Embudo (`routes/_app/pipeline.tsx`): filtros, columnas y tarjetas, con sus nombres reales. */
import { Skeleton } from "@odentia/ui"
import { DataTableSkeleton } from "@odentia/ui-patterns"
import { ControlSkeleton, PageLoading, ProductFilterSkeleton, TextSm, TextXs } from "./page-loading"

export const PIPELINE_SUBTITLE =
  "Las ventas abiertas, por etapa. Una tarjeta cambia de columna cuando pasa el hecho que la mueve."

/** Las columnas como en la pantalla: una debajo de otra en el teléfono, en fila desde tableta. */
export const PIPELINE_BOARD_CLASS =
  "flex flex-col gap-4 md:flex-row md:items-start md:overflow-x-auto md:pb-2"
export const PIPELINE_COLUMN_CLASS =
  "flex min-w-0 flex-col gap-3 rounded-xl border bg-muted/40 p-3 md:w-72 md:shrink-0"

const COLUMNS = ["Contacto", "Presentación agendada", "Presentación hecha", "Propuesta"]

export function PipelineBoardSkeleton() {
  return (
    <div className={PIPELINE_BOARD_CLASS}>
      {COLUMNS.map((title) => (
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
      <div className={PIPELINE_COLUMN_CLASS}>
        <span className="text-sm font-semibold">Decidió</span>
        <Skeleton className="h-8 w-full rounded-lg" />
      </div>
    </div>
  )
}

export function PipelineListSkeleton() {
  return <DataTableSkeleton columnCount={6} rowCount={5} label="Cargando las ventas" />
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

export function PipelinePageSkeleton() {
  return (
    <PageLoading
      title="Embudo"
      subtitle={PIPELINE_SUBTITLE}
      className="space-y-5"
      bodyClassName="space-y-5"
    >
      <div aria-hidden className="flex gap-1">
        <span className="inline-flex min-h-9 items-center rounded-md bg-background px-3 text-sm font-medium shadow-xs">
          Tablero
        </span>
        <span className="inline-flex min-h-9 items-center px-3 text-sm text-muted-foreground">
          Lista
        </span>
      </div>
      <PipelineFiltersSkeleton />
      <PipelineBoardSkeleton />
    </PageLoading>
  )
}
