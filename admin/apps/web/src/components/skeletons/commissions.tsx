/** Comisiones (`routes/_app/commissions.tsx`): tres listas con su título real. */
import { Plus } from "lucide-react"
import { PageLoading, RowSkeleton } from "./page-loading"

export function SellersSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1].map((row) => (
        <RowSkeleton key={row} actions={["w-16", "w-20"]} />
      ))}
    </ul>
  )
}

export function PendingCommissionsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1, 2].map((row) => (
        <RowSkeleton key={row} value />
      ))}
    </ul>
  )
}

export function SettlementsSkeleton() {
  return (
    <ul className="flex flex-col gap-2">
      {[0, 1].map((row) => (
        <RowSkeleton key={row} value actions={["w-16"]} />
      ))}
    </ul>
  )
}

export function CommissionsPageSkeleton() {
  return (
    <PageLoading
      title="Comisiones"
      subtitle="Vendedores, cobros confirmados por liquidar y liquidaciones"
      primary={{ label: "Nuevo vendedor", icon: <Plus aria-hidden />, disabled: true }}
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Vendedores</h2>
        <SellersSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Por liquidar</h2>
        <PendingCommissionsSkeleton />
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Liquidaciones</h2>
        <SettlementsSkeleton />
      </section>
    </PageLoading>
  )
}
