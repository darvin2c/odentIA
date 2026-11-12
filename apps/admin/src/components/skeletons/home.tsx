/**
 * Hoy (`routes/_app/index.tsx`): filas con nombre, una línea y su botón, en
 * secciones; debajo, «Otras colas». Sin el bloque de cobros: lo de cobro solo
 * se dibuja si llega (soporte no lo recibe).
 */
import { Skeleton } from "@odentia/ui"
import { PageLoading, ProductFilterSkeleton, TextBase, TextSm } from "./page-loading"

/** Una sección de filas: su título por llegar y filas con el botón al lado. */
function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-3">
      <TextBase className="w-56" />
      <ul className="divide-y rounded-xl border bg-card">
        {Array.from({ length: rows }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
          <li key={row} className="flex flex-wrap items-center gap-3 p-4">
            <div className="min-w-0 flex-1 basis-60">
              <TextBase className="w-48" />
              <TextSm className="w-80" />
            </div>
            <Skeleton className="h-8 w-32 rounded-3xl" />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Las secciones de filas de Inicio mientras llegan. */
export function HomeSkeleton() {
  return (
    <div className="space-y-6">
      <RowsSkeleton rows={3} />
      <RowsSkeleton rows={2} />
    </div>
  )
}

/** «Otras colas»: los contadores, una fila con su número. */
export function HomeCountersSkeleton() {
  return (
    <div className="space-y-3">
      <TextBase className="w-28" />
      <ul className="divide-y rounded-xl border bg-card">
        {[0, 1, 2].map((row) => (
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
    </div>
  )
}

export function HomePageSkeleton() {
  return (
    <PageLoading title="Hoy" subtitle="Lo que necesita atención del equipo." className="space-y-6" bodyClassName="space-y-6">
      <ProductFilterSkeleton />
      <HomeSkeleton />
      <HomeCountersSkeleton />
    </PageLoading>
  )
}
