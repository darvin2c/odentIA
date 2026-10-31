/**
 * «Un paso antes de seguir» (`routes/terminos.tsx`): la cuenta, la casilla y el
 * botón. El marco es el `AuthSplit` real: es lo que la pantalla ya pinta mientras
 * carga, con sus enlaces legales (`AuthLegal`, solo enlaces).
 */
import { Skeleton } from "@odentia/ui"
import { AuthSplit, SkeletonRegion } from "@odentia/ui-patterns"
import { AuthLegal } from "../../lib/auth-screens"
import { TextSm } from "./page-loading"

export function TerminosSkeleton() {
  return (
    <SkeletonRegion message="Cargando…" className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-xl border bg-muted/40 px-3 py-2.5">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <span className="flex min-w-0 flex-1 flex-col">
          <TextSm className="w-32" />
          <TextSm className="w-48" />
        </span>
      </div>
      <div className="flex items-start gap-2.5">
        <Skeleton className="mt-0.5 size-4 shrink-0 rounded-md" />
        <span className="flex min-w-0 flex-1 flex-col">
          <TextSm className="w-full" />
          <TextSm className="w-3/4" />
        </span>
      </div>
      <Skeleton className="h-9 w-full rounded-3xl" />
    </SkeletonRegion>
  )
}

export function TerminosPageSkeleton() {
  return (
    <AuthSplit title="Un paso antes de seguir" legal={<AuthLegal />}>
      <TerminosSkeleton />
    </AuthSplit>
  )
}
