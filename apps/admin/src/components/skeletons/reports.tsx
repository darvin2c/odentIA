/**
 * Reportes (`routes/_app/reports.tsx`, solo Administración): las pestañas
 * reales, las cifras con su título y los gráficos por llegar.
 */
import { Skeleton } from "@odentia/ui"
import { ControlSkeleton, KpiSkeleton, PageLoading, TextBase, TextSm } from "./page-loading"

export const REPORTS_TITLE = "Reportes"
export const REPORTS_SUBTITLE =
  "Embudo, ingresos y previsión. Las cifras las pone el cálculo; Kairós solo las cuenta."

/** Las pestañas, sin interacción mientras llega. */
export function ReportsTabsSkeleton() {
  const tab = "inline-flex min-h-11 items-center rounded-3xl px-3.5 text-sm font-medium sm:min-h-9"
  return (
    <div
      aria-hidden
      className="flex w-fit max-w-full gap-1 overflow-hidden rounded-3xl bg-muted p-1"
    >
      <span className={`${tab} bg-background shadow-xs`}>Embudo</span>
      <span className={`${tab} text-muted-foreground`}>Ingresos</span>
      <span className={`${tab} text-muted-foreground`}>Previsión</span>
    </div>
  )
}

/** Una tarjeta con su título, un gráfico o una lista por llegar. */
function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="elevated flex flex-col gap-3 rounded-xl border bg-card p-5">
      <TextBase className="w-48" />
      <TextSm className="w-64" />
      {Array.from({ length: rows }, (_, row) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <Skeleton key={row} className="h-6 w-full rounded-md" />
      ))}
    </div>
  )
}

/** El cuerpo de una pestaña: cifras arriba y dos tarjetas. */
export function ReportsBodySkeleton({ kpis }: { kpis: string[] }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((title) => (
          <KpiSkeleton key={title} title={title} description />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    </div>
  )
}

export const FUNNEL_KPIS = ["Clínicas", "Entraron", "Siguen abiertas", "Perdidas"]

export function ReportsPageSkeleton() {
  return (
    <PageLoading title={REPORTS_TITLE} subtitle={REPORTS_SUBTITLE}>
      <div className="flex flex-wrap items-center gap-3">
        <ReportsTabsSkeleton />
        <ControlSkeleton className="w-48" />
      </div>
      <ReportsBodySkeleton kpis={FUNNEL_KPIS} />
    </PageLoading>
  )
}
