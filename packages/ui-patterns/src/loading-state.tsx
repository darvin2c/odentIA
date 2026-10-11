import { cn, Skeleton, Spinner } from "@odentia/ui"
import { common } from "./common.js"

export interface LoadingStateProps {
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
    <div
      className={[
        "flex flex-col items-center justify-center gap-4 rounded-lg border border-border bg-surface p-8 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className="text-sm text-muted-foreground">{message}</span>
      <div className="w-full max-w-sm space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    </div>
  )
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
