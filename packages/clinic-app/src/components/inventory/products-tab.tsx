/**
 * Productos (tableros 3, 4 y 15): «¿qué hay en esta sede y qué tengo que
 * hacer?». Lo urgente arriba (el orden lo da el servidor), dos filtros con sus
 * números, una acción por fila («Pedir» o «Dar de baja») y «Pedir lo que
 * falta» cuando algo hace falta. Recepción ve la misma lista sin «Pedir».
 */
import { Button, cn, toast } from "@odentia/ui"
import { DataTable, EmptyState, RowActions, type RowActionItem, SearchInput, SkeletonRegion, useListSearch, ViewTabs } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef, getCoreRowModel, useReactTable } from "@tanstack/react-table"
import { Package } from "lucide-react"
import * as React from "react"
import {
  createReorderDrafts,
  fetchProducts,
  fetchReorder,
  formatWhole,
  inventoryErrorMessage,
  inventoryKeys,
  newKey,
  type ProductListItem,
  type ProductNeed,
  type ReorderItem,
  stateBadge,
  stockText,
  unitsText,
  writeOffExpired,
} from "../../lib/inventory"
import { isAmbiguousMutationError, QueryErrorState } from "../../lib/query-error"
import { ProductRowsSkeleton } from "../skeletons/inventory"
import { Chip } from "./fields"
import { type PurchasePreset, useInventory } from "./inventory-scope"
import { appWords } from "../../lib/product-words"

export function toNeed(value: string | undefined): ProductNeed | null {
  return value === "hacen_falta" || value === "por_vencer" ? value : null
}

/** «Pedir» de una fila: la fila llega puesta con lo que falta, el último proveedor y su precio. */
export function presetFor(productId: string, suggestion: ReorderItem | undefined): PurchasePreset {
  const last = suggestion?.lastPurchase
  return {
    supplierId: last?.supplierActive ? last.supplierId : undefined,
    lines: [{ productId, quantity: suggestion?.quantity ?? 0, unitCostCents: last?.unitCostCents }],
    notice: suggestion?.inDraft ? `Este producto ya está en el borrador ${suggestion.inDraft.label}.` : undefined,
  }
}

export function ProductsTab() {
  const scope = useInventory()
  const { branchId, branchName, can, open } = scope
  const queryClient = useQueryClient()
  const { get, setParam, setParams } = useListSearch()
  const q = (get("q") ?? "").trim()
  const need = toNeed(get("ver"))
  const openId = get("producto")
  const query = useQuery({
    queryKey: inventoryKeys.products(branchId, q, need ?? ""),
    queryFn: () => fetchProducts(branchId, q, need),
    // Un fallo se dice al momento con «Reintentar», sin reintentos ocultos.
    retry: false,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === branchId ? previous : undefined),
  })
  const list = query.data
  const rows = list?.items ?? []

  // «Pedir» de una fila: busca cuánto falta y a quién se le compró antes.
  const [asking, setAsking] = React.useState<string | null>(null)
  const ask = async (productId: string) => {
    setAsking(productId)
    try {
      const suggestions = await queryClient.fetchQuery({
        queryKey: inventoryKeys.reorder(branchId),
        queryFn: () => fetchReorder(branchId),
        staleTime: 15_000,
      })
      open.purchase(presetFor(productId, suggestions.items.find((item) => item.productId === productId)))
    } catch {
      // Sin la sugerencia igual se puede pedir: la fila llega vacía.
      open.purchase(presetFor(productId, undefined))
    } finally {
      setAsking(null)
    }
  }

  // «Dar de baja» lo vencido, sin formulario. La clave sigue igual hasta que se confirma: un reintento no duplica.
  const writeOffKeys = React.useRef(new Map<string, string>())
  const writeOff = useMutation({
    mutationFn: (item: ProductListItem) => {
      const key = writeOffKeys.current.get(item.id) ?? newKey()
      writeOffKeys.current.set(item.id, key)
      return writeOffExpired(item.id, branchId, key)
    },
    onSuccess: (result, item) => {
      writeOffKeys.current.delete(item.id)
      toast.success(`Se dio de baja lo vencido de ${item.name}: ${unitsText(result.quantity, item.unit)}.`)
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
    },
    onError: (error, item) => {
      if (!isAmbiguousMutationError(error)) writeOffKeys.current.delete(item.id)
      toast.error(inventoryErrorMessage(error))
    },
  })

  // «Pedir lo que falta»: un borrador por proveedor; lo que nunca se compró pregunta a quién pedirlo.
  const reorder = useMutation({
    mutationFn: () => createReorderDrafts(branchId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: inventoryKeys.all })
      const drafts = result.drafts
      if (drafts.length > 0) {
        const which = drafts.map((draft) => `${draft.label} a ${draft.supplierName ?? "su proveedor"}`).join(", ")
        toast.success(`${drafts.length === 1 ? "Se armó un borrador" : `Se armaron ${drafts.length} borradores`}: ${which}. ${drafts.length === 1 ? "Revísalo y confirma el pedido." : "Revísalos y confirma los pedidos."}`)
      } else if (result.alreadyInDraft.length > 0 && result.withoutSupplier.length === 0) {
        const labels = [...new Set(result.alreadyInDraft.flatMap((item) => (item.inDraft ? [item.inDraft.label] : [])))].join(", ")
        toast.info(`Lo que falta ya está en ${labels.includes(",") ? "los borradores" : "el borrador"} ${labels}.`)
      } else if (result.withoutSupplier.length === 0) {
        toast.info("No hay nada que pedir: lo que falta ya viene en compras pedidas.")
      }
      if (drafts.length > 0 || result.alreadyInDraft.length > 0) setParams({ tab: "compras", ver: "borradores", q: undefined, producto: undefined })
      if (result.withoutSupplier.length > 0) {
        open.purchase({
          lines: result.withoutSupplier.map((item) => ({ productId: item.productId, quantity: item.quantity })),
          notice:
            result.withoutSupplier.length === 1
              ? "Este producto nunca se compró (o su proveedor está desactivado): elige a quién pedirlo."
              : "Estos productos nunca se compraron (o su proveedor está desactivado): elige a quién pedirlos.",
        })
      }
    },
    onError: (error) => toast.error(inventoryErrorMessage(error)),
  })

  // Las columnas leen las acciones al momento: así no se rehacen en cada render.
  const act = React.useRef({ ask, writeOff: (item: ProductListItem) => writeOff.mutate(item) })
  act.current = { ask, writeOff: (item: ProductListItem) => writeOff.mutate(item) }
  const writingOff = writeOff.isPending
  const columns = React.useMemo<ColumnDef<ProductListItem>[]>(
    () => [
      {
        id: "producto",
        header: "Producto",
        meta: { view: { role: "title" } },
        cell: ({ row }) => {
          const item = row.original
          return (
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <button
                type="button"
                className="min-h-11 text-left font-medium hover:underline focus-visible:underline sm:min-h-0"
                onClick={() => open.product(item.id)}
              >
                {item.name}
              </button>
              {item.forSale ? <span className="text-xs text-muted-foreground">se vende</span> : null}
              {!item.isActive ? <span className="text-xs text-muted-foreground">desactivado</span> : null}
              {item.unitReview ? <span className="text-xs text-warning">unidad por revisar</span> : null}
            </span>
          )
        },
      },
      {
        id: "hay",
        header: () => <span className="block text-right">Hay</span>,
        meta: { view: { primary: true, label: "Hay" } },
        cell: ({ row }) => (
          <span className={cn("block whitespace-nowrap tabular-nums md:text-right", row.original.onHand < 0 && "font-semibold text-destructive")}>
            {stockText(row.original.onHand, row.original)}
          </span>
        ),
      },
      {
        id: "minimo",
        header: () => <span className="block text-right">Mínimo</span>,
        meta: { view: { primary: true, label: "Mínimo" } },
        cell: ({ row }) => (
          <span className="block whitespace-nowrap tabular-nums md:text-right">
            <span className="md:hidden">mín. </span>
            {row.original.minQuantity > 0 ? formatWhole(row.original.minQuantity) : "—"}
          </span>
        ),
      },
      {
        id: "estado",
        header: "Estado",
        meta: { view: { primary: true } },
        cell: ({ row }) => {
          const badge = stateBadge(row.original, list?.today)
          return badge ? <Chip tone={badge.tone}>{badge.label}</Chip> : null
        },
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Acción</span>,
        cell: ({ row }) => {
          const item = row.original
          if (can.write && item.isActive && item.state === "vencido") {
            return (
              <div className="text-right">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  aria-label={`Dar de baja lo vencido de ${item.name}`}
                  disabled={writingOff}
                  onClick={() => act.current.writeOff(item)}
                >
                  Dar de baja
                </Button>
              </div>
            )
          }
          if (can.write && item.isActive && item.needs) {
            return (
              <div className="text-right">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  aria-label={`Pedir ${item.name}`}
                  disabled={asking !== null}
                  onClick={() => void act.current.ask(item.id)}
                >
                  Pedir
                </Button>
              </div>
            )
          }
          const items: RowActionItem[] = [{ key: "ver", label: "Ver el producto", onSelect: () => open.product(item.id) }]
          if (item.isActive && can.write) items.push({ key: "ajustar", label: "Ajustar", onSelect: () => open.action("ajustar", { productId: item.id }) })
          if (item.isActive && can.write && scope.branches.length > 1)
            items.push({ key: "trasladar", label: "Trasladar", onSelect: () => open.action("trasladar", { productId: item.id }) })
          if (item.isActive && can.receive) items.push({ key: "uso", label: "Registrar uso", onSelect: () => open.action("uso", { productId: item.id }) })
          if (item.isActive && can.write) items.push({ key: "agregar", label: "Agregar sin compra", onSelect: () => open.action("agregar", { productId: item.id }) })
          return (
            <div className="text-right">
              <RowActions label={`Acciones de ${item.name}`} items={items} />
            </div>
          )
        },
      },
    ],
    [can.write, can.receive, list?.today, asking, writingOff, scope.branches.length, open],
  )
  // Sin paginación: reiniciar la página con cada lista nueva re-renderiza sin fin (las filas son otro arreglo en cada render).
  const table = useReactTable({ data: rows, columns, autoResetPageIndex: false, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id })

  const counts = list?.counts
  const filters: Array<{ value: ProductNeed | undefined; label: string; count: number | undefined }> = [
    { value: undefined, label: "Todos", count: counts?.todos },
    { value: "hacen_falta", label: "Hacen falta", count: counts?.hacen_falta },
    { value: "por_vencer", label: "Por vencer", count: counts?.por_vencer },
  ]
  const nothingYet = !query.isPending && !query.isError && counts?.todos === 0 && !q
  const missingCount = counts?.hacen_falta ?? 0

  return (
    <div className="flex flex-col gap-3">
      {nothingYet ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-card p-3">
          <SearchInput
            label="Buscar en productos"
            placeholder="Buscar por nombre o código"
            expandable
            isFetching={query.isFetching && !query.isPending && q !== ""}
          />
          <ViewTabs
            label="Qué productos ver"
            value={need ?? "todos"}
            options={filters.map((filter) => ({ value: filter.value ?? "todos", label: filter.label, count: filter.count }))}
            onValueChange={(next) => setParam("ver", next === "todos" ? undefined : next, { replace: true })}
          />
        </div>
      )}

      {query.isPending ? (
        <SkeletonRegion message="Cargando productos…">
          <ProductRowsSkeleton />
        </SkeletonRegion>
      ) : query.isError && !list ? (
        <QueryErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : nothingYet ? (
        <EmptyState
          icon={Package}
          title="Todavía no hay productos"
          description={
            can.write
              ? `Si ya tienes una lista en Excel o Google Sheets, pégala y ${appWords().name} la ordena.`
              : "Los registra quien lleva el inventario de la clínica."
          }
          {...(can.write
            ? { actionLabel: "Pegar mi lista", onAction: open.paste, secondaryActionLabel: "+ Producto", onSecondaryAction: () => open.productForm() }
            : {})}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Package}
          title={q ? "Sin resultados" : need === "hacen_falta" ? `Nada hace falta en ${branchName}` : "Nada vence en los próximos 30 días"}
          description={q ? "Ningún producto coincide con lo que buscas." : "Cuando algo haga falta o esté por vencer, aparece aquí y arriba de la lista."}
          actionLabel="Ver todos"
          onAction={() => setParams({ ver: undefined, q: undefined }, { replace: true })}
        />
      ) : (
        <DataTable
          table={table}
          isFetching={query.isFetching}
          onRowClick={(item) => open.product(item.id)}
          isRowActive={(item) => item.id === openId}
        />
      )}

      {query.isError && list ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo actualizar la lista; se conservan los productos cargados.{" "}
          <Button type="button" variant="link" size="sm" onClick={() => void query.refetch()}>
            Reintentar
          </Button>
        </p>
      ) : null}

      {can.write && missingCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-4 py-3">
          <p className="text-sm">
            {missingCount === 1 ? "1 producto hace falta" : `${formatWhole(missingCount)} productos hacen falta`} en {branchName}: se arma un
            borrador por proveedor.
          </p>
          <Button type="button" className="min-h-11 sm:min-h-9" disabled={reorder.isPending} onClick={() => reorder.mutate()}>
            Pedir lo que falta
          </Button>
        </div>
      ) : null}
    </div>
  )
}
