/** Equipo (`routes/_app/team.tsx`): Personal e Invitaciones pendientes. */
import { cn, Skeleton } from "@odentia/ui"
import { Plus } from "lucide-react"
import { useIsAdmin } from "../../lib/session"
import { PageLoading, TextBase, TextXs } from "./page-loading"

function TeamRow({ actions, badge = true }: { actions: string[]; badge?: boolean }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <TextBase className="w-40" />
        <TextXs className="w-52" />
      </div>
      {badge ? <Skeleton className="h-5 w-24 rounded-full" /> : null}
      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {actions.map((width, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: botones de relleno, siempre los mismos.
            <Skeleton key={index} className={cn("h-9 rounded-3xl", width)} />
          ))}
        </div>
      ) : null}
    </li>
  )
}

/** Los botones de cada fila son de quien gestiona el equipo: la administración. */
export function TeamSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Personal</h2>
        <ul className="flex flex-col gap-2">
          {[0, 1, 2].map((row) => (
            <TeamRow key={row} actions={isAdmin ? ["w-32", "w-24", "w-32"] : []} />
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Invitaciones pendientes</h2>
        <ul className="flex flex-col gap-2">
          <TeamRow badge={false} actions={isAdmin ? ["w-24", "w-20"] : []} />
        </ul>
      </section>
    </div>
  )
}

export function TeamPageSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <PageLoading
      title="Equipo"
      subtitle="Personal interno: invitaciones nominales, roles y reactivación"
      primary={isAdmin ? { label: "Invitar", icon: <Plus aria-hidden />, disabled: true } : undefined}
    >
      <TeamSkeleton />
    </PageLoading>
  )
}
