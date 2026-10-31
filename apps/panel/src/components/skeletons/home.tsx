/** «Elige tu clínica» (`routes/_app/index.tsx`): una fila por clínica. */
import { Skeleton } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"
import { StaffEntry } from "../staff-entry"
import { TextBase, TextSm } from "./page-loading"

export function OrganizationsSkeleton() {
  return (
    <ul className="space-y-3">
      {[0, 1].map((row) => (
        <li key={row} className="relative flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
          <Skeleton className="size-11 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 basis-48">
            <TextBase className="w-40" />
            <TextSm className="mt-1.5 w-56" />
          </div>
          <div className="relative flex shrink-0 items-center gap-1 max-sm:basis-full max-sm:justify-end">
            <Skeleton className="size-5 shrink-0 max-sm:hidden" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function OrganizationsPageSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10 sm:py-14">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-xl font-semibold">Elige tu clínica</h1>
        <TextSm className="w-52" />
      </div>
      <StaffEntry />
      <section aria-label="Clínicas" className="space-y-3">
        <SkeletonRegion message="Cargando clínicas…">
          <OrganizationsSkeleton />
        </SkeletonRegion>
      </section>
      <footer className="flex flex-col items-center gap-3 border-t pt-6">
        <p className="text-sm text-muted-foreground">
          ¿Necesitas ayuda? <span className="underline">Contacta con soporte</span>
        </p>
      </footer>
    </main>
  )
}
