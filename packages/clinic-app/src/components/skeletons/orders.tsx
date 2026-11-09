/**
 * Esqueleto de Pedidos: desde `md` la tabla con sus columnas; en el teléfono, las
 * filas de la vista lista. Las vistas y el buscador se pintan reales; el número de
 * atrasados es un dato que aún no llega y no se dibuja.
 */
import { Skeleton, TabsTrigger } from "@odentia/ui"
import { FilterBar, ScrollingTabsList, useListSearch } from "@odentia/ui-patterns"
import { useCan, usePermission } from "../../lib/crm"
import { ORDER_VIEWS, orderViewOf } from "../../lib/orders"
import { ordersPrimary } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"
import { LabeledTableSkeleton } from "./labeled-table"
import { PageLoading } from "./page-loading"
import { ParamTabs } from "./param-tabs"

export function OrdersSkeleton() {
  // «Falta» es de quien ve la caja: la columna está o no desde el primer pintado.
  const seesMoney = usePermission("finance.read")
  return (
    <LabeledTableSkeleton
      columns={[
        { label: "N.º", cell: <Skeleton className="h-3.5 w-8" /> },
        {
          label: "Qué es",
          cell: (
            <div className="flex min-w-0 max-w-sm flex-col items-start gap-2">
              <Skeleton className="h-3.5 w-48 max-w-full" />
              <Skeleton className="h-3 w-32 max-w-full" />
            </div>
          ),
        },
        { label: "Para quién", cell: <Skeleton className="h-3.5 w-28" /> },
        { label: "Para cuándo", cell: <Skeleton className="h-3.5 w-20" /> },
        { label: "Cómo va", cell: <Skeleton className="h-3.5 w-24" /> },
        ...(seesMoney ? [{ label: "Por pagar", cell: <Skeleton className="h-3.5 w-20" /> }] : []),
      ]}
      title={
        <span className="flex flex-col gap-2 py-0.5">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3 w-3/5" />
        </span>
      }
      summary={
        <>
          <Skeleton className="my-1 h-3 w-24" />
          <Skeleton className="my-1 h-3 w-20" />
          <Skeleton className="my-1 h-3 w-16" />
        </>
      }
    />
  )
}

export function OrdersPageSkeleton() {
  const { get } = useListSearch()
  const can = useCan()
  const view = orderViewOf(get("vista"))
  // Un producto sin pedidos dice que no los hay: sin pestañas que luego se van.
  if (!productUi().orders) return <PageLoading title="Pedidos">{null}</PageLoading>
  return (
    <PageLoading title="Pedidos" className="flex flex-col gap-6" primary={ordersPrimary(can)}>
      <div className="flex flex-col gap-6">
        <ParamTabs param="vista" fallback={ORDER_VIEWS[0].value} value={view.value}>
          <ScrollingTabsList aria-label="Qué pedidos ver">
            {ORDER_VIEWS.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                className="shrink-0 min-h-11 px-3 sm:min-h-9"
              >
                {item.label}
              </TabsTrigger>
            ))}
          </ScrollingTabsList>
        </ParamTabs>
        {/* Los mismos textos que el buscador de `routes/_org/orders.tsx`. */}
        <FilterBar
          filters={[]}
          sortOptions={[]}
          searchPlaceholder="Número, persona, qué es o quién lo hace"
          searchLabel="Buscar en pedidos"
          resetKeys={["q"]}
        />
        <OrdersSkeleton />
      </div>
    </PageLoading>
  )
}
