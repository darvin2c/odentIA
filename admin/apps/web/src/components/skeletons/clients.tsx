/**
 * Clientes (`routes/_app/clients.tsx`): las vistas, el filtro «Producto», la
 * fila de filtros y la tabla. Las vistas y los rótulos se pintan reales; las
 * cifras y las filas, por llegar.
 */
import { DataTableSkeleton } from "@odentia/ui-patterns"
import { Plus } from "lucide-react"
import { CLIENT_LIST_VIEWS } from "../../lib/list-search"
import { VIEW_WORDS } from "../arm/client-model"
import { ControlSkeleton, PageLoading, ProductFilterSkeleton } from "./page-loading"

export const CLIENTS_SUBTITLE =
  "Todas las clínicas de odentIA, latidIA y vistIA, desde el primer contacto hasta las que pagan. Las demos están en Demos."

/** Las vistas como texto, sin interacción: los mismos nombres y el mismo alto que `ViewTabs`. */
export function ClientViewsSkeleton({ active = "por_vender" }: { active?: string }) {
  return (
    <div
      aria-hidden
      className="flex min-w-0 max-w-full gap-1 overflow-hidden rounded-lg bg-muted p-[3px]"
    >
      {CLIENT_LIST_VIEWS.map((view) => (
        <span
          key={view}
          className={
            view === active
              ? "inline-flex min-h-11 shrink-0 items-center rounded-md bg-background px-3 text-sm font-medium shadow-xs sm:min-h-9"
              : "inline-flex min-h-11 shrink-0 items-center px-3 text-sm font-medium text-muted-foreground sm:min-h-9"
          }
        >
          {VIEW_WORDS[view]}
        </span>
      ))}
    </div>
  )
}

export function ClientsTableSkeleton() {
  return <DataTableSkeleton columnCount={7} rowCount={6} label="Cargando los clientes" />
}

/** La fila de filtros: búsqueda y los tres filtros con nombre, como `FilterBar`. */
export function ClientFiltersSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2 md:flex-row md:items-center">
      <ControlSkeleton className="w-full md:w-48" />
      <div className="flex gap-2 overflow-hidden">
        <ControlSkeleton className="w-36 shrink-0" />
        <ControlSkeleton className="w-32 shrink-0" />
        <ControlSkeleton className="w-28 shrink-0" />
      </div>
    </div>
  )
}

export function ClientsPageSkeleton() {
  return (
    <PageLoading
      title="Clientes"
      subtitle={CLIENTS_SUBTITLE}
      primary={{ label: "Nuevo cliente", icon: <Plus aria-hidden />, disabled: true }}
      className="flex flex-col gap-5"
      bodyClassName="flex flex-col gap-4"
    >
      <ClientViewsSkeleton />
      <ProductFilterSkeleton />
      <ClientFiltersSkeleton />
      <ClientsTableSkeleton />
    </PageLoading>
  )
}
