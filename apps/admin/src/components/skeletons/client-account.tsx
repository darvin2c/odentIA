/**
 * Las pestañas de la ficha del cliente que son de la cuenta (ARM): Alta, Plan
 * y pagos, Uso, Soporte y Documentos. Las mismas rejillas y clases que cada
 * pestaña, con los títulos reales; no piden datos. La ficha las usa también
 * mientras llega su código, según la pestaña de la dirección.
 */
import { cn, Skeleton } from "@odentia/ui"
import { useIsAdmin } from "../../lib/session"
import { BillingHistorySkeleton } from "./billing"
import { OrgBillingSkeleton, OrgSummarySkeleton } from "./organization-detail"
import { RowSkeleton, TextSm, TextXs } from "./page-loading"

/** La rejilla de Alta: pasos · registro de la carga · Kairós. */
export const ONBOARDING_GRID = "grid gap-4 xl:grid-cols-[17rem_minmax(0,1fr)_17rem]"

function Lines({ count, className }: { count: number; className?: string }) {
  return (
    <ul className={cn("flex flex-col divide-y", className)}>
      {Array.from({ length: count }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: filas de relleno, siempre las mismas.
        <li key={index} className="flex gap-2 py-2">
          <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <TextSm className="w-40" />
            <TextXs className="w-32" />
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ClientOnboardingSkeleton({ hasAccount = true }: { hasAccount?: boolean }) {
  const isAdmin = useIsAdmin()
  return (
    <div className="flex flex-col gap-4">
      <div className={ONBOARDING_GRID}>
        <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 className="text-base font-medium">Pasos del alta</h2>
          <Lines count={6} />
        </section>
        <div className="flex min-w-0 flex-col gap-4">
          {isAdmin && hasAccount ? (
            // Las dos secciones del registro de la carga (`OrgLoadRecord`), sin otra región.
            ["Informes enviados", "Cargas"].map((title) => (
              <section key={title} className="flex flex-col gap-2 rounded-xl border bg-card p-4">
                <h2 className="text-base font-medium">{title}</h2>
                <TextSm className="w-3/4" />
                <TextSm className="w-1/2" />
              </section>
            ))
          ) : (
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <TextSm className="w-64" />
            </section>
          )}
        </div>
        <section className="flex flex-col gap-2 rounded-xl border border-agent-border bg-agent-soft p-4">
          <h2 className="text-base font-medium">Kairós propone</h2>
          <TextSm className="w-48" />
          <TextXs className="w-40" />
        </section>
      </div>
    </div>
  )
}

export function ClientBillingSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <OrgBillingSkeleton />
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Comprobantes y pagos</h2>
          <Skeleton className="h-8 w-32 rounded-3xl" />
        </div>
        <BillingHistorySkeleton />
      </section>
    </div>
  )
}

export function ClientUsageSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
        <h2 className="text-base font-medium">Cómo va</h2>
        <TextSm className="w-80" />
      </section>
      <OrgSummarySkeleton />
    </div>
  )
}

export function ClientSupportSkeleton() {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Casos de soporte</h2>
        <TextSm className="w-32" />
      </div>
      <ul className="flex flex-col gap-2">
        <RowSkeleton />
        <RowSkeleton />
      </ul>
    </section>
  )
}

export function ClientFilesSkeleton() {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Documentos</h2>
        <Skeleton className="h-8 w-20 rounded-3xl" />
      </div>
      <ul className="flex flex-col gap-2">
        <RowSkeleton actions={["w-24"]} />
        <RowSkeleton actions={["w-24"]} />
        <RowSkeleton actions={["w-24"]} />
      </ul>
    </section>
  )
}
