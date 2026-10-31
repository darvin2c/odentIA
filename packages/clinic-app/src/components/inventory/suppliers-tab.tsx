/**
 * Proveedores (tablero 13): quién es, cuántas compras y, para quien ve
 * precios, el saldo con el mismo cálculo del pago de compras («Por pagar» o
 * «A favor»), que abre sus compras. Desactivar confirma su consecuencia.
 */
import { Button, toast } from "@odentia/ui"
import { ConfirmDialog, DataTable, EmptyState, RowActions, SearchInput, SkeletonRegion, internationalText, isValidE164, useListSearch } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Truck } from "lucide-react"
import * as React from "react"
import {
  fetchSuppliers,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  moneyText,
  setSupplierActive,
  supplierDocText,
  type SupplierItem,
} from "../../lib/inventory"
import { QueryErrorState } from "../../lib/query-error"
import { SupplierRowsSkeleton } from "../skeletons/inventory"
import { Chip } from "./fields"
import { useInventory } from "./inventory-scope"

/** «RUC 20123456789 · 01 555 1234»: lo que identifica al proveedor en una línea. */
export function supplierFacts(item: SupplierItem): string {
  const phone = item.phone ? (isValidE164(item.phone) ? internationalText(item.phone) : item.phone) : null
  return [supplierDocText(item), phone, item.email].filter(Boolean).join(" · ")
}

export function SuppliersTab() {
  const { can, open } = useInventory()
  const queryClient = useQueryClient()
  const { get } = useListSearch()
  const q = (get("q") ?? "").trim()
  const query = useQuery({
    queryKey: inventoryKeys.suppliers(q),
    queryFn: () => fetchSuppliers(q),
    placeholderData: (previous) => previous,
  })
  const rows = query.data ?? []
  const [confirming, setConfirming] = React.useState<SupplierItem | null>(null)
  const activation = useMutation({
    mutationFn: (input: { item: SupplierItem; isActive: boolean }) => setSupplierActive(input.item.id, input.isActive),
    onSuccess: (_result, input) => {
      setConfirming(null)
      toast.success(input.isActive ? `${input.item.name} está activo otra vez.` : `${input.item.name} quedó desactivado.`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    },
    // Desactivar se confirma en un diálogo: el motivo se dice ahí, no detrás de él.
    onError: (error, input) => {
      if (input.isActive) toast.error(inventoryErrorMessage(error))
    },
  })

  const columns = React.useMemo<ColumnDef<SupplierItem>[]>(() => {
    const list: ColumnDef<SupplierItem>[] = [
      {
        id: "proveedor",
        header: "Proveedor",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const item = row.original
          const facts = supplierFacts(item)
          return (
            <span className="flex min-w-0 flex-col">
              {can.write ? (
                <button type="button" className="min-h-11 text-left font-medium hover:underline sm:min-h-0" onClick={() => open.supplier(item)}>
                  {item.name}
                </button>
              ) : (
                <span className="font-medium">{item.name}</span>
              )}
              {!item.isActive ? <span className="text-xs text-muted-foreground">desactivado</span> : facts ? <span className="text-xs text-muted-foreground">{facts}</span> : null}
            </span>
          )
        },
      },
      {
        id: "compras",
        header: "Compras",
        meta: { view: { primary: true, label: "Compras" } },
        cell: ({ row }) => (
          <span className="tabular-nums">
            <span className="md:hidden">Compras: </span>
            {formatWhole(row.original.orders)}
          </span>
        ),
      },
    ]
    if (can.prices) {
      list.push({
        id: "saldo",
        header: "Saldo",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const item = row.original
          const currency = item.currency
          if (!currency) return null
          if ((item.dueCents ?? 0) > 0)
            return (
              <button type="button" className="rounded-full" onClick={() => open.ordersOf(item.id, "por_pagar")} aria-label={`Ver las compras por pagar de ${item.name}`}>
                <Chip tone="warn">Por pagar {moneyText(item.dueCents ?? 0, currency)}</Chip>
              </button>
            )
          if ((item.creditCents ?? 0) > 0)
            return (
              <button type="button" className="rounded-full" onClick={() => open.ordersOf(item.id)} aria-label={`Ver las compras de ${item.name}`}>
                <Chip tone="soft">A favor {moneyText(item.creditCents ?? 0, currency)}</Chip>
              </button>
            )
          return item.orders > 0 ? (
            <button type="button" className="rounded-full" onClick={() => open.ordersOf(item.id)} aria-label={`Ver las compras de ${item.name}`}>
              <Chip tone="muted">Al día</Chip>
            </button>
          ) : (
            <Chip tone="muted">Al día</Chip>
          )
        },
      })
    }
    if (can.write) {
      list.push({
        id: "actions",
        header: () => <span className="sr-only">Acciones</span>,
        cell: ({ row }) => {
          const item = row.original
          return (
            <div className="text-right">
              <RowActions
                label={`Acciones de ${item.name}`}
                items={[
                  { key: "editar", label: "Editar", onSelect: () => open.supplier(item) },
                  ...(item.orders > 0 ? [{ key: "compras", label: "Ver sus compras", onSelect: () => open.ordersOf(item.id) }] : []),
                  item.isActive
                    ? { key: "desactivar", label: "Desactivar", tone: "danger" as const, onSelect: () => setConfirming(item) }
                    : { key: "reactivar", label: "Reactivar", onSelect: () => activation.mutate({ item, isActive: true }) },
                ]}
              />
            </div>
          )
        },
      })
    }
    return list
  }, [can.prices, can.write, open, activation.mutate])
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 || q || query.isPending ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
          <SearchInput label="Buscar en proveedores" placeholder="Buscar por nombre o documento" expandable isFetching={query.isFetching && q !== ""} />
        </div>
      ) : null}
      {query.isPending ? (
        <SkeletonRegion message="Cargando proveedores…">
          <SupplierRowsSkeleton prices={can.prices} write={can.write} />
        </SkeletonRegion>
      ) : query.isError && rows.length === 0 ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={q ? "Sin resultados" : "Todavía no hay proveedores"}
          description={q ? "Ningún proveedor coincide con lo que buscas." : "Se registran al pedir la primera compra o aquí, con su nombre y teléfono."}
          {...(can.write && !q ? { actionLabel: "+ Proveedor", onAction: () => open.supplier() } : {})}
        />
      ) : (
        <DataTable table={table} isFetching={query.isFetching} onRowClick={can.write ? (item) => open.supplier(item) : undefined} />
      )}
      {query.isError && rows.length > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo actualizar la lista; se conservan los proveedores cargados.{" "}
          <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}
      <ConfirmDialog
        open={confirming !== null}
        title={confirming ? `Desactivar «${confirming.name}»` : "Desactivar proveedor"}
        description="No aparecerá al pedir compras. Sus compras y pagos se quedan."
        confirmLabel="Desactivar"
        cancelLabel="Volver"
        pending={activation.isPending}
        error={activation.error && activation.variables?.isActive === false ? inventoryErrorMessage(activation.error) : null}
        onClose={() => {
          setConfirming(null)
          activation.reset()
        }}
        onConfirm={() => {
          if (confirming) activation.mutate({ item: confirming, isActive: false })
        }}
      />
    </div>
  )
}
