/** Demos (`routes/_app/demos.tsx`): el filtro de producto y las filas por llegar. «Crear demo» es solo de Administración. */
import { Skeleton } from "@odentia/ui"
import { Plus } from "lucide-react"
import { useIsAdmin } from "../../lib/session"
import { PageLoading, ProductFilterSkeleton, TextBase, TextSm } from "./page-loading"

export const DEMOS_TITLE = "Demos"
export const DEMOS_SUBTITLE =
  "Clínicas inventadas para presentar cada producto. Nunca son clientes."

export function DemosListSkeleton() {
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex flex-wrap items-center gap-3 p-4">
          <div className="min-w-0 flex-1 basis-60">
            <TextBase className="w-56" />
            <TextSm className="w-80" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-8 w-28 rounded-3xl" />
            <Skeleton className="h-8 w-16 rounded-3xl" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DemosPageSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <PageLoading
      title={DEMOS_TITLE}
      subtitle={DEMOS_SUBTITLE}
      primary={
        isAdmin ? { label: "Crear demo", icon: <Plus aria-hidden />, disabled: true } : undefined
      }
    >
      <ProductFilterSkeleton />
      <DemosListSkeleton />
    </PageLoading>
  )
}
