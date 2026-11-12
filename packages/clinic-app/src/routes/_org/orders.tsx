import { Tabs, TabsTrigger, toast } from "@odentia/ui"
import {
  common,
  DataTable,
  DraftKeptInPage,
  EmptyState,
  FilterBar,
  ListSearchScope,
  normalizeSearchText,
  PageHeader,
  PageShell,
  ScrollingTabsList,
  SkeletonRegion,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { PackageCheck } from "lucide-react"
import { lazy, Suspense, useMemo } from "react"
import { OrderDetailDrawer } from "../../components/orders/order-detail"
import { SaleDrawer } from "../../components/orders/sale-drawer"
import { PersonLink } from "../../components/person-link"
import { OrdersPageSkeleton, OrdersSkeleton } from "../../components/skeletons/orders"
import { formatDate } from "../../lib/clinical-journey"
import { useCan, usePermission } from "../../lib/crm"
import { invalidateFinance } from "../../lib/finance-cash"
import {
  dueOf,
  fetchOrders,
  invalidateOrders,
  ORDER_VIEWS,
  type OrderRow,
  type OrderView,
  orderKeys,
  orderViewOf,
} from "../../lib/orders"
import { useOrgProfile } from "../../lib/org"
import { usePrivateListSearch } from "../../lib/private-list-search"
import { QueryErrorState } from "../../lib/query-error"
import { canSellOrders, ordersPrimary } from "../../lib/screen-rules"
import { productUi } from "../../product/product-ui"

// El ticket del adelanto se abre al lado, el mismo de Cobros; pesa, así que llega al pedirlo.
const TicketPanel = lazy(() =>
  import("../../components/finance/ticket-panel").then((m) => ({ default: m.TicketPanel })),
)

interface OrdersSearch {
  vista?: string
  /** Buscar en la lista: número, persona, qué es o quién lo hace. */
  q?: string
  /** El pedido abierto al lado. */
  pedido?: string
  /** El ticket del adelanto abierto al lado, recién vendido. */
  ticket?: string
  /** «Vender» abierto (`1`), con la persona y la receta que trae el enlace. */
  vender?: 1
  persona?: string
  receta?: string
}

/** El tope de la lista del servidor (`listJobOrders`): con tantos, puede haber más. */
const LIST_LIMIT = 500

/** Lo que encuentra el buscador en una fila: su número, la persona, qué es y quién lo hace. */
function rowMatches(row: OrderRow, words: string[]): boolean {
  const haystack = normalizeSearchText(
    [`${row.orderNumber}`, `n.º ${row.orderNumber}`, row.patientName, row.title, row.maker].join(
      " ",
    ),
  )
  return words.every((word) => haystack.includes(word))
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
    q: text(search.q),
    pedido: text(search.pedido),
    ticket: text(search.ticket),
    vender: search.vender === 1 || search.vender === "1" ? 1 : undefined,
    persona: text(search.persona),
    receta: text(search.receta),
  }),
  pendingComponent: OrdersPageSkeleton,
  component: OrdersPage,
})

/**
 * Pedidos (ADR 0171): lo que la clínica encargó al taller o al laboratorio, del
 * más próximo a vencer al más lejano, con sus vistas en la dirección
 * (`?vista=abiertos|atrasados|listos|entregados|anulados`) y el buscador sobre lo
 * que llegó (`?q=`). Toda la fila abre el pedido al lado (`?pedido=`); el ticket
 * de un adelanto recién cobrado, también (`?ticket=`). Es común, pero solo la usa
 * el producto que vende con pedido (`productUi().orders`): en otro dice que no hay.
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
  const queryClient = useQueryClient()
  const profile = useOrgProfile().data
  // Lo buscado (un nombre, un teléfono) no va en la dirección (repaso final de la ficha, M4).
  const listSearch = usePrivateListSearch()
  const view = orderViewOf(listSearch.get("vista"))
  const q = listSearch.get("q") ?? ""
  const openId = listSearch.get("pedido") ?? null
  const ticketId = listSearch.get("ticket") ?? null
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
  // Cerrar la venta no es un paso más del historial: «Atrás» no la vuelve a abrir.
  const closeSale = (orderId?: string) =>
    void navigate({
      to: ".",
      replace: true,
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        vender: undefined,
        persona: undefined,
        receta: undefined,
        pedido: orderId ?? prev.pedido,
      }),
    } as never)
  const onSold = (order: { id: string; orderNumber: number }, soldTicketId: string | null) => {
    closeSale(order.id)
    toast.success(
      `Pedido N.º ${order.orderNumber} registrado${soldTicketId ? ", con su adelanto" : ""}.`,
      soldTicketId
        ? {
            action: {
              label: "Ver el ticket",
              onClick: () => listSearch.setParam("ticket", soldTicketId),
            },
          }
        : undefined,
    )
  }

  const loaded = list.data ?? []
  const words = normalizeSearchText(q.trim()).split(/\s+/).filter(Boolean)
  const rows = words.length > 0 ? loaded.filter((row) => rowMatches(row, words)) : loaded
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
          <span className="flex min-w-0 max-w-sm flex-col items-start gap-0.5 [overflow-wrap:break-word] [&>*]:max-w-full">
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
                // «Falta S/ 120.00»; anulado, lo que se sigue debiendo.
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
  const filtered = words.length > 0

  return (
    // Lo que se escribe en la venta sigue montado al cambiar de vista, buscar o abrir un pedido.
    <DraftKeptInPage>
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
        <ListSearchScope value={listSearch}>
          <FilterBar
            filters={[]}
            sortOptions={[]}
            searchPlaceholder="Número, persona, qué es o quién lo hace"
            searchLabel="Buscar en pedidos"
            resetKeys={["q"]}
          />
        </ListSearchScope>
        {list.isPending ? (
          <SkeletonRegion message="Cargando los pedidos…">
            <OrdersSkeleton />
          </SkeletonRegion>
        ) : list.isError && rows.length === 0 ? (
          <QueryErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          filtered ? (
            <EmptyState
              title={common.filters.noResults}
              description="Ningún pedido de esta vista coincide con lo que buscas."
            />
          ) : (
            <EmptyState
              icon={PackageCheck}
              title={emptyView.title}
              description={emptyView.description}
              {...(canSell && orders && view.value === "abiertos"
                ? { actionLabel: orders.sellLabel, onAction: openSale }
                : {})}
            />
          )
        ) : (
          <div className="flex flex-col gap-2">
            <DataTable
              wrap
              table={table}
              isFetching={list.isFetching}
              onRowClick={(row: OrderRow) => listSearch.setParam("pedido", row.id)}
              isRowActive={(row: OrderRow) => row.id === openId}
            />
            {loaded.length >= LIST_LIMIT ? (
              // El servidor entrega hasta 500: lo que se trabaja, por el día prometido; lo cerrado, lo último.
              <p className="text-sm text-muted-foreground">
                {view.value === "entregados" || view.value === "anulados"
                  ? `Se muestran los ${LIST_LIMIT} más recientes.`
                  : `Se muestran los ${LIST_LIMIT} más próximos a vencer.`}
              </p>
            ) : null}
          </div>
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
            onSold={onSold}
          />
        ) : null}
        {ticketId && profile ? (
          <Suspense fallback={null}>
            <TicketPanel
              ticketId={ticketId}
              locale={profile.locale}
              timeZone={profile.timezone}
              ticketFooter={profile.ticketFooter}
              onOpen={(id) => listSearch.setParam("ticket", id)}
              onClose={() => listSearch.setParam("ticket", undefined)}
              onChanged={() => {
                invalidateFinance(queryClient)
                invalidateOrders(queryClient)
              }}
            />
          </Suspense>
        ) : null}
      </PageShell>
    </DraftKeptInPage>
  )
}
