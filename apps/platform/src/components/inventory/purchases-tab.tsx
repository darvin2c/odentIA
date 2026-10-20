/**
 * Compras (tablero 8): lo que falta que llegue y lo que falta pagar, de un
 * vistazo. Filtros «Por llegar», «Por pagar», «Borradores» y «Todas» con sus
 * números; cada fila dice «Llegó» y «Pago» en palabras y se abre al lado
 * (`?orden=`). Recepción ve lo que llega, sin precios ni pagos.
 */
import { Button, Spinner } from "@odentia/ui"
import { DataTable, DataTableSkeleton, EmptyState, useListSearch } from "@odentia/ui-patterns"
import { useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { ShoppingCart, X } from "lucide-react"
import * as React from "react"
import {
  arrivalBadge,
  dayText,
  fetchOrders,
  fetchSuppliers,
  formatWhole,
  inventoryKeys,
  moneyText,
  ORDERS_PAGE,
  PAYMENT_TONE,
  type PurchaseListItem,
  type PurchaseView,
  purchasePaymentState,
  clinicDayOf,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { Chip } from "./fields"
import { useInventory } from "./inventory-scope"

export function toPurchaseView(value: string | undefined, legacyPago: string | undefined, prices: boolean, write: boolean): PurchaseView {
  const wanted = legacyPago === "por_pagar" ? "por_pagar" : value
  if (wanted === "por_pagar") return prices ? "por_pagar" : "por_llegar"
  if (wanted === "borradores") return write ? "borradores" : "por_llegar"
  if (wanted === "todas" || wanted === "por_llegar") return wanted
  return "por_llegar"
}

export function PurchasesTab() {
  const { branchId, can, open } = useInventory()
  const { get, setParams } = useListSearch()
  const view = toPurchaseView(get("ver"), get("pago"), can.prices, can.write)
  const supplierId = get("proveedor") ?? ""
  const openId = get("orden")
  const query = useInfiniteQuery({
    queryKey: inventoryKeys.orders(branchId, view, supplierId),
    queryFn: ({ pageParam }) => fetchOrders(branchId, view, supplierId || undefined, pageParam),
    // Un fallo se dice al momento con «Reintentar», sin reintentos ocultos.
    retry: false,
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < last.total && last.items.length === ORDERS_PAGE ? loaded : undefined
    },
  })
  const pages = query.data?.pages ?? []
  const rows = React.useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.items), [query.data])
  const first = pages[0]
  const total = first?.total ?? 0
  const suppliers = useQuery({ queryKey: inventoryKeys.suppliers(), queryFn: () => fetchSuppliers(), enabled: supplierId !== "" })
  const supplierName = supplierId ? (suppliers.data?.find((item) => item.id === supplierId)?.name ?? rows[0]?.supplierName ?? "este proveedor") : null

  const columns = React.useMemo<ColumnDef<PurchaseListItem>[]>(() => {
    const list: ColumnDef<PurchaseListItem>[] = [
      {
        id: "compra",
        header: "Compra",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const order = row.original
          const when = dayText(clinicDayOf(order.createdAt))
          const facts = [
            order.status === "borrador" ? `borrador del ${when}` : `pedida ${when}`,
            can.prices && order.totalCents !== undefined ? moneyText(order.totalCents, order.currency) : null,
          ]
            .filter(Boolean)
            .join(" · ")
          return (
            <span className="flex min-w-0 flex-col">
              <button type="button" className="min-h-11 text-left font-medium hover:underline sm:min-h-0" onClick={() => open.order(order.id)}>
                {order.label} · {order.supplierName}
              </button>
              <span className="text-xs text-muted-foreground">{facts}</span>
            </span>
          )
        },
      },
      {
        id: "llego",
        header: "Llegó",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const badge = arrivalBadge(row.original.status)
          return <Chip tone={badge.tone}>{badge.label}</Chip>
        },
      },
    ]
    if (can.prices) {
      list.push({
        id: "pago",
        header: "Pago",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const order = row.original
          const state = purchasePaymentState(order, order.balance ?? null, (cents) => moneyText(cents, order.currency))
          return <Chip tone={PAYMENT_TONE[state.tone]}>{state.label}</Chip>
        },
      })
    }
    return list
  }, [can.prices, open])
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })

  const counts = first?.counts
  const views: Array<{ value: PurchaseView; label: string; count?: number }> = [
    { value: "por_llegar", label: "Por llegar", count: counts?.por_llegar },
    ...(can.prices ? [{ value: "por_pagar" as const, label: "Por pagar", count: counts?.por_pagar }] : []),
    ...(can.write ? [{ value: "borradores" as const, label: "Borradores", count: counts?.borradores }] : []),
    { value: "todas", label: "Todas" },
  ]
  const empty: Record<PurchaseView, { title: string; description: string }> = {
    por_llegar: { title: "Nada por llegar", description: "Las compras pedidas aparecen aquí hasta que llega todo." },
    por_pagar: { title: "Nada por pagar", description: "Lo recibido de cada compra ya está pagado." },
    borradores: { title: "Sin borradores", description: "«Pedir lo que falta» en Productos arma uno por proveedor." },
    todas: { title: "Todavía no hay compras", description: "Una compra que ya trajiste se registra de una vez con «Ya la tengo»." },
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
        <fieldset className="flex min-w-0 flex-wrap gap-1.5">
          <legend className="sr-only">Qué compras ver</legend>
          {views.map((item) => {
            const pressed = view === item.value
            return (
              <Button
                key={item.value}
                type="button"
                size="sm"
                variant={pressed ? "default" : "outline"}
                aria-pressed={pressed}
                className="min-h-11 rounded-full sm:min-h-9"
                onClick={() => setParams({ ver: item.value === "por_llegar" ? undefined : item.value, pago: undefined }, { replace: true })}
              >
                {item.label}
                {item.count !== undefined ? <span className="tabular-nums opacity-80">{formatWhole(item.count)}</span> : null}
              </Button>
            )
          })}
        </fieldset>
        {supplierName ? (
          <Button type="button" size="sm" variant="secondary" className="min-h-11 rounded-full sm:min-h-9" onClick={() => setParams({ proveedor: undefined }, { replace: true })}>
            Solo {supplierName}
            <X aria-hidden />
            <span className="sr-only">: quitar el filtro</span>
          </Button>
        ) : null}
      </div>

      {query.isPending ? (
        <DataTableSkeleton columnCount={can.prices ? 3 : 2} label="Cargando compras…" />
      ) : query.isError && rows.length === 0 ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          title={supplierName ? `Sin compras de ${supplierName} aquí` : empty[view].title}
          description={supplierName ? "Prueba con «Todas» o quita el filtro del proveedor." : empty[view].description}
          {...(can.write && !supplierName && view !== "por_pagar" ? { actionLabel: "+ Compra", onAction: () => open.purchase() } : {})}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <DataTable
            table={table}
            isFetching={query.isFetching && !query.isFetchingNextPage}
            onRowClick={(order) => open.order(order.id)}
            isRowActive={(order) => order.id === openId}
          />
          {query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              No se pudo actualizar la lista; se conservan las compras cargadas.{" "}
              <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
                Reintentar
              </Button>
            </p>
          ) : null}
          {total > rows.length ? (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground" role="status">
                Mostrando {formatWhole(rows.length)} de {formatWhole(total)}
              </p>
              {query.hasNextPage ? (
                <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                  {query.isFetchingNextPage ? <Spinner className="size-6" aria-hidden /> : null}
                  Cargar más
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
