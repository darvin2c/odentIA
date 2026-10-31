/** Aviso de privacidad (`routes/public/aviso.tsx`): la clínica, el título real y el texto. */
import { Skeleton } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"

export function AvisoSkeleton() {
  return (
    <>
      <header className="flex items-center gap-3">
        <Skeleton className="size-10 shrink-0 rounded-md" />
        <div className="flex min-w-0 flex-col">
          <Skeleton className="my-0.5 h-4 w-40 max-w-full" />
          <h1 className="font-heading text-xl font-semibold">Aviso de privacidad</h1>
          <Skeleton className="my-0.5 h-4 w-20" />
        </div>
      </header>
      <section className="flex flex-col gap-2 rounded-3xl border bg-card p-5 shadow-xs">
        {["w-full", "w-full", "w-11/12", "w-full", "w-4/5", "w-full", "w-full", "w-3/4", "w-full", "w-2/3"].map((width, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: líneas de relleno, siempre las mismas.
          <Skeleton key={index} className={`h-4 ${width}`} />
        ))}
      </section>
      <p className="px-1 text-sm text-muted-foreground">¿Dudas? Escríbenos por el chat y te ayudamos.</p>
    </>
  )
}

export function AvisoPageSkeleton() {
  return (
    <PageShell maxWidth="md" className="py-6 sm:py-10">
      <SkeletonRegion message="Cargando el aviso de privacidad…" className="flex flex-col gap-4">
        <AvisoSkeleton />
      </SkeletonRegion>
    </PageShell>
  )
}
