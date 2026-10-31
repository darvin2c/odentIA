/**
 * Esqueletos de Comisiones, con las clases de `finance/CommissionsPanel.tsx`:
 * «Mis comisiones» (lo que me corresponde, de qué sale y los meses anteriores)
 * y el mes de toda la clínica (una fila por profesional).
 */
import { Skeleton } from "@odentia/ui"
import { ChevronRight } from "lucide-react"

const LINES = [
  { name: "w-40", detail: "w-3/4" },
  { name: "w-32", detail: "w-2/3" },
  { name: "w-44", detail: "w-4/5" },
  { name: "w-36", detail: "w-3/5" },
]

export function MyCommissionsSkeleton() {
  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      <section className="elevated min-w-0 rounded-xl border bg-card p-5">
        <p className="text-sm font-medium text-muted-foreground">Me corresponde</p>
        <Skeleton className="mt-1 h-9 w-44" />
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-3.5 w-48 max-w-full" />
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        <h2 className="text-base font-semibold">De qué sale</h2>
        <ul className="elevated flex min-w-0 flex-col divide-y rounded-xl border bg-card">
          {LINES.map((line) => (
            <li key={line.name} className="flex min-w-0 items-start gap-3 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
                <Skeleton className={`h-3.5 max-w-full ${line.name}`} />
                <Skeleton className={`h-3 ${line.detail}`} />
              </div>
              <Skeleton className="my-1 h-3.5 w-16 shrink-0" />
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Cuenta lo que ya se cobró de lo que atendiste. Lo atendido que aún no se cobra entra
          cuando el paciente pague.
        </p>
      </section>

      <section className="flex min-w-0 flex-col gap-2">
        {/* Solo existe si ya hubo meses: su título no se anticipa. */}
        <Skeleton className="h-6 w-40" />
        <ul className="elevated flex min-w-0 flex-col divide-y rounded-xl border bg-card">
          {["w-24", "w-20"].map((width) => (
            <li key={width} className="flex min-w-0 items-center gap-3 px-4 py-3">
              <span className="flex min-w-0 flex-1 flex-col gap-2 py-1">
                <Skeleton className={`h-3.5 ${width}`} />
                <Skeleton className="h-3 w-32 max-w-full" />
              </span>
              <Skeleton className="h-4 w-16 shrink-0" />
              <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

/** Dentro de `flex flex-col gap-4`, en lugar de la sección «Profesionales». */
export function CommissionsMonthSkeleton() {
  return (
    <section className="elevated min-w-0 rounded-xl border bg-card">
      <ul className="flex min-w-0 flex-col divide-y">
        {LINES.map((line) => (
          <li key={line.name} className="flex w-full min-w-0 items-center justify-start gap-3 px-4 py-3">
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <span className="flex min-w-0 flex-1 flex-col gap-2 py-1">
              <Skeleton className={`h-3.5 max-w-full ${line.name}`} />
              <Skeleton className={`h-3 ${line.detail}`} />
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <Skeleton className="h-5 w-20" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
