/**
 * Portal del paciente (`routes/public/portal.tsx`): una sola página con un bloque
 * por cosa. Cada bloque se carga aparte y tiene su pieza; en `PortalSkeleton`,
 * que va antes de saber su alcance, ningún bloque dice aún su título.
 */
import { cn, Skeleton } from "@odentia/ui"
import { PageShell, SkeletonRegion } from "@odentia/ui-patterns"

/** Una línea de `text-sm` (20 px de alto). */
function TextSm({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-4 max-w-full", className)} />
}

/** Una línea de `text-xs` (16 px de alto). */
function TextXs({ className }: { className?: string }) {
  return <Skeleton className={cn("my-0.5 h-3 max-w-full", className)} />
}

function BlockTitle({ title }: { title?: string }) {
  return title ? <h2 className="font-semibold">{title}</h2> : <Skeleton className="my-1 h-4 w-36" />
}

/** «Tu próxima cita», el mismo bloque de `AppointmentBlock`. */
export function PortalAppointmentSkeleton({ title }: { title?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <BlockTitle title={title} />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <div className="flex flex-col gap-0.5">
        <Skeleton className="my-1 h-4 w-56 max-w-full" />
        <TextSm className="w-72" />
        <TextSm className="w-52" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-11 w-24 rounded-3xl" />
        <Skeleton className="h-11 w-24 rounded-3xl" />
        <Skeleton className="h-11 w-24 rounded-3xl" />
      </div>
    </section>
  )
}

/** «Por decidir»: una fila por presupuesto, con su botón. */
export function PortalBudgetsSkeleton({ title }: { title?: string }) {
  return (
    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <BlockTitle title={title} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TextSm className="w-64" />
        <Skeleton className="h-11 w-36 rounded-3xl" />
      </div>
    </section>
  )
}

/** Lo que va dentro de «Tus documentos». */
export function PortalDocumentsSkeleton() {
  return (
    <div className="grid gap-2">
      {[0, 1].map((row) => (
        <div key={row} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <div className="min-w-0 flex-1">
            <TextSm className="w-48" />
            <TextXs className="w-36" />
          </div>
          <Skeleton className="h-8 w-16 rounded-3xl" />
        </div>
      ))}
    </div>
  )
}

/** Lo que va dentro de «Tu cuenta». */
export function PortalAccountSkeleton() {
  return (
    <div className="grid gap-4">
      <div className="rounded-md border p-4">
        <p className="text-sm font-medium">Saldo</p>
        <Skeleton className="mt-1 h-8 w-32" />
        <TextXs className="w-32" />
        <div className="mt-2 grid grid-cols-2 gap-1">
          <p className="text-sm text-muted-foreground">Debe</p>
          <TextSm className="ml-auto w-16" />
          <p className="text-sm text-muted-foreground">Pagado</p>
          <TextSm className="ml-auto w-16" />
        </div>
      </div>
      <div className="grid gap-2">
        <p className="text-sm font-medium">Historial</p>
        {[0, 1].map((row) => (
          <div key={row} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <TextSm className="w-40" />
            </div>
            <TextSm className="w-16" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Antes de saber el alcance de la sesión: cita y presupuestos, lo más común. */
export function PortalSkeleton() {
  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <Skeleton className="my-0.5 h-6 w-48 max-w-full" />
          <TextSm className="w-72" />
        </div>
        <Skeleton className="h-11 w-32 rounded-3xl" />
      </header>
      <div className="flex flex-col gap-4">
        <PortalAppointmentSkeleton />
        <PortalBudgetsSkeleton />
      </div>
    </>
  )
}

export function PortalPageSkeleton() {
  return (
    <PageShell maxWidth="md">
      <SkeletonRegion message="Abriendo tu portal…">
        <PortalSkeleton />
      </SkeletonRegion>
    </PageShell>
  )
}
