/**
 * Kairós (`routes/_app/kairos.tsx`): las pestañas «Espera tu sí | Lo que
 * hizo», reales, y tarjetas o frases por llegar. «Correr ahora» es solo de
 * Administración, como en la pantalla.
 */
import { Skeleton } from "@odentia/ui"
import { RefreshCw } from "lucide-react"
import { useIsAdmin } from "../../lib/session"
import { PageLoading, ProductFilterSkeleton, TextBase, TextSm, TextXs } from "./page-loading"

export const KAIROS_TITLE = "Kairós"
export const KAIROS_SUBTITLE = "Lo que preparó y lo que hizo. Nada sale a una clínica sin tu sí."

/** Las pestañas de la pantalla, sin interacción mientras llega. */
export function KairosTabsSkeleton({ view = "espera" }: { view?: "espera" | "hizo" }) {
  const tab = "inline-flex min-h-11 items-center rounded-3xl px-3.5 text-sm font-medium sm:min-h-9"
  return (
    <div aria-hidden className="flex w-fit gap-1 rounded-3xl bg-muted p-1">
      <span
        className={`${tab} ${view === "espera" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
      >
        Espera tu sí
      </span>
      <span
        className={`${tab} ${view === "hizo" ? "bg-background shadow-xs" : "text-muted-foreground"}`}
      >
        Lo que hizo
      </span>
    </div>
  )
}

/** Tarjetas de lo que espera un sí. */
export function KairosItemsSkeleton() {
  return (
    <ul className="flex flex-col gap-3">
      {[0, 1, 2].map((card) => (
        <li key={card} className="flex flex-col gap-3 rounded-xl border bg-card p-4">
          <div className="flex items-start gap-3">
            <Skeleton className="size-6 rounded-md" />
            <div className="min-w-0 flex-1">
              <TextBase className="w-64" />
              <TextSm className="w-40" />
            </div>
            <Skeleton className="h-5 w-36 rounded-full" />
          </div>
          <TextSm className="w-full" />
          <TextSm className="w-2/3" />
          <div className="flex gap-2">
            <Skeleton className="h-8 w-20 rounded-3xl" />
            <Skeleton className="h-8 w-20 rounded-3xl" />
            <Skeleton className="h-8 w-20 rounded-3xl" />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Las frases de «Lo que hizo», por día. */
export function KairosDoneSkeleton() {
  return (
    <div className="space-y-3">
      <TextBase className="w-40" />
      <ul className="divide-y rounded-xl border bg-card">
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className="flex flex-wrap items-start gap-3 p-4">
            <TextXs className="w-10" />
            <Skeleton className="size-6 rounded-md" />
            <div className="min-w-0 flex-1 basis-60">
              <TextSm className="w-72" />
              <TextXs className="w-32" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function KairosPageSkeleton() {
  const isAdmin = useIsAdmin()
  return (
    <PageLoading
      title={KAIROS_TITLE}
      subtitle={KAIROS_SUBTITLE}
      primary={
        isAdmin
          ? { label: "Correr ahora", icon: <RefreshCw aria-hidden />, disabled: true }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <KairosTabsSkeleton />
        <ProductFilterSkeleton />
      </div>
      <KairosItemsSkeleton />
    </PageLoading>
  )
}
