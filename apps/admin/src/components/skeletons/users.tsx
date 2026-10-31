/** Usuarios (`routes/_app/users.tsx`): la lista y, al lado, la ficha. */
import { Skeleton } from "@odentia/ui"
import { EmptyState } from "@odentia/ui-patterns"
import { ShieldAlert, UserSearch } from "lucide-react"
import { useIsAdmin } from "../../lib/session"
import { ControlSkeleton, PageLoading, TextBase, TextSm, TextXs } from "./page-loading"

export function UsersSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <ul className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <li key={row}>
            <div className="flex w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm">
              <TextSm className="w-52" />
              <TextXs className="w-64" />
            </div>
          </li>
        ))}
      </ul>
      <section className="min-w-0">
        <EmptyState
          icon={UserSearch}
          title="Elige un usuario"
          description="Selecciona un usuario para ver su ficha y ayudarle."
        />
      </section>
    </div>
  )
}

/** La ficha de quien se eligió, mientras llega. */
export function UserDetailSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <div className="flex flex-col gap-4 rounded-xl border bg-card p-4 text-sm">
      <TextBase className="w-56" />
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-52 rounded-3xl" />
        <Skeleton className="h-8 w-40 rounded-3xl" />
        {/* Bloquear y cerrar la cuenta son de la administración, como en la pantalla. */}
        {isAdmin ? (
          <>
            <Skeleton className="h-8 w-40 rounded-3xl" />
            <Skeleton className="h-8 w-28 rounded-3xl" />
          </>
        ) : null}
      </div>
      <div>
        <TextXs className="w-full" />
        <TextXs className="w-3/4" />
      </div>
      <div>
        <h3 className="font-medium">Clínicas</h3>
        <div className="mt-1 flex flex-col gap-1">
          <TextSm className="w-48" />
        </div>
      </div>
      <div>
        <h3 className="font-medium">Sesiones</h3>
        <div className="mt-1 flex flex-col gap-1">
          <TextSm className="w-64" />
          <TextSm className="w-56" />
        </div>
      </div>
    </div>
  )
}

export function UsersPageSkeleton() {
  return (
    <PageLoading
      title="Usuarios"
      subtitle="Búsqueda, ayuda de acceso, sesiones, bloqueo global y recuperación con doble control."
      primary={{ label: "Abrir recuperación", icon: <ShieldAlert aria-hidden />, disabled: true }}
    >
      <div className="flex flex-wrap gap-2">
        <ControlSkeleton className="min-w-0 flex-1" />
        <ControlSkeleton className="w-40" />
        <ControlSkeleton className="w-20" />
      </div>
      <UsersSkeleton />
    </PageLoading>
  )
}
