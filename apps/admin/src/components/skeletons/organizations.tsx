/** Clínicas (`routes/_app/organizations.tsx`): búsqueda, filtros y tarjetas. */
import { Skeleton } from "@odentia/ui"
import { Plus, Presentation } from "lucide-react"
import { useIsAdmin } from "../../lib/session"
import { ControlSkeleton, PageLoading, ProductFilterSkeleton, TextBase, TextXs } from "./page-loading"

export function OrganizationsSkeleton() {
  return (
    <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((card) => (
        <li key={card}>
          <div className="flex h-full w-full flex-col gap-1.5 rounded-xl border bg-card p-3 text-left text-sm">
            <TextXs className="w-16" />
            <span className="flex flex-wrap items-center gap-2">
              <span className="block min-w-0 flex-1">
                <TextBase className="w-40" />
              </span>
              <Skeleton className="h-5 w-16 rounded-full" />
            </span>
            <TextXs className="w-44" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function OrganizationsPageSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <PageLoading
      title="Clínicas"
      subtitle="Las de odentIA y las de latidIA, con suscripción, uso, miembros y actividad."
      primary={{ label: "Alta asistida", icon: <Plus aria-hidden />, disabled: true }}
      // «Crear demo» y el filtro «Precio» son de la administración, como en la pantalla.
      secondary={isAdmin ? { label: "Crear demo", icon: <Presentation aria-hidden />, disabled: true } : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-64 flex-1 gap-2">
          <ControlSkeleton className="min-w-0 flex-1" />
          <ControlSkeleton className="w-20 shrink-0" />
        </div>
        <ProductFilterSkeleton />
        {isAdmin ? <ControlSkeleton className="w-60 shrink-0" /> : null}
        <ControlSkeleton className="w-44 shrink-0" />
      </div>
      <OrganizationsSkeleton />
    </PageLoading>
  )
}
