/** Lista de espera (`routes/_app/waitlist.tsx`): cifras, filtros y tabla. */
import { DataTableSkeleton } from "@odentia/ui-patterns"
import { ControlSkeleton, KpiSkeleton, PageLoading, ProductFilterSkeleton } from "./page-loading"

export function WaitlistKpisSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiSkeleton title="Por revisar" />
      <KpiSkeleton title="Lugares usados" description />
      <KpiSkeleton title="Invitadas" />
    </div>
  )
}

export function WaitlistSkeleton() {
  return <DataTableSkeleton columnCount={8} rowCount={4} label="Cargando las solicitudes" />
}

export function WaitlistPageSkeleton() {
  return (
    <PageLoading
      title="Lista de espera"
      subtitle="Clínicas que pidieron entrar."
      className="space-y-5"
      bodyClassName="space-y-5"
    >
      <WaitlistKpisSkeleton />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-snug font-medium">Estado</span>
          <ControlSkeleton className="w-56" />
        </div>
        <ControlSkeleton className="w-full min-w-52 sm:w-80" />
        <ProductFilterSkeleton />
      </div>
      <WaitlistSkeleton />
    </PageLoading>
  )
}
