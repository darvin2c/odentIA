/** Soporte (`routes/_app/support.tsx`): Cola, Conocimiento, Métricas y la ficha del caso. */
import { Button, Skeleton } from "@odentia/ui"
import { useIsAdmin } from "../../lib/session"
import { ControlSkeleton, PageLoading, TextSm, TextXs } from "./page-loading"

/** Las cuatro de estado y las tres fijas. */
const METRIC_COUNT = 7

export function SupportMetricsSkeleton() {
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      {Array.from({ length: METRIC_COUNT }, (_, card) => (
        <div key={card} className="rounded-xl border px-3 py-2.5">
          <TextSm className="w-40" />
          <Skeleton className="my-1 h-5 w-12" />
        </div>
      ))}
    </dl>
  )
}

export function SupportKnowledgeSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <li key={row} className="rounded-xl border px-3 py-2.5 text-sm">
          <TextSm className="w-2/3" />
          <TextSm className="w-1/2" />
        </li>
      ))}
    </ul>
  )
}

/** La casilla de cada caso solo la tiene la administración. */
export function SupportCasesSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((row) => (
        <li key={row} className="flex min-w-0 items-start gap-2 rounded-xl border px-3 py-2.5">
          {isAdmin ? <Skeleton className="mt-1.5 size-5 shrink-0 rounded-md" /> : null}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex flex-wrap items-center gap-2">
              <Skeleton className="h-5 w-20 rounded-full" />
              <TextSm className="w-40" />
            </span>
            <TextSm className="w-3/4" />
            <Skeleton className="h-11 w-24 self-start rounded-3xl sm:h-9" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Lo que va bajo «← Cerrar ficha», dentro de la tarjeta de la ficha. */
export function SupportCaseSkeleton() {
  return (
    <>
      <TextSm className="w-3/4" />
      <TextSm className="w-full" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="rounded-xl border px-3 py-2">
            <TextXs className="w-24" />
            <TextSm className="w-2/3" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <TextSm className="w-40" />
        <Skeleton className="h-[76px] w-full rounded-md" />
        <Skeleton className="h-11 w-36 self-start rounded-3xl sm:h-9" />
      </div>
    </>
  )
}

export function SupportPageSkeleton() {
  return (
    <PageLoading
      title="Soporte"
      subtitle="Casos de las clínicas: conversación, responsable y acceso diagnóstico con permiso."
      className="flex flex-col gap-4"
      bodyClassName="flex flex-col gap-4"
    >
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled className="min-h-11 sm:min-h-9">
          Cola
        </Button>
        <Button type="button" variant="outline" disabled className="min-h-11 sm:min-h-9">
          Conocimiento
        </Button>
        <Button type="button" variant="outline" disabled className="min-h-11 sm:min-h-9">
          Métricas
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm leading-snug font-medium">Estado</span>
          <ControlSkeleton className="w-56" />
        </div>
        <SupportCasesSkeleton />
      </div>
    </PageLoading>
  )
}
