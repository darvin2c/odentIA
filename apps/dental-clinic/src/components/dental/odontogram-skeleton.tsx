/**
 * Esqueletos del odontograma y del periodontograma. Sin datos ni pantallas
 * pesadas: los declara el producto al arrancar. Mismas clases que
 * `OdontogramStudio` y `PeriodontogramaTab`. Las dos columnas del estudio se
 * deciden por el ancho de su contenedor (960 px, `useContainerWide`): aquí, con
 * la misma medida en una consulta de contenedor.
 */
import { Button, Skeleton } from "@odentia/ui"
import { SkeletonRegion } from "@odentia/ui-patterns"

/** Las piezas de un arco, repartidas sobre media elipse: arriba abre hacia abajo y abajo, hacia arriba. */
const ARCH_SLOTS = Array.from({ length: 16 }, (_, index) => {
  const angle = (Math.PI * (index + 0.5)) / 16
  // Redondeado: servidor y navegador no siempre calculan el último decimal igual y la hidratación se queja.
  return { x: Number((50 - 44 * Math.cos(angle)).toFixed(2)), rise: Number((42 * Math.sin(angle)).toFixed(2)) }
})

function ArchShape() {
  return (
    <div className="relative mx-auto aspect-[10/9] w-full min-w-0 max-w-[520px]">
      {ARCH_SLOTS.flatMap((slot, index) => [
        <Skeleton
          key={`upper-${index}`}
          className="absolute size-[6%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${slot.x}%`, top: `${(48 - slot.rise).toFixed(2)}%` }}
        />,
        <Skeleton
          key={`lower-${index}`}
          className="absolute size-[6%] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${slot.x}%`, top: `${(52 + slot.rise).toFixed(2)}%` }}
        />,
      ])}
    </div>
  )
}

function WaitingButton({ children }: { children: string }) {
  return (
    <Button type="button" size="sm" variant="outline" disabled>
      {children}
    </Button>
  )
}

/** `OdontogramaTab`: el arco con sus controles, la evolución y cuánto queda en el plan. */
export function OdontogramSkeleton() {
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <div className="grid min-w-0 grid-cols-1 gap-4 @min-[960px]:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]">
        <section className="flex min-w-0 flex-col gap-4 self-start rounded-lg border p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold">Odontograma</h3>
            <div className="flex flex-wrap gap-2">
              <WaitingButton>Permanente (32)</WaitingButton>
              <WaitingButton>Mixta</WaitingButton>
              <WaitingButton>Temporal (20)</WaitingButton>
            </div>
          </div>
          <Skeleton className="my-0.5 h-3 w-64 max-w-full" />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <WaitingButton>Seleccionar varias</WaitingButton>
            </div>
            <div className="flex w-full flex-col gap-2 sm:w-52">
              <span className="text-sm font-medium">Ver estado al</span>
              <Skeleton className="h-9 w-full rounded-3xl" />
            </div>
          </div>
          <div className="-mx-3 sm:mx-0">
            <ArchShape />
          </div>
          <p className="text-xs text-muted-foreground">Haz clic en una pieza para abrir su registro clínico.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-red-600" />
              Patología, mal estado o temporal
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-blue-600" />
              Buen estado o característica no patológica
            </span>
          </div>
        </section>
        <section className="min-h-[70px] min-w-0 self-start rounded-sm bg-card">
          <div className="min-h-11 px-4 py-3">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Odontograma</span>
            <span className="block text-lg font-semibold">Evolución</span>
          </div>
        </section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
        <Skeleton className="my-0.5 h-4 w-64 max-w-full" />
        <WaitingButton>Ver en Plan</WaitingButton>
      </div>
    </div>
  )
}

/** `PeriodontogramaTab`: su título y las visitas. */
export function PeriodontogramSkeleton() {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-heading text-base font-medium">Periodontograma</h2>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {[0, 1].map((row) => (
          <li key={row} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div>
                <Skeleton className="my-0.5 h-5 w-32" />
                <Skeleton className="my-0.5 h-4 w-64 max-w-full" />
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-36 rounded-full" />
              </div>
            </div>
            <Skeleton className="h-8 w-16 rounded-full" />
          </li>
        ))}
      </ul>
    </section>
  )
}

export function OdontogramLoading() {
  return (
    <SkeletonRegion message="Cargando odontograma…">
      <OdontogramSkeleton />
    </SkeletonRegion>
  )
}

export function PeriodontogramLoading() {
  return (
    <SkeletonRegion message="Cargando el periodontograma…">
      <PeriodontogramSkeleton />
    </SkeletonRegion>
  )
}
