/**
 * Cobros y planes (`routes/_app/billing.tsx`): una sola página larga, sin
 * pestañas, con una sección por tema. Cada sección tiene el suyo porque se carga
 * por separado.
 */
import { Skeleton } from "@odentia/ui"
import { Plus } from "lucide-react"
import { ControlSkeleton, PageLoading, ProductFilterSkeleton, RowSkeleton, TextSm, TextXs } from "./page-loading"

export function BillingPendingSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1].map((row) => (
        <RowSkeleton key={row} value actions={["w-12", "w-24", "w-20"]} />
      ))}
    </ul>
  )
}

export function BillingSubscriptionsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2, 3].map((row) => (
        <RowSkeleton key={row} value actions={["w-24"]} />
      ))}
    </ul>
  )
}

/** Una lista por producto, con sus planes. */
export function BillingPlansSkeleton() {
  return (
    <>
      {[0, 1].map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <TextSm className="w-48" />
          <ul className="flex flex-col gap-2">
            {[0, 1].map((row) => (
              <RowSkeleton key={row} value actions={["w-16"]} />
            ))}
          </ul>
        </div>
      ))}
    </>
  )
}

export function BillingMethodsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1].map((row) => (
        <li key={row} className="rounded-lg border p-4">
          <TextSm className="w-32" />
          <TextXs className="mt-1.5 w-64" />
        </li>
      ))}
    </ul>
  )
}

export function BillingHistorySkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <RowSkeleton key={row} value actions={["w-12", "w-20", "w-20"]} />
      ))}
    </ul>
  )
}

/** «Alta de clínicas nuevas»: un grupo de dos opciones por producto. */
export function BillingSignupSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {[0, 1].map((group) => (
        <div key={group} className="flex flex-col gap-2">
          <TextSm className="w-20" />
          <div className="grid w-full gap-3">
            {[0, 1].map((option) => (
              <div key={option} className="flex items-start gap-3 rounded-lg border p-3">
                <Skeleton className="mt-0.5 size-4 shrink-0 rounded-full" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <TextSm className="w-32" />
                  <TextSm className="w-full" />
                  <TextSm className="w-2/3" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** Condiciones comerciales: una tarjeta por grupo, con su «Cambiar». */
export function CommercialTermsSkeleton() {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,17rem),1fr))] gap-2">
      {[0, 1, 2, 3, 4].map((card) => (
        <div key={card} className="flex flex-col gap-1.5 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-2">
            <TextSm className="w-1/2" />
            <Skeleton className="h-8 w-20 shrink-0 rounded-3xl" />
          </div>
          <div className="flex flex-col gap-1.5">
            <TextSm className="w-full" />
            <TextSm className="w-4/5" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function BillingPageSkeleton() {
  return (
    <PageLoading
      title="Cobros y planes"
      subtitle="Suscripciones, comprobantes por confirmar, cargos, planes y medios"
      primary={{ label: "Nuevo plan", icon: <Plus aria-hidden />, disabled: true }}
      menu={[
        { label: "Nuevo medio", disabled: true },
        { label: "Registrar pago", disabled: true },
      ]}
    >
      <ProductFilterSkeleton />
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Comprobantes por confirmar</h2>
        <BillingPendingSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">Suscripciones</h2>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span>Estado</span>
            <ControlSkeleton className="w-44" />
          </div>
        </div>
        <BillingSubscriptionsSkeleton />
      </section>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-base font-semibold">Alta de clínicas nuevas</h2>
          <p className="text-sm text-muted-foreground">Cada producto decide si se entra solo con invitación o libre.</p>
        </div>
        <BillingSignupSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Planes</h2>
        <BillingPlansSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Condiciones comerciales</h2>
        <CommercialTermsSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Medios de pago</h2>
        <BillingMethodsSkeleton />
      </section>
    </PageLoading>
  )
}
