import { cn, Skeleton, Spinner } from "@odentia/ui"
import type * as React from "react"
import { common } from "./common.js"
import { PageShell, useInsidePageShell } from "./page-shell.js"

export interface LoadingStateProps {
  /** Lo dice el lector de pantalla; a la vista queda solo con `indeterminate`. */
  message?: string
  className?: string
  /**
   * `skeleton` (default): primera carga con estructura conocida, sin
   * Spinner duplicado. `indeterminate`: actividad sin estructura conocida
   * (Spinner B). No intercambiarlos en masa: cada caller elige según si
   * conoce la estructura que va a montar.
   */
  kind?: "skeleton" | "indeterminate"
}

export interface DataRefreshMarkerProps {
  message?: string
  className?: string
}

const LINE_WIDTHS = ["w-full", "w-11/12", "w-3/4"]
const ROW_WIDTHS = ["w-2/5", "w-1/3", "w-1/2", "w-1/4", "w-2/5", "w-1/3"]

export function LoadingState({
  message = common.states.loading,
  className,
  kind = "skeleton",
}: LoadingStateProps) {
  if (kind === "indeterminate") {
    return (
      <div
        className={[
          "flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-surface p-8 text-center",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <Spinner className="size-6 text-[var(--identity-accent)]" aria-label={message} />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    )
  }
  return (
    <div role="status" className={cn("min-w-0", className)}>
      <span className="sr-only">{message}</span>
      <div className="flex flex-col gap-2.5 py-1">
        {LINE_WIDTHS.map((width) => (
          <Skeleton key={width} className={cn("h-4", width)} />
        ))}
      </div>
    </div>
  )
}

/**
 * Lo que envuelve al esqueleto propio de una pantalla: dice al lector de
 * pantalla qué se está cargando. Dentro va la misma rejilla de la pantalla real
 * (las mismas clases), para que en cada ancho quede igual y nada salte al llegar.
 */
export function SkeletonRegion({ message = common.states.loading, className, children }: { message?: string; className?: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-label={message} className={className}>
      <span className="sr-only">{message}</span>
      {children}
    </div>
  )
}

/**
 * Lo que se ve mientras llega el código de una pantalla que no declaró su
 * `pendingComponent` (`defaultPendingComponent` del router): un título y una
 * lista. Dentro de un layout que ya puso su `PageShell`, solo el contenido.
 */
export function PagePending() {
  const content = (
    <SkeletonRegion className="flex flex-col gap-4">
      <Skeleton className="h-8 w-48 max-w-full" />
      <div className="elevated flex flex-col divide-y rounded-xl border bg-card">
        {ROW_WIDTHS.map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
          <div key={index} className="flex min-h-14 items-center gap-3 px-4">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <Skeleton className={cn("h-4", width)} />
            <Skeleton className="ml-auto h-4 w-16 shrink-0" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  )
  return useInsidePageShell() ? content : <PageShell>{content}</PageShell>
}

/**
 * Revalidación con datos en pantalla: indicador B junto al texto, sin
 * shimmer. Vive en el área de estado fija del caller (barra sobre la
 * tabla); las filas no se retiran mientras aparece.
 */
export function DataRefreshMarker({
  message = common.states.refreshing,
  className,
}: DataRefreshMarkerProps) {
  return (
    <span
      role="status"
      className={cn(
        "inline-flex items-center gap-2 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <Spinner className="size-6 text-[var(--identity-accent)]" aria-hidden />
      <span>{message}</span>
    </span>
  )
}
