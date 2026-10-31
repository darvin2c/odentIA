/**
 * Registro de paciente (`routes/public/registro.tsx`): la clínica arriba y el
 * cuestionario de una pantalla por tema. Lo que pregunta primero lo decide la
 * clínica, así que los campos son los de un tema típico.
 */
import { Skeleton } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"

export function RegistroSkeleton() {
  return (
    <>
      <header className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-md" />
        <div className="flex min-w-0 flex-1 flex-col">
          <Skeleton className="my-1 h-4 w-44 max-w-full" />
          <Skeleton className="my-0.5 h-4 w-36 max-w-full" />
        </div>
      </header>
      <div className="flex flex-col gap-8 rounded-2xl border bg-card p-5 shadow-xs sm:p-8">
        <div className="flex w-full flex-col gap-2">
          <Skeleton className="my-0.5 h-3 w-20" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
        <div className="flex flex-col gap-5">
          <Skeleton className="my-1 h-5 w-52 max-w-full" />
          {[0, 1, 2].map((field) => (
            <div key={field} className="flex flex-col gap-2">
              <Skeleton className="my-0.5 h-4 w-28" />
              <Skeleton className="h-9 w-full rounded-3xl" />
            </div>
          ))}
        </div>
        <Skeleton className="h-11 w-full rounded-3xl sm:w-32" />
      </div>
      <p className="text-center text-xs text-muted-foreground">Tus respuestas se envían solo al final.</p>
    </>
  )
}

export function RegistroPageSkeleton() {
  return (
    <PageShell maxWidth="md" className="py-6 sm:py-10">
      <SkeletonRegion message="Cargando el formulario de registro…" className="flex flex-col gap-6">
        <RegistroSkeleton />
      </SkeletonRegion>
    </PageShell>
  )
}
