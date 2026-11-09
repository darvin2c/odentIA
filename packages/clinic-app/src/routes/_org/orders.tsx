import { Tabs, TabsTrigger } from "@odentia/ui"
import {
  DataTable,
  EmptyState,
  PageHeader,
  PageShell,
  ScrollingTabsList,
  SkeletonRegion,
  useListSearch,
} from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { PackageCheck } from "lucide-react"
import { useMemo } from "react"
import { dueOf, OrderDetailDrawer } from "../../components/orders/order-detail"
import { SaleDrawer } from "../../components/orders/sale-drawer"
import { PersonLink } from "../../components/person-link"
import { OrdersPageSkeleton, OrdersSkeleton } from "../../components/skeletons/orders"
import { formatDate } from "../../lib/clinical-journey"
import { useCan, usePermission } from "../../lib/crm"
import {
  fetchOrders,
  ORDER_VIEWS,
  type OrderRow,
  type OrderView,
  orderKeys,
  orderViewOf,
} from "../../lib/orders"
import { QueryErrorState } from "../../lib/query-error"
import { canSellOrders, ordersPrimary } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"

interface OrdersSearch {
  vista?: string
  /** El pedido abierto al lado. */
  pedido?: string
  /** «Vender» abierto (`1`), con la persona y la receta que trae el enlace. */
  vender?: 1
  persona?: string
  receta?: string
}

const text = (value: unknown) => (typeof value === "string" && value ? value : undefined)

/** Lo que dice cada vista sin pedidos. */
const EMPTY: Record<OrderView["value"], { title: string; description: string }> = {
  abiertos: {
    title: "Sin pedidos abiertos",
    description: "Cada venta con pedido aparece aquí hasta que se entrega.",
  },
  atrasados: { title: "Nada atrasado", description: "Ningún pedido pasó el día prometido." },
  listos: {
    title: "Nada listo para entregar",
    description: "Cuando un pedido esté revisado y listo, aparece aquí.",
  },
  entregados: { title: "Nada entregado todavía", description: "Lo entregado queda aquí." },
  anulados: { title: "Ningún pedido anulado", description: "Lo anulado queda aquí con su motivo." },
}

export const Route = createFileRoute("/_org/orders")({
  /** La pantalla los lee con `useListSearch`; aquí solo se tipan para los enlaces (la receta abre la venta). */
  validateSearch: (search: Record<string, unknown>): OrdersSearch => ({
    ...search,
    vista: text(search.vista),
    pedido: text(search.pedido),
    vender: search.vender === 1 || search.vender === "1" ? 1 : undefined,
    persona: text(search.persona),
    receta: text(search.receta),
  }),
  pendingComponent: OrdersPageSkeleton,
  component: OrdersPage,
})

/**
 * Pedidos (ADR 0168): lo que la clínica encargó al taller o al laboratorio, del
 * más próximo a vencer al más lejano, con sus vistas en la dirección
 * (`?vista=abiertos|atrasados|listos|entregados|anulados`). Toda la fila abre el
 * pedido al lado (`?pedido=`). Es común, pero solo la usa el producto que vende
 * con pedido (`productUi().orders`): en otro dice que no hay.
 */
function OrdersPage() {
  const orders = productUi().orders
  if (!orders) {
    return (
      <PageShell className="flex flex-col gap-4">
        <PageHeader title="Pedidos" />
        <EmptyState
          icon={PackageCheck}
          title="Esta clínica no trabaja con pedidos"
          description="Los pedidos al taller o al laboratorio no están disponibles aquí."
        />
      </PageShell>
    )
  }
  return <OrdersWorkspace />
}

function OrdersWorkspace() {
  const orders = productUi().orders
  const can = useCan()
  const canSell = canSellOrders(can)
  const seesMoney = usePermission("finance.read")
  const navigate = useNavigate()
  const listSearch = useListSearch()
  const view = orderViewOf(listSearch.get("vista"))
  const openId = listSearch.get("pedido") ?? null
  const selling = canSell && listSearch.get("vender") === "1"

  const list = useQuery({
    queryKey: orderKeys.list(view.status),
    queryFn: () => fetchOrders(view.status),
  })
  // Cuántos van atrasados, en su pestaña: la misma consulta cuando es la vista abierta.
  const overdue = useQuery({
    queryKey: orderKeys.list("atrasados"),
    queryFn: () => fetchOrders("atrasados"),
  })
  const overdueCount = overdue.data?.length

  // «Vender» vive en la dirección: un enlace (la receta de la ficha) lo abre con lo que trae.
  const openSale = () =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        vender: 1,
        persona: undefined,
        receta: undefined,
      }),
    } as never)
  const closeSale = (orderId?: string) =>
    void navigate({
      to: ".",
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        vender: undefined,
        persona: undefined,
        receta: undefined,
        pedido: orderId ?? prev.pedido,
      }),
    } as never)

  const rows = list.data ?? []
  const columns = useMemo<ColumnDef<OrderRow>[]>(
    () => [
      {
        id: "numero",
        header: "N.º",
        meta: { view: { primary: true } },
        cell: ({ row }) => <span className="tabular-nums">N.º {row.original.orderNumber}</span>,
      },
      {
        id: "que",
        header: "Qué es",
        meta: { view: { role: "title" } },
        cell: ({ row }) => (
          <span className="flex min-w-0 max-w-sm flex-col items-start gap-0.5 whitespace-normal [overflow-wrap:anywhere]">
            <span className="font-medium">{row.original.title}</span>
            <span className="text-sm text-muted-foreground">Lo hace: {row.original.maker}</span>
          </span>
        ),
      },
      {
        id: "persona",
        header: "Para quién",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <PersonLink patientId={row.original.patientId}>{row.original.patientName}</PersonLink>
        ),
      },
      {
        id: "cuando",
        header: "Para cuándo",
        meta: { view: { primary: true } },
        cell: ({ row }) => (
          <span className={row.original.overdue ? "font-medium text-destructive" : undefined}>
            {row.original.overdue ? "Atrasado · " : ""}
            {formatDate(row.original.promisedOn)}
          </span>
        ),
      },
      {
        id: "estado",
        header: "Cómo va",
        meta: { view: { primary: true } },
        // Uno rehecho ya no se trabaja: lo dice en palabras y sigue en el otro.
        cell: ({ row }) =>
          row.original.remadeAs
            ? `${row.original.statusLabel} · se rehízo`
            : row.original.statusLabel,
      },
      ...(seesMoney
        ? [
            {
              id: "falta",
              header: "Por pagar",
              meta: { view: { primary: true } },
              cell: ({ row }) => {
                // «Falta S/ 120.00»; anulado, lo cobrado que quedó en su cuenta.
                const due = dueOf(row.original)
                return due ? (
                  <span className="tabular-nums">
                    {due.label === "Falta pagar" ? "Falta" : due.label} {due.amount}
                  </span>
                ) : null
              },
            } satisfies ColumnDef<OrderRow>,
          ]
        : []),
    ],
    [seesMoney],
  )
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })

  const emptyView = EMPTY[view.value]

  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title="Pedidos" primary={ordersPrimary(can, openSale)} />
      <Tabs
        value={view.value}
        onValueChange={(next) =>
          listSearch.setParams(
            { vista: String(next) === ORDER_VIEWS[0].value ? undefined : String(next) },
            { replace: true },
          )
        }
      >
        <ScrollingTabsList aria-label="Qué pedidos ver">
          {ORDER_VIEWS.map((item) => (
            <TabsTrigger
              key={item.value}
              value={item.value}
              className="shrink-0 min-h-11 px-3 sm:min-h-9"
            >
              {item.label}
              {item.value === "atrasados" && overdueCount !== undefined ? (
                <span className="tabular-nums opacity-80"> {overdueCount}</span>
              ) : null}
            </TabsTrigger>
          ))}
        </ScrollingTabsList>
      </Tabs>
      {list.isPending ? (
        <SkeletonRegion message="Cargando los pedidos…">
          <OrdersSkeleton />
        </SkeletonRegion>
      ) : list.isError && rows.length === 0 ? (
        <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title={emptyView.title}
          description={emptyView.description}
          {...(canSell && orders && view.value === "abiertos"
            ? { actionLabel: orders.sellLabel, onAction: openSale }
            : {})}
        />
      ) : (
        <DataTable
          className="[&_td]:whitespace-normal [&_td]:[overflow-wrap:anywhere]"
          table={table}
          isFetching={list.isFetching}
          onRowClick={(row: OrderRow) => listSearch.setParam("pedido", row.id)}
          isRowActive={(row: OrderRow) => row.id === openId}
        />
      )}
      <OrderDetailDrawer
        orderId={openId}
        onClose={() => listSearch.setParam("pedido", undefined)}
        onOpen={(id) => listSearch.setParam("pedido", id)}
      />
      {selling && orders ? (
        <SaleDrawer
          key={`${listSearch.get("persona") ?? ""}:${listSearch.get("receta") ?? ""}`}
          orders={orders}
          presetPatientId={listSearch.get("persona")}
          presetReferenceId={listSearch.get("receta")}
          onClose={() => closeSale()}
          onSold={(orderId) => closeSale(orderId)}
        />
      ) : null}
    </PageShell>
  )
}
