/** Libro de Reclamaciones (`routes/_app/complaints.tsx`): cifras, filtros y tabla. */
import { DataTableSkeleton } from "@odentia/ui-patterns"
import { ControlSkeleton, KpiSkeleton, PageLoading } from "./page-loading"

export function ComplaintsKpisSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <KpiSkeleton title="Por responder" />
      <KpiSkeleton title="Vencen en 5 días hábiles o menos" />
      <KpiSkeleton title="Plazo vencido" />
    </div>
  )
}

export function ComplaintsSkeleton() {
  return <DataTableSkeleton columnCount={6} rowCount={4} label="Cargando las hojas" />
}

export function ComplaintsPageSkeleton() {
  return (
    <PageLoading
      title="Libro de Reclamaciones"
      subtitle="Las hojas que llegan desde las webs de odentIA y latidIA. Cada una se responde por correo en un plazo de 15 días hábiles que no se puede ampliar."
      className="space-y-5"
      bodyClassName="space-y-5"
    >
      <ComplaintsKpisSkeleton />
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <span className="text-sm leading-snug font-medium">Estado</span>
          <ControlSkeleton className="w-56" />
        </div>
        <ControlSkeleton className="w-full min-w-52 sm:w-96" />
      </div>
      <ComplaintsSkeleton />
    </PageLoading>
  )
}
