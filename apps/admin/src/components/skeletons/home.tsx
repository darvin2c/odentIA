/** Hoy (`routes/_app/index.tsx`): la lista de pendientes de las colas. */
import { Skeleton } from "@odentia/ui"
import { PageLoading, ProductFilterSkeleton, TextBase, TextSm } from "./page-loading"

export function HomeSkeleton() {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex items-center gap-4 p-4">
          <span className="block min-w-0 flex-1">
            <TextBase className="w-44" />
            <TextSm className="w-72" />
          </span>
          <Skeleton className="my-1 h-5 w-6" />
          <Skeleton className="size-4 shrink-0" />
        </li>
      ))}
    </ul>
  )
}

export function HomePageSkeleton() {
  return (
    <PageLoading
      title="Hoy"
      subtitle="Lo que necesita atención del equipo, en los dos productos."
      className="space-y-6"
      bodyClassName="space-y-6"
    >
      <ProductFilterSkeleton />
      <HomeSkeleton />
    </PageLoading>
  )
}
